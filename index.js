import http from 'http';
import os from 'os';
import { config } from './config.js';
import { createClient, getCurrentClient, getLatestQr, detectBrowser } from './client.js';
import { startOrderMonitor } from './services/orderMonitor.js';
import { getMenuText, getInfoProduk, getCaraOrder, getInfoPembayaran, startMenuRefresh } from './services/menu.js';
import { isHandoverActive, endHandover, startHandover, handleAdminReply, forwardToAdmin, initHandover } from './services/handoverService.js';
import { checkDailyLimit } from './services/queue.js';
import { handleAdminCommand } from './services/admin.js';
import { askAI, askAIWithImage, clearHistory, clearHistoryExcept, startHistoryCleanup, detectGreeting } from './services/ai.js';
import { bufferAiMessage } from './services/aiBuffer.js';
import { settings, loadSettings, saveSettings, flushSettings } from './services/settings.js';
import { getDb } from './services/supabase.js';
import { formatPrice, formatTime, formatWaNumber } from './utils/format.js';
import { logger } from './utils/logger.js';


const WELCOMED_USERS = new Set();
const blockedUsers = new Set();
let waClient = null;
let orderMonitorCleanup = null;

async function loadBlockedUsers() {
  try {
    const db = getDb();
    if (!db) return;
    const { data } = await db.from('wa_bot_config').select('value').eq('key', 'blocked_users').single();
    if (data?.value && Array.isArray(data.value)) {
      data.value.forEach(jid => blockedUsers.add(jid));
      logger.info('Blocklist', `Loaded ${blockedUsers.size} blocked users`);
    }
  } catch (e) {
    if (!e.message?.includes('relation') && !e.message?.includes('does not exist') && !e.message?.includes('PGRST116')) {
      logger.error('Blocklist', 'Load error:', e.message);
    }
  }
}

async function saveBlockedUsers() {
  const db = getDb();
  if (!db) return;
  try {
    await db.from('wa_bot_config').upsert({
      key: 'blocked_users',
      value: [...blockedUsers],
    }, { onConflict: 'key' });
  } catch (e) {
    if (!e.message?.includes('relation') && !e.message?.includes('does not exist')) {
      logger.error('Blocklist', 'Save error:', e.message);
    }
  }
}
let botStartedAt = Date.now();
const ADMIN_RAW = config.adminNumber.replace(/^\+/, '').trim();

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

  // First-run login on a headless host — scan the pending QR from a browser.
  if (url === '/qr') {
    const qr = getLatestQr();
    const connected = getCurrentClient()?.info?.wid?.user ? true : false;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (connected) {
      res.end('<h2>✅ WhatsApp sudah terhubung.</h2>');
    } else if (qr) {
      const img = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(qr)}`;
      res.end(`<html><body style="text-align:center;font-family:sans-serif"><h2>Scan di WhatsApp → Perangkat Tertaut</h2><img src="${img}" alt="QR"><p>Auto-refresh 20 detik.</p><script>setTimeout(()=>location.reload(),20000)</script></body></html>`);
    } else {
      res.end('<h2>⏳ QR belum siap, tunggu &amp; refresh…</h2><script>setTimeout(()=>location.reload(),5000)</script>');
    }
    return;
  }

  // Readiness + detailed status (default path and /ready).
  const waConnected = getCurrentClient()?.info?.wid?.user ? true : false;
  let dbConnected = false;
  try {
    const db = getDb();
    if (db) {
      const { error } = await db.from('wa_bot_config').select('key').limit(1);
      dbConnected = !error;
    }
  } catch {}

  const isOk = waConnected && dbConnected;
  res.writeHead(isOk ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: isOk ? 'ok' : 'degraded',
    wa: waConnected ? 'connected' : 'disconnected',
    db: dbConnected ? 'connected' : 'error',
    uptime: os.uptime(),
    botUptime: Math.floor((Date.now() - botStartedAt) / 1000),
    aiMode: settings.aiMode,
    jawabDuluan: settings.jawabDuluan,
    blockedUsers: blockedUsers.size,
  }));
});

const PORT = Number(process.env.PORT) || 3000;
healthApp.on('error', (err) => {
  logger.error('Health', `Failed to start on ${PORT}:`, err.message);
  process.exit(1);
});
healthApp.listen(PORT, () => {
  logger.info('Health', `HTTP server on port ${PORT}`);
});

// ─── Check Orders ─────────────────────────────────────────────────────

async function checkOrders(msg, username) {
  try {
    const resp = await fetch(`${config.apiBase}/api/transactions/user/${encodeURIComponent(username.trim())}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return await msg.reply('❌ Gagal cek order.');
    const result = await resp.json();
    if (!result?.success || !result?.transactions?.length) {
      return await msg.reply(`Tidak ada order untuk *${username}*.`);
    }
    let reply = `📋 *Order ${username}*\n━━━━━━━━━━━━━━\n`;
    for (const o of result.transactions.slice(0, 5)) {
      const prod = o.productName || o.product_name || '-';
      const price = o.priceIdr ?? o.price_idr;
      const status = o.orderStatus || o.order_status || o.paymentStatus || o.payment_status || '-';
      const time = o.createdAt || o.created_at;
      reply += `\n🆔 ${o.id}\n📦 ${prod}\n💰 ${formatPrice(price)}\n📊 ${status}\n⏰ ${formatTime(time)}\n━━━━━━━━━━━━━━`;
    }
    await msg.reply(reply);
  } catch (e) {
    await msg.reply('❌ Error cek order.');
    logger.error('CekOrder', e.message);
  }
}

