import fs from 'fs';
import { config } from '../config.js';
import { getDb } from './supabase.js';

const NOTIFIED_FILE = './.notified.json';
const CATCHUP_WINDOW_MS = 5 * 60 * 1000; // catch-up 5 menit terakhir pas startup

let notified = new Set();
try {
  const raw = fs.readFileSync(NOTIFIED_FILE, 'utf-8');
  const arr = JSON.parse(raw);
  if (Array.isArray(arr)) notified = new Set(arr);
  console.log(`[OrderMonitor] Loaded ${notified.size} notified IDs`);
} catch {}

function persistNotified() {
  try { fs.writeFileSync(NOTIFIED_FILE, JSON.stringify([...notified])); } catch {}
}

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

function formatWaNumber(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('62') && n.length >= 10) return n + '@c.us';
  return null;
}

function sendNotif(client, order, type) {
  if (!config.groupId) {
    console.warn('[OrderMonitor] GROUP_ID not set');
    return;
  }
  if (notified.has(order.id)) return;
  notified.add(order.id);
  persistNotified();

  const msg = formatOrderMessage(order, type);
  client.sendMessage(config.groupId, msg)
    .then(() => console.log(`[OrderMonitor] ${type} sent for ${order.id}`))
    .catch(err => console.error(`[OrderMonitor] Send failed: ${err.message}`));

  // Also DM the customer
  const userJid = formatWaNumber(order.wa_number);
  if (userJid) {
    const userMsg = type === 'payment'
      ? `💰 *Pembayaran Diterima!*\n\nHalo *${order.username || 'Kak'}*, pembayaran untuk pesanan *${order.id}* sudah kami terima. Pesanan akan segera diproses.\n\nTerima kasih telah berbelanja di NDXStore! 🎉`
      : `📩 *Pesanan Baru Diterima*\n\nHalo *${order.username || 'Kak'}*, pesanan kamu *${order.id}* sudah tercatat.\n\nKami akan proses setelah pembayaran dikonfirmasi.\n\nGunakan *cek ${order.username}* untuk cek status terbaru.`;
    client.sendMessage(userJid, userMsg)
      .then(() => console.log(`[OrderMonitor] DM sent to ${userJid}`))
      .catch(err => console.log(`[OrderMonitor] DM failed for ${userJid}: ${err.message}`));
  }
}

function sendUpdateToUser(client, order) {
  const userJid = formatWaNumber(order.wa_number);
  if (!userJid) return;

  const statusLabels = {
    PROCESSING: 'sedang diproses ✅',
    SUCCESS: 'selesai! 🎉',
    REJECTED: 'dibatalkan ❌',
  };

  const label = statusLabels[(order.order_status || '').toUpperCase()] || (order.order_status || order.payment_status || '-');

  const msg = `📋 *Update Pesanan*\n\nHalo *${order.username || 'Kak'}*,\nPesanan *${order.id}* saat ini: *${label}*.\n\nTerima kasih! 🙏`;
  client.sendMessage(userJid, msg)
    .then(() => console.log(`[OrderMonitor] Update DM sent to ${userJid}`))
    .catch(err => console.log(`[OrderMonitor] Update DM failed: ${userJid}: ${err.message}`));
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

async function catchUpMissed(client, db) {
  try {
    const since = new Date(Date.now() - CATCHUP_WINDOW_MS).toISOString();
    const { data, error } = await db
      .from('transactions')
      .select('id, product_name, game_name, username, wa_number, roblox_id, ml_data, price_idr, payment_method, order_status, payment_status, contact_admin, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[OrderMonitor] Catch-up error:', error.message);
      return;
    }

    if (data && data.length > 0) {
      console.log(`[OrderMonitor] Catch-up: ${data.length} missed order(s)`);
      for (const order of data) {
        if (notified.has(order.id)) continue;
        const type = isPaymentConfirmed(order) ? 'payment' : 'new';
        sendNotif(client, order, type);
      }
    }
  } catch (e) {
    console.error('[OrderMonitor] Catch-up exception:', e.message);
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

        if (changed) {
          if (confirmed) {
            console.log(`[OrderMonitor] Payment confirmed: ${order.id}`);
            sendNotif(client, order, 'payment');
          } else {
            console.log(`[OrderMonitor] Status update: ${order.id} → ${order.order_status || order.payment_status}`);
          }
          sendUpdateToUser(client, order);
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[OrderMonitor] Realtime connected');
        console.log('[OrderMonitor] Jalankan SQL jika notif tidak muncul:');
        console.log('[OrderMonitor]   ALTER PUBLICATION supabase_realtime ADD TABLE transactions;');
      } else if (status === 'CHANNEL_ERROR') {
        console.warn('[OrderMonitor] Realtime channel error — checking subscription status...');
      }
    });

  catchUpMissed(client, db);

  return { channel };
}
