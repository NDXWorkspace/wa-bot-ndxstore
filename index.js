import http from 'http';
import os from 'os';
import { config } from './config.js';
import { createClient } from './client.js';
import { startOrderMonitor } from './services/orderMonitor.js';
import { getMenuText, getInfoProduk, getCaraOrder, getInfoPembayaran } from './services/menu.js';
import { isHandoverActive, endHandover, startHandover, handleAdminReply, forwardToAdmin } from './services/handoverService.js';
import { isOnCooldown } from './services/queue.js';
import { handleAdminCommand } from './services/admin.js';
import { askAI, clearHistory } from './services/ai.js';
import { getDb } from './services/supabase.js';

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

let aiMode = false;
const blockedUsers = new Set();
let waClient = null;
let botStartedAt = Date.now();

const healthApp = http.createServer(async (_req, res) => {
  const waConnected = waClient?.info?.wid?.user ? true : false;
  let dbConnected = false;
  try {
    const db = getDb();
    if (db) {
      const { error } = await db.from('transactions').select('id').limit(1);
      dbConnected = !error;
    }
  } catch {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: waConnected ? 'ok' : 'degraded',
    wa: waConnected ? 'connected' : 'disconnected',
    db: dbConnected ? 'connected' : 'error',
    uptime: os.uptime(),
    botUptime: Math.floor((Date.now() - botStartedAt) / 1000),
    aiMode,
    blockedUsers: blockedUsers.size,
  }));
});
const PORT = Number(process.env.PORT) || 3000;
healthApp.listen(PORT, () => {
  console.log(`[Health] HTTP server on port ${PORT}`);
});

function formatPrice(val) {
  const n = Number(val);
  return isNaN(n) ? '-' : `Rp${n.toLocaleString('id-ID')}`;
}

function formatTime(val) {
  if (!val) return '-';
  try { return new Date(val).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); }
  catch { return String(val).slice(0, 19); }
}

const API_BASE = 'https://ndxstoreid.vercel.app';

