import { config } from '../config.js';
import { getDb } from './supabase.js';
import { VALID_ORDER_STATUSES } from '../utils/constants.js';

export async function apiCall(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiPassword) {
    headers['x-admin-password'] = config.apiPassword;
  }
  // Auth utama admin API: x-bot-token (statis, tanpa expiry, sejajar sesi
  // Google owner di sisi server). Isi NDX_BOT_TOKEN di .env = BOT_API_TOKEN
  // di Vercel. Lihat ndxstoreid/docs/bot-auth.md.
  if (config.botToken) {
    headers['x-bot-token'] = config.botToken;
  }
  // Fallback: cookie browser (kalau ada sesi cookie di masa depan).
  if (config.ndxSession) {
    headers['Cookie'] = config.ndxSession;
  }
  const opts = { method, headers, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${config.apiBase}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 401) {
      throw new Error(
        'Admin API menolak auth. Cek: (1) NDX_BOT_TOKEN di .env sama dengan ' +
        'BOT_API_TOKEN di Vercel (sudah redeploy?), (2) token min 16 karakter. ' +
        `(${text.slice(0, 100)})`
      );
    }
    if (resp.status === 500 && text.includes('belum dikonfigurasi')) {
      throw new Error(
        'BOT_API_TOKEN belum dipasang di server (Vercel). Pasang env + redeploy. ' +
        `(${text.slice(0, 100)})`
      );
    }
    throw new Error(`API ${resp.status}: ${text.slice(0, 100)}`);
  }
  return await resp.json();
}

function hasAdminApiAuth() {
  return Boolean(config.botToken || config.ndxSession);
}

