import { config } from '../config.js';
import { getDb } from './supabase.js';

const notified = new Set();
const POLL_INTERVAL = 15000;

function safeJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

function formatPrice(val) {
  const n = Number(val);
  return isNaN(n) ? '-' : `Rp${n.toLocaleString('id-ID')}`;
}

function formatTime(val) {
  if (!val) return '-';
  try {
    return new Date(val).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  } catch {
    return String(val).slice(0, 19);
  }
}

function sendNotif(client, order, type) {
  if (!config.groupId) {
    console.warn('[OrderMonitor] GROUP_ID not set');
    return;
  }
  if (notified.has(order.id)) return;
  notified.add(order.id);

  const msg = formatOrderMessage(order, type);
  client.sendMessage(config.groupId, msg)
    .then(() => console.log(`[OrderMonitor] ${type} sent for ${order.id}`))
    .catch(err => console.error(`[OrderMonitor] Send failed: ${err.message}`));
}

function formatOrderMessage(order, type) {
  const game = order.game_name || '-';
  const product = order.product_name || '-';
  const username = order.username || '-';

  let extra = '';
  const ml = safeJson(order.ml_data);
  if (ml) {
    extra += `\n🆔 ID ML: ${ml.userId || '-'} (Zone ${ml.zoneId || '-'})`;
  }
  if (order.roblox_id) {
    extra += `\n🆔 Roblox ID: ${order.roblox_id}`;
  }
  if (order.contact_admin) {
    extra += '\n🔐 *Butuh bantuan 2FA*';
  }

  let msg = '';
  if (type === 'payment') {
    msg = `💰 *PEMBAYARAN DIKONFIRMASI*\n`;
  } else {
    msg = `🆕 *PESANAN BARU NDXSTORE*\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📋 *ID:* ${order.id}\n`;
  msg += `🎮 *Game:* ${game}\n`;
  msg += `📦 *Produk:* ${product}\n`;
  msg += `👤 *User:* ${username}${extra}\n`;

  if (order.roblox_password) {
    msg += `🔑 *Password:* ${order.roblox_password}\n`;
  }
  if (order.backup_code) {
    msg += `🔐 *Backup/2FA:* ${order.backup_code}\n`;
  }

  msg += `💰 *Harga:* ${formatPrice(order.price_idr)}\n`;
  msg += `💳 *Bayar:* ${order.payment_method || '-'}\n`;
  msg += `📊 *Status:* ${order.order_status || '-'}\n`;
  msg += `⏰ *Waktu:* ${formatTime(order.created_at)}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━`;

  return msg;
}

const PAYMENT_OK = ['SUCCESS', 'PROCESSING'];

function isPaymentConfirmed(order) {
  const os = (order.order_status || '').toUpperCase();
  const ps = (order.payment_status || '').toUpperCase();
  return PAYMENT_OK.includes(os) || PAYMENT_OK.includes(ps);
}

async function pollOrders(client, db) {
  try {
    const { data, error } = await db
      .from('transactions')
      .select('id, product_name, game_name, username, roblox_id, roblox_password, backup_code, ml_data, price_idr, payment_method, order_status, payment_status, contact_admin, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('[OrderMonitor] Poll error:', error.message);
      return;
    }

    if (data) {
      for (const order of data.reverse()) {
        if (notified.has(order.id)) continue;
        const type = isPaymentConfirmed(order) ? 'payment' : 'new';
        console.log(`[OrderMonitor] Poll: ${order.id} — ${order.product_name || '-'}`);
        sendNotif(client, order, type);
      }
    }
  } catch (e) {
    console.error('[OrderMonitor] Poll exception:', e.message);
  }
}

export function startOrderMonitor(client) {
  const db = getDb();
  if (!db) {
    console.warn('[OrderMonitor] Supabase not configured');
    return null;
  }

  const channel = db
    .channel('wa-bot-order-monitor')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'transactions' },
      (payload) => {
        const order = payload.new;
        console.log(`[OrderMonitor] Realtime: ${order.id} — ${order.product_name || '-'}`);
        const type = isPaymentConfirmed(order) ? 'payment' : 'new';
        sendNotif(client, order, type);
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'transactions' },
      (payload) => {
        const order = payload.new;
        const prev = payload.old;
        const oldStatus = (prev.order_status || '').toUpperCase();
        const newStatus = (order.order_status || '').toUpperCase();
        const oldPay = (prev.payment_status || '').toUpperCase();
        const newPay = (order.payment_status || '').toUpperCase();

        const changed = oldStatus !== newStatus || oldPay !== newPay;
        const confirmed = isPaymentConfirmed(order) && !isPaymentConfirmed(prev);

        if (changed && confirmed) {
          console.log(`[OrderMonitor] Payment confirmed: ${order.id}`);
          sendNotif(client, order, 'payment');
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[OrderMonitor] Realtime connected');
        console.log('[OrderMonitor] Jalankan SQL jika notif tidak muncul:');
        console.log('[OrderMonitor]   ALTER PUBLICATION supabase_realtime ADD TABLE transactions;');
      } else if (status === 'CHANNEL_ERROR') {
        console.warn('[OrderMonitor] Realtime error — polling fallback aktif');
      }
    });

  const pollTimer = setInterval(() => pollOrders(client, db), POLL_INTERVAL);
  console.log(`[OrderMonitor] Polling setiap ${POLL_INTERVAL / 1000}s (fallback)`);

  pollOrders(client, db);

  return { channel, pollTimer };
}
