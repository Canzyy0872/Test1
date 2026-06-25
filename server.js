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
