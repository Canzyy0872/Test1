/**
 * Minimap Relay Server — Enhanced Edition
 *
 * Endpoints relay:
 *   POST /push/:slot          ← C++ mod kirim data hero
 *   GET  /get/:slot           ← Android ambil snapshot awal
 *   WS   /ws/:slot            ← Android subscribe real-time
 *   GET  /status              ← health check / debug
 *
 * Slot Management (via Telegram Bot):
 *   /start    → info & status semua slot
 *   /addslot  → tambah slot baru (pilih nomor slot + durasi expiry)
 *   /rmslot   → hapus slot yang dipilih
 *   /slots    → list semua slot & status expiry
 *
 * Fitur tambahan:
 *   - Slot expired otomatis diblokir (push/get/ws ditolak)
 *   - Slot expired otomatis dihapus dari daftar tiap 1 menit
 *   - Warning Telegram 1 jam sebelum slot expire
 *   - Data slot disimpan ke slots.json (persistent restart)
 */

const express    = require("express");
const http       = require("http");
const { WebSocketServer, OPEN } = require("ws");
const url        = require("url");
const fs         = require("fs");
const path       = require("path");
const https      = require("https");

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN   || "8729150876:AAHADR8eAdR6iHojxTNott_8xBi9J2S98KU";
const ADMIN_IDS   = (process.env.ADMIN_IDS  || "").split(",").map(s => s.trim()).filter(Boolean);
// Jika ADMIN_IDS kosong, siapa saja bisa akses bot — set di Railway env var
const SLOTS_FILE  = path.join(__dirname, "slots.json");

// ─── Persistent Slot Store ────────────────────────────────────────────────────
// slotRegistry[slot] = { slot: number, label: string, expireAt: number (ms), createdAt: number }
let slotRegistry = {};

function loadSlots() {
  try {
    if (fs.existsSync(SLOTS_FILE)) {
      slotRegistry = JSON.parse(fs.readFileSync(SLOTS_FILE, "utf8"));
      console.log(`[Slots] Loaded ${Object.keys(slotRegistry).length} slot(s) dari file`);
    }
  } catch (e) {
    console.error("[Slots] Gagal load slots.json:", e.message);
    slotRegistry = {};
  }
}

function saveSlots() {
  try {
    fs.writeFileSync(SLOTS_FILE, JSON.stringify(slotRegistry, null, 2));
  } catch (e) {
    console.error("[Slots] Gagal save slots.json:", e.message);
  }
}

function isSlotValid(slot) {
  const entry = slotRegistry[slot];
  if (!entry) return false;
  if (entry.expireAt === 0) return true; // 0 = permanent
  return Date.now() < entry.expireAt;
}

function slotExpiredIn(slot) {
  const entry = slotRegistry[slot];
  if (!entry || entry.expireAt === 0) return null;
  return entry.expireAt - Date.now(); // ms, bisa negatif kalau sudah lewat
}

function formatDuration(ms) {
  if (ms <= 0) return "Sudah expired";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const parts = [];
  if (d > 0) parts.push(`${d}h`);  // "h" = hari
  if (h > 0) parts.push(`${h}j`);  // "j" = jam
  if (m > 0 && d === 0) parts.push(`${m}m`); // menit hanya kalau < 1 hari
  return parts.join(" ") || "< 1 menit";
}

loadSlots();

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

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Middleware: cek slot valid ───────────────────────────────────────────────
function requireValidSlot(req, res, next) {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });
  if (!isSlotValid(slot)) {
    return res.status(403).json({
      ok: false,
      error: "Slot tidak terdaftar atau sudah expired",
      slot
    });
  }
  req.slotNum = slot;
  next();
}

