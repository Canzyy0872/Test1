/**
 * Minimap Relay Server — v3
 *
 * HTTP Endpoints:
 *   POST /push/:slot   ← C++ mod kirim data hero
 *   GET  /get/:slot    ← Android ambil snapshot
 *   WS   /ws/:slot     ← Android realtime
 *   GET  /status       ← health check JSON
 *   GET  /info/:slot   ← info publik slot (label, expireAt, valid)
 *
 * Database: data.json
 *   slots    → slot aktif (label, expireAt, createdAt, publishUrl)
 *   history  → riwayat slot yang sudah expired / dihapus
 *
 * Telegram Bot:
 *   /start   → info & menu utama
 *   /addslot → tambah slot (pilih nomor → tulis label → numpad hari → konfirmasi)
 *   /rmslot  → hapus slot (pilih dari list)
 *   /slots   → list semua slot aktif + link publish
 *   /history → riwayat slot yang sudah expired/dihapus
 */

const express  = require("express");
const http     = require("http");
const { WebSocketServer, OPEN } = require("ws");
const urlMod   = require("url");
const fs       = require("fs");
const path     = require("path");
const https    = require("https");

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN  || "8729150876:AAHADR8eAdR6iHojxTNott_8xBi9J2S98KU";
const ADMIN_IDS  = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const BASE_URL   = (process.env.BASE_URL  || "").replace(/\/$/, "");
// BASE_URL contoh: https://minimap-relay.up.railway.app
// Jika kosong, link publish akan menggunakan placeholder

const DATA_FILE  = path.join(__dirname, "data.json");

// ─── Database (data.json) ─────────────────────────────────────────────────────
// Struktur:
// {
//   "slots": {
//     "7": { slot, label, expireAt, createdAt, publishUrl }
//   },
//   "history": [
//     { slot, label, expireAt, createdAt, publishUrl, removedAt, reason }
//   ]
// }

let db = { slots: {}, history: [] };

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (!db.slots)   db.slots   = {};
      if (!db.history) db.history = [];
      console.log(`[DB] Loaded: ${Object.keys(db.slots).length} slot aktif, ${db.history.length} history`);
    }
  } catch (e) {
    console.error("[DB] Gagal load data.json:", e.message);
    db = { slots: {}, history: [] };
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("[DB] Gagal save data.json:", e.message);
  }
}

function makePublishUrl(slot) {
  if (!BASE_URL) return `https://YOUR-RAILWAY-URL/info/${slot}`;
  return `${BASE_URL}/info/${slot}`;
}

function isSlotValid(slotKey) {
  const entry = db.slots[slotKey];
  if (!entry) return false;
  if (entry.expireAt === 0) return true;
  return Date.now() < entry.expireAt;
}

function msLeft(slotKey) {
  const entry = db.slots[slotKey];
  if (!entry || entry.expireAt === 0) return Infinity;
  return entry.expireAt - Date.now();
}

function fmtDuration(ms) {
  if (ms <= 0)      return "Sudah expired";
  if (ms === Infinity) return "Permanen";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000)  / 60000);
  if (d > 0) return `${d} hari ${h > 0 ? h + " jam" : ""}`.trim();
  if (h > 0) return `${h} jam ${m > 0 ? m + " mnt" : ""}`.trim();
  return `${m} menit`;
}

function fmtDate(ts) {
  if (!ts || ts === 0) return "Permanen";
  return new Date(ts).toLocaleString("id-ID", { timeZone: "Asia/Makassar" }) + " WITA";
}

loadDb();

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

// ─── Middleware: cek slot valid ───────────────────────────────────────────────
function requireValidSlot(req, res, next) {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });
  if (!isSlotValid(String(slot))) {
    return res.status(403).json({ ok: false, error: "Slot tidak aktif atau sudah expired", slot });
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
  const sc = getClients(slot);
  const msg = JSON.stringify({ event: "hero_update", payload: data });
  let sent = 0;
  sc.forEach(ws => { if (ws.readyState === OPEN) { ws.send(msg); sent++; } });
  res.json({ ok: true, slot, count: data.length, forwarded: sent });
});

