/**
 * Minimap Relay Server (Enhanced with Slot Management)
 *
 * Tugas satu-satunya: terima POST dari C++ mod, forward langsung
 * ke semua Android client yang connect via WebSocket ke slot yang sama.
 * Sekarang dengan manajemen slot berbasis memori dan dashboard admin.
 *
 * Endpoint:
 *   POST /push/:slot          ← C++ mod kirim data hero ke sini
 *   GET  /get/:slot           ← Android ambil snapshot awal pas connect
 *   WS   /ws/:slot            ← Android subscribe real-time update
 *   GET  /status              ← health check / debug
 *   GET  /admin               ← Dashboard admin (protected)
 */

const express = require("express");
const http    = require("http");
const { WebSocketServer, OPEN } = require("ws");
const url     = require("url");
const basicAuth = require('express-basic-auth');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── In-memory store ──────────────────────────────────────────────────────────
// Data utama aplikasi
const snapshot = {};   // { 7: [{id,x,y,hp,hpMax}, ...] }
const clients  = {};   // { 7: Set<WebSocket> }

function getClients(slot) {
  if (!clients[slot]) clients[slot] = new Set();
  return clients[slot];
}

// ─── Slot Manager ─────────────────────────────────────────────────────────────
// Struktur untuk mengelola slot yang aktif dan waktu expired-nya
// Contoh: { "1": { expiresAt: 1717020800000 }, "2": { expiresAt: null } }
const slotManager = {};

// Fungsi untuk mengecek apakah slot valid dan belum expired
function isSlotActive(slotId) {
  const slotInfo = slotManager[slotId];
  if (!slotInfo) return false; // Slot tidak terdaftar

  if (slotInfo.expiresAt === null) return true; // Tidak ada expiry (aktif selamanya)

  return Date.now() < slotInfo.expiresAt; // Periksa waktu expired
}