// ─── POST /push/:slot ─────────────────────────────────────────────────────────
app.post("/push/:slot", requireValidSlot, (req, res) => {
  const slot = req.slotNum;
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
app.get("/get/:slot", requireValidSlot, (req, res) => {
  const slot = req.slotNum;
  res.json(snapshot[slot] ?? []);
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const info = {};
  for (const slot of Object.keys(slotRegistry)) {
    const entry = slotRegistry[slot];
    const msLeft = slotExpiredIn(slot);
    info[slot] = {
      label: entry.label || "-",
      connected: getClients(parseInt(slot)).size,
      heroes: (snapshot[slot] ?? []).length,
      valid: isSlotValid(slot),
      expireAt: entry.expireAt === 0 ? "permanent" : new Date(entry.expireAt).toISOString(),
      timeLeft: entry.expireAt === 0 ? "permanent" : formatDuration(msLeft),
    };
  }
  res.json({ ok: true, slots: info, uptime: Math.floor(process.uptime()) + "s" });
});

// ─── WebSocket /ws/:slot ──────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const parsed  = url.parse(req.url);
  const parts   = parsed.pathname.split("/").filter(Boolean);
  const slot    = parseInt(parts[1], 10);

  if (isNaN(slot)) { ws.close(1008, "Invalid slot"); return; }

  if (!isSlotValid(slot)) {
    ws.close(1008, "Slot expired atau tidak terdaftar");
    console.log(`[WS] Ditolak slot=${slot} (expired/unknown)`);
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

// ─── Auto cleanup slot expired ────────────────────────────────────────────────
// Jalankan tiap 1 menit. Hapus slot expired dari registry & putus WS-nya.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const slotKey of Object.keys(slotRegistry)) {
    const entry = slotRegistry[slotKey];
    if (entry.expireAt !== 0 && now >= entry.expireAt) {
      console.log(`[AutoClean] Slot ${slotKey} (${entry.label}) expired, dihapus`);
      // Putus semua WS client slot ini
      const sc = clients[slotKey];
      if (sc) {
        sc.forEach(ws => {
          try { ws.close(1001, "Slot expired"); } catch (_) {}
        });
        delete clients[slotKey];
      }
      delete snapshot[slotKey];
      delete slotRegistry[slotKey];
      changed = true;
      // Notify Telegram admin
      broadcastTelegram(`🔴 *Slot ${slotKey}* (${entry.label}) telah *expired* dan otomatis dihapus.`);
    }
  }
  if (changed) saveSlots();
}, 60 * 1000);

// ─── Warning 1 jam sebelum expire ────────────────────────────────────────────
const warnedSlots = new Set();
setInterval(() => {
  const now = Date.now();
  for (const slotKey of Object.keys(slotRegistry)) {
    const entry = slotRegistry[slotKey];
    if (entry.expireAt === 0) continue;
    const msLeft = entry.expireAt - now;
    if (msLeft > 0 && msLeft <= 3600000 && !warnedSlots.has(slotKey)) {
      warnedSlots.add(slotKey);
      broadcastTelegram(
        `⚠️ *Slot ${slotKey}* (${entry.label}) akan expire dalam *${formatDuration(msLeft)}*!`
      );
    }
    if (msLeft <= 0) warnedSlots.delete(slotKey); // reset kalau sudah expire
  }
}, 5 * 60 * 1000); // cek tiap 5 menit

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
let lastUpdateId = 0;
// State per user untuk multi-step command
// userState[chatId] = { step, data }
const userState = {};