// ─── GET /get/:slot ───────────────────────────────────────────────────────────
app.get("/get/:slot", requireValidSlot, (req, res) => {
  res.json(snapshot[req.slotNum] ?? []);
});

// ─── GET /info/:slot — info publik slot ───────────────────────────────────────
app.get("/info/:slot", (req, res) => {
  const slotKey = req.params.slot;
  const entry   = db.slots[slotKey];
  if (!entry) {
    // Cek di history
    const hist = db.history.filter(h => String(h.slot) === slotKey);
    if (hist.length > 0) {
      return res.json({
        ok: false,
        slot: slotKey,
        status: "expired_or_removed",
        history: hist.map(h => ({ label: h.label, removedAt: fmtDate(h.removedAt), reason: h.reason }))
      });
    }
    return res.status(404).json({ ok: false, error: "Slot tidak ditemukan" });
  }
  const valid = isSlotValid(slotKey);
  res.json({
    ok: true,
    slot: slotKey,
    label: entry.label,
    status: valid ? "active" : "expired",
    expireAt: fmtDate(entry.expireAt),
    timeLeft: fmtDuration(msLeft(slotKey)),
    createdAt: fmtDate(entry.createdAt),
    wsClients: getClients(parseInt(slotKey)).size,
  });
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const info = {};
  for (const slotKey of Object.keys(db.slots)) {
    const e = db.slots[slotKey];
    info[slotKey] = {
      label: e.label,
      valid: isSlotValid(slotKey),
      expireAt: fmtDate(e.expireAt),
      timeLeft: fmtDuration(msLeft(slotKey)),
      publishUrl: e.publishUrl,
      wsClients: getClients(parseInt(slotKey)).size,
      heroes: (snapshot[slotKey] ?? []).length,
    };
  }
  res.json({ ok: true, uptime: Math.floor(process.uptime()) + "s", slots: info, historyCount: db.history.length });
});

// ─── WebSocket /ws/:slot ──────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const parsed = urlMod.parse(req.url);
  const parts  = parsed.pathname.split("/").filter(Boolean);
  const slot   = parseInt(parts[1], 10);
  if (isNaN(slot)) { ws.close(1008, "Invalid slot"); return; }
  if (!isSlotValid(String(slot))) {
    ws.close(1008, "Slot expired atau tidak terdaftar");
    return;
  }
  const sc = getClients(slot);
  sc.add(ws);
  console.log(`[WS] Connect slot=${slot}, total=${sc.size}`);
  if (snapshot[slot]?.length > 0) {
    ws.send(JSON.stringify({ event: "hero_update", payload: snapshot[slot] }));
  }
  const ping = setInterval(() => { if (ws.readyState === OPEN) ws.ping(); }, 20000);
  ws.on("close", () => { sc.delete(ws); clearInterval(ping); });
  ws.on("error", () => { sc.delete(ws); clearInterval(ping); });
});

// ─── Auto cleanup expired ─────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const slotKey of Object.keys(db.slots)) {
    const e = db.slots[slotKey];
    if (e.expireAt !== 0 && now >= e.expireAt) {
      // Pindah ke history
      db.history.push({ ...e, removedAt: now, reason: "expired" });
      // Putus WS
      const sc = clients[slotKey];
      if (sc) { sc.forEach(ws => { try { ws.close(1001, "Slot expired"); } catch (_) {} }); delete clients[slotKey]; }
      delete snapshot[slotKey];
      delete db.slots[slotKey];
      changed = true;
      console.log(`[AutoClean] Slot ${slotKey} (${e.label}) expired → history`);
      broadcastTelegram(
        `🔴 *Slot ${slotKey}* (${e.label}) telah *expired* dan otomatis dinonaktifkan.\n` +
        `📦 Data tersimpan di history.`
      );
    }
  }
  if (changed) saveDb();
}, 60 * 1000);

