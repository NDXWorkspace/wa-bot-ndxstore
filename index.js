import http from 'http';
import { config } from './config.js';
import { createClient } from './client.js';
import { startOrderMonitor } from './services/orderMonitor.js';

const healthApp = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
});
const PORT = Number(process.env.PORT) || 3000;
healthApp.listen(PORT, () => {
  console.log(`[Health] HTTP server on port ${PORT}`);
});

async function main() {
  console.log('=== WA Bot NDXStore — Order Notifier ===');
  console.log(`Supabase: ${config.supabase.key ? '✓' : '✗'}`);
  console.log(`Group ID: ${config.groupId || '(not set)'}`);
  console.log('');

  const client = await createClient();

  client.on('message_create', async (msg) => {
    try {
      if (msg.fromMe && msg.body.trim() === '!groupid') {
        const isGroup = msg.to.includes('@g.us');
        const jid = msg.to.replace(/@(g\.us|s\.whatsapp\.net)/g, '');
        const reply = isGroup
          ? `Group ID: ${jid}@g.us\n\nSimpan di .env:\nGROUP_ID=${jid}@g.us`
          : 'Ini bukan grup. Ketik !groupid di grup WhatsApp.';
        await msg.reply(reply);
        if (isGroup) console.log('[Bot] Group ID:', jid);
      }
    } catch (e) {
      console.error('[Bot] Handler error:', e);
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
