import http from 'http';
import os from 'os';
import { config } from './config.js';
import { createClient, getCurrentClient, getLatestQr, getLatestPairingCode, detectBrowser, setOnMaxReconnect, setOnReady, initWithRetry, startConnectionMonitor, getConnectionState } from './client.js';
import { startOrderMonitor } from './services/orderMonitor.js';
import { getMenuText, getInfoProduk, getCaraOrder, getInfoPembayaran, startMenuRefresh } from './services/menu.js';
import { isHandoverActive, endHandover, startHandover, handleAdminReply, forwardToAdmin, initHandover } from './services/handoverService.js';
import { checkDailyLimit } from './services/queue.js';
import { initDashboard, handleDashboardRequest, authorized } from './services/dashboard.js';
import { askAI, askAIWithImage, transcribeAudio, startHistoryCleanup, getAiMetrics } from './services/ai.js';
import { isRelationError } from './utils/db.js';
import { bufferAiMessage, cancelBuffer, savePendingBuffers, setDefaultFlushFn, flushPendingBuffers, holdBufferForMedia, releaseBufferForMedia } from './services/aiBuffer.js';
import { settings, loadSettings, saveSettings, flushSettings } from './services/settings.js';
import { getDb } from './services/supabase.js';
import { withRetry, isDbAvailable } from './utils/db.js';
import { formatPrice, formatTime, formatWaNumber } from './utils/format.js';
import { isViewOnceMessage, saveViewOnceMedia } from './utils/viewOnce.js';
import { startLiveDataRefresh } from './services/liveData.js';
import { handleInstagramWebhook, startInstagramService } from './services/instagram.js';
import { logger, createLogger, throttleLog } from './utils/logger.js';

import ww from 'whatsapp-web.js';
const { MessageMedia } = ww;

const WELCOMED_USERS = new Map();

// Periodic cleanup of welcomed users older than 24h to avoid memory leaks
const welcomedCleanupTimer = setInterval(() => {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  for (const [jid, ts] of WELCOMED_USERS.entries()) {
    if (now - ts > ONE_DAY) {
      WELCOMED_USERS.delete(jid);
    }
  }
}, 3600000);
welcomedCleanupTimer.unref();

const blockedUsers = new Set();
const lastUserMessage = new Map();
const LAST_MSG_TTL = 24 * 60 * 60 * 1000;
const LAST_MSG_MAX = 500;
let waClient = null;
let orderMonitorCleanup = null;
const burstCounts = new Map();

function touchMap(map, key) {
  const val = map.get(key);
  if (val !== undefined) {
    map.delete(key);
    map.set(key, val);
  }
  return val;
}

function evictLRU(map, maxSize) {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [key, entry] of burstCounts) {
    if (entry.ts < cutoff) burstCounts.delete(key);
  }
  evictLRU(burstCounts, 200);
  const msgCutoff = Date.now() - LAST_MSG_TTL;
  for (const [jid, entry] of lastUserMessage) {
    if (entry.ts < msgCutoff) lastUserMessage.delete(jid);
  }
  evictLRU(lastUserMessage, LAST_MSG_MAX);
}, 60000).unref();

async function loadBlockedUsers() {
  try {
    const db = getDb();
    if (!db) return;
    const { data } = await withRetry(() => db.from('wa_bot_config').select('value').eq('key', 'blocked_users').single(), { label: 'Blocklist:load' });
    if (data?.value && Array.isArray(data.value)) {
      data.value.forEach(jid => blockedUsers.add(jid));
      logger.info('Blocklist', `Loaded ${blockedUsers.size} blocked users`);
    }
  } catch (e) {
    if (!isRelationError(e) && !e.message?.includes('PGRST116')) {
      logger.error('Blocklist', 'Load error:', e.message);
    }
  }
}

async function saveBlockedUsers() {
  const db = getDb();
  if (!db) return;
  try {
    await withRetry(() => db.from('wa_bot_config').upsert({
      key: 'blocked_users',
      value: [...blockedUsers],
    }, { onConflict: 'key' }), { label: 'Blocklist:save' });
  } catch (e) {
    if (!isRelationError(e)) {
      logger.error('Blocklist', 'Save error:', e.message);
    }
  }
}
let botStartedAt = Date.now();
const ADMIN_RAW = config.adminNumber.replace(/[^0-9]/g, '');
const ADMIN_JID = formatWaNumber(config.adminNumber);

// ─── Health Check ──────────────────────────────────────────────────────