// Fungsi untuk mendapatkan pesan penolakan HTML
function getAccessDeniedPage() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Akses Ditolak - Space Evolution</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0a0a0f;
      font-family: 'Segoe UI', system-ui, sans-serif;
      color: #e2e8f0;
      overflow: hidden;
    }
    .card {
      position: relative;
      text-align: center;
      padding: 3rem 2.5rem;
      max-width: 480px;
      width: 90%;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 20px;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    }
    .logo {
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -.02em;
      background: linear-gradient(135deg, #ef4444 0%, #f97316 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 1rem;
    }
    .message {
      font-size: 1.1rem;
      color: #f87171;
      margin-bottom: 2rem;
      line-height: 1.6;
    }
    .contact-label {
      font-size: .72rem;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: #64748b;
      margin-bottom: .8rem;
    }
    .tg-btn {
      display: inline-flex;
      align-items: center;
      gap: .55rem;
      padding: .7rem 1.6rem;
      border-radius: 12px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      color: #fff;
      font-size: .9rem;
      font-weight: 600;
      text-decoration: none;
      transition: opacity .2s, transform .2s;
    }
    .tg-btn:hover { opacity: .88; transform: translateY(-2px); }
    .tg-btn svg { width: 18px; height: 18px; fill: #fff; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Akses Ditolak</div>
    <p class="message">Slot yang Anda minta tidak dapat diakses karena belum terdaftarkan atau masa aksesnya telah habis.</p>

    <p class="contact-label">Silahkan hubungi Admin</p>
    <a class="tg-btn" href="https://t.me/ace_finder" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M9.04 15.594l-.392 5.522c.56 0 .803-.24 1.094-.528l2.625-2.507 5.44 3.966c.998.55 1.706.26 1.974-.918l3.578-16.7C23.76.99 22.89.6 21.918.998L1.116 8.874C-.275 9.424-.267 10.2.843 10.54l5.11 1.595 11.87-7.43c.56-.373 1.07-.166.65.207z"/>
      </svg>
      @ace_finder
    </a>
  </div>
</body>
</html>`;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Helper Middleware: Validasi Slot ─────────────────────────────────────────
// Middleware ini akan digunakan oleh semua endpoint yang memerlukan validasi slot
const validateSlot = (req, res, next) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) {
    return res.status(400).json({ ok: false, error: "Invalid slot ID" });
  }

  if (!isSlotActive(slot.toString())) {
    // Alihkan ke halaman HTML penolakan akses
    res.setHeader("Content-Type", "text/html");
    return res.status(403).send(getAccessDeniedPage());
  }

  req.validatedSlot = slot; // Simpan slot yang sudah divalidasi untuk handler berikutnya
  next();
};

// ─── GET / ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  // Menggunakan konten landing page yang sudah ada
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DomainBuy – Space Evolution</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0a0a0f;
      font-family: 'Segoe UI', system-ui, sans-serif;
      color: #e2e8f0;
      overflow: hidden;
    }

    /* Animated background */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%, rgba(99,102,241,0.18) 0%, transparent 70%),
        radial-gradient(ellipse 60% 40% at 80% 100%, rgba(168,85,247,0.12) 0%, transparent 70%);
      pointer-events: none;
    }

    .card {
      position: relative;
      text-align: center;
      padding: 3rem 2.5rem;
      max-width: 480px;
      width: 90%;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 20px;
      backdrop-filter: blur(12px);
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      animation: fadeUp .6s ease both;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(24px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .badge {
      display: inline-block;
      margin-bottom: 1.2rem;
      padding: .3rem 1rem;
      font-size: .7rem;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: #a5b4fc;
      background: rgba(99,102,241,0.15);
      border: 1px solid rgba(99,102,241,0.3);
      border-radius: 999px;
    }

    .logo {
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -.02em;
      background: linear-gradient(135deg, #818cf8 0%, #c084fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: .4rem;
    }

    .sub {
      font-size: .95rem;
      color: #94a3b8;
      margin-bottom: 2rem;
      line-height: 1.6;
    }

    .divider {
      height: 1px;
      background: rgba(255,255,255,0.07);
      margin: 1.5rem 0;
    }

    .contact-label {
      font-size: .72rem;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: #64748b;
      margin-bottom: .8rem;
    }

    .tg-btn {
      display: inline-flex;
      align-items: center;
      gap: .55rem;
      padding: .7rem 1.6rem;
      border-radius: 12px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      color: #fff;
      font-size: .9rem;
      font-weight: 600;
      text-decoration: none;
      transition: opacity .2s, transform .2s;
      margin-bottom: .6rem;
    }
    .tg-btn:hover { opacity: .88; transform: translateY(-2px); }

    .tg-btn svg { width: 18px; height: 18px; fill: #fff; flex-shrink: 0; }

    .channel-link {
      display: block;
      margin-top: .5rem;
      font-size: .8rem;
      color: #6366f1;
      text-decoration: none;
      transition: color .2s;
    }
    .channel-link:hover { color: #a5b4fc; }

    .footer {
      margin-top: 2rem;
      font-size: .7rem;
      color: #334155;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🌌 Space Evolution</div>
    <div class="logo">DomainBuy</div>
    <p class="sub">Minimap Plug-In MLBB<br>by Space Evolution.</p>

    <div class="divider"></div>

    <p class="contact-label">Hubungi Owner</p>

    <a class="tg-btn" href="https://t.me/ace_finder" target="_blank" rel="noopener">
      <!-- Telegram icon -->
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M9.04 15.594l-.392 5.522c.56 0 .803-.24 1.094-.528l2.625-2.507 5.44 3.966c.998.55 1.706.26 1.974-.918l3.578-16.7C23.76.99 22.89.6 21.918.998L1.116 8.874C-.275 9.424-.267 10.2.843 10.54l5.11 1.595 11.87-7.43c.56-.373 1.07-.166.65.207z"/>
      </svg>
      @ace_finder
    </a>

    <a class="channel-link" href="https://t.me/SpaceOfficialNew" target="_blank" rel="noopener">
      📢 Channel: t.me/SpaceOfficialNew
    </a>

    <div class="footer">© Space Evolution · All rights reserved</div>
  </div>
</body>
</html>`);
});

// ─── POST /push/:slot ─────────────────────────────────────────────────────────
app.post("/push/:slot", validateSlot, (req, res) => {
  const slot = req.validatedSlot;
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ ok: false, error: "Body must be array" });

  snapshot[slot] = data;

  const slotClients = getClients(slot);
  const msg = JSON.stringify({ event: "hero_update", payload: data });
  let sent = 0;
  slotClients.forEach((ws) => {
    if (ws.readyState === OPEN) {
      ws.send(msg);
      sent++;
    }
  });

  res.json({ ok: true, slot, count: data.length, forwarded: sent });
});

// ─── GET /get/:slot ───────────────────────────────────────────────────────────
app.get("/get/:slot", validateSlot, (req, res) => {
  const slot = req.validatedSlot;
  res.json(snapshot[slot] ?? []);
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const info = {};
  for (const slot of Object.keys(clients)) {
    info[slot] = {
      connected: getClients(parseInt(slot)).size,
      heroes: (snapshot[slot] ?? []).length,
    };
  }
  res.json({ ok: true, slots: info, uptime: Math.floor(process.uptime()) + "s" });
});