async function checkOrders(msg, username) {
  try {
    const resp = await fetch(`${API_BASE}/api/transactions/user/${encodeURIComponent(username.trim())}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return await msg.reply('❌ Gagal cek order.');

    const result = await resp.json();
    if (!result?.success || !result?.transactions?.length) {
      return await msg.reply(`Tidak ada order untuk *${username}*.`);
    }

    let reply = `📋 *Order ${username}*\n━━━━━━━━━━━━━━\n`;
    for (const o of result.transactions.slice(0, 5)) {
      reply += `\n🆔 ${o.id}\n📦 ${o.productName || '-'}\n💰 ${formatPrice(o.priceIdr)}\n📊 ${o.orderStatus || o.paymentStatus || '-'}\n⏰ ${formatTime(o.createdAt)}\n━━━━━━━━━━━━━━`;
    }
    await msg.reply(reply);
  } catch (e) {
    await msg.reply('❌ Error cek order.');
    console.error('[CekOrder] Error:', e.message);
  }
}

async function main() {
  console.log('=== WA Bot NDXStore ===');
  console.log(`Supabase: ${config.supabase.key ? '✓' : '✗'}`);
  console.log(`Group ID: ${config.groupId || '(not set)'}`);
  console.log(`Admin: ${config.adminNumber || '(not set)'}`);
  console.log('');

  function setupMessageHandler(c) {
    c.removeAllListeners('message_create');
    c.on('message_create', async (msg) => {
      try {
        const body = msg.body?.trim() || '';
        const senderJid = msg.author || msg.from;
        const isAdmin = senderJid.split('@')[0].replace(/^\+/, '') === config.adminNumber.replace(/^\+/, '');
        console.log('[Msg] from:', senderJid.replace(/@.*/, ''), 'body:', body.slice(0, 40), '| fromMe:', msg.fromMe, '| isAdmin:', isAdmin, '| aiMode:', aiMode);

        if (body === '!block' && isAdmin) {
          const target = msg.to.includes('@g.us') ? msg.author || msg.from : msg.from;
          blockedUsers.add(target);
          await msg.reply(`⛔ User diblokir: ${target}`);
          return;
        }
        if (body === '!unblock' && isAdmin) {
          const target = msg.to.includes('@g.us') ? msg.author || msg.from : msg.from;
          blockedUsers.delete(target);
          await msg.reply(`✅ User di-unblock: ${target}`);
          return;
        }

        // === BLOCKED USERS ===
        if (!isAdmin && blockedUsers.has(senderJid)) return;

        if (body === '!history' && isAdmin) {
          const limit = parseInt(body.slice(9).trim()) || 20;
          const history = await getChatHistory(limit);
          if (!history?.length) return await msg.reply('📋 Riwayat chat kosong.');
          let reply = `📋 *RIWAYAT CHAT (${history.length})*\n━━━━━━━━━━━━━━\n`;
          for (const h of history.slice(0, 10)) {
            reply += `\n👤 ${h.jid?.replace(/@.*/, '')}\n💬 ${(h.message || '').slice(0, 50)}${h.message?.length > 50 ? '...' : ''}\n⏰ ${formatTime(h.created_at)}\n━━━━━━━━━━━━━━`;
          }
          await msg.reply(reply);
          return;
        }

        // === ADMIN COMMANDS ===
        if (msg.fromMe || isAdmin) {
          if (body === '!aimode') {
            aiMode = !aiMode;
            await msg.reply(aiMode ? 'Bima aktif — semua chat bakal dijawab Bima' : 'Bima nonaktif');
            if (!aiMode) clearHistory('all');
            return;
          }

          if (body === '!aireset') {
            clearHistory('all');
            await msg.reply('🧹 Riwayat chat AI direset');
            return;
          }

          if (body.startsWith('!')) {
            const handled = await handleAdminCommand(c, msg, body);
            if (handled) return;
          }

          if (body.startsWith('!reply ') && config.adminNumber) {
            const rest = body.slice(7).trim();
            const spaceIdx = rest.indexOf(' ');
            if (spaceIdx > 0) {
              const target = rest.slice(0, spaceIdx).replace(/[^0-9]/g, '') + '@c.us';
              const replyText = rest.slice(spaceIdx + 1);
              await c.sendMessage(target, `📨 *Pesan dari Admin:*\n\n${replyText}`);
              await msg.reply('✅ Pesan terkirim.');
            }
            return;
          }

          if (isAdmin && msg.hasQuotedMsg) {
            const forwarded = await handleAdminReply(c, msg);
            if (forwarded) {
              await msg.reply('✅ Balasan terkirim ke user.');
              return;
            }
          }
        }

        // === CORE MENU — jalan SELALU, di grup/DM, bypass AI mode ===
        const lowered = body.toLowerCase();
        if (lowered === 'menu' || lowered === '0' || lowered === 'halo' || lowered === 'hi' || lowered === 'p') {
          await msg.reply(getMenuText());
          return;
        }
        if (body.startsWith('cek ') || lowered === '1') {
          if (body.startsWith('cek ')) {
            const username = body.slice(4).trim();
            if (username) return await checkOrders(msg, username);
          }
          await msg.reply('Ketik *cek [username]* untuk cek status order.\nContoh: *cek ROWSOWS*');
          return;
        }
        if (lowered === '2') { await msg.reply(getInfoProduk()); return; }
        if (lowered === '3') { await msg.reply(getCaraOrder()); return; }
        if (lowered === '5') { await msg.reply(getInfoPembayaran()); return; }

        // === SKIP OWN GROUP NOTIFICATIONS ===
        if (msg.fromMe && msg.from.includes('@g.us')) return;
        if (msg.fromMe) return;
        if (msg.from.includes('@g.us') && !aiMode) return;

        // === AI MODE — jawab SEMUA pesan ===
        if (aiMode) {
          console.log('[AiMode] msg from', msg.from, 'body:', body.slice(0, 30));
          try {
            const reply = await askAI(msg.from, body);
            if (reply) await msg.reply(reply);
            else await msg.reply('Maaf, lagi error. Coba lagi ya.');
          } catch (e) {
            console.error('[AiMode] Error:', e.message);
            await msg.reply('Error, coba lagi ya.');
          }
          return;
        }

        // === AKHIR AI MODE — sisanya flow normal ===

        if (msg.from.includes('@g.us')) return;

        // === ACTIVE HANDOVER — forward to admin ===
        if (isHandoverActive(msg.from) && config.adminNumber) {
          if (body.toLowerCase() === 'selesai' || body.toLowerCase() === 'stop') {
            endHandover(msg.from);
            await msg.reply('🔚 Sesi CS selesai. Ketik *menu* untuk kembali.');
            await c.sendMessage(config.adminNumber, `🔚 *Sesi CS selesai\nUser: ${msg.from}`);
            return;
          }
          await forwardToAdmin(c, msg.from, body, config.adminNumber);
          await msg.reply('✅ Pesan diteruskan ke admin.');
          return;
        }

        // === COOLDOWN (general: 2s, AI: handled above) ===
        if (isOnCooldown(msg.from, 'default')) return;

        // === CS HANDOVER (DM only) ===
        if (lowered === '4' || lowered === 'cs') {
          if (config.adminNumber) {
            await startHandover(c, msg, config.adminNumber);
          } else {
            await msg.reply('❌ Admin belum dikonfigurasi.');
          }
          return;
        }

      } catch (e) {
        console.error('[Bot] Handler error:', e.message);
      }
    });
  }

  waClient = await createClient(setupMessageHandler);
  setupMessageHandler(waClient);

  waClient.on('ready', () => {
    console.log('[WA] Client ready — bot online!');
    startOrderMonitor(waClient);
  });

  waClient.initialize();

  function shutdown(signal) {
    console.log(`\n[Bot] Received ${signal}, shutting down...`);
    if (waClient) waClient.destroy().then(() => process.exit(0)).catch(() => process.exit(1));
    else process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => console.error('[FATAL]', err));
  process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

  console.log('[Bot] Starting WhatsApp client...');
}

main().catch((err) => {
  console.error('[FATAL] Bot failed to start:', err);
  process.exit(1);
});
