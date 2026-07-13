import { config } from '../config.js';
import { formatPrice, formatTime } from '../utils/format.js';
import { VALID_ORDER_STATUSES } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

const API_BASE = process.env.API_BASE || 'https://ndxstoreid.vercel.app';

async function apiCall(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiPassword) {
    headers['x-admin-password'] = config.apiPassword;
  }
  const opts = { method, headers, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${API_BASE}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text.slice(0, 100)}`);
  }
  return await resp.json();
}

function formatStats(data) {
  if (!data?.success || !data?.stats) return '❌ Gagal ambil statistik.';
  const s = data.stats;
  let msg = `📊 *STATISTIK NDXSTORE*\n━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📦 *Total Transaksi:* ${s.totalTransactions || 0}\n`;
  msg += `💰 *Total Revenue:* ${formatPrice(s.totalRevenue)}\n`;
  msg += `⏳ *Pending Payment:* ${s.pendingPayments || 0} (${formatPrice(s.pendingAmount)})\n`;
  msg += `📋 *Pending Orders:* ${s.pendingOrders || 0}\n━━━━━━━━━━━━━━━━━━━\n`;
  if (s.successToday !== undefined) {
    msg += `📅 *Hari Ini*\n✅ Sukses: ${s.successToday}\n💰 Revenue: ${formatPrice(s.revenueToday)}\n`;
  }
  return msg;
}

function formatOrderList(orders, title) {
  if (!orders?.length) return `📋 ${title || 'Order'}\n━━━━━━━━━━━━━━\n(Tidak ada)`;
  let msg = `📋 *${title || 'Order'}*\n━━━━━━━━━━━━━━\n`;
  for (const o of orders.slice(0, 10)) {
    const status = o.orderStatus || o.order_status || o.paymentStatus || '-';
    msg += `\n🆔 ${o.id || '-'}\n👤 ${o.username || o.robloxDisplayName || '-'}\n📦 ${o.productName || o.product_name || '-'}\n💰 ${formatPrice(o.priceIdr ?? o.price_idr)}\n📊 ${status}\n⏰ ${formatTime(o.createdAt || o.created_at)}\n━━━━━━━━━━━━━━`;
  }
  return msg;
}

function formatOrderDetail(tx) {
  if (!tx) return '❌ Transaksi tidak ditemukan.';
  const t = tx.transaction || tx;
  let msg = `📋 *DETAIL ORDER*\n━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🆔 *ID:* ${t.id || '-'}\n👤 *User:* ${t.username || '-'}\n`;
  msg += `🎮 *Game:* ${t.gameName || t.game_name || '-'}\n`;
  msg += `📦 *Produk:* ${t.productName || t.product_name || '-'}\n`;
  msg += `💰 *Harga:* ${formatPrice(t.priceIdr ?? t.price_idr)}\n`;
  msg += `💳 *Bayar:* ${t.paymentMethod || t.payment_method || '-'}\n`;
  msg += `📊 *Status:* ${t.orderStatus || t.order_status || '-'}\n`;
  msg += `💳 *Payment:* ${t.paymentStatus || t.payment_status || '-'}\n`;
  msg += `📞 *WA:* ${t.waNumber || t.wa_number || '-'}\n📧 *Email:* ${t.email || '-'}\n`;
  msg += `📦 *Qty:* ${t.quantity || 1}\n`;

  if (t.robloxId || t.roblox_id) msg += `🆔 *Roblox ID:* ${t.robloxId || t.roblox_id}\n`;
  if (t.robloxPassword || t.roblox_password) msg += `🔑 *Password:* ${t.robloxPassword || t.roblox_password}\n`;
  if (t.backupCode || t.backup_code) msg += `🔐 *Backup Code:* ${t.backupCode || t.backup_code}\n`;
  if (t.contactAdmin || t.contact_admin) msg += `🔐 *Butuh 2FA*\n`;

  const ml = t.mlData || t.ml_data;
  if (ml && typeof ml === 'object') {
    msg += `🆔 *ML ID:* ${ml.userId || ml.user_id || '-'}\n🌍 *Zone:* ${ml.zoneId || ml.zone_id || '-'}\n`;
  }

  msg += `⏰ *Dibuat:* ${formatTime(t.createdAt || t.created_at)}\n`;
  if (t.updatedAt || t.updated_at) msg += `🔄 *Update:* ${formatTime(t.updatedAt || t.updated_at)}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━`;
  return msg;
}

const HELPTEXT = `📋 *ADMIN COMMANDS*\n━━━━━━━━━━━━━━━━━━━
!help — List command
!stats — Statistik
!orders — 5 order terbaru
!pending — Order pending
!pending [game] — Filter by game
!detail NDX-XXXX — Detail order
!status NDX-XXXX STATUS — Update status
━━━━━━━━━━━━━━━━━━━`;

export async function handleAdminCommand(client, msg, body) {
  if (body === '!groupid') {
    const isGroup = msg.to.includes('@g.us');
    const jid = msg.to.replace(/@(g\.us|s\.whatsapp\.net)/g, '');
    await msg.reply(isGroup
      ? `Group ID: ${jid}@g.us\n\nSimpan di .env:\nGROUP_ID=${jid}@g.us`
      : 'Ini bukan grup.');
    if (isGroup) logger.info('Bot', 'Group ID:', jid);
    return true;
  }

  if (body === '!help') {
    await msg.reply(HELPTEXT);
    return true;
  }

  if (body === '!stats') {
    try {
      const data = await apiCall('GET', '/api/admin/stats');
      await msg.reply(formatStats(data));
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return true;
  }

  if (body === '!orders') {
    try {
      const data = await apiCall('GET', '/api/admin/transactions?limit=5&sort=createdAt&sortDir=desc');
      if (!data?.success) return await msg.reply('❌ Gagal ambil order.');
      await msg.reply(formatOrderList(data.transactions, '5 ORDER TERBARU'));
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return true;
  }

  if (body === '!pending' || body.startsWith('!pending ')) {
    try {
      const game = body.slice(9).trim();
      let path = '/api/admin/transactions?paymentStatus=PENDING&sort=createdAt&sortDir=desc';
      if (game) path += `&game=${encodeURIComponent(game)}`;
      const data = await apiCall('GET', path);
      if (!data?.success) return await msg.reply('❌ Gagal ambil pending.');
      const title = game ? `PENDING: ${game}` : 'ORDER PENDING';
      const totalInfo = data.total ? ` (${data.total} total)` : '';
      await msg.reply(formatOrderList(data.transactions, `${title}${totalInfo}`));
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return true;
  }

  if (body.startsWith('!detail ')) {
    const txId = body.slice(8).trim().toUpperCase();
    if (!txId.startsWith('NDX-')) return await msg.reply('❌ Format ID salah. Contoh: !detail NDX-XXXX');
    try {
      const data = await apiCall('GET', `/api/transaction/${txId}`);
      if (!data?.success) return await msg.reply('❌ Transaksi tidak ditemukan.');
      await msg.reply(formatOrderDetail(data));
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return true;
  }

  if (body.startsWith('!status ')) {
    const rest = body.slice(8).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx <= 0) return await msg.reply('❌ Format: !status NDX-XXXX STATUS');

    const txId = rest.slice(0, spaceIdx).toUpperCase();
    const statusArg = rest.slice(spaceIdx + 1).toUpperCase();

    if (!txId.startsWith('NDX-')) return await msg.reply('❌ Format ID salah.');
    if (!VALID_ORDER_STATUSES.includes(statusArg)) {
      return await msg.reply(`❌ Status tidak valid. Pilih: ${VALID_ORDER_STATUSES.join(', ')}`);
    }

    try {
      const body = {};
      if (['SUCCESS', 'REJECTED', 'PENDING'].includes(statusArg)) {
        body.paymentStatus = statusArg;
        body.status = statusArg;
      }
      if (['PROCESSING', 'SUCCESS', 'REJECTED', 'WAITING_PAYMENT'].includes(statusArg)) {
        body.orderStatus = statusArg;
      }

      const data = await apiCall('POST', `/api/admin/transaction/${txId}/status`, body);
      if (!data?.success) return await msg.reply(`❌ Gagal update: ${data?.message || 'unknown'}`);

      const updated = data.transaction || data;
      const os = updated.orderStatus || updated.order_status || '-';
      const ps = updated.paymentStatus || updated.payment_status || '-';

      await msg.reply(`✅ *Status diupdate*\n🆔 ${txId}\n📊 Order: ${os}\n💳 Payment: ${ps}`);
    } catch (e) {
      await msg.reply(`❌ Error: ${e.message}`);
    }
    return true;
  }

  return false;
}
