/**
 * Minimap Relay Server + Telegram Bot
 *
 * Endpoint:
 *   POST /push/:slot          ← C++ mod kirim data hero
 *   GET  /get/:slot           ← Android snapshot awal
 *   WS   /ws/:slot            ← Android realtime
 *   GET  /config              ← C++ startup fetch (query: ?key=DEVICE_KEY)
 *   GET  /status              ← health chec
 *
 * Bot Commands (hanya owner):
 *   /setslot <key> <slot> <YYYY-MM-DD>   — assign slot + expiry ke device key
 *   /delslot <key>                        — hapus akses
 *   /listslot                             — lihat semua aktif
 *   /checkslot <key>                      — cek status satu key
 */

const express      = require("express");
const http         = require("http");
const { WebSocketServer, OPEN } = require("ws");
const url          = require("url");
const fs           = require("fs");
const path         = require("path");
const https        = require("https");

// ─── ENV ──────────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN;       // Token dari @BotFather
const OWNER_ID    = parseInt(process.env.OWNER_ID || "0"); // Telegram user ID kamu
const SERVER_HOST = process.env.SERVER_HOST || "https://spaceevolution.up.railway.app";
const USERS_FILE  = path.join(__dirname, "users.json"); // persistent di Railway volume

// ─── File JSON Storage ─────────────────────────────────────────────────────────
// Struktur: { "DEVICE_KEY": { slot: 7, expiry: "2026-08-01", addedAt: "..." } }
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) { console.error("[DB] Load error:", e.message); }
  return {};
}

function saveUsers(data) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), "utf8"); }
  catch (e) { console.error("[DB] Save error:", e.message); }
}

let usersDb = loadUsers();

// ─── Express + HTTP + WS ──────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const snapshot = {};
const clients  = {};

