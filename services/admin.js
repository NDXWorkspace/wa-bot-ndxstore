import { config } from '../config.js';
import { VALID_ORDER_STATUSES } from '../utils/constants.js';

export async function apiCall(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiPassword) {
    headers['x-admin-password'] = config.apiPassword;
  }
  // API admin sekarang wajib sesi login Google owner (NextAuth).
  // Isi NDX_SESSION di .env dengan cookie dari browser yang sudah login
  // (lihat README). Cookie dikirim apa adanya.
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
        'Sesi admin Google kedaluwarsa/ditolak. Login ulang di ndxstoreid.vercel.app ' +
        'dengan akun owner, update NDX_SESSION di .env, lalu restart bot. ' +
        `(${text.slice(0, 100)})`
      );
    }
    throw new Error(`API ${resp.status}: ${text.slice(0, 100)}`);
  }
  return await resp.json();
}

export async function getStoreStats() {
  const data = await apiCall('GET', '/api/admin/stats');
  if (!data?.success || !data?.stats) throw new Error('Gagal ambil statistik');
  return data.stats;
}

export async function getRecentOrders(limit = 5) {
  const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const data = await apiCall('GET', `/api/admin/transactions?limit=${n}&sort=createdAt&sortDir=desc`);
  if (!data?.success) throw new Error('Gagal ambil order');
  return { transactions: data.transactions || [], total: data.total ?? null };
}

export async function getPendingOrders(game = '') {
  let path = '/api/admin/transactions?paymentStatus=PENDING&sort=createdAt&sortDir=desc';
  if (game) path += `&game=${encodeURIComponent(game)}`;
  const data = await apiCall('GET', path);
  if (!data?.success) throw new Error('Gagal ambil pending');
  return { transactions: data.transactions || [], total: data.total ?? null };
}

export async function getOrderDetail(txId) {
  const id = String(txId || '').trim().toUpperCase();
  if (!id.startsWith('NDX-')) throw new Error('Format ID salah (contoh: NDX-XXXX)');
  const data = await apiCall('GET', `/api/transaction/${id}`);
  if (!data?.success) throw new Error('Transaksi tidak ditemukan');
  return data.transaction || data;
}

export async function updateOrderStatus(txId, statusArg) {
  const id = String(txId || '').trim().toUpperCase();
  const status = String(statusArg || '').trim().toUpperCase();
  if (!id.startsWith('NDX-')) throw new Error('Format ID salah (contoh: NDX-XXXX)');
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
  const data = await apiCall('POST', `/api/admin/transaction/${id}/status`, payload);
  if (!data?.success) throw new Error(`Gagal update: ${data?.message || 'unknown'}`);
  const updated = data.transaction || data;
  return {
    id,
    orderStatus: updated.orderStatus || updated.order_status || '-',
    paymentStatus: updated.paymentStatus || updated.payment_status || '-',
  };
}
