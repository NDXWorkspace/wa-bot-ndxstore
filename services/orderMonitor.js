import fsp from 'fs/promises';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

const NOTIFIED_FILE = './.notified.json';

let notified = new Set();
let seenOrders = new Map();
let supabase = null;
let channel = null;

async function loadNotified() {
  try {
    const raw = await fsp.readFile(NOTIFIED_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) notified = new Set(arr);
    console.log(`[OrderMonitor] Loaded ${notified.size} notified IDs`);
  } catch {}
}

async function persistNotified() {
  try {
    const tmp = NOTIFIED_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...notified]));
    await fsp.rename(tmp, NOTIFIED_FILE);
  } catch {}
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
  const ml = order.ml_data;
  if (ml && typeof ml === 'object') {
    extra += `\n🆔 ID ML: ${ml.userId || ml.user_id || '-'} (Zone ${ml.zoneId || ml.zone_id || '-'})`;
  }
  if (order.roblox_id) {
    extra += `\n🆔 Roblox ID: ${order.roblox_id}`;
  }
  if (order.roblox_password) {
    extra += `\n🔑 *Password:* ${order.roblox_password}`;
  }
  if (order.backup_code) {
    extra += `\n🔐 *Backup Code:* ${order.backup_code}`;
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

function handleOrder(client, order) {
  if (!order || !order.id) return;

  if (!notified.has(order.id)) {
    const type = isPaymentConfirmed(order) ? 'payment' : 'new';
    sendNotif(client, order, type);
    seenOrders.set(order.id, { status: order.order_status, payment: order.payment_status });
    return;
  }

  const prev = seenOrders.get(order.id);
  if (prev) {
    const osChanged = prev.status !== order.order_status;
    const psChanged = prev.payment !== order.payment_status;
    if (osChanged || psChanged) {
      const confirmed = isPaymentConfirmed(order) && !PAYMENT_OK.includes(prev.status) && !PAYMENT_OK.includes(prev.payment);
      if (confirmed) {
        sendNotif(client, order, 'payment');
      }
      sendUpdateToUser(client, order);
    }
  }

  seenOrders.set(order.id, { status: order.order_status, payment: order.payment_status });
}

async function catchUp(client) {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn(`[OrderMonitor] Catch-up query failed: ${error.message}`);
      return;
    }
    if (!data?.length) return;

    console.log(`[OrderMonitor] Catch-up: ${data.length} order(s)`);
    for (const order of data) {
      handleOrder(client, order);
    }
  } catch (e) {
    console.warn(`[OrderMonitor] Catch-up error: ${e.message}`);
  }
}

export async function startOrderMonitor(client) {
  await loadNotified();

  supabase = createClient(config.supabase.url, config.supabase.key, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  // Catch-up for orders created while bot was offline
  await catchUp(client);

  // Supabase Realtime for live notifications
  channel = supabase
    .channel('wa-bot-orders')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'transactions' },
      (payload) => {
        console.log(`[OrderMonitor] INSERT: ${payload.new?.id}`);
        handleOrder(client, payload.new);
      }
    )
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'transactions' },
      (payload) => {
        console.log(`[OrderMonitor] UPDATE: ${payload.new?.id}`);
        handleOrder(client, payload.new);
      }
    )
    .subscribe((status) => {
      console.log(`[OrderMonitor] Realtime: ${status}`);
    });

  console.log('[OrderMonitor] Supabase Realtime — no polling');

  return {
    unsubscribe: () => {
      if (channel && supabase) supabase.removeChannel(channel);
      channel = null;
    },
  };
}
