import { getDb } from './supabase.js';
import { withRetry } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

function getDefaults() {
  const admin = config.adminNumber;
  return {
    menu_text: `━━━ *NDXSTORE* ━━━
0 Menu
1 Cek status order
2 Produk & harga
3 Cara order
4 Hubungi CS
5 Info pembayaran
6 Keluar
━━━━━━━━━━━━━━━
Ketik angka untuk pilih menu`,
    info_produk: `📦 *Produk & Harga*\n\nKunjungi: ${config.apiBase || 'https://ndxstoreid.vercel.app'}`,
    cara_order: `📝 *Cara Order*\n\n1. Kunjungi ${config.apiBase || 'https://ndxstoreid.vercel.app'}\n2. Pilih produk & lakukan pembayaran\n3. Kami akan proses pesananmu`,
    info_pembayaran: `💳 *Info Pembayaran*\n\nDANA: ${admin} a.n NDXSTORE\n\nWA Admin: ${admin}\n\nKonfirmasi setelah bayar ya!`,
  };
}

const cache = {};

let menuLoadPromise = null;
let menuLoadTs = 0;
const MENU_CACHE_TTL = 300000;

async function loadFromDb() {
  const defaults = getDefaults();
  // Fill cache with defaults first if empty
  for (const [k, v] of Object.entries(defaults)) {
    if (!cache[k]) cache[k] = v;
  }
  if (menuLoadTs > 0 && Date.now() - menuLoadTs < MENU_CACHE_TTL) return;
  if (menuLoadPromise) return menuLoadPromise;
  menuLoadPromise = (async () => {
    try {
      const db = getDb();
      if (!db) return;
      const { data } = await withRetry(() => db
        .from('wa_bot_config')
        .select('key, value')
        .in('key', Object.keys(defaults)), { label: 'Menu:load', maxRetries: 1 });
      if (!data?.length) return;
      for (const row of data) {
        if (row.value) {
          const val = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
          cache[row.key] = val;
        }
      }
      menuLoadTs = Date.now();
      logger.info('Menu', 'Loaded from DB');
    } catch {}
  })();
  await menuLoadPromise;
  menuLoadPromise = null;
}

let refreshTimer = null;
export function startMenuRefresh() {
  loadFromDb();
  refreshTimer = setInterval(() => loadFromDb().catch(() => {}), 5 * 60 * 1000);
}

export function getMenuText() { return cache.menu_text; }
export function getInfoProduk() { return cache.info_produk; }
export function getCaraOrder() { return cache.cara_order; }
export function getInfoPembayaran() { return cache.info_pembayaran; }
