/**
 * Minimap Relay Server
 *
 * Terima POST dari C++ mod, forward ke Android client via WebSocket.
 *
 * Endpoint:
 *   POST /push/:slot  ← C++ mod kirim { "heroes": [...], "retri": 0|1 }
 *   GET  /get/:slot   ← Android ambil snapshot awal pas connect
 *   WS   /ws/:slot    ← Android subscribe real-time update
 *   GET  /status      ← health check / debug
 *
 * Event WebSocket yang dikirim ke Android:
 *   { "event": "hero_update", "payload": [...heroes...] }
 *   { "event": "retri",       "payload": 1 }   ← hanya saat retri:1
 *   { "event": "retri",       "payload": 0 }   ← saat kembali idle
 */

const express = require("express");
const http    = require("http");
const { WebSocketServer, OPEN } = require("ws");
const url     = require("url");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── In-memory store ──────────────────────────────────────────────────────────
// snapshot[slot]    = last heroes array
// retriState[slot]  = last retri value (0 or 1)
// clients[slot]     = Set<WebSocket>
const snapshot   = {};
const retriState = {};
const clients    = {};

function getClients(slot) {
  if (!clients[slot]) clients[slot] = new Set();
  return clients[slot];
}

// ─── Broadcast ke semua client di slot ────────────────────────────────────────
function broadcast(slot, msg) {
  const slotClients = getClients(slot);
  const str = JSON.stringify(msg);
  let sent = 0;
  slotClients.forEach((ws) => {
    if (ws.readyState === OPEN) {
      ws.send(str);
      sent++;
    }
  });
  return sent;
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

// ─── POST /push/:slot ─────────────────────────────────────────────────────────
// C++ mod kirim: { "heroes": [...], "retri": 0|1 }
// Server:
//   1. Simpan snapshot heroes
//   2. Forward hero_update ke semua client
//   3. Jika retri berubah → forward event retri
app.post("/push/:slot", (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });

  const data = req.body;

  // Validasi format baru: { heroes: [...], retri: 0|1 }
  if (!data || typeof data !== "object") {
    return res.status(400).json({ ok: false, error: "Body must be JSON object" });
  }

  const heroes    = Array.isArray(data.heroes) ? data.heroes : [];
  const retri     = data.retri === 1 ? 1 : 0;
  const prevRetri = retriState[slot] ?? 0;

  // Simpan snapshot
  snapshot[slot]   = heroes;
  retriState[slot] = retri;

  // Forward hero positions
  const heroSent = broadcast(slot, { event: "hero_update", payload: heroes });

  // Selalu forward retri:1 ke client (tidak filter perubahan)
  // retri:0 hanya forward saat transisi 1→0
  let retriSent = 0;
  if (retri === 1) {
    retriSent = broadcast(slot, { event: "retri", payload: 1 });
    console.log(`[RETRI] slot=${slot} retri=1 → forwarded to ${retriSent} clients`);
  } else if (retri === 0 && prevRetri === 1) {
    retriSent = broadcast(slot, { event: "retri", payload: 0 });
    console.log(`[RETRI] slot=${slot} retri=0 (idle) → forwarded to ${retriSent} clients`);
  }

  res.json({ ok: true, slot, heroes: heroes.length, retri, heroSent, retriSent });
});

// ─── GET /get/:slot ───────────────────────────────────────────────────────────
// Android ambil snapshot awal sebelum WebSocket connect.
// Return: { heroes: [...], retri: 0|1 }
app.get("/get/:slot", (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });
  res.json({
    heroes: snapshot[slot] ?? [],
    retri:  retriState[slot] ?? 0,
  });
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const info = {};
  for (const slot of Object.keys(clients)) {
    info[slot] = {
      connected: getClients(parseInt(slot)).size,
      heroes:    (snapshot[slot] ?? []).length,
      retri:     retriState[slot] ?? 0,
    };
  }
  res.json({ ok: true, slots: info, uptime: Math.floor(process.uptime()) + "s" });
});

// ─── WebSocket /ws/:slot ──────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const parsed = url.parse(req.url);
  const parts  = parsed.pathname.split("/").filter(Boolean); // ["ws", "1"]
  const slot   = parseInt(parts[1], 10);

  if (isNaN(slot)) {
    ws.close(1008, "Invalid slot");
    return;
  }

  const slotClients = getClients(slot);
  slotClients.add(ws);
  console.log(`[WS] Client connect slot=${slot}, total=${slotClients.size}`);

  // Kirim snapshot awal: heroes + retri state saat ini
  const initHeroes = snapshot[slot] ?? [];
  const initRetri  = retriState[slot] ?? 0;

  if (initHeroes.length > 0) {
    ws.send(JSON.stringify({ event: "hero_update", payload: initHeroes }));
  }
  // Kirim retri state awal agar client tahu kondisi sebelum connect
  ws.send(JSON.stringify({ event: "retri", payload: initRetri }));

  // Ping tiap 20 detik biar tidak di-drop idle
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
  console.log(`  POST /push/:slot  ← C++ mod { heroes:[...], retri:0|1 }`);
  console.log(`  GET  /get/:slot   ← Android snapshot`);
  console.log(`  WS   /ws/:slot    ← Android realtime`);
  console.log(`  GET  /status      ← health check`);
});