export async function getStoreStats() {
  if (hasAdminApiAuth()) {
    try {
      const data = await apiCall('GET', '/api/admin/stats');
      const payload = data?.data ?? data;
      if (data?.success && payload?.stats) return payload.stats;
    } catch (e) {
      if (!getDb()) throw e;
    }
  }
  const db = getDb();
  if (!db) throw new Error('Gagal ambil statistik (DB tidak tersedia)');
  const { data: rows, error } = await db.from('transactions').select('*');
  if (error) throw new Error(`Gagal ambil statistik: ${error.message}`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const stats = {
    totalRevenue: 0,
    totalTransactions: (rows || []).length,
    pendingPayments: 0,
    pendingAmount: 0,
    successToday: 0,
    revenueToday: 0,
    pendingOrders: 0,
  };
  for (const tx of rows || []) {
    const p = Number(tx.price_idr ?? tx.priceIdr ?? 0);
    const ps = String(tx.payment_status ?? tx.paymentStatus ?? tx.status ?? '').toUpperCase();
    const os = String(tx.order_status ?? tx.orderStatus ?? '').toUpperCase();
    if (ps !== 'SUCCESS') {
      if (ps === 'PENDING') {
        stats.pendingPayments++;
        stats.pendingAmount += p;
      }
      if (os === 'WAITING_PAYMENT' || os === 'PENDING') stats.pendingOrders++;
      continue;
    }
    stats.totalRevenue += p;
    if (os === 'WAITING_PAYMENT' || os === 'PENDING') stats.pendingOrders++;
    const txDate = new Date(String(tx.created_at ?? tx.createdAt ?? 0));
    if (txDate >= today) {
      stats.successToday++;
      stats.revenueToday += p;
    }
  }
  return stats;
}

export async function getRecentOrders(limit = 5) {
  const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
  if (hasAdminApiAuth()) {
    try {
      const data = await apiCall('GET', `/api/admin/transactions?limit=${n}&sort=createdAt&sortDir=desc`);
      const payload = data?.data ?? data;
      if (data?.success) {
        return { transactions: payload.transactions || [], total: payload.total ?? null };
      }
    } catch (e) {
      if (!getDb()) throw e;
    }
  }
  const db = getDb();
  if (!db) throw new Error('Gagal ambil order');
  const { data: rows, count, error } = await db
    .from('transactions')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(n);
  if (error) throw new Error(`Gagal ambil order: ${error.message}`);
  return { transactions: rows || [], total: count ?? (rows || []).length };
}

export async function getPendingOrders(game = '') {
  if (hasAdminApiAuth()) {
    try {
      let path = '/api/admin/transactions?paymentStatus=PENDING&sort=createdAt&sortDir=desc';
      if (game) path += `&game=${encodeURIComponent(game)}`;
      const data = await apiCall('GET', path);
      const payload = data?.data ?? data;
      if (data?.success) {
        return { transactions: payload.transactions || [], total: payload.total ?? null };
      }
    } catch (e) {
      if (!getDb()) throw e;
    }
  }
  const db = getDb();
  if (!db) throw new Error('Gagal ambil pending');
  let q = db
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('payment_status', 'PENDING')
    .order('created_at', { ascending: false });
  if (game) q = q.ilike('game_name', `%${game}%`);
  const { data: rows, count, error } = await q;
  if (error) throw new Error(`Gagal ambil pending: ${error.message}`);
  return { transactions: rows || [], total: count ?? (rows || []).length };
}

// ID order valid: NDXSTORE/SERVICE/KATEGORI/VARIANT/KODE (format baru),
// NDX-xxxx (legacy web), atau TX-/TXN-xxxx (ID transaksi payment).
// Panel harus menerima semua yang AI kenali — kalau tidak, hasil "cek" dari
// chat tidak bisa dicari/diupdate lewat panel.
export const ORDER_ID_RE = /^(?:(?:NDX|TX|TXN)-[A-Z0-9]+|NDXSTORE\/[A-Z0-9_-]+(?:\/[A-Z0-9_-]+){1,6})$/i;
function normalizeOrderId(txId) {
  const id = String(txId || '').trim().toUpperCase();
  if (!ORDER_ID_RE.test(id)) throw new Error('Format ID salah (contoh: NDXSTORE/... atau NDX-XXXX)');
  return id;
}

export async function getOrderDetail(txId) {
  const id = normalizeOrderId(txId);
  try {
    const data = await apiCall('GET', `/api/transaction/${encodeURIComponent(id)}`);
    const payload = data?.data ?? data;
    if (data?.success && (payload?.transaction || payload?.id)) {
      return payload.transaction || payload;
    }
  } catch (e) {
    if (!getDb()) throw e;
  }
  const db = getDb();
  if (db) {
    const { data: row, error } = await db.from('transactions').select('*').eq('id', id).maybeSingle();
    if (!error && row) return row;
  }
  throw new Error('Transaksi tidak ditemukan');
}

export async function updateOrderStatus(txId, statusArg) {
  const id = normalizeOrderId(txId);
  const status = String(statusArg || '').trim().toUpperCase();
  if (!VALID_ORDER_STATUSES.includes(status)) {
    throw new Error(`Status tidak valid. Pilih: ${VALID_ORDER_STATUSES.join(', ')}`);
  }
  const payload = {};
  if (['SUCCESS', 'REJECTED', 'PENDING'].includes(status)) {
    payload.paymentStatus = status;
    payload.status = status;
  }
  if (['PROCESSING', 'SUCCESS', 'REJECTED', 'WAITING_PAYMENT'].includes(status)) {
    payload.orderStatus = status;
  }
  if (hasAdminApiAuth()) {
    const data = await apiCall('POST', `/api/admin/transaction/${encodeURIComponent(id)}/status`, payload);
    if (!data?.success) throw new Error(`Gagal update: ${data?.message || 'unknown'}`);
    const resData = data?.data ?? data;
    const updated = resData.transaction || resData;
    return {
      id,
      orderStatus: updated.orderStatus || updated.order_status || '-',
      paymentStatus: updated.paymentStatus || updated.payment_status || '-',
    };
  }
  const db = getDb();
  if (!db) throw new Error('NDX_BOT_TOKEN belum diisi dan DB tidak tersedia');
  const { data: existing, error: findErr } = await db.from('transactions').select('*').eq('id', id).maybeSingle();
  if (findErr || !existing) throw new Error('Transaksi tidak ditemukan');
  const dbUpdates = { updated_at: new Date().toISOString() };
  if (payload.paymentStatus) {
    dbUpdates.payment_status = payload.paymentStatus;
    dbUpdates.status = payload.status;
  }
  if (payload.orderStatus) {
    dbUpdates.order_status = payload.orderStatus;
  }
  const { data: updated, error: upErr } = await db
    .from('transactions')
    .update(dbUpdates)
    .eq('id', id)
    .select('*')
    .single();
  if (upErr) throw new Error(`Gagal update: ${upErr.message}`);
  return {
    id,
    orderStatus: updated.order_status || updated.orderStatus || '-',
    paymentStatus: updated.payment_status || updated.paymentStatus || '-',
  };
}