// ─── Chat History ──────────────────────────────────────────────────────

async function getChatHistory(limit = 20) {
  try {
    const db = getDb();
    if (!db) return [];
    const { data } = await db
      .from('wa_chat_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 50));
    return data || [];
  } catch { return []; }
}

// ─── Welcome Message ──────────────────────────────────────────────────

async function sendWelcomeIfNew(client, msg) {
  const jid = msg.from;
  if (jid.includes('@g.us')) return;
  if (WELCOMED_USERS.has(jid)) return;
  WELCOMED_USERS.add(jid);
  await msg.reply(
    `Halo! 👋\n\nSelamat datang di *NDXStore* — tempat top up game & Roblox!\n\nKetik *Menu* untuk lihat pilihan.`
  );
}

// ─── AI Mode Parsing ──────────────────────────────────────────────────

function parseAiMode(body) {
  const lower = body.toLowerCase().replace(/\s+/g, ' ').trim();
  if (lower === '!aimode 0' || lower === '!aimode off' || lower === '!aimode0' || lower === '!aimodeoff') return 0;
  if (lower === '!aimode 1' || lower === '!aimode1' || lower === '!aimode on') return 1;
  if (lower === '!aimode 2' || lower === '!aimode2') return 2;
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Bot', '=== WA Bot NDXStore ===');
  logger.info('Bot', `Supabase: ${config.supabase.key ? '✓' : '✗'}`);
  logger.info('Bot', `Group ID: ${config.groupId || '(not set)'}`);
  logger.info('Bot', `Admin: ${config.adminNumber || '(not set)'}`);
  logger.info('Bot', `Groq: ${config.groqKey ? '✓' : '✗'}`);

  const browserPath = await detectBrowser().catch(() => null);
  if (browserPath) {
    logger.info('Bot', `Browser: ${browserPath}`);
  } else {
    logger.warn('Bot', 'Browser tidak ditemukan — pastikan chromium terinstall');
  }

  await loadSettings();
  logger.info('Bot', `AI mode: ${['off', 'Bima', 'NDXStore'][settings.aiMode] || 'unknown'}`);
  await loadBlockedUsers();
  startMenuRefresh();
  startHistoryCleanup();
  await initHandover();

  function setupMessageHandler(c) {
    c.removeAllListeners('message_create');

    // Called after a user's message burst settles — answers once, with full context.
    async function flushAiReply(jid, text, image, latestMsg) {
      await c.sendPresenceUpdate('composing', jid).catch(() => {});
      let reply;
      if (image) {
        reply = await askAIWithImage(jid, text, image.data, image.mime, settings.aiMode).catch(() => null);
      }
      if (!reply) reply = await askAI(jid, text, settings.aiMode).catch(() => null);
      if (reply) {
        const delay = Math.min(reply.length * 10, 2000);
        await new Promise(r => setTimeout(r, delay));
        latestMsg.reply(reply).catch(() => {});
      }
    }

    c.on('message_create', async (msg) => {
      try {
        const body = msg.body?.trim() || '';
        const senderJid = msg.author || msg.from;
        const isAdmin = senderJid.split('@')[0].replace(/^\+/, '').trim() === ADMIN_RAW;
        logger.debug('Msg', `${senderJid.replace(/@.*/, '')} | "${body.slice(0, 40)}" | fromMe:${msg.fromMe} | admin:${isAdmin} | aiMode:${settings.aiMode}`);

        // ── Block / Unblock ──
        if (body === '!block' && isAdmin) {
          const target = msg.to?.includes('@g.us') ? msg.author || msg.from : msg.from;
          blockedUsers.add(target);
          await saveBlockedUsers();
          await msg.reply(`⛔ User diblokir: ${target}`);
          return;
        }
        if (body === '!unblock' && isAdmin) {
          const target = msg.to?.includes('@g.us') ? msg.author || msg.from : msg.from;
          blockedUsers.delete(target);
          await saveBlockedUsers();
          await msg.reply(`✅ User di-unblock: ${target}`);
          return;
        }

        // ── Blocked Users ──
        if (!isAdmin && blockedUsers.has(senderJid)) return;

        // ── Admin Commands ──
        if (msg.fromMe || isAdmin) {
          // Comprehensive help listing all commands
          if (body === '!help' || body === '!helpall') {
            await msg.reply(
              `📋 *BOT COMMANDS*\n━━━━━━━━━━━━━━━━━━━\n` +
              `*AI & Chat*\n` +
              `!aimode — lihat mode\n` +
              `!aimode 0|1|2 — set mode\n` +
              `!aireset — reset history\n` +
              `!aimodesetting — lihat setting\n` +
              `!aimodesetting jd — toggle jawab duluan\n` +
              `!aimodesetting unigroup — toggle ungroup\n` +
              `!history [n] — riwayat chat\n` +
              `!clear <n> — hapus n pesan bot\n` +
              `*Security*\n` +
              `!block — blokir user\n` +
              `!unblock — buka blokir\n` +
              `*Messaging*\n` +
              `!reply 628xxx <pesan> — kirim pesan\n` +
              `!groupid — tampilkan ID grup\n` +
              `*API NDXStore*\n` +
              `!help — lihat command API\n` +
              `!stats — statistik\n` +
              `!orders — 5 order terbaru\n` +
              `!pending [game] — order pending\n` +
              `!detail NDX-xxxx — detail order\n` +
              `!status NDX-xxxx STATUS — update status\n` +
              `━━━━━━━━━━━━━━━━━━━`
            );
            return;
          }
          // Aimode with flexible parsing
          const aimodeVal = parseAiMode(body);
          if (aimodeVal !== null) {
            settings.aiMode = aimodeVal;
            if (aimodeVal === 0) {
              clearHistoryExcept(senderJid);
              await msg.reply('Nonaktif');
            } else {
              clearHistoryExcept(senderJid);
              await msg.reply(aimodeVal === 1 ? 'Bima aktif' : 'NDXStore AI aktif');
            }
            await flushSettings();
            return;
          }

          if (body === '!aimode') {
            await msg.reply(
              `Mode skrg: ${settings.aiMode === 0 ? 'Nonaktif' : settings.aiMode === 1 ? 'Bima (1)' : 'NDXStore (2)'}\n` +
              `Gunakan: !aimode 1 (Bima), !aimode 2 (NDXStore), !aimode 0 (nonaktif)`
            );
            return;
          }

          if (body === '!aireset') {
            clearHistory(senderJid);
            await msg.reply('🧹 Riwayat chat direset');
            return;
          }

          // !clear — simplified (removed dead WWebJS page eval)
          const clearMatch = body.match(/^!clear\s+(\d+)/i);
          if (clearMatch) {
            const num = parseInt(clearMatch[1]);
            if (num < 1 || num > 50) { await msg.reply('❌ Jumlah: 1-50'); return; }
            try {
              const chat = await c.getChatById(msg.from);
              const msgs = await chat.fetchMessages({ limit: Math.min(num * 3, 50) });
              const botMsgs = msgs.filter(m => m.fromMe).slice(0, num);
              if (!botMsgs.length) { await msg.reply('❌ Gak ada pesan bot.'); return; }
              let ok = 0, fail = 0;
              for (const m of botMsgs) {
                try {
                  if (typeof m.delete === 'function') { await m.delete(true); ok++; }
                  else fail++;
                } catch { fail++; }
              }
              await msg.reply(`🧹 ${ok} terhapus${fail ? `, ${fail} gagal` : ''}`);
            } catch (e) {
              await msg.reply(`❌ Gagal: ${e.message.slice(0, 80)}`);
            }
            return;
          }

          // Settings
          if (body === '!aimodesetting') {
            await msg.reply(
              `Jawab duluan: ${settings.jawabDuluan ? 'ON' : 'OFF'} | ` +
              `Ungroup: ${settings.ungroup ? 'ON (mention/reply)' : 'OFF'}\n` +
              `Gunakan: !aimodesetting jd, !aimodesetting uningroup`
            );
            return;
          }
          if (body === '!aimodesetting jd') {
            settings.jawabDuluan = !settings.jawabDuluan;
            await flushSettings();
            await msg.reply(`Jawab duluan ${settings.jawabDuluan ? 'ON' : 'OFF'}`);
            return;
          }
          if (body === '!aimodesetting unigroup' || body === '!aimodesetting uningroup') {
            settings.ungroup = !settings.ungroup;
            await flushSettings();
            await msg.reply(`Ungroup ${settings.ungroup ? 'ON — cuma bales di grup kalo di mention/di-reply' : 'OFF'}`);
            return;
          }

          // ── History ──
          if (body.startsWith('!history') && isAdmin) {
            const limit = parseInt(body.slice(8).trim()) || 20;
            const history = await getChatHistory(limit);
            if (!history?.length) return await msg.reply('📋 Riwayat chat kosong.');
            let reply = `📋 *RIWAYAT CHAT (${history.length})*\n━━━━━━━━━━━━━━\n`;
            for (const h of history.slice(0, 10)) {
              reply += `\n👤 ${h.user_number?.replace(/@.*/, '')}\n💬 ${(h.content || '').slice(0, 50)}${h.content?.length > 50 ? '...' : ''}\n⏰ ${formatTime(h.created_at)}\n━━━━━━━━━━━━━━`;
            }
            await msg.reply(reply);
            return;
          }

          if (body.startsWith('!')) {
            const handled = await handleAdminCommand(c, msg, body);
            if (handled) return;
          }

          // !reply
          if (body.startsWith('!reply ') && config.adminNumber) {
            const rest = body.slice(7).trim();
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx <= 0 || !rest.slice(spaceIdx + 1).trim()) {
              await msg.reply('❌ Format: !reply [nomor] [pesan]\nContoh: !reply 6285159898005 Halo kak');
              return;
            }
            const rawNumber = rest.slice(0, spaceIdx).trim();
            const replyText = rest.slice(spaceIdx + 1).trim();
            const target = formatWaNumber(rawNumber);
            if (!target) {
              await msg.reply('❌ Nomor tujuan tidak valid. Format: 628xxx');
              return;
            }
            await c.sendMessage(target, `📨 *Pesan dari Admin:*\n\n${replyText}`);
            await msg.reply('✅ Pesan terkirim.');
            return;
          }

          // Admin reply via quoted message
          if (isAdmin && msg.hasQuotedMsg) {
            const forwarded = await handleAdminReply(c, msg);
            if (forwarded) {
              await msg.reply('✅ Balasan terkirim ke user.');
              return;
            }
          }
        }
        if (isAdmin) return;

        // ── Welcome new users (DM only, only when AI is off) ──
        if (!msg.fromMe && !msg.from.includes('@g.us') && !WELCOMED_USERS.has(senderJid) && !settings.aiMode) {
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
              if (username) return await checkOrders(msg, username);
            }
            await msg.reply('Ketik *Cek [username]* buat cek status order.\nContoh: *Cek ROWSOWS*');
            return;
          }

          if (body === '2') { await msg.reply(getInfoProduk()); return; }
          if (body === '3') { await msg.reply(getCaraOrder()); return; }
          if (body === '5') { await msg.reply(getInfoPembayaran()); return; }

          // ── CS Handover start ──
          if (body === '4' || lower === 'cs') {
            if (config.adminNumber) {
              await startHandover(c, msg, config.adminNumber);
            } else {
              await msg.reply('❌ Admin belum dikonfigurasi.');
            }
            return;
          }
        }

        // Active CS session works regardless of AI mode
        if (isHandoverActive(msg.from) && config.adminNumber) {
          if (lower === 'selesai' || lower === 'stop') {
            endHandover(msg.from);
            await msg.reply('🔚 Sesi CS selesai. Ketik *Menu* untuk kembali.');
            await c.sendMessage(config.adminNumber, `🔚 *Sesi CS selesai*\nUser: ${msg.from}`);
            return;
          }
          await forwardToAdmin(c, msg.from, body, config.adminNumber);
          await msg.reply('✅ Pesan diteruskan ke admin.');
          return;
        }

        // ── Group / self filters ──
        if (msg.fromMe && msg.from.includes('@g.us')) return;
        if (msg.fromMe) return;
        if (msg.from.includes('@g.us') && !settings.aiMode) return;

        if (msg.from.includes('@g.us') && settings.ungroup) {
          const botUser = c.info?.wid?.user;
          if (botUser) {
            const mentioned = msg.mentionedIds?.some(id => id.includes(botUser));
            let repliedToBot = false;
            if (msg.hasQuotedMsg) {
              try {
                const quoted = await msg.getQuotedMessage();
                repliedToBot = quoted?.fromMe === true;
              } catch {}
            }
            if (!mentioned && !repliedToBot) return;
          }
        }

        // Free-form chat only goes to the AI. If AI is off, there's nothing left to do.
        if (settings.aiMode <= 0) return;

        // ── Daily Limit (DM users only) ──
        if (!msg.from.includes('@g.us') && !isAdmin) {
          const limit = await checkDailyLimit(msg.from);
          if (!limit.allowed) {
            await msg.reply(`❌ Kamu sudah mencapai batas pesan harian. ${limit.remaining === 0 ? 'Coba lagi besok.' : ''}`);
            return;
          }
        }

        // ── Non-image media without a caption: we can't read it, respond gracefully ──
        if (msg.hasMedia && msg.type !== 'image' && !body) {
          if (msg.type === 'sticker') return; // ignore stickers silently
          const kind = (msg.type === 'ptt' || msg.type === 'audio') ? 'voice note'
            : msg.type === 'document' ? 'file/dokumen'
            : msg.type === 'video' ? 'video'
            : 'media ini';
          await msg.reply(`Maaf, aku belum bisa proses ${kind}. Ketik pesan teks aja ya 🙏`).catch(() => {});
          return;
        }

        // ── Fast reply (common greetings) — instant, no buffer delay ──
        const fastReply = detectGreeting(body);
        if (fastReply) {
          const reply = await askAI(senderJid, body, settings.aiMode).catch(() => null);
          if (reply) {
            await msg.reply(reply).catch(() => {});
          }
          return;
        }

        // ── Buffer fragments, answer once the burst settles (see aiBuffer.js) ──
        let image = null;
        if (msg.hasMedia && msg.type === 'image') {
          const media = await msg.downloadMedia().catch(() => null);
          if (media) image = { data: media.data, mime: media.mimetype };
        }
        bufferAiMessage(msg.from, msg, body, image, flushAiReply);
        return;

      } catch (e) {
        logger.error('Bot', 'Handler error:', e.message);
      }
    });
  }

  waClient = await createClient(setupMessageHandler);
  setupMessageHandler(waClient);

  waClient.on('ready', async () => {
    logger.info('Bot', 'Client ready — bot online!');
    const monitor = await startOrderMonitor(waClient, settings);
    if (monitor) orderMonitorCleanup = monitor;
  });

  waClient.initialize().catch(e => logger.error('WA', 'Init failed:', `${e.message} (${process.platform}/${process.arch})`));

  async function shutdown(signal) {
    logger.info('Bot', `Received ${signal}, shutting down...`);
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

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught', err.message);
    logger.error('Uncaught', err.stack?.slice(0, 500));
    process.exit(1);
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
  logger.error('FATAL', 'Bot failed to start:', err.message);
  process.exit(1);
});