const healthApp = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // Liveness — 200 while the process is up. Used by the Render/Docker healthcheck so
  // the container isn't killed during first-run QR login (before WA/DB are ready).
  if (url === '/health' || url === '/healthz' || url === '/livez') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', botUptime: Math.floor((Date.now() - botStartedAt) / 1000) }));
    return;
  }

  // First-run login on a headless host — scan QR atau pakai pairing code dari browser.
  // KODE LOGIN = KREDENSIAL PENUH atas akun WA. Begitu ADMIN_TOKEN diisi,
  // /code + /qr wajib token (header x-admin-token) — tanpa itu siapa saja
  // bisa menautkan perangkat dan mengambil alih sesi bot.
  const needLoginAuth = (url === '/code' || url === '/qr') && Boolean(config.adminToken);
  if (needLoginAuth) {
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    if (!authorized(req, q)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — butuh token admin (header x-admin-token)' }));
      return;
    }
  }

  if (url === '/code') {
    const pairing = getLatestPairingCode();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pairing
      ? { code: pairing.code, generatedAt: pairing.generatedAt }
      : { code: null, hint: 'Belum ada kode. Isi PAIRING_NUMBER di .env lalu restart, atau login via QR di /qr.' }));
    return;
  }

  if (url === '/qr') {
    const pairing = getLatestPairingCode();
    const qr = getLatestQr();
    const connected = getCurrentClient()?.info?.wid?.user ? true : false;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (connected) {
      res.end('<h2>✅ WhatsApp sudah terhubung.</h2>');
      return;
    }
    // Mode login aktif: pairing (PAIRING_NUMBER diisi) atau QR.
    // Di mode pairing, WA Web tidak menerbitkan QR sama sekali — jadi yang
    // tampil di sini memang kode pairing. Kosongkan PAIRING_NUMBER + restart
    // untuk login via scan QR.
    const modeNote = config.pairingNumber
      ? '<p><i>Mode pairing aktif (PAIRING_NUMBER diisi). Kosongkan PAIRING_NUMBER di .env lalu restart bot untuk login via scan QR.</i></p>'
      : '<p><i>Mode scan QR aktif. Isi PAIRING_NUMBER di .env lalu restart untuk login via kode pairing.</i></p>';
    let body = `<html><body style="text-align:center;font-family:sans-serif">`;
    if (qr) {
      const img = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(qr)}`;
      body += `<h2>Scan di WhatsApp → Perangkat Tertaut</h2><img src="${img}" alt="QR">`;
    }
    if (pairing) {
      const pretty = String(pairing.code).replace(/(.{4})(.{4})/, '$1-$2');
      body += `<h2>Kode Pairing WhatsApp</h2><p style="font-size:48px;letter-spacing:8px;font-weight:bold">${pretty}</p><p>WA → Perangkat Tertaut → Tautkan dengan nomor telepon → masukkan kode di atas.<br>Kode refresh otomatis tiap ±3 menit. Kode yang sama juga tampil di panel <a href="/admin">/admin</a>.</p>`;
    }
    if (!qr && !pairing) {
      body += `<h2>⏳ QR/kode belum siap, tunggu &amp; refresh…</h2>`;
    }
    body += `${modeNote}<script>setTimeout(()=>location.reload(),20000)</script></body></html>`;
    res.end(body);
    return;
  }

  // Webhook resmi Meta Instagram (/webhook/instagram atau /api/webhook/instagram).
  // Dipasang sebelum auth x-admin-token karena request datang dari server Meta.
  if (url === '/webhook/instagram' || url === '/api/webhook/instagram') {
    if (await handleInstagramWebhook(req, res)) return;
  }

  // Admin dashboard + API — konfigurasi bot lewat localhost, bukan via chat.
  // /admin = panel UI, /api/* = JSON API (token kalau ADMIN_TOKEN diisi).
  if (url === '/admin' || url.startsWith('/api/')) {
    if (await handleDashboardRequest(req, res)) return;
  }

  // Readiness — 200 hanya kalau WA + DB benar-benar terhubung, 503 kalau
  // degraded. Dipakai Docker HEALTHCHECK (dengan start-period agar login
  // pertama via QR/pairing tidak dibunuh). Berbeda dari /health (liveness:
  // 200 selama proses hidup).
  async function readiness() {
    const waConnected = getCurrentClient()?.info?.wid?.user ? true : false;
    let dbConnected = false;
    try {
      const db = getDb();
      if (db) {
        const { error } = await db.from('wa_bot_config').select('key').limit(1);
        dbConnected = !error;
      }
    } catch {}
    return { waConnected, dbConnected };
  }

  if (url === '/ready') {
    const { waConnected, dbConnected } = await readiness();
    const isOk = waConnected && dbConnected;
    res.writeHead(isOk ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isOk ? 'ok' : 'degraded',
      wa: waConnected ? 'connected' : 'disconnected',
      db: dbConnected ? 'connected' : 'error',
    }));
    return;
  }

  if (url === '/metrics') {
    const metrics = getAiMetrics();
    const avgTime = metrics.responseTimes.length
      ? Math.round(metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length)
      : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalCalls: metrics.calls,
      totalErrors: metrics.errors,
      avgResponseTimeMs: avgTime,
      promptTokens: metrics.promptTokens || 0,
      completionTokens: metrics.completionTokens || 0,
      byModel: metrics.byModel,
    }));
    return;
  }

  const { waConnected, dbConnected } = await readiness();

  const isOk = waConnected && dbConnected;
  res.writeHead(isOk ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: isOk ? 'ok' : 'degraded',
    wa: waConnected ? 'connected' : 'disconnected',
    db: dbConnected ? 'connected' : 'error',
    dbAvailable: isDbAvailable(),
    uptime: os.uptime(),
    botUptime: Math.floor((Date.now() - botStartedAt) / 1000),
    aiMode: settings.aiMode,
    jawabDuluan: settings.jawabDuluan,
    blockedUsers: blockedUsers.size,
  }));
});

const PORT = config.port;
healthApp.on('error', (err) => {
  logger.error('Health', `Failed to start on ${PORT}:`, err.message);
  process.exit(1);
});
healthApp.listen(PORT, config.host, () => {
  logger.info('Health', `HTTP server on ${config.host}:${PORT}`);
  // Kontrak PM2 wait_ready — tanpa ini PM2 menunggu listen_timeout penuh
  // (2 mnt) di setiap restart sebelum menandai online.
  if (typeof process.send === 'function') {
    try { process.send('ready'); } catch {}
  }
});

// ─── Check Orders ─────────────────────────────────────────────────────

async function checkOrders(msg, username) {
  try {
    const clean = username.trim();
    const resp = await fetch(`${config.apiBase}/api/transactions/user/${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      logger.warn('CekOrder', `HTTP ${resp.status} for ${clean}`);
      return false;
    }
    const result = await resp.json();
    let txs = result?.data?.transactions ?? result?.transactions ?? [];
    if ((!Array.isArray(txs) || !txs.length) && clean.length >= 3) {
      const sResp = await fetch(`${config.apiBase}/api/transactions/search/${encodeURIComponent(clean)}`, {
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      if (sResp?.ok) {
        const sResult = await sResp.json().catch(() => null);
        txs = sResult?.data?.transactions ?? sResult?.transactions ?? [];
      }
    }
    if (!Array.isArray(txs) || !txs.length) {
      await msg.reply(`Belum ketemu order atas nama *${clean}* kak. Boleh kirim ID order-nya (NDXSTORE/...) biar aku cek ulang?`);
      return true;
    }
    let reply = `Order ${clean}\n━━━━━━━━━━━━━━\n`;
    for (const o of txs.slice(0, 5)) {
      const prod = o.productName || o.product_name || '-';
      const price = o.priceIdr ?? o.price_idr;
      const status = o.orderStatus || o.order_status || o.paymentStatus || o.payment_status || '-';
      const time = o.createdAt || o.created_at;
      reply += `\nID: ${o.id}\nProduk: ${prod}\nHarga: ${formatPrice(price)}\nStatus: ${status}\nWaktu: ${formatTime(time)}\n━━━━━━━━━━━━━━`;
    }
    await msg.reply(reply);
    return true;
  } catch (e) {
    // Jangan kirim "Gagal cek order" ke user — caller lempar ke AI.
    logger.error('CekOrder', e.message);
    return false;
  }
}

// ─── Auto-resolve cek (tanpa AI, hemat kuota) ────────────────────────────
// Dipanggil saat AI mode AKTIF dan user ketik "cek [username]" atau
// "cek [NDXSTORE/... / TX-/NDX-xxxx]". Jawaban diformat langsung dari API NDXStore —
// nol API call ke AI. Return true = sudah ditangani, skip AI.
async function autoResolveCek(msg, query) {
  const q = (query || '').trim();
  if (!q) return false;
  try {
    const idMatch = q.match(/^(?:(?:TX|TXN|NDX)-[A-Z0-9]+|NDXSTORE\/[A-Z0-9_-]+(?:\/[A-Z0-9_-]+){1,6})$/i);
    if (idMatch) {
      const orderId = idMatch[0].toUpperCase();
      const resp = await fetch(`${config.apiBase}/api/transaction/${encodeURIComponent(orderId)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status === 404) {
        await msg.reply(`Order *${orderId}* belum ketemu kak. Boleh dicek lagi ID-nya ya.`);
        return true;
      }
      if (!resp.ok) return false;
      const data = await resp.json();
      const t = data?.data?.transaction ?? data?.transaction;
      if (!t) {
        await msg.reply(`Order *${orderId}* belum ketemu kak. Boleh dicek lagi ID-nya ya.`);
        return true;
      }
      const status = t.orderStatus || t.order_status || t.paymentStatus || t.payment_status || '-';
      await msg.reply(
        `Order ${t.id}\n━━━━━━━━━━━━━━\n` +
        `Produk: ${t.productName || t.product_name || '-'}\n` +
        `Harga: ${formatPrice(t.priceIdr ?? t.price_idr)}\n` +
        `Status: ${status}\n` +
        `Waktu: ${formatTime(t.createdAt || t.created_at)}`
      );
      return true;
    }
    return await checkOrders(msg, q);
  } catch (e) {
    // API gagal → return false supaya AI yang jawab (tanpa pesan error).
    logger.error('AutoCek', e.message?.slice(0, 120));
    return false;
  }
}

// ─── Welcome Message ──────────────────────────────────────────────────

async function sendWelcomeIfNew(client, msg) {
  const jid = msg.from;
  if (jid.includes('@g.us')) return;
  if (WELCOMED_USERS.has(jid)) return;
  WELCOMED_USERS.set(jid, Date.now());
  await msg.reply(
    `Halo!\n\nSelamat datang di *NDXStore* — tempat top up game & Roblox!\n\nKetik *Menu* untuk lihat pilihan.`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  logger.printBanner();
  logger.info('Bot', '=== WA Bot NDXStore ===');
  logger.info('Bot', `Supabase: ${config.supabase.key ? '✓' : '✗'}`);
  logger.info('Bot', `Group ID: ${config.groupId || '(not set)'}`);
  logger.info('Bot', `Admin: ${config.adminNumber || '(not set)'}`);
  logger.info('Bot', `Groq: ${config.groqKey ? '✓' : '✗'}`);
  logger.info('Bot', `OpenRouter: ${config.openrouterKey ? '✓' : '✗'}`);
  logger.info('Bot', `Gemini: ${config.geminiKey ? '✓' : '✗'}`);
  logger.info('Bot', config.pairingNumber ? `Login: pairing code (${config.pairingNumber})` : 'Login: scan QR');

  const heartbeatMs = parseInt(process.env.LOG_HEARTBEAT_MS || '300000', 10);
  if (heartbeatMs > 0) logger.startHeartbeat(heartbeatMs);

  // Startup validation (F4)
  const adminNum = config.adminNumber.replace(/[^0-9]/g, '');
  if (!adminNum.startsWith('62') || adminNum.length < 10) {
    logger.warn('Bot', 'ADMIN_NUMBER format invalid — harus 62xxx tanpa +');
  }
  if (config.groqKey && !config.groqKey.startsWith('gsk_')) {
    logger.warn('Bot', 'GROQ_API_KEY seharusnya dimulai dengan gsk_');
  }
  if (config.openrouterKey && !config.openrouterKey.startsWith('sk-or-')) {
    logger.warn('Bot', 'OPENROUTER_API_KEY seharusnya dimulai dengan sk-or-');
  }

  // Startup self-check — validasi kredensial eksternal (non-blocking).
  // Tanpa ini, key invalid = fitur mati diam-diam dan baru ketahuan hari kemudian.
  (async () => {
    try {
      if (config.groqKey?.startsWith('gsk_')) {
        const r = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${config.groqKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r.status === 401) {
          logger.warn('SelfCheck', (config.openrouterKey || config.geminiKey)
            ? 'GROQ_API_KEY ditolak (401) — beralih ke fallback OpenRouter / Gemini.'
            : 'GROQ_API_KEY DITOLAK (401) — tier Groq + Whisper NONAKTIF. Ganti key di .env.');
        } else if (!r.ok) logger.warn('SelfCheck', `Groq check: HTTP ${r.status}`);
        else logger.info('SelfCheck', 'Groq key OK.');
      } else {
        logger.warn('SelfCheck', 'GROQ_API_KEY kosong — tier Groq + Whisper nonaktif.');
      }
    } catch (e) { logger.warn('SelfCheck', `Groq check gagal: ${e.message?.slice(0, 80)}`); }
    try {
      if (config.openrouterKey?.startsWith('sk-or-')) {
        const r = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { Authorization: `Bearer ${config.openrouterKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (r.status === 401) logger.error('SelfCheck', 'OPENROUTER_API_KEY DITOLAK (401) — cek kembali key di .env.');
        else if (!r.ok) logger.warn('SelfCheck', `OpenRouter check: HTTP ${r.status}`);
        else logger.info('SelfCheck', `OpenRouter key OK (${config.openrouterModel}).`);
      }
    } catch (e) { logger.warn('SelfCheck', `OpenRouter check gagal: ${e.message?.slice(0, 80)}`); }
    try {
      if (config.geminiKey) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.geminiKey)}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (r.status === 401 || r.status === 403) logger.error('SelfCheck', 'GEMINI_API_KEY DITOLAK — cek kembali key di .env.');
        else if (!r.ok) logger.warn('SelfCheck', `Gemini check: HTTP ${r.status}`);
        else logger.info('SelfCheck', `Gemini key OK (${config.geminiModel}).`);
      }
    } catch (e) { logger.warn('SelfCheck', `Gemini check gagal: ${e.message?.slice(0, 80)}`); }
    try {
      if (config.botToken) {
        const r = await fetch(`${config.apiBase}/api/admin/stats`, {
          headers: { 'x-bot-token': config.botToken },
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) logger.info('SelfCheck', 'NDX_BOT_TOKEN OK — panel Toko aktif.');
        else if (r.status === 401) logger.error('SelfCheck', 'NDX_BOT_TOKEN DITOLAK (401) — samakan dengan BOT_API_TOKEN di Vercel + redeploy.');
        else if (r.status === 500) logger.error('SelfCheck', 'BOT_API_TOKEN belum dipasang di server Vercel — panel Toko memakai fallback Supabase.');
        else logger.warn('SelfCheck', `Admin API check: HTTP ${r.status}`);
      } else {
        logger.info('SelfCheck', 'NDX_BOT_TOKEN kosong — panel Toko memakai fallback Supabase langsung.');
      }
    } catch (e) { logger.warn('SelfCheck', `Admin API check gagal: ${e.message?.slice(0, 80)}`); }
  })().catch(() => {});

  // Start background services immediately (non-blocking)
  startLiveDataRefresh();
  startMenuRefresh();
  startHistoryCleanup();

  // Parallel init: browser detection + DB calls
  const [browserPath] = await Promise.all([
    detectBrowser().catch(() => null),
    loadSettings(),
    loadBlockedUsers(),
    initHandover(),
  ]);

  if (browserPath) {
    logger.info('Bot', `Browser: ${browserPath}`);
  } else {
    logger.warn('Bot', 'Browser tidak ditemukan - pastikan chromium terinstall');
  }

  logger.info('Bot', `AI mode: ${['off', 'Bima', 'NDXStore'][settings.aiMode] || 'unknown'}`);

  // Dashboard localhost — inject akses blocklist + kirim pesan WA.
  initDashboard({
    getBlocked: () => [...blockedUsers],
    setBlocked: (jid, on) => { if (on) blockedUsers.add(jid); else blockedUsers.delete(jid); },
    saveBlocked: () => saveBlockedUsers(),
    sendWaMessage: (jid, text) => {
      const cl = getCurrentClient();
      if (!cl?.info?.wid) throw new Error('WhatsApp belum terhubung');
      return cl.sendMessage(jid, text);
    },
  });
  logger.info('Bot', `Panel admin: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${PORT}/admin`);
  startInstagramService().catch(e => logger.error('IG', e.message));

  setOnMaxReconnect(() => shutdown('MaxReconnect'));

  function setupMessageHandler(c) {
    c.removeAllListeners('message_create');

    c.on('message_create', async (msg) => {
      try {
        let body = msg.body?.trim() || '';
        const senderJid = msg.author || msg.from || '';
        const isAdmin = senderJid.split('@')[0].replace(/^\+/, '').trim() === ADMIN_RAW;
        logger.debug('Msg', `${senderJid.replace(/@.*/, '')} | "${body.slice(0, 40)}"`);

        // ── Block / Unblock ──
        if ((body === '!block' || body === '!unblock') && isAdmin) {
          const isBlock = body === '!block';
          let target = null;
          if (msg.hasQuotedMsg) {
            try {
              const quoted = await msg.getQuotedMessage();
              target = quoted?.author || quoted?.from || null;
            } catch (e) { logger.debug('Bot', 'getQuotedMessage failed:', e.message); }
          }
          if (!target && msg.mentionedIds?.length) {
            target = msg.mentionedIds[0];
          }
          if (!target) {
            await msg.reply(`Reply pesan user yang mau di-${isBlock ? 'block' : 'unblock'}, atau mention user-nya.`);
            return;
          }
          if (isBlock) blockedUsers.add(target);
          else blockedUsers.delete(target);
          await saveBlockedUsers();
          await msg.reply(`User ${isBlock ? 'diblokir' : 'di-unblock'}: ${target}`);
          return;
        }

        // ── Blocked Users ──
        if (!isAdmin && blockedUsers.has(senderJid)) return;

        // ── Admin → user relay (handover CS) ──
        // Konfigurasi bot HANYA via panel localhost (/admin), bukan via chat.
        if ((isAdmin || msg.fromMe) && msg.hasQuotedMsg) {
          try {
            const forwarded = await handleAdminReply(c, msg);
            if (forwarded) {
              await msg.reply('Balasan terkirim ke user.');
              return;
            }
          } catch (e) {
            logger.error('AdminReply', 'Gagal reply:', e.message);
            await msg.reply('Gagal mengirim balasan. Coba lagi.');
            return;
          }
        }

        // ── Welcome new users (DM only, only when AI is off) ──
        if (!msg.fromMe && !msg.from?.includes('@g.us') && !WELCOMED_USERS.has(senderJid) && !settings.aiMode) {
          await sendWelcomeIfNew(c, msg);
          return;
        }

        // ── Core Menu ──
        const lower = body.toLowerCase();

        // When AI mode is on, skip menu/CS commands → everything goes to AI
        if (settings.aiMode <= 0) {
          if (lower === 'menu' || lower === '0' || body === 'Menu') {
            await msg.reply(getMenuText());
            return;
          }

          if (lower.startsWith('cek ') || body === '1') {
            if (lower.startsWith('cek ')) {
              const username = body.slice(4).trim();
              if (username) {
                const ok = await checkOrders(msg, username);
                if (!ok) {
                  await msg.reply(`Siap kak, order *${username}* aku cek dulu ya. Nanti dikabari 🙏`);
                  if (ADMIN_JID) c.sendMessage(ADMIN_JID, `[Auto] API cek order gagal.\nUser: ${msg.from}\nUsername: ${username}\nTolong follow up manual.`).catch(() => {});
                }
                return;
              }
            }
            await msg.reply('Ketik *Cek [username]* buat cek status order.\nContoh: *Cek ROWSOWS*');
            return;
          }

          if (body === '2') { await msg.reply(getInfoProduk()); return; }
          if (body === '3') { await msg.reply(getCaraOrder()); return; }
          if (body === '5') { await msg.reply(getInfoPembayaran()); return; }
          if (body === '6') { await msg.reply('Terima kasih telah menghubungi *NDXStore*! Ketik *Menu* kapan saja jika butuh bantuan.'); return; }
        }

        const isGroup = msg.from?.includes('@g.us') ?? false;

        // ── CS Handover start — berlaku di SEMUA mode AI (khusus DM / chat pribadi) ──
        // "4"/"cs" tidak boleh jatuh ke AI: filter gibberish menelannya
        // (1 karakter → SKIP/null → bot diam) sehingga jalur CS resmi mati.
        if (!isGroup && !msg.fromMe && ADMIN_JID && (body === '4' || lower === 'cs')) {
          cancelBuffer(senderJid);
          cancelBuffer(msg.from);
          await startHandover(c, msg, ADMIN_JID);
          return;
        }

        // Active CS session works regardless of AI mode (DM only)
        if (!isGroup && !msg.fromMe && isHandoverActive(msg.from) && ADMIN_JID) {
          cancelBuffer(senderJid);
          cancelBuffer(msg.from);
          if (lower === 'selesai' || lower === 'stop') {
            endHandover(msg.from);
            await msg.reply('Sesi CS selesai. Ketik *Menu* untuk kembali.');
            await c.sendMessage(ADMIN_JID, `Sesi CS selesai\nUser: ${msg.from}`);
            return;
          }
          try {
            await forwardToAdmin(c, msg.from, body, ADMIN_JID, msg);
            await msg.reply('Pesan diteruskan ke admin.');
          } catch (e) {
            // Jangan kirim pesan error ke user — coba ulang sekali diam-diam.
            logger.error('Forward', 'Gagal forward ke admin:', e.message);
            setTimeout(() => {
              forwardToAdmin(c, msg.from, body, ADMIN_JID, msg).catch(err => logger.error('Forward', 'Retry gagal:', err.message));
            }, 3000);
          }
          return;
        }

        // ── Group / self filters ──
        const aiOn = settings.aiMode > 0;

        if (msg.fromMe) return;

        // Track burst per-group (E5)
        if (isGroup) {
          const now = Date.now();
          let burst = burstCounts.get(msg.from) || { count: 0, ts: now };
          if (now - burst.ts > 10000) { burst.count = 0; burst.ts = now; }
          burst.count++;
          // Skip if >5 msgs in 10 sec window (per-group)
          if (burst.count > 5) return;
          burstCounts.set(msg.from, burst);
        }

        if (!aiOn) {
          if (isGroup) return;
          // When AI is off in DM, let menu/CS flow handle it (already processed above)
          return;
        }

        // ── Group & Quoted message inspection ──
        let isGroupDirect = false;
        let quotedContext = '';
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            if (isGroup && quoted?.fromMe === true) {
              isGroupDirect = true;
            }
            const qBody = quoted?.body?.trim();
            if (qBody) {
              quotedContext = `[Membalas pesan: "${qBody.replace(/\s+/g, ' ').slice(0, 120)}"] `;
            }
          } catch (e) { logger.debug('Bot', 'getQuotedMessage failed:', e.message); }
        }

        if (isGroup) {
          const botUser = c.info?.wid?.user;
          const mentioned = botUser ? msg.mentionedIds?.some(id => id.includes(botUser)) : false;
          if (mentioned) isGroupDirect = true;
          if (!isGroupDirect && settings.ungroup) {
            return;
          }
        }

        const historyJid = isGroup ? msg.from : senderJid;
        const bufferKey = isGroup ? `${msg.from}:${senderJid}` : historyJid;
        const senderName = isGroup ? senderJid.split('@')[0] : null;

        // ── Auto-resolve: "cek [username/id]" dijawab langsung dari API ──
        // (nol API call ke AI). Batalkan buffer sapaan sebelumnya agar tidak
        // mengirim balasan ganda setelah hasil cek dikirim.
        const cekArg = body.match(/^cek\s+(.+)$/i)?.[1]?.trim();
        if (cekArg && (!isGroup || isGroupDirect || !settings.ungroup)) {
          cancelBuffer(bufferKey);
          cancelBuffer(historyJid);
          if (await autoResolveCek(msg, cekArg)) return;
          // API gagal → lanjut ke AI (jawab natural, tanpa pesan error)
        }

        // ── Media handling (Hold buffer open while downloading/transcribing) ──
        let mediaImage = null;
        let mediaHandled = false;

        if (msg.hasMedia) {
          holdBufferForMedia(bufferKey, { isGroup });
        }
        try {
          // View-once (gambar/video sekali lihat): unduh TEPAT SEKALI (akses
          // hangus setelah dibuka), simpan ke ./downloads, teruskan ke AI.
          if (msg.hasMedia && isViewOnceMessage(msg) && msg.type !== 'sticker') {
            mediaHandled = true;
            const voMedia = await msg.downloadMedia().catch(() => null);
            if (voMedia?.data) {
              const savedPath = await saveViewOnceMedia(voMedia, senderJid);
              logger.info('ViewOnce', `Downloaded ${voMedia.mimetype} from ${senderJid}${savedPath ? ` → ${savedPath}` : ''}`);
              const mime = voMedia.mimetype || '';
              const caption = body ? ` ${body}` : '';
              if (mime.startsWith('image/')) {
                mediaImage = { data: voMedia.data, mime };
                body = `[Gambar sekali lihat]${caption}`;
              } else if (mime.startsWith('video/')) {
                const vtext = await transcribeAudio(voMedia.data, mime);
                body = vtext
                  ? `[Video sekali lihat]${caption}\n\n[Transkripsi: ${vtext}]`
                  : `[Video sekali lihat]${caption}\n\n(Tidak ada audio/transkripsi)`;
              } else {
                body = `[File sekali lihat: ${mime || 'unknown'}]${caption}`;
              }
            } else {
              body = body || '[Media sekali lihat sudah dibuka / tidak bisa diunduh]';
              logger.warn('ViewOnce', `Download failed (sudah dibuka?) from ${senderJid}`);
            }
          }

          if (msg.hasMedia && msg.type !== 'sticker' && !mediaHandled) {
            if (msg.type === 'ptt' || msg.type === 'audio') {
              // Voice note / audio → mark seen (sedang mendengarkan) lalu transcribe
              // tanpa mengirim chat "dengerin..." terpisah agar tidak balas 2x.
              c.getChatById(msg.from).then(ch => ch.sendSeen().catch(() => {})).catch(() => {});
              const audio = await msg.downloadMedia().catch(() => null);
              if (audio?.data) {
                const text = await transcribeAudio(audio.data, audio.mimetype);
                if (text) {
                  body = body ? `${body}\n\n[Pesan suara: ${text}]` : text;
                }
              }
            } else if (msg.type === 'video') {
              const video = await msg.downloadMedia().catch(() => null);
              if (video?.data) {
                const text = await transcribeAudio(video.data, video.mimetype);
                if (text) {
                  body = body ? `${body}\n\n[Transkripsi video: ${text}]` : `[Transkripsi video: ${text}]`;
                } else {
                  body = body ? `${body}\n\n[User mengirim video]` : '[User mengirim video]';
                }
              }
            } else if (msg.type === 'document') {
              const doc = await msg.downloadMedia().catch(() => null);
              if (doc) {
                const docName = doc.filename || 'file';
                body = body ? `${body}\n\n[User mengirim file: ${docName}]` : `[User mengirim file: ${docName}]`;
              }
            }
          }

          // Sticker & image → prepare for vision AI
          // (skip kalau view-once sudah diunduh di atas — unduhan kedua pasti gagal)
          if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker') && !mediaHandled) {
            const media = await msg.downloadMedia().catch(() => null);
            if (media) mediaImage = { data: media.data, mime: media.mimetype };
          }
        } finally {
          if (msg.hasMedia) {
            releaseBufferForMedia(bufferKey);
          }
        }

        if (!body && !mediaImage) return;

        // ── !ulang — re-ask AI with last user message (B5) ──
        if (body === '!ulang' || body === '!ulangi') {
          const last = lastUserMessage.get(senderJid);
          if (last?.body) {
            body = last.body;
            lastUserMessage.delete(senderJid);
          } else {
            return;
          }
        } else if (body && !msg.hasMedia) {
          lastUserMessage.set(senderJid, { body, ts: Date.now() });
        }

        if (quotedContext && body) {
          body = `${quotedContext}${body}`;
        }

        // ── Reply helper (Realistic Human: Baca Semua Dulu → Mengetik → Kirim 1x) ──
        // Kontrak flush aiBuffer: flushFn(jid, text, image, latestMsg, meta).
        const doReply = async (_bufKey, text, img, latestMsg, meta) => {
          const isCancelled = () => Boolean(meta?.isCancelled?.());
          const signal = meta?.signal || null;
          if (isCancelled()) return;

          // Daily Limit dicek per 1 giliran percakapan utuh (bukan per bubble pecahan)
          if (!isGroup && !isAdmin) {
            const limit = await checkDailyLimit(msg.from);
            if (isCancelled()) return;
            if (!limit.allowed) {
              // Jangan pernah kirim "batas harian habis" ke user — diam saja.
              logger.info('Limit', `Daily limit reached for ${msg.from} — reply skipped silently`);
              return;
            }
          }

          const sendTargetJid = latestMsg?.from || historyJid;
          const sendText = (t) => latestMsg
            ? latestMsg.reply(t)
            : c.sendMessage(sendTargetJid, t);
          const msgForAI = isGroup
            ? `Di grup, ${senderName || 'seseorang'} bilang:\n${text}`
            : text;

          // 1. TAHAP BACA: Tampilkan online, jeda baca natural sesuai panjang semua
          //    bubble yang masuk, lalu tandai centang biru (sendSeen).
          c.sendPresenceAvailable().catch(() => {});
          const wordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
          const readDelayMs = isGroup
            ? Math.min(300 + wordCount * 25, 900)
            : Math.min(650 + wordCount * 45, 2000);
          await new Promise(r => setTimeout(r, readDelayMs));
          if (isCancelled()) return;

          const chat = await c.getChatById(sendTargetJid).catch(() => null);
          if (chat) {
            await chat.sendSeen().catch(() => {});
          }
          if (isCancelled()) return;

          // 2. TAHAP MIKIR & MENGETIK: Nyalakan indikator "sedang mengetik..."
          //    sambil memproses seluruh penggalan chat di AI.
          let typingTimer = null;
          if (chat) {
            chat.sendStateTyping().catch(() => {});
            typingTimer = setInterval(() => {
              if (!isCancelled()) chat.sendStateTyping().catch(() => {});
            }, 4000);
            if (typingTimer.unref) typingTimer.unref();
          }

          let reply = null;
          const aiStart = Date.now();
          try {
            reply = img
              ? await askAIWithImage(historyJid, msgForAI, img.data, img.mime, settings.aiMode, senderName, isGroup, signal)
              : await askAI(historyJid, msgForAI, settings.aiMode, senderName, isGroup, signal);
          } finally {
            if (typingTimer) clearInterval(typingTimer);
          }

          // Jika saat AI berpikir user mengirim bubble tambahan, batalkan pengiriman
          // agar digabung ke batch berikutnya!
          if (isCancelled() || !reply || /^SKIP\b/.test(reply)) {
            if (chat) chat.clearState().catch(() => {});
            return;
          }

          const stickerMatch = reply.match(/^\[STICKER:(.+?)\]\s*/);
          const textToReply = stickerMatch ? reply.slice(stickerMatch[0].length).trim() : reply;

          // 3. TAHAP DURASI MENGETIK REALISTIS: Sesuaikan durasi mengetik dengan
          //    panjang balasan (dikurangi waktu yang sudah terpakai saat tunggu AI).
          const aiElapsed = Date.now() - aiStart;
          const targetTypingMs = isGroup
            ? Math.min(400 + textToReply.length * 18, 1600)
            : Math.min(Math.max(textToReply.length * 28, 1100), 3600);
          const remainingTypingMs = Math.max(250, targetTypingMs - aiElapsed);
          await new Promise(r => setTimeout(r, remainingTypingMs));

          // Cek sekali lagi tepat sebelum kirim: kalau user baru saja kirim chat
          // susulan saat bot sedang mengetik, jangan kirim balasan parsial ini!
          if (isCancelled()) {
            if (chat) chat.clearState().catch(() => {});
            return;
          }

          if (chat) chat.clearState().catch(() => {});

          if (textToReply) {
            await sendText(textToReply).catch(e => throttleLog('warn', 'Bot', 'reply-fail', `AI reply failed: ${e.message?.slice(0, 80)}`, 10000));
          }
          if (stickerMatch && !isCancelled()) {
            const desc = stickerMatch[1].trim();
            if (desc.split(/\s+/).length < 2) return;
            const encoded = encodeURIComponent(desc.slice(0, 200));
            fetch(`https://image.pollinations.ai/prompt/${encoded}?width=512&height=512&nofeed=true`)
              .then(r => r.arrayBuffer())
              .then(buf => {
                if (isCancelled()) return;
                const base64 = Buffer.from(buf).toString('base64');
                const media = new MessageMedia('image/png', base64);
                return c.sendMessage(sendTargetJid, media, { sendMediaAsSticker: true });
              })
              .catch(() => {
                // Gagal bikin stiker → diam saja, jangan kirim pesan error.
              });
          }
        };

        // Semua chat (baik DM maupun mention/reply di grup) masuk ke buffer
        // agar bot membaca semua penggalan chat dulu sebelum mengirim 1 balasan utuh.
        bufferAiMessage(bufferKey, msg, body, mediaImage, doReply, { isGroup });
        return;

      } catch (e) {
        const errMsg = e?.message || String(e);
        logger.error('Bot', 'Handler error:', errMsg.slice(0, 200));
        if (errMsg.includes('window.require') || errMsg.includes('require') || errMsg.includes('evaluation')) {
          logger.warn('Bot', 'Page injection failed — kemungkinan Chromium versi baru. Coba restart bot.');
          logger.error('Bot', 'Stack:', (e?.stack || errMsg).slice(0, 300));
        }
      }
    });
  }

  // Flush default untuk buffer yang dipulihkan dari disk saat ready.
  // Kontrak: (jid, text, image, latestMsg, meta) — kirim langsung via client.
  setDefaultFlushFn((jid, text, img, _latestMsg, meta) => {
    const cl = getCurrentClient();
    if (!cl || (!text?.trim() && !img)) return Promise.resolve();
    const targetJid = jid?.includes('@g.us:') ? `${jid.split('@g.us:')[0]}@g.us` : jid;
    const grp = targetJid?.includes('@g.us') ?? false;
    const signal = meta?.signal || null;
    const run = img
      ? askAIWithImage(targetJid, text, img.data, img.mime, settings.aiMode, null, grp, signal)
      : askAI(targetJid, text, settings.aiMode, null, grp, signal);
    return run.then((r) => {
      if (meta?.isCancelled?.()) return;
      if (r && !/^SKIP\b/.test(r)) {
        const cleaned = r.replace(/^\[STICKER:.+?\]\s*/, '').trim();
        if (cleaned) return cl.sendMessage(targetJid, cleaned).catch(() => {});
      }
    }).catch(() => {});
  });

  waClient = await createClient(setupMessageHandler);
  setupMessageHandler(waClient);

  setOnReady(async () => {
    try {
      logger.info('Bot', 'Client ready — bot online!');
      flushPendingBuffers();
      const client = getCurrentClient();
      if (client) {
        const monitor = await startOrderMonitor(client, settings);
        if (monitor) orderMonitorCleanup = monitor;
      }
    } catch (e) {
      logger.error('Bot', 'Ready handler error:', e.message);
    }
  });

  initWithRetry(waClient).catch(e => {
    logger.error('WA', 'All init attempts failed:', e.message);
    process.exit(1);
  });

  const monitorTimer = startConnectionMonitor(60000);
  monitorTimer.unref();

  async function shutdown(signal) {
    logger.info('Bot', `Received ${signal}, shutting down...`);
    await savePendingBuffers().catch(() => {});
    if (orderMonitorCleanup) {
      await orderMonitorCleanup.flush().catch(() => {});
      orderMonitorCleanup.unsubscribe();
    }
    await flushSettings().catch(() => {});
    const client = getCurrentClient();
    if (client) await client.destroy().catch(() => {});
    healthApp.close(() => {});
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT').catch(e => logger.error('Shutdown', e.message)));
  process.on('SIGTERM', () => shutdown('SIGTERM').catch(e => logger.error('Shutdown', e.message)));
  process.setMaxListeners(50);
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught', err.message);
    logger.error('Uncaught', err.stack?.slice(0, 500));
    shutdown('Uncaught').catch(e => logger.error('Shutdown', e.message));
  });
  // Not fatal — most unhandled rejections are harmless fire-and-forget promises.
  // Log with details so we can trace it if something important fails.
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error
      ? `${reason.message}\n${reason.stack?.slice(0, 500)}`
      : String(reason).slice(0, 600);
    logger.warn('unhandledRejection', detail);
  });

  logger.info('Bot', 'Starting WhatsApp client...');
}

main().catch((err) => {
  logger.error('FATAL', err.stack || err.message);
  process.exit(1);
});
