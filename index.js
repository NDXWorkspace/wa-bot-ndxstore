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
import { settings } from './services/settings.js';
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
    aiMode: settings.aiMode,
    jawabDuluan: settings.jawabDuluan,
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
        console.log('[Msg] from:', senderJid.replace(/@.*/, ''), 'body:', body.slice(0, 40), '| fromMe:', msg.fromMe, '| isAdmin:', isAdmin, '| aiMode:', settings.aiMode);

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
            await msg.reply(`Mode skrg: ${settings.aiMode === 0 ? 'Nonaktif' : settings.aiMode === 1 ? 'Bima (1)' : 'NDXStore (2)'}\nGunakan: !aimode 1 (Bima), !aimode 2 (NDXStore), !aimode 0 (nonaktif)`);
            return;
          }
          if (body === '!aimode 0' || body === '!aimode off') {
            settings.aiMode = 0;
            clearHistory('all');
            await msg.reply('Nonaktif');
            return;
          }
          if (body === '!aimode 1') {
            settings.aiMode = 1;
            clearHistory('all');
            await msg.reply('Bima aktif — semua chat bakal dijawab Bima');
            return;
          }
          if (body === '!aimode 2') {
            settings.aiMode = 2;
            clearHistory('all');
            await msg.reply('NDXStore AI aktif — semua chat dilayani CS NDXStore');
            return;
          }

          if (body === '!aireset') {
            clearHistory('all');
            await msg.reply('🧹 Riwayat chat AI direset');
            return;
          }

          const clearMatch = body.match(/^!clear\s+(\d+)(?:\s+(.+))?$/i);
          if (clearMatch) {
            const num = parseInt(clearMatch[1]);
            const alsoClearLocal = clearMatch[2]?.toLowerCase() === 'true' || clearMatch[2] === '1';
            if (num < 1 || num > 50) { await msg.reply('❌ Jumlah: 1-50'); return; }
            try {
              const chat = await c.getChatById(msg.from);
              const allMsgs = await chat.fetchMessages({ limit: Math.min(num * 5, 100) });
              const botMsgs = allMsgs.filter(m => m.fromMe).slice(0, num);
              if (!botMsgs.length) { await msg.reply('❌ Gak ada pesan bot.'); return; }
              let okForAll = 0, okForMe = 0, fail = 0;
              for (const m of botMsgs) {
                try { await m.delete(true); okForAll++; } catch {
                  try { await m.delete(false); okForMe++; } catch { fail++; }
                }
              }
              const parts = [];
              if (okForAll) parts.push(`${okForAll} untuk semua`);
              if (okForMe) parts.push(`${okForMe} untuk diri sendiri`);
              if (fail) parts.push(`${fail} gagal`);
              if (alsoClearLocal) parts.push('riwayat dibersihkan');
              await msg.reply('🧹 ' + parts.join(', '));
            } catch (e) {
              await msg.reply('❌ Gagal: ' + e.message.slice(0, 80));
            }
            return;
          }

          if (body === '!aimodesetting') {
            await msg.reply(`Jawab duluan: ${settings.jawabDuluan ? 'ON' : 'OFF'}\nGunakan: !aimodesetting jd (toggle ON/OFF)`);
            return;
          }
          if (body === '!aimodesetting jd') {
            settings.jawabDuluan = !settings.jawabDuluan;
            await msg.reply(`Jawab duluan ${settings.jawabDuluan ? 'ON' : 'OFF'} — AI bakal ${settings.jawabDuluan ? 'proaktif chat pelanggan' : 'diem aja'}`);
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

        // === CORE MENU — case-sensitive (huruf besar di awal) ===
        if (body === 'Menu' || body === '0') {
          await msg.reply(getMenuText());
          return;
        }
        if (body.startsWith('Cek ') || body === '1') {
          if (body.startsWith('Cek ')) {
            const username = body.slice(4).trim();
            if (username) return await checkOrders(msg, username);
          }
          await msg.reply('Ketik *Cek [username]* untuk cek status order.\nContoh: *Cek ROWSOWS*');
          return;
        }
        if (body === '2') { await msg.reply(getInfoProduk()); return; }
        if (body === '3') { await msg.reply(getCaraOrder()); return; }
        if (body === '5') { await msg.reply(getInfoPembayaran()); return; }

        // === SKIP OWN GROUP NOTIFICATIONS ===
        if (msg.fromMe && msg.from.includes('@g.us')) return;
        if (msg.fromMe) return;
        if (msg.from.includes('@g.us') && !settings.aiMode) return;

        // === AI MODE — jawab SEMUA pesan ===
        if (settings.aiMode > 0) {
          console.log('[AiMode] msg from', msg.from, 'body:', body.slice(0, 30));
          try {
            try { c.sendPresenceUpdate('composing', msg.from); } catch {}
            const reply = await askAI(msg.from, body, settings.aiMode);
            if (reply) {
              const delay = Math.min(reply.length * 10, 3000);
              await new Promise(r => setTimeout(r, delay));
              try { await msg.reply(reply); } catch { try { await c.sendMessage(msg.from, reply); } catch {} }
            } else {
              try { await msg.reply('Maaf, lagi error. Coba lagi ya.'); } catch {}
            }
          } catch (e) {
            console.error('[AiMode] Error:', e.message);
            try { await msg.reply('Error, coba lagi ya.'); } catch {}
          }
          return;
        }

        // === AKHIR AI MODE — sisanya flow normal ===

        if (msg.from.includes('@g.us')) return;

        // === ACTIVE HANDOVER — forward to admin ===
        if (isHandoverActive(msg.from) && config.adminNumber) {
          if (body === 'Selesai' || body === 'Stop') {
            endHandover(msg.from);
            await msg.reply('🔚 Sesi CS selesai. Ketik *Menu* untuk kembali.');
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
        if (body === '4' || body === 'Cs' || body === 'CS') {
          if (config.adminNumber) {
            await startHandover(c, msg, config.adminNumber);
          } else {
            await msg.reply('❌ Admin belum dikonfigurasi.');
          }
          return;
        }

      } catch (e) {
        console.error('[Bot] Handler error:', e.message);
        try { if (msg && msg.from) c.sendMessage(msg.from, 'Error: ' + e.message.slice(0, 100)); } catch {}
      }
    });
  }

  waClient = await createClient(setupMessageHandler);
  setupMessageHandler(waClient);

  waClient.on('ready', () => {
    console.log('[WA] Client ready — bot online!');
    startOrderMonitor(waClient, settings);
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