// ─── Warning 1 jam sebelum expire ────────────────────────────────────────────
const warnedSet = new Set();
setInterval(() => {
  const now = Date.now();
  for (const slotKey of Object.keys(db.slots)) {
    const e = db.slots[slotKey];
    if (e.expireAt === 0) continue;
    const left = e.expireAt - now;
    if (left > 0 && left <= 3600000 && !warnedSet.has(slotKey)) {
      warnedSet.add(slotKey);
      broadcastTelegram(`⚠️ *Slot ${slotKey}* (${e.label}) expire dalam *${fmtDuration(left)}*!`);
    }
    if (left <= 0) warnedSet.delete(slotKey);
  }
}, 5 * 60 * 1000);

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
let lastUpdateId = 0;
const userState = {}; // { chatId: { step, data } }

function tgApi(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const req  = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendMsg(chatId, text, extra = {}) {
  return tgApi("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });
}

function editMsg(chatId, msgId, text, extra = {}) {
  return tgApi("editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "Markdown", ...extra });
}

function broadcastTelegram(text) {
  if (!ADMIN_IDS.length) return;
  ADMIN_IDS.forEach(id => sendMsg(id, text).catch(() => {}));
}

function isAdmin(chatId) {
  return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(String(chatId));
}

// ── Numpad keyboard untuk input hari ─────────────────────────────────────────
// digits = string angka yang sudah diketik, misal "1", "14", "30"
function buildNumpad(slotKey, label, digits) {
  const display = digits === "" ? "0" : digits;
  const numpad = [
    ["7","8","9"],
    ["4","5","6"],
    ["1","2","3"],
    ["⌫","0","✅"],
  ];
  const keyboard = numpad.map(row =>
    row.map(k => {
      let cb;
      if (k === "⌫") cb = `np:${slotKey}:${label}:${digits}:del`;
      else if (k === "✅") cb = `np:${slotKey}:${label}:${digits}:ok`;
      else cb = `np:${slotKey}:${label}:${digits}:${k}`;
      return { text: k, callback_data: cb };
    })
  );
  // Tambah tombol Permanen di bawah
  keyboard.push([{ text: "♾️ Permanen (tanpa batas)", callback_data: `np:${slotKey}:${label}:0:perm` }]);
  return {
    text:
      `🔢 *Masukkan durasi slot (hari):*\n\n` +
      `📌 Slot: *${slotKey}* — ${label}\n` +
      `⌨️ Input: *${display} hari*\n\n` +
      `_Tekan ✅ untuk konfirmasi_`,
    keyboard: { inline_keyboard: keyboard },
  };
}

// ── Slot list keyboard ────────────────────────────────────────────────────────
function buildSlotListKb(action) {
  const keys = Object.keys(db.slots);
  if (!keys.length) return null;
  return {
    inline_keyboard: keys.map(k => {
      const e    = db.slots[k];
      const left = msLeft(k);
      const tag  = isSlotValid(k)
        ? `✅ Slot ${k} — ${e.label} (${fmtDuration(left)})`
        : `🔴 Slot ${k} — ${e.label} (expired)`;
      return [{ text: tag, callback_data: `${action}:${k}` }];
    })
  };
}

// ── Slot number keyboard (pilih nomor slot yg belum dipakai) ─────────────────
function buildSlotNumKb() {
  const used = new Set(Object.keys(db.slots).map(Number));
  const avail = [];
  for (let i = 1; i <= 20; i++) if (!used.has(i)) avail.push(i);
  const rows = [];
  for (let i = 0; i < avail.length; i += 5)
    rows.push(avail.slice(i, i+5).map(n => ({ text: `Slot ${n}`, callback_data: `slotnum:${n}` })));
  return rows.length ? { inline_keyboard: rows } : null;
}

// ── Confirm keyboard ──────────────────────────────────────────────────────────
function buildConfirmKb(slotKey, label, days) {
  return {
    inline_keyboard: [[
      { text: "✅ Tambahkan", callback_data: `confirm:${slotKey}:${label}:${days}` },
      { text: "❌ Batal",     callback_data: `confirm:cancel` },
    ]]
  };
}

// ─── Handler update ───────────────────────────────────────────────────────────
async function handleUpdate(update) {

  // ── Callback query ──────────────────────────────────────────────────────────
  if (update.callback_query) {
    const cq     = update.callback_query;
    const chatId = cq.message.chat.id;
    const msgId  = cq.message.message_id;
    const cbData = cq.data;
    await tgApi("answerCallbackQuery", { callback_query_id: cq.id });
    if (!isAdmin(chatId)) return;

    // slotnum:<n> → pilih nomor slot, minta label
    if (cbData.startsWith("slotnum:")) {
      const slotKey = cbData.split(":")[1];
      userState[chatId] = { step: "waiting_label", data: { slotKey } };
      await editMsg(chatId, msgId,
        `➕ *Tambah Slot ${slotKey}*\n\nKetik *label/nama* untuk slot ini:\n_(contoh: Budi VIP, Akun1, dll)_`
      );
      return;
    }

    // np:<slot>:<label>:<digits>:<action>
    if (cbData.startsWith("np:")) {
      const parts  = cbData.split(":");
      // parts: ["np", slotKey, label, digits, action]
      // label bisa punya ":" jadi kita ambil dari index 2 sampai length-2
      const slotKey = parts[1];
      const action  = parts[parts.length - 1];
      const digits  = parts[parts.length - 2];
      // label = bagian tengah (index 2 s/d length-3)
      const label   = parts.slice(2, parts.length - 2).join(":");

      if (action === "perm") {
        // Langsung konfirmasi permanen
        const kb = buildConfirmKb(slotKey, label, 0);
        await editMsg(chatId, msgId,
          `📋 *Konfirmasi Slot Baru*\n\n` +
          `🔢 Slot: *${slotKey}*\n` +
          `📌 Label: ${label}\n` +
          `⏳ Durasi: *Permanen*\n` +
          `🔗 Link: \`${makePublishUrl(slotKey)}\`\n\n` +
          `Lanjutkan?`,
          { reply_markup: kb }
        );
        return;
      }

      if (action === "del") {
        const newDigits = digits.length > 1 ? digits.slice(0, -1) : "";
        const { text, keyboard } = buildNumpad(slotKey, label, newDigits);
        await editMsg(chatId, msgId, text, { reply_markup: keyboard });
        return;
      }

      if (action === "ok") {
        const days = parseInt(digits || "0", 10);
        if (days < 1) {
          await tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Masukkan minimal 1 hari dulu!", show_alert: true });
          return;
        }
        const kb = buildConfirmKb(slotKey, label, days);
        await editMsg(chatId, msgId,
          `📋 *Konfirmasi Slot Baru*\n\n` +
          `🔢 Slot: *${slotKey}*\n` +
          `📌 Label: ${label}\n` +
          `⏳ Durasi: *${days} hari*\n` +
          `📅 Expire: ${fmtDate(Date.now() + days * 86400000)}\n` +
          `🔗 Link: \`${makePublishUrl(slotKey)}\`\n\n` +
          `Lanjutkan?`,
          { reply_markup: kb }
        );
        return;
      }

      // Digit 0-9
      const newDigits = (digits + action).replace(/^0+/, "") || "0";
      if (newDigits.length > 4) return; // max 9999 hari
      const { text, keyboard } = buildNumpad(slotKey, label, newDigits === "0" ? "" : newDigits);
      await editMsg(chatId, msgId, text, { reply_markup: keyboard });
      return;
    }

    // confirm:<slot>:<label>:<days>
    if (cbData.startsWith("confirm:")) {
      if (cbData === "confirm:cancel") {
        await editMsg(chatId, msgId, "❌ Penambahan slot dibatalkan.");
        delete userState[chatId];
        return;
      }
      const parts   = cbData.split(":");
      const slotKey = parts[1];
      const days    = parseInt(parts[parts.length - 1], 10);
      const label   = parts.slice(2, parts.length - 1).join(":");
      const expireAt  = days === 0 ? 0 : Date.now() + days * 86400000;
      const publishUrl = makePublishUrl(slotKey);

      db.slots[slotKey] = {
        slot: slotKey,
        label,
        expireAt,
        createdAt: Date.now(),
        publishUrl,
      };
      saveDb();
      delete userState[chatId];

      await editMsg(chatId, msgId,
        `✅ *Slot ${slotKey} berhasil ditambahkan!*\n\n` +
        `📌 Label: ${label}\n` +
        `⏳ Expire: ${expireAt === 0 ? "Permanen" : fmtDate(expireAt)}\n` +
        `🔗 Link Publish:\n\`${publishUrl}\`\n\n` +
        `_Share link di atas ke client untuk cek status slot._`
      );
      return;
    }

    // rmslot:<slot>
    if (cbData.startsWith("rmslot:")) {
      const slotKey = cbData.split(":")[1];
      const e = db.slots[slotKey];
      if (!e) { await editMsg(chatId, msgId, `Slot ${slotKey} tidak ditemukan.`); return; }
      // Konfirmasi hapus
      await editMsg(chatId, msgId,
        `🗑️ *Hapus Slot ${slotKey}?*\n\nLabel: ${e.label}\nExpire: ${fmtDate(e.expireAt)}\n\nYakin?`,
        { reply_markup: { inline_keyboard: [[
          { text: "✅ Ya, hapus", callback_data: `rmconfirm:${slotKey}` },
          { text: "❌ Batal",    callback_data: `rmconfirm:cancel` },
        ]] } }
      );
      return;
    }

    // rmconfirm:<slot>
    if (cbData.startsWith("rmconfirm:")) {
      if (cbData === "rmconfirm:cancel") {
        await editMsg(chatId, msgId, "❌ Penghapusan dibatalkan."); return;
      }
      const slotKey = cbData.split(":")[1];
      const e = db.slots[slotKey];
      if (!e) { await editMsg(chatId, msgId, "Slot tidak ditemukan."); return; }
      // Pindah ke history
      db.history.push({ ...e, removedAt: Date.now(), reason: "manual" });
      // Putus WS
      const sc = clients[slotKey];
      if (sc) { sc.forEach(ws => { try { ws.close(1001, "Slot removed"); } catch (_) {} }); delete clients[slotKey]; }
      delete snapshot[slotKey];
      delete db.slots[slotKey];
      saveDb();
      await editMsg(chatId, msgId,
        `🗑️ *Slot ${slotKey}* (${e.label}) berhasil dihapus.\n📦 Tersimpan di /history.`
      );
      return;
    }

    return;
  }

  // ── Pesan teks ──────────────────────────────────────────────────────────────
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  if (!isAdmin(chatId)) { await sendMsg(chatId, "⛔ Tidak punya akses."); return; }

  // Input label (multi-step)
  const st = userState[chatId];
  if (st?.step === "waiting_label") {
    const label   = text;
    const slotKey = st.data.slotKey;
    delete userState[chatId];
    const { text: npText, keyboard } = buildNumpad(slotKey, label, "");
    await sendMsg(chatId, npText, { reply_markup: keyboard });
    return;
  }

  const cmd = text.split(" ")[0].toLowerCase();

  // /start
  if (cmd === "/start" || cmd === "/help") {
    const totalSlots  = Object.keys(db.slots).length;
    const activeSlots = Object.keys(db.slots).filter(s => isSlotValid(s)).length;
    await sendMsg(chatId,
      `🗺️ *Minimap Relay Bot*\n\n` +
      `🟢 Server Online | ⏱ Uptime: ${Math.floor(process.uptime())}s\n` +
      `📦 Slot: ${totalSlots} terdaftar, ${activeSlots} aktif\n` +
      `📋 History: ${db.history.length} slot\n\n` +
      `*Menu:*\n` +
      `/addslot — ➕ Tambah slot baru\n` +
      `/rmslot  — 🗑️ Hapus slot\n` +
      `/slots   — 📋 Daftar slot & link\n` +
      `/history — 📦 Riwayat slot expired\n` +
      `/status  — 📊 Status detail server`
    );
    return;
  }

  // /addslot
  if (cmd === "/addslot") {
    const kb = buildSlotNumKb();
    if (!kb) { await sendMsg(chatId, "⛔ Slot penuh (maks 20)."); return; }
    await sendMsg(chatId, `➕ *Tambah Slot Baru*\n\nPilih nomor slot:`, { reply_markup: kb });
    return;
  }

  // /rmslot
  if (cmd === "/rmslot") {
    const kb = buildSlotListKb("rmslot");
    if (!kb) { await sendMsg(chatId, "📭 Tidak ada slot untuk dihapus."); return; }
    await sendMsg(chatId, `🗑️ *Hapus Slot*\n\nPilih slot:`, { reply_markup: kb });
    return;
  }

  // /slots
  if (cmd === "/slots") {
    const keys = Object.keys(db.slots);
    if (!keys.length) { await sendMsg(chatId, "📭 Belum ada slot.\n\n/addslot untuk tambah slot baru."); return; }
    const lines = [`📋 *Daftar Slot (${keys.length})*\n`];
    for (const k of keys) {
      const e    = db.slots[k];
      const valid = isSlotValid(k);
      const left  = msLeft(k);
      lines.push(
        `${valid ? "✅" : "🔴"} *Slot ${k}* — ${e.label}\n` +
        `   ⏳ ${e.expireAt === 0 ? "Permanen" : fmtDuration(left)}\n` +
        `   👥 ${getClients(parseInt(k)).size} client\n` +
        `   🔗 \`${e.publishUrl}\``
      );
    }
    await sendMsg(chatId, lines.join("\n\n"));
    return;
  }

  // /history
  if (cmd === "/history") {
    if (!db.history.length) { await sendMsg(chatId, "📭 History kosong."); return; }
    const recent = db.history.slice(-10).reverse(); // 10 terbaru
    const lines  = [`📦 *History Slot (${db.history.length} total, menampilkan 10 terakhir)*\n`];
    for (const h of recent) {
      const reason = h.reason === "expired" ? "⏰ Auto-expired" : "🗑️ Dihapus manual";
      lines.push(
        `*Slot ${h.slot}* — ${h.label}\n` +
        `   ${reason} • ${fmtDate(h.removedAt)}\n` +
        `   Dibuat: ${fmtDate(h.createdAt)} | Expire: ${fmtDate(h.expireAt)}`
      );
    }
    await sendMsg(chatId, lines.join("\n\n"));
    return;
  }

  // /status
  if (cmd === "/status") {
    const keys  = Object.keys(db.slots);
    const lines = [`📊 *Status Server*\n⏱ Uptime: ${Math.floor(process.uptime())}s\n`];
    if (!keys.length) {
      lines.push("Tidak ada slot terdaftar.");
    } else {
      for (const k of keys) {
        const e = db.slots[k];
        lines.push(
          `${isSlotValid(k) ? "✅" : "🔴"} *Slot ${k}* (${e.label})\n` +
          `   👥 ${getClients(parseInt(k)).size} WS | 🦸 ${(snapshot[k] ?? []).length} hero\n` +
          `   ⏳ ${e.expireAt === 0 ? "Permanen" : fmtDuration(msLeft(k))}`
        );
      }
    }
    await sendMsg(chatId, lines.join("\n\n"));
    return;
  }

  await sendMsg(chatId, "❓ Tidak dikenal. Ketik /start untuk menu.");
}

// ─── Telegram Polling ─────────────────────────────────────────────────────────
async function pollTelegram() {
  console.log("[TG] Polling started...");
  while (true) {
    try {
      const res = await tgApi("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      if (res.ok && res.result.length > 0) {
        for (const upd of res.result) {
          lastUpdateId = upd.update_id;
          handleUpdate(upd).catch(e => console.error("[TG] Error:", e.message));
        }
      }
    } catch (e) {
      console.error("[TG] Poll error:", e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Minimap Relay v3 running on port ${PORT}`);
  console.log(`   POST /push/:slot  ← C++ mod`);
  console.log(`   GET  /get/:slot   ← Android`);
  console.log(`   WS   /ws/:slot    ← Android WS`);
  console.log(`   GET  /info/:slot  ← Info publik slot`);
  console.log(`   GET  /status      ← Health check`);
  console.log(`   DB   data.json    ← Persistent storage`);
  if (BASE_URL) console.log(`   BASE_URL: ${BASE_URL}`);
  else console.log(`   ⚠️  Set BASE_URL env var untuk link publish yang benar!`);
  pollTelegram();
});
