import fsp from 'fs/promises';
import { config } from '../config.js';
import { getDbWithRealtime } from './supabase.js';
import { enqueueSend } from './rateLimiter.js';
import { askAIProactive } from './ai.js';
import { formatPrice, formatTime, formatWaNumber } from '../utils/format.js';
import { PAYMENT_OK_STATUSES as PAYMENT_OK } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

const NOTIFIED_FILE = './.notified.json';
const PERSIST_DEBOUNCE_MS = 2000;
const RECONNECT_INTERVAL_MS = 30000;

let notified = new Set();
let seenOrders = new Map();
let supabase = null;
let channel = null;
let persistTimer = null;
let persistLock = false;
let reconnectTimer = null;
let _settings = { jawabDuluan: false, aiMode: 0 };

async function loadNotified() {
  try {
    const raw = await fsp.readFile(NOTIFIED_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) notified = new Set(arr);
    logger.info('OrderMonitor', `Loaded ${notified.size} notified IDs`);
  } catch {}
}

async function persistNotified() {
  if (persistLock) return;
  persistLock = true;
  try {
    const tmp = NOTIFIED_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...notified]));
    await fsp.rename(tmp, NOTIFIED_FILE);
  } catch (e) {
    logger.error('OrderMonitor', 'Persist error:', e.message);
  } finally {
    persistLock = false;
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNotified().catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

function sendNotif(client, order, type) {
  if (!config.groupId) {
    logger.warn('OrderMonitor', 'GROUP_ID not set');
    return;
  }
  if (notified.has(order.id)) return;
  notified.add(order.id);
  schedulePersist();

  const msg = formatOrderMessage(order, type);
  enqueueSend(() => client.sendMessage(config.groupId, msg));

  const userJid = formatWaNumber(order.wa_number);
  if (userJid) {
    if (_settings.jawabDuluan) {
      sendAIProactive(client, order, type, userJid);
    } else {
      let creds = '';
      if (order.roblox_password || order.backup_code) {
        creds = '\n\n🔐 *Akses Roblox:*\n';
        if (order.roblox_password) creds += `🔑 Password: ${order.roblox_password}\n`;
        if (order.backup_code) creds += `🔐 Backup Code: ${order.backup_code}\n`;
      }
      const userMsg = type === 'payment'
        ? `💰 *Pembayaran Diterima!*\n\nHalo *${order.username || 'Kak'}*, pembayaran untuk pesanan *${order.id}* sudah kami terima. Pesanan akan segera diproses.${creds}\n\nTerima kasih telah berbelanja di NDXStore! 🎉`
        : `📩 *Pesanan Baru Diterima*\n\nHalo *${order.username || 'Kak'}*, pesanan kamu *${order.id}* sudah tercatat.\n\nKami akan proses setelah pembayaran dikonfirmasi.${creds}\n\nGunakan *cek ${order.username}* untuk cek status terbaru.`;
      enqueueSend(() => client.sendMessage(userJid, userMsg));
    }
  }
}

async function sendAIProactive(client, order, type, userJid) {
  try {
    const aiMsg = await askAIProactive(order, _settings.aiMode || 1);
    if (aiMsg) {
      enqueueSend(() => client.sendMessage(userJid, aiMsg));
    }
  } catch (e) {
    logger.error('OrderMonitor', 'AI proactive error:', e.message);
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
  enqueueSend(() => client.sendMessage(userJid, msg));
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
    const pw = String(order.roblox_password);
    extra += `\n🔑 *Password:* ${pw.length > 6 ? pw.slice(0, 2) + '****' + pw.slice(-2) : '********'}`;
  }
  if (order.backup_code) {
    extra += `\n🔐 *Backup Code:* ********`;
  }
  if (order.contact_admin) {
    extra += '\n🔐 *Butuh bantuan 2FA*';
  }

  let msg = type === 'payment'
    ? `💰 *PEMBAYARAN DIKONFIRMASI*\n`
    : `🆕 *PESANAN BARU NDXSTORE*\n`;

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
      const confirmed = isPaymentConfirmed(order) &&
        !PAYMENT_OK.includes(prev.status) &&
        !PAYMENT_OK.includes(prev.payment);
      if (confirmed) {
        sendNotif(client, order, 'payment');
      } else {
        sendUpdateToUser(client, order);
      }
    }
  }

  seenOrders.set(order.id, { status: order.order_status, payment: order.payment_status });
}

async function catchUp(client) {
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) {
      logger.warn('OrderMonitor', `Catch-up failed: ${error.message}`);
      return;
    }
    if (!data?.length) return;

    logger.info('OrderMonitor', `Catch-up: ${data.length} order(s)`);
    for (const order of data) {
      handleOrder(client, order);
    }
  } catch (e) {
    logger.warn('OrderMonitor', `Catch-up error: ${e.message}`);
  }
}

function setupRealtime(client) {
  if (channel) {
    supabase.removeChannel(channel).catch(() => {});
    channel = null;
  }

  channel = supabase
    .channel('wa-bot-orders')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'transactions' },
      (payload) => {
        handleOrder(client, payload.new);
      }
    )
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'transactions' },
      (payload) => {
        handleOrder(client, payload.new);
      }
    )
    .subscribe((status) => {
      logger.info('OrderMonitor', `Realtime: ${status}`);
      if (status === 'SUBSCRIBED') {
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
      }
      if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
        startReconnectLoop(client);
      }
    });
}

function startReconnectLoop(client) {
  if (reconnectTimer) return;
  logger.warn('OrderMonitor', 'Starting Realtime reconnect loop');
  reconnectTimer = setInterval(() => {
    logger.info('OrderMonitor', 'Attempting Realtime reconnect...');
    setupRealtime(client);
  }, RECONNECT_INTERVAL_MS);
}

export async function startOrderMonitor(client, settings) {
  if (settings) _settings = settings;
  await loadNotified();

  supabase = getDbWithRealtime();
  if (!supabase) {
    logger.warn('OrderMonitor', 'No Supabase — skipping');
    return;
  }

  await catchUp(client);
  setupRealtime(client);

  logger.info('OrderMonitor', 'Supabase Realtime active');

  return {
    unsubscribe: () => {
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
      if (channel && supabase) supabase.removeChannel(channel);
      channel = null;
    },
    flush: async () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      await persistNotified();
    },
  };
}