// ─── Admin Authentication Middleware ──────────────────────────────────────────
const adminAuth = basicAuth({
  users: {
    // Ambil dari Railway Environment Variables
    [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'password'
  },
  challenge: true, // Kirim header 'WWW-Authenticate' jika gagal
  unauthorizedResponse: getAccessDeniedPage() // Gunakan halaman yang sama untuk konsistensi
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
// Halaman dashboard admin sederhana
app.get('/admin', adminAuth, (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Admin Dashboard - Slot Manager</title>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #1a1a1a; color: white; }
        input, button { padding: 8px; margin: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #444; padding: 10px; text-align: left; }
        th { background-color: #2a2a2a; }
      </style>
    </head>
    <body>
      <h1>Admin Dashboard</h1>
      <h2>Tambah/Perbarui Slot</h2>
      <form id="slotForm">
        <input type="number" id="slotId" placeholder="ID Slot" required>
        <input type="datetime-local" id="expiresAt" placeholder="Waktu Expired (opsional)">
        <button type="submit">Simpan Slot</button>
      </form>

      <h2>Daftar Slot Aktif</h2>
      <div id="slotList"></div>

      <script>
        function loadSlots() {
          fetch('/admin/api/slots')
            .then(res => res.json())
            .then(data => {
              let html = '<table><thead><tr><th>ID Slot</th><th>Status</th><th>Expired At</th></tr></thead><tbody>';
              for (const [id, info] of Object.entries(data.slots)) {
                const status = new Date() < new Date(info.expiresAt || Infinity) ? 'Aktif' : 'Kedaluwarsa';
                const expiresAtStr = info.expiresAt ? new Date(info.expiresAt).toLocaleString() : 'Tidak Terbatas';
                html += \`<tr><td>\${id}</td><td>\${status}</td><td>\${expiresAtStr}</td></tr>\`;
              }
              html += '</tbody></table>';
              document.getElementById('slotList').innerHTML = html;
            });
        }

        document.getElementById('slotForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const slotId = document.getElementById('slotId').value;
          const expiresAtInput = document.getElementById('expiresAt').value;
          let expiresAt = null;
          if (expiresAtInput) {
            expiresAt = new Date(expiresAtInput).toISOString();
          }

          const response = await fetch('/admin/api/slots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slotId, expiresAt })
          });

          if (response.ok) {
            alert('Slot berhasil disimpan!');
            loadSlots();
            document.getElementById('slotForm').reset();
          } else {
            const error = await response.json();
            alert('Gagal: ' + error.error);
          }
        });

        loadSlots();
        setInterval(loadSlots, 5000); // Refresh setiap 5 detik
      </script>
    </body>
    </html>
  `);
});

// API untuk mendapatkan daftar slot
app.get('/admin/api/slots', adminAuth, (req, res) => {
  res.json({ slots: slotManager });
});

// API untuk menambah/memperbarui slot
app.post('/admin/api/slots', adminAuth, (req, res) => {
  const { slotId, expiresAt } = req.body;

  if (!slotId) {
    return res.status(400).json({ error: 'slotId is required' });
  }

  // Konversi expiresAt ke timestamp jika diberikan
  let expiresAtTimestamp = null;
  if (expiresAt) {
    const date = new Date(expiresAt);
    if (isNaN(date.getTime())) {
      return res.status(400).json({ error: 'Invalid expiresAt format' });
    }
    expiresAtTimestamp = date.getTime();
  }

  // Simpan ke memori
  slotManager[slotId.toString()] = { expiresAt: expiresAtTimestamp };
  console.log(`[ADMIN] Slot ${slotId} updated. ExpiresAt: ${expiresAtTimestamp}`);

  res.json({ ok: true, message: 'Slot updated successfully' });
});

// ─── WebSocket /ws/:slot ──────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const parsed = url.parse(req.url);
  const parts  = parsed.pathname.split("/").filter(Boolean); // ["ws", "7"]
  const slot   = parseInt(parts[1], 10);

  if (isNaN(slot) || !isSlotActive(slot.toString())) {
    // Kirim pesan penutupan yang jelas dan tutup koneksi
    ws.close(1008, "Slot not active or expired. Please contact admin.");
    return;
  }

  const slotClients = getClients(slot);
  slotClients.add(ws);
  console.log(`[WS] Client connect slot=${slot}, total=${slotClients.size}`);

  if (snapshot[slot] && snapshot[slot].length > 0) {
    ws.send(JSON.stringify({ event: "hero_update", payload: snapshot[slot] }));
  }

  const pingInterval = setInterval(() => {
    if (ws.readyState === OPEN) ws.ping();
  }, 20000);

  ws.on("close", () => {
    slotClients.delete(ws);
    clearInterval(pingInterval);
    console.log(`[WS] Client disconnect slot=${slot}, remaining=${slotClients.size}`);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error slot=${slot}:`, err.message);
    slotClients.delete(ws);
    clearInterval(pingInterval);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Minimap Relay (Enhanced) running on port ${PORT}`);
  console.log(`  POST /push/:slot  ← C++ mod`);
  console.log(`  GET  /get/:slot   ← Android fallback`);
  console.log(`  WS   /ws/:slot    ← Android realtime`);
  console.log(`  GET  /status      ← health check`);
  console.log(`  GET  /admin       ← Admin dashboard (protected)`);
});
