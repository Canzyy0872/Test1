/**
 * Minimap Relay Server
 *
 * Tugas satu-satunya: terima POST dari C++ mod, forward langsung
 * ke semua Android client yang connect via WebSocket ke slot yang sama.
 * Tidak ada database, tidak ada Supabase, tidak ada library berat.
 *
 * Endpoint:
 *   POST /push/:slot          ← C++ mod kirim data hero ke sini
 *   GET  /get/:slot           ← Android ambil snapshot awal pas connect
 *   WS   /ws/:slot            ← Android subscribe real-time update
 *   GET  /status              ← health check / debug
 */

const express = require("express");
const http    = require("http");
const { WebSocketServer, OPEN } = require("ws");
const url     = require("url");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── In-memory store ──────────────────────────────────────────────────────────
// snapshot[slot] = array of hero objects (last push)
// clients[slot]  = Set of active WebSocket connections untuk slot itu
const snapshot = {};   // { 7: [{id,x,y,hp,hpMax}, ...] }
const clients  = {};   // { 7: Set<WebSocket> }

function getClients(slot) {
  if (!clients[slot]) clients[slot] = new Set();
  return clients[slot];
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

// ─── GET / ────────────────────────────────────────────────────────────────────
// Landing page publik — tampil kalau ada yg buka root URL biasa
app.get("/", (req, res) => {
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
// C++ mod kirim array hero ke sini. Server simpan sebagai snapshot,
// lalu langsung forward ke semua WebSocket client di slot yang sama.
app.post("/push/:slot", (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });

  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ ok: false, error: "Body must be array" });

  // Simpan snapshot terbaru
  snapshot[slot] = data;

  // Forward ke semua client yang subscribe slot ini
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
// Android ambil snapshot awal sebelum WebSocket connect.
app.get("/get/:slot", (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });
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

// ─── WebSocket /ws/:slot ──────────────────────────────────────────────────────
// Android connect ke ws://host/ws/7 → masuk ke slot 7.
// Server langsung kirim snapshot terakhir, lalu tetap open untuk terima update.
wss.on("connection", (ws, req) => {
  const parsed   = url.parse(req.url);
  const parts    = parsed.pathname.split("/").filter(Boolean); // ["ws", "7"]
  const slot     = parseInt(parts[1], 10);

  if (isNaN(slot)) {
    ws.close(1008, "Invalid slot");
    return;
  }

  // Daftarkan client
  const slotClients = getClients(slot);
  slotClients.add(ws);
  console.log(`[WS] Client connect slot=${slot}, total=${slotClients.size}`);

  // Kirim snapshot awal langsung setelah connect
  if (snapshot[slot] && snapshot[slot].length > 0) {
    ws.send(JSON.stringify({ event: "hero_update", payload: snapshot[slot] }));
  }

  // Ping tiap 20 detik biar koneksi nggak di-drop idle oleh hosting
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
  console.log(`Minimap Relay running on port ${PORT}`);
  console.log(`  POST /push/:slot  ← C++ mod`);
  console.log(`  GET  /get/:slot   ← Android fallback`);
  console.log(`  WS   /ws/:slot    ← Android realtime`);
  console.log(`  GET  /status      ← health check`);
});
// ═══════════════════════════════════════════════════════════════
// SLOT DATABASE + TELEGRAM BOT
// ═══════════════════════════════════════════════════════════════

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const BOT_TOKEN   = process.env.BOT_TOKEN;
const OWNER_ID    = parseInt(process.env.OWNER_ID || "0");
const SLOTS_FILE  = path.join(__dirname, "slots.json");

// ── slots.json struktur ──────────────────────────────────────
// { "1": { expiry: "2026-08-01", createdAt: "..." }, "2": {...} }
function loadSlots() {
  try {
    if (fs.existsSync(SLOTS_FILE)) return JSON.parse(fs.readFileSync(SLOTS_FILE, "utf8"));
  } catch (e) { console.error("[DB] Load error:", e.message); }
  return {};
}
function saveSlots(data) {
  try { fs.writeFileSync(SLOTS_FILE, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("[DB] Save error:", e.message); }
}
let slotsDb = loadSlots();

// ── Helper: cek apakah slot valid & belum expired ─────────────
function isSlotActive(slot) {
  const s = slotsDb[String(slot)];
  if (!s) return false;
  const now    = new Date();
  const expiry = new Date(s.expiry + "T23:59:59Z");
  return now <= expiry;
}

// ── Patch POST /push/:slot — blokir kalau slot tidak aktif ────
// (Override handler yang sudah ada di atas dengan middleware global)
app.use("/push/:slot", (req, res, next) => {
  if (req.method !== "POST") return next();
  const slot = parseInt(req.params.slot, 10);
  if (!isSlotActive(slot)) {
    // Drop koneksi total
    req.socket.destroy();
    return;
  }
  next();
});

// ── Patch WS — kick client kalau slot expired/belum ada ───────
// (Ditangani di event 'connection' yang sudah ada, tapi kita tambah
//  pengecekan ulang tiap 60 detik untuk kick yang sudah connect)
setInterval(() => {
  for (const slotKey of Object.keys(clients)) {
    const slot = parseInt(slotKey);
    if (!isSlotActive(slot)) {
      const sc = getClients(slot);
      sc.forEach(ws => {
        if (ws.readyState === OPEN) ws.close(1008, "Slot expired");
      });
      sc.clear();
      console.log(`[SLOT] Slot ${slot} expired, semua client di-kick`);
    }
  }
}, 60000);

// Patch WS connection — tolak langsung kalau slot tidak aktif
const _originalWssOn = wss.on.bind(wss);
wss.on("connection", (ws, req) => {
  const parsed = require("url").parse(req.url);
  const parts  = parsed.pathname.split("/").filter(Boolean);
  const slot   = parseInt(parts[1], 10);
  if (!isNaN(slot) && !isSlotActive(slot)) {
    ws.close(1008, "Slot not active");
    console.log(`[WS] Tolak koneksi slot=${slot} (expired/tidak ada)`);
  }
});

// ═══════════════════════════════════════════════════════════════
// TELEGRAM BOT — robust polling
// ═══════════════════════════════════════════════════════════════

// State untuk multi-step input
// pendingSet[chatId] = { step: 'slot'|'expiry'|'confirm', slot, expiry }
const pendingSet = {};

let lastUpdateId = 0;

function tgApi(method, body, cb) {
  if (!BOT_TOKEN) return;
  const bodyStr = JSON.stringify(body);
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/${method}`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
    timeout: 10000
  }, (res) => {
    let d = ""; res.on("data", c => d += c);
    res.on("end", () => { try { if (cb) cb(JSON.parse(d)); } catch {} });
  });
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(bodyStr); req.end();
}

function tgSend(chatId, text, extra = {}) {
  tgApi("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

function tgEdit(chatId, msgId, text, extra = {}) {
  tgApi("editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", ...extra });
}

function tgAnswer(callbackQueryId, text = "") {
  tgApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

// ── Kirim menu utama ──────────────────────────────────────────
function sendMainMenu(chatId, msgId = null) {
  const keys  = Object.keys(slotsDb);
  const now   = new Date();
  let info    = keys.length === 0
    ? "📭 Belum ada slot terdaftar."
    : keys.map(k => {
        const exp    = new Date(slotsDb[k].expiry + "T23:59:59Z");
        const aktif  = now <= exp ? "🟢" : "🔴";
        const sisa   = Math.ceil((exp - now) / 86400000);
        return `${aktif} Slot <b>${k}</b> — ${slotsDb[k].expiry}${now <= exp ? ` (${sisa}h)` : " (expired)"}`;
      }).join("\n");

  const text = `🤖 <b>Space Evolution — Slot Manager</b>\n\n${info}\n\n<i>Pilih aksi:</i>`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "➕ Set Slot", callback_data: "act:set" },
        { text: "🗑 Hapus Slot", callback_data: "act:del" }
      ],
      [
        { text: "🔄 Refresh", callback_data: "act:refresh" }
      ]
    ]
  };

  if (msgId) {
    tgEdit(chatId, msgId, text, { reply_markup: keyboard });
  } else {
    tgSend(chatId, text, { reply_markup: keyboard });
  }
}

// ── Handle text message ───────────────────────────────────────
function handleMessage(msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const text   = msg.text.trim();

  if (fromId !== OWNER_ID) { tgSend(chatId, "❌ Unauthorized."); return; }

  const cmd = text.split(/\s+/)[0].toLowerCase();
  if (cmd === "/start" || cmd === "/menu") {
    delete pendingSet[chatId];
    sendMainMenu(chatId);
    return;
  }

  // ── Multi-step: tunggu input slot ────────────────────────────
  const pending = pendingSet[chatId];
  if (pending) {
    if (pending.step === "slot") {
      const slot = parseInt(text);
      if (isNaN(slot) || slot < 1 || slot > 9999) {
        tgSend(chatId, "❌ Nomor slot tidak valid. Masukkan angka 1-9999:");
        return;
      }
      pending.slot = slot;
      pending.step = "expiry";
      tgSend(chatId,
        `📅 Masukkan tanggal expired untuk Slot <b>${slot}</b>\n` +
        `Format: <code>YYYY-MM-DD</code>\n` +
        `Contoh: <code>2026-08-01</code>`,
        {
          reply_markup: { inline_keyboard: [[
            { text: "❌ Batal", callback_data: "act:cancel" }
          ]]}
        }
      );
      return;
    }

    if (pending.step === "expiry") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        tgSend(chatId, "❌ Format salah. Contoh: <code>2026-08-01</code>");
        return;
      }
      pending.expiry = text;
      pending.step   = "confirm";

      const exp    = new Date(text + "T23:59:59Z");
      const now    = new Date();
      const sisa   = Math.ceil((exp - now) / 86400000);
      const sudahAda = slotsDb[String(pending.slot)] ? "⚠️ Slot ini sudah ada, akan ditimpa!\n\n" : "";

      tgSend(chatId,
        `${sudahAda}✅ Konfirmasi:\n\n` +
        `📍 Slot: <b>${pending.slot}</b>\n` +
        `📅 Expired: <b>${text}</b>\n` +
        `⏳ Durasi: <b>${sisa} hari</b>\n\n` +
        `Lanjutkan?`,
        {
          reply_markup: { inline_keyboard: [[
            { text: "✅ Konfirmasi", callback_data: "act:confirm" },
            { text: "❌ Batal",     callback_data: "act:cancel"  }
          ]]}
        }
      );
      return;
    }
  }
}

// ── Handle callback query (tombol inline) ─────────────────────
function handleCallback(cb) {
  const chatId  = cb.message.chat.id;
  const msgId   = cb.message.message_id;
  const fromId  = cb.from.id;
  const data    = cb.data;

  tgAnswer(cb.id);
  if (fromId !== OWNER_ID) return;

  // ── Refresh menu ──────────────────────────────────────────────
  if (data === "act:refresh") {
    sendMainMenu(chatId, msgId);
    return;
  }

  // ── Mulai set slot ────────────────────────────────────────────
  if (data === "act:set") {
    pendingSet[chatId] = { step: "slot" };
    tgEdit(chatId, msgId,
      `➕ <b>Set Slot Baru</b>\n\nMasukkan <b>nomor slot</b> (1–9999):`,
      { reply_markup: { inline_keyboard: [[
        { text: "❌ Batal", callback_data: "act:cancel" }
      ]]}}
    );
    return;
  }

  // ── Hapus slot — tampil daftar tombol slot aktif ─────────────
  if (data === "act:del") {
    const keys = Object.keys(slotsDb);
    if (!keys.length) {
      tgEdit(chatId, msgId, "📭 Tidak ada slot untuk dihapus.", {
        reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "act:refresh" }]] }
      });
      return;
    }
    const rows = [];
    for (let i = 0; i < keys.length; i += 3) {
      rows.push(keys.slice(i, i + 3).map(k => ({
        text: `Slot ${k}`, callback_data: `del:${k}`
      })));
    }
    rows.push([{ text: "🔙 Kembali", callback_data: "act:refresh" }]);
    tgEdit(chatId, msgId, "🗑 <b>Pilih slot yang ingin dihapus:</b>", {
      reply_markup: { inline_keyboard: rows }
    });
    return;
  }

  // ── Konfirmasi set ────────────────────────────────────────────
  if (data === "act:confirm") {
    const pending = pendingSet[chatId];
    if (!pending || pending.step !== "confirm") {
      tgEdit(chatId, msgId, "❌ Sesi expired, mulai ulang.", {
        reply_markup: { inline_keyboard: [[{ text: "🔙 Menu", callback_data: "act:refresh" }]] }
      });
      return;
    }
    slotsDb[String(pending.slot)] = {
      expiry:    pending.expiry,
      createdAt: new Date().toISOString()
    };
    saveSlots(slotsDb);
    delete pendingSet[chatId];

    tgEdit(chatId, msgId,
      `✅ <b>Slot ${pending.slot} berhasil disimpan!</b>\n\n` +
      `📅 Expired: <b>${pending.expiry}</b>`,
      { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu", callback_data: "act:refresh" }]] }}
    );
    return;
  }

  // ── Batal ─────────────────────────────────────────────────────
  if (data === "act:cancel") {
    delete pendingSet[chatId];
    sendMainMenu(chatId, msgId);
    return;
  }

  // ── Hapus slot tertentu ───────────────────────────────────────
  if (data.startsWith("del:")) {
    const slot = data.slice(4);
    if (slotsDb[slot]) {
      delete slotsDb[slot];
      saveSlots(slotsDb);

      // Kick semua WS client di slot ini
      const sc = getClients(parseInt(slot));
      sc.forEach(ws => { if (ws.readyState === OPEN) ws.close(1008, "Slot deleted"); });
      sc.clear();
    }
    tgEdit(chatId, msgId,
      `🗑 Slot <b>${slot}</b> dihapus.\nSemua koneksi aktif di-kick.`,
      { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu", callback_data: "act:refresh" }]] }}
    );
    return;
  }
}

// ── Polling robust ────────────────────────────────────────────
function tgPoll() {
  if (!BOT_TOKEN) return;
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/getUpdates?timeout=15&offset=${lastUpdateId + 1}`,
    method: "GET",
    timeout: 20000
  }, (res) => {
    let raw = "";
    res.on("data", d => raw += d);
    res.on("end", () => {
      try {
        const json = JSON.parse(raw);
        if (json.ok && json.result && json.result.length > 0) {
          for (const update of json.result) {
            lastUpdateId = update.update_id;
            if (update.message)        handleMessage(update.message);
            if (update.callback_query) handleCallback(update.callback_query);
          }
        }
      } catch (e) {
        console.error("[BOT] Parse error:", e.message);
      }
      setImmediate(tgPoll); // ← selalu lanjut, kondisi apapun
    });
  });
  req.on("error", (e) => {
    console.error("[BOT] Poll error:", e.message, "→ retry 3s");
    setTimeout(tgPoll, 3000);
  });
  req.on("timeout", () => req.destroy());
  req.end();
}

if (BOT_TOKEN) {
  console.log("[BOT] Telegram bot aktif, mulai polling...");
  tgPoll();
} else {
  console.warn("[BOT] BOT_TOKEN tidak ada di ENV.");
}
