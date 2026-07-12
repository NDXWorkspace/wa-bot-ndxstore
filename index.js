import http from 'http';
import { config } from './config.js';
import { createClient } from './client.js';
import { getDb } from './services/supabase.js';
import { startOrderMonitor } from './services/orderMonitor.js';
import { MENU_TEXT, INFO_PRODUK, CARA_ORDER, INFO_PEMBAYARAN } from './services/menu.js';
import { isHandoverActive, endHandover, startHandover, handleAdminReply, forwardToAdmin } from './services/handoverService.js';

const healthApp = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
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

async function checkOrders(msg, username) {
  try {
    const db = getDb();
    if (!db) return await msg.reply('❌ Database tidak tersedia.');

    const { data, error } = await db
      .from('transactions')
      .select('id, product_name, game_name, price_idr, payment_status, order_status, created_at')
      .eq('username', username)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) return await msg.reply(`❌ Gagal cek order: ${error.message}`);

    if (!data || data.length === 0) {
      return await msg.reply(`Tidak ada order untuk *${username}*.`);
    }

    let reply = `📋 *Order ${username}*\n━━━━━━━━━━━━━━\n`;
    for (const o of data) {
      reply += `\n🆔 ${o.id}\n📦 ${o.product_name || '-'}\n💰 ${formatPrice(o.price_idr)}\n📊 ${o.order_status || o.payment_status || '-'}\n⏰ ${formatTime(o.created_at)}\n━━━━━━━━━━━━━━`;
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

  const client = await createClient();

  client.on('message_create', async (msg) => {
    try {
      const body = msg.body.trim();
      const isAdmin = msg.from === config.adminNumber;

      // === ADMIN COMMANDS ===
      if (msg.fromMe || isAdmin) {
        if (body === '!groupid') {
          const isGroup = msg.to.includes('@g.us');
          const jid = msg.to.replace(/@(g\.us|s\.whatsapp\.net)/g, '');
          await msg.reply(isGroup
            ? `Group ID: ${jid}@g.us\n\nSimpan di .env:\nGROUP_ID=${jid}@g.us`
            : 'Ini bukan grup.');
          if (isGroup) console.log('[Bot] Group ID:', jid);
          return;
        }

        if (body.startsWith('!reply ') && config.adminNumber) {
          const rest = body.slice(7).trim();
          const spaceIdx = rest.indexOf(' ');
          if (spaceIdx > 0) {
            const target = rest.slice(0, spaceIdx).replace(/[^0-9]/g, '') + '@c.us';
            const replyText = rest.slice(spaceIdx + 1);
            await client.sendMessage(target, `📨 *Pesan dari Admin:*\n\n${replyText}`);
            await msg.reply('✅ Pesan terkirim.');
          }
          return;
        }

        // Admin reply to quoted handover message
        if (isAdmin && msg.hasQuotedMsg) {
          const forwarded = await handleAdminReply(client, msg);
          if (forwarded) {
            await msg.reply('✅ Balasan terkirim ke user.');
            return;
          }
        }

        if (msg.fromMe) return;
      }

      // === IGNORE GROUP MESSAGES (not admin) ===
      if (msg.from.includes('@g.us') && !isAdmin) return;

      // === ACTIVE HANDOVER — forward to admin ===
      if (isHandoverActive(msg.from) && config.adminNumber) {
        if (body.toLowerCase() === 'selesai' || body.toLowerCase() === 'stop') {
          endHandover(msg.from);
          await msg.reply('🔚 Sesi CS selesai. Ketik *menu* untuk kembali.');
          await client.sendMessage(config.adminNumber, `🔚 *Sesi CS selesai*\nUser: ${msg.from}`);
          return;
        }
        await forwardToAdmin(client, msg.from, body, config.adminNumber);
        await msg.reply('✅ Pesan diteruskan ke admin.');
        return;
      }

      // === USER MENU ===
      const lowered = body.toLowerCase();

      if (lowered === 'menu' || lowered === '0' || lowered === 'halo' || lowered === 'hi' || lowered === 'p') {
        await msg.reply(MENU_TEXT);
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

      if (lowered === '2') { await msg.reply(INFO_PRODUK); return; }
      if (lowered === '3') { await msg.reply(CARA_ORDER); return; }
      if (lowered === '4' || lowered === 'cs') {
        if (config.adminNumber) {
          await startHandover(client, msg, config.adminNumber);
        } else {
          await msg.reply('❌ Admin belum dikonfigurasi.');
        }
        return;
      }
      if (lowered === '5') { await msg.reply(INFO_PEMBAYARAN); return; }

      // Unknown
      await msg.reply(`Ketik *menu* untuk melihat daftar perintah.`);
    } catch (e) {
      console.error('[Bot] Handler error:', e.message);
    }
  });

  client.on('ready', () => {
    console.log('[WA] Client ready — bot online!');
    startOrderMonitor(client);
  });

  client.initialize();

  function shutdown(signal) {
    console.log(`\n[Bot] Received ${signal}, shutting down...`);
    client.destroy().then(() => process.exit(0)).catch(() => process.exit(1));
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