function getClients(slot) {
  if (!clients[slot]) clients[slot] = new Set();
  return clients[slot];
}

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── GET / ────────────────────────────────────────────────────────────────────
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
      display: flex; align-items: center; justify-content: center;
      background: #0a0a0f;
      font-family: 'Segoe UI', system-ui, sans-serif;
      color: #e2e8f0; overflow: hidden;
    }
    body::before {
      content: ''; position: fixed; inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%, rgba(99,102,241,0.18) 0%, transparent 70%),
        radial-gradient(ellipse 60% 40% at 80% 100%, rgba(168,85,247,0.12) 0%, transparent 70%);
      pointer-events: none;
    }
    .card {
      position: relative; text-align: center;
      padding: 3rem 2.5rem; max-width: 480px; width: 90%;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 20px; backdrop-filter: blur(12px);
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      animation: fadeUp .6s ease both;
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(24px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .badge {
      display: inline-block; margin-bottom: 1.2rem;
      padding: .3rem 1rem; font-size: .7rem; font-weight: 700;
      letter-spacing: .12em; text-transform: uppercase;
      color: #a5b4fc; background: rgba(99,102,241,0.15);
      border: 1px solid rgba(99,102,241,0.3); border-radius: 999px;
    }
    .logo {
      font-size: 2.2rem; font-weight: 800; letter-spacing: -.02em;
      background: linear-gradient(135deg, #818cf8 0%, #c084fc 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text; margin-bottom: .4rem;
    }
    .sub { font-size: .95rem; color: #94a3b8; margin-bottom: 2rem; line-height: 1.6; }
    .divider { height: 1px; background: rgba(255,255,255,0.07); margin: 1.5rem 0; }
    .contact-label { font-size: .72rem; text-transform: uppercase; letter-spacing: .1em; color: #64748b; margin-bottom: .8rem; }
    .tg-btn {
      display: inline-flex; align-items: center; gap: .55rem;
      padding: .7rem 1.6rem; border-radius: 12px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      color: #fff; font-size: .9rem; font-weight: 600;
      text-decoration: none; transition: opacity .2s, transform .2s; margin-bottom: .6rem;
    }
    .tg-btn:hover { opacity: .88; transform: translateY(-2px); }
    .tg-btn svg { width: 18px; height: 18px; fill: #fff; flex-shrink: 0; }
    .channel-link { display: block; margin-top: .5rem; font-size: .8rem; color: #6366f1; text-decoration: none; transition: color .2s; }
    .channel-link:hover { color: #a5b4fc; }
    .footer { margin-top: 2rem; font-size: .7rem; color: #334155; }
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

// ─── GET /config ──────────────────────────────────────────────────────────────
// C++ startup hit ini: GET /config?key=DEVICE_KEY
// Response: { ok, slot, expiry, pushUrl, wsUrl } atau { ok: false, error }
app.get("/config", (req, res) => {
  const key = (req.query.key || "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "Missing key" });

  const user = usersDb[key];
  if (!user) return res.status(404).json({ ok: false, error: "Key not found" });

  // Cek expired
  const now    = new Date();
  const expiry = new Date(user.expiry + "T00:00:00Z");
  if (now > expiry) return res.status(403).json({ ok: false, error: "Expired", expiry: user.expiry });

  res.json({
    ok:      true,
    slot:    user.slot,
    expiry:  user.expiry,
    pushUrl: `${SERVER_HOST}/push/${user.slot}`,
    wsUrl:   `${SERVER_HOST.replace("https://", "wss://").replace("http://", "ws://")}/ws/${user.slot}`
  });
});

// ─── POST /push/:slot ─────────────────────────────────────────────────────────
app.post("/push/:slot", (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });

  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ ok: false, error: "Body must be array" });

  snapshot[slot] = data;

  const slotClients = getClients(slot);
  const msg = JSON.stringify({ event: "hero_update", payload: data });
  let sent = 0;
  slotClients.forEach((ws) => {
    if (ws.readyState === OPEN) { ws.send(msg); sent++; }
  });

  res.json({ ok: true, slot, count: data.length, forwarded: sent });
});

// ─── GET /get/:slot ───────────────────────────────────────────────────────────
app.get("/get/:slot", (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });
  res.json(snapshot[slot] ?? []);
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const info = {};
  for (const slot of Object.keys(clients)) {
    info[slot] = { connected: getClients(parseInt(slot)).size, heroes: (snapshot[slot] ?? []).length };
  }
  res.json({ ok: true, slots: info, uptime: Math.floor(process.uptime()) + "s" });
});

// ─── WebSocket /ws/:slot ──────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const parsed = url.parse(req.url);
  const parts  = parsed.pathname.split("/").filter(Boolean);
  const slot   = parseInt(parts[1], 10);

  if (isNaN(slot)) { ws.close(1008, "Invalid slot"); return; }

  const slotClients = getClients(slot);
  slotClients.add(ws);
  console.log(`[WS] Connect slot=${slot}, total=${slotClients.size}`);

  if (snapshot[slot] && snapshot[slot].length > 0)
    ws.send(JSON.stringify({ event: "hero_update", payload: snapshot[slot] }));

  const pingInterval = setInterval(() => {
    if (ws.readyState === OPEN) ws.ping();
  }, 20000);

  ws.on("close", () => {
    slotClients.delete(ws); clearInterval(pingInterval);
    console.log(`[WS] Disconnect slot=${slot}, remaining=${slotClients.size}`);
  });
  ws.on("error", (err) => {
    console.error(`[WS] Error slot=${slot}:`, err.message);
    slotClients.delete(ws); clearInterval(pingInterval);
  });
});

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
// Polling sederhana, tanpa library (biar nggak perlu install node-telegram-bot-api)

let lastUpdateId = 0;

function tgSend(chatId, text) {
  if (!BOT_TOKEN) return;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  });
  req.on("error", () => {});
  req.write(body);
  req.end();
}