function tgApi(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return tgApi("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });
}

function broadcastTelegram(text) {
  if (ADMIN_IDS.length === 0) return;
  ADMIN_IDS.forEach(id => sendMessage(id, text).catch(() => {}));
}

function isAdmin(chatId) {
  if (ADMIN_IDS.length === 0) return true; // open jika tidak ada admin terdaftar
  return ADMIN_IDS.includes(String(chatId));
}

// ── Build inline keyboard slot list untuk /rmslot ────────────────────────────
function buildSlotKeyboard(action = "rmslot") {
  const keys = Object.keys(slotRegistry);
  if (keys.length === 0) return null;
  const buttons = keys.map(slotKey => {
    const entry = slotRegistry[slotKey];
    const valid = isSlotValid(slotKey);
    const msLeft = slotExpiredIn(slotKey);
    const label = valid
      ? `✅ Slot ${slotKey} — ${entry.label} (${entry.expireAt === 0 ? "∞" : formatDuration(msLeft)})`
      : `🔴 Slot ${slotKey} — ${entry.label} (expired)`;
    return [{ text: label, callback_data: `${action}:${slotKey}` }];
  });
  return { inline_keyboard: buttons };
}

// ── Durasi pilihan untuk /addslot ────────────────────────────────────────────
const DURATION_OPTIONS = [
  { label: "1 Hari",    ms: 1 * 86400000 },
  { label: "3 Hari",   ms: 3 * 86400000 },
  { label: "7 Hari",   ms: 7 * 86400000 },
  { label: "14 Hari",  ms: 14 * 86400000 },
  { label: "30 Hari",  ms: 30 * 86400000 },
  { label: "Permanen", ms: 0 },
];

function buildDurationKeyboard(slot) {
  const buttons = DURATION_OPTIONS.map(opt => ([{
    text: opt.label,
    callback_data: `duration:${slot}:${opt.ms}`
  }]));
  return { inline_keyboard: buttons };
}

// ── Handler update Telegram ───────────────────────────────────────────────────
async function handleUpdate(update) {
  // Callback query (inline button press)
  if (update.callback_query) {
    const cq     = update.callback_query;
    const chatId = cq.message.chat.id;
    const msgId  = cq.message.message_id;
    const data   = cq.data;
    await tgApi("answerCallbackQuery", { callback_query_id: cq.id });

    if (!isAdmin(chatId)) return;

    // rmslot:<slot>
    if (data.startsWith("rmslot:")) {
      const slotKey = data.split(":")[1];
      const entry = slotRegistry[slotKey];
      if (!entry) {
        await tgApi("editMessageText", { chat_id: chatId, message_id: msgId, text: `Slot ${slotKey} tidak ditemukan.` });
        return;
      }
      // Putus WS
      const sc = clients[slotKey];
      if (sc) {
        sc.forEach(ws => { try { ws.close(1001, "Slot removed"); } catch (_) {} });
        delete clients[slotKey];
      }
      delete snapshot[slotKey];
      delete slotRegistry[slotKey];
      saveSlots();
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: msgId,
        text: `🗑️ Slot *${slotKey}* (${entry.label}) berhasil dihapus.`,
        parse_mode: "Markdown"
      });
      return;
    }

    // duration:<slot>:<ms>
    if (data.startsWith("duration:")) {
      const parts  = data.split(":");
      const slot   = parseInt(parts[1], 10);
      const ms     = parseInt(parts[2], 10);
      const state  = userState[chatId];
      const label  = state?.data?.label || `Slot ${slot}`;
      const expireAt = ms === 0 ? 0 : Date.now() + ms;

      slotRegistry[slot] = { slot, label, expireAt, createdAt: Date.now() };
      saveSlots();

      const expireStr = expireAt === 0
        ? "Permanen (tidak expire)"
        : new Date(expireAt).toLocaleString("id-ID", { timeZone: "Asia/Makassar" }) + " WITA";

      delete userState[chatId];
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: msgId,
        text:
          `✅ *Slot ${slot}* berhasil ditambahkan!\n` +
          `📌 Label: ${label}\n` +
          `⏳ Expire: ${expireStr}`,
        parse_mode: "Markdown"
      });
      return;
    }

    // slot_select:<slot> (dari addslot step 1 pilih nomor slot)
    if (data.startsWith("slot_select:")) {
      const slot = parseInt(data.split(":")[1], 10);
      userState[chatId] = { step: "waiting_label", data: { slot } };
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: msgId,
        text: `Slot *${slot}* dipilih.\n\nSekarang ketik *nama/label* untuk slot ini (contoh: _Akun Budi_, _VIP1_, dll):`,
        parse_mode: "Markdown"
      });
      return;
    }

    return;
  }

  // Pesan teks biasa
  const msg    = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  if (!isAdmin(chatId)) {
    await sendMessage(chatId, "⛔ Kamu tidak punya akses ke bot ini.");
    return;
  }

  // Tangkap state input label (multi-step addslot)
  const state = userState[chatId];
  if (state?.step === "waiting_label") {
    const label = text;
    const slot  = state.data.slot;
    userState[chatId] = { step: "waiting_duration", data: { slot, label } };
    await sendMessage(chatId,
      `Label: *${label}*\n\nPilih durasi aktif untuk Slot *${slot}*:`,
      { reply_markup: buildDurationKeyboard(slot) }
    );
    return;
  }

  // ── Commands ─────────────────────────────────────────────────────────────────
  const cmd = text.split(" ")[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    const totalSlots = Object.keys(slotRegistry).length;
    const activeSlots = Object.keys(slotRegistry).filter(s => isSlotValid(s)).length;
    await sendMessage(chatId,
      `🗺️ *Minimap Relay Bot*\n\n` +
      `Status server: 🟢 Online\n` +
      `Uptime: ${Math.floor(process.uptime())}s\n` +
      `Total slot: ${totalSlots} (aktif: ${activeSlots})\n\n` +
      `*Perintah:*\n` +
      `/slots — lihat semua slot & status\n` +
      `/addslot — tambah slot baru\n` +
      `/rmslot — hapus slot\n` +
      `/status — status server lengkap`
    );
    return;
  }

  if (cmd === "/slots") {
    const keys = Object.keys(slotRegistry);
    if (keys.length === 0) {
      await sendMessage(chatId, "📭 Belum ada slot yang terdaftar.\n\nGunakan /addslot untuk tambah slot baru.");
      return;
    }
    let lines = [`📋 *Daftar Slot (${keys.length})*\n`];
    for (const slotKey of keys) {
      const entry  = slotRegistry[slotKey];
      const valid  = isSlotValid(slotKey);
      const msLeft = slotExpiredIn(slotKey);
      const icon   = valid ? "✅" : "🔴";
      const timeStr = entry.expireAt === 0
        ? "Permanen"
        : valid ? `Sisa: ${formatDuration(msLeft)}` : "Expired";
      const wsCount = getClients(parseInt(slotKey)).size;
      lines.push(
        `${icon} *Slot ${slotKey}* — ${entry.label}\n` +
        `   ⏳ ${timeStr} | 📡 ${wsCount} client`
      );
    }
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  if (cmd === "/status") {
    const keys = Object.keys(slotRegistry);
    let lines = [`📊 *Status Server*\n⏱ Uptime: ${Math.floor(process.uptime())}s\n`];
    if (keys.length === 0) {
      lines.push("Tidak ada slot terdaftar.");
    } else {
      for (const slotKey of keys) {
        const entry    = slotRegistry[slotKey];
        const valid    = isSlotValid(slotKey);
        const wsCount  = getClients(parseInt(slotKey)).size;
        const heroes   = (snapshot[slotKey] ?? []).length;
        const msLeft   = slotExpiredIn(slotKey);
        const timeStr  = entry.expireAt === 0 ? "Permanen" : formatDuration(msLeft);
        lines.push(
          `${valid ? "✅" : "🔴"} *Slot ${slotKey}* (${entry.label})\n` +
          `   👥 ${wsCount} WS | 🦸 ${heroes} hero | ⏳ ${timeStr}`
        );
      }
    }
    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  if (cmd === "/addslot") {
    // Pilih nomor slot (1-20 yang belum dipakai)
    const usedSlots = new Set(Object.keys(slotRegistry).map(Number));
    const available = [];
    for (let i = 1; i <= 20; i++) {
      if (!usedSlots.has(i)) available.push(i);
    }
    if (available.length === 0) {
      await sendMessage(chatId, "⛔ Slot penuh (maksimal 20 slot).");
      return;
    }
    // Susun tombol 5 per baris
    const rows = [];
    for (let i = 0; i < available.length; i += 5) {
      rows.push(
        available.slice(i, i + 5).map(n => ({
          text: `Slot ${n}`,
          callback_data: `slot_select:${n}`
        }))
      );
    }
    await sendMessage(chatId,
      `➕ *Tambah Slot Baru*\n\nPilih nomor slot yang mau dipakai:`,
      { reply_markup: { inline_keyboard: rows } }
    );
    return;
  }

  if (cmd === "/rmslot") {
    const keyboard = buildSlotKeyboard("rmslot");
    if (!keyboard) {
      await sendMessage(chatId, "📭 Tidak ada slot yang bisa dihapus.");
      return;
    }
    await sendMessage(chatId,
      `🗑️ *Hapus Slot*\n\nPilih slot yang mau dihapus:`,
      { reply_markup: keyboard }
    );
    return;
  }

  // Default
  await sendMessage(chatId, "❓ Perintah tidak dikenal. Ketik /start untuk bantuan.");
}

// ─── Telegram Polling ─────────────────────────────────────────────────────────
async function pollTelegram() {
  while (true) {
    try {
      const res = await tgApi("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      if (res.ok && res.result.length > 0) {
        for (const update of res.result) {
          lastUpdateId = update.update_id;
          handleUpdate(update).catch(e => console.error("[TG] Handle error:", e.message));
        }
      }
    } catch (e) {
      console.error("[TG] Poll error:", e.message);
      await new Promise(r => setTimeout(r, 5000)); // tunggu 5 detik kalau error
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Minimap Relay (Enhanced) running on port ${PORT}`);
  console.log(`  POST /push/:slot  ← C++ mod`);
  console.log(`  GET  /get/:slot   ← Android fallback`);
  console.log(`  WS   /ws/:slot    ← Android realtime`);
  console.log(`  GET  /status      ← health check`);
  console.log(`  Telegram Bot: aktif (polling)`);

  // Mulai Telegram polling setelah server ready
  pollTelegram();
});