function tgPoll() {
  if (!BOT_TOKEN) return;
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/getUpdates?timeout=25&offset=${lastUpdateId + 1}`,
    method: "GET"
  }, (res) => {
    let raw = "";
    res.on("data", d => raw += d);
    res.on("end", () => {
      try {
        const json = JSON.parse(raw);
        if (!json.ok || !json.result.length) return;
        for (const update of json.result) {
          lastUpdateId = update.update_id;
          handleMessage(update.message);
        }
      } catch {}
      tgPoll(); // lanjut polling
    });
  });
  req.on("error", () => setTimeout(tgPoll, 5000));
  req.end();
}

function handleMessage(msg) {
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const text   = msg.text.trim();

  // Hanya owner yang bisa pakai
  if (fromId !== OWNER_ID) {
    tgSend(chatId, "❌ Unauthorized.");
    return;
  }

  const args = text.split(/\s+/);
  const cmd  = args[0].toLowerCase();

  // ── /setslot <key> <slot> <YYYY-MM-DD> ──────────────────────────────────────
  if (cmd === "/setslot") {
    if (args.length < 4) {
      tgSend(chatId, "⚠️ Format: <code>/setslot KEY SLOT YYYY-MM-DD</code>\nContoh: /setslot abc123 7 2026-08-01");
      return;
    }
    const key    = args[1];
    const slot   = parseInt(args[2]);
    const expiry = args[3];

    if (isNaN(slot) || slot < 1 || slot > 999) { tgSend(chatId, "❌ Slot harus angka 1-999."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry))   { tgSend(chatId, "❌ Format tanggal: YYYY-MM-DD"); return; }

    usersDb[key] = { slot, expiry, addedAt: new Date().toISOString() };
    saveUsers(usersDb);

    tgSend(chatId,
      `✅ Slot di-set!\n\n` +
      `🔑 Key: <code>${key}</code>\n` +
      `📍 Slot: <b>${slot}</b>\n` +
      `📅 Expired: <b>${expiry}</b>\n\n` +
      `🔗 Push URL:\n<code>${SERVER_HOST}/push/${slot}</code>`
    );
    return;
  }

  // ── /delslot <key> ──────────────────────────────────────────────────────────
  if (cmd === "/delslot") {
    const key = args[1];
    if (!key) { tgSend(chatId, "⚠️ Format: <code>/delslot KEY</code>"); return; }
    if (!usersDb[key]) { tgSend(chatId, `❌ Key <code>${key}</code> tidak ditemukan.`); return; }
    delete usersDb[key];
    saveUsers(usersDb);
    tgSend(chatId, `🗑️ Key <code>${key}</code> dihapus.`);
    return;
  }

  // ── /listslot ───────────────────────────────────────────────────────────────
  if (cmd === "/listslot") {
    const keys = Object.keys(usersDb);
    if (!keys.length) { tgSend(chatId, "📭 Belum ada slot terdaftar."); return; }

    const now   = new Date();
    let lines = [`📋 <b>Daftar Slot (${keys.length})</b>\n`];
    for (const k of keys) {
      const u      = usersDb[k];
      const expiry = new Date(u.expiry + "T00:00:00Z");
      const status = now > expiry ? "❌ Expired" : "✅ Aktif";
      lines.push(`• <code>${k}</code> → Slot <b>${u.slot}</b> | ${u.expiry} | ${status}`);
    }
    tgSend(chatId, lines.join("\n"));
    return;
  }

  // ── /checkslot <key> ────────────────────────────────────────────────────────
  if (cmd === "/checkslot") {
    const key = args[1];
    if (!key) { tgSend(chatId, "⚠️ Format: <code>/checkslot KEY</code>"); return; }
    const u = usersDb[key];
    if (!u) { tgSend(chatId, `❌ Key <code>${key}</code> tidak ditemukan.`); return; }

    const now    = new Date();
    const expiry = new Date(u.expiry + "T00:00:00Z");
    const sisa   = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    const status = now > expiry ? "❌ <b>Expired</b>" : `✅ Aktif, sisa <b>${sisa} hari</b>`;

    tgSend(chatId,
      `🔍 Info Key\n\n` +
      `🔑 Key: <code>${key}</code>\n` +
      `📍 Slot: <b>${u.slot}</b>\n` +
      `📅 Expired: <b>${u.expiry}</b>\n` +
      `Status: ${status}\n\n` +
      `🔗 Push URL:\n<code>${SERVER_HOST}/push/${u.slot}</code>`
    );
    return;
  }

  // ── /help ───────────────────────────────────────────────────────────────────
  if (cmd === "/help" || cmd === "/start") {
    tgSend(chatId,
      `🤖 <b>Space Evolution Bot</b>\n\n` +
      `Commands:\n` +
      `/setslot KEY SLOT YYYY-MM-DD\n` +
      `/delslot KEY\n` +
      `/listslot\n` +
      `/checkslot KEY\n\n` +
      `Contoh:\n<code>/setslot abc123 7 2026-08-01</code>`
    );
    return;
  }

  tgSend(chatId, "❓ Command tidak dikenal. Ketik /help");
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Minimap Relay running on port ${PORT}`);
  console.log(`  POST /push/:slot  ← C++ mod`);
  console.log(`  GET  /get/:slot   ← Android fallback`);
  console.log(`  WS   /ws/:slot    ← Android realtime`);
  console.log(`  GET  /config      ← C++ startup config`);
  console.log(`  GET  /status      ← health check`);
  if (BOT_TOKEN) {
    console.log(`  Bot Telegram aktif, polling...`);
    tgPoll();
  } else {
    console.warn("  [BOT] BOT_TOKEN tidak ada di ENV, bot tidak jalan.");
  }
});
