import { getDb } from './supabase.js';

const DEFAULTS = {
  menu_text: `━━━ *NDXSTORE* ━━━
0 Menu
1 Cek status order
2 Produk & harga
3 Cara order
4 Hubungi CS
5 Info pembayaran
━━━━━━━━━━━━━━━
Ketik angka untuk pilih menu`,
  info_produk: `📦 *Produk & Harga*\n\nKunjungi: https://ndxstoreid.vercel.app`,
  cara_order: `📝 *Cara Order*\n\n1. Kunjungi ndxstoreid.vercel.app\n2. Pilih produk & lakukan pembayaran\n3. Kami akan proses pesananmu`,
  info_pembayaran: `💳 *Info Pembayaran*\n\nDANA: 6285159898005 a.n NDXSTORE\n\nWA Admin: 6285159898005\n\nKonfirmasi setelah bayar ya!`,
};

const cache = { ...DEFAULTS };

async function loadFromDb() {
  try {
    const db = getDb();
    if (!db) return;
    const { data } = await db
      .from('wa_bot_config')
      .select('key, value')
      .in('key', Object.keys(DEFAULTS));
    if (!data?.length) return;
    for (const row of data) {
      if (row.value && typeof row.value === 'string') {
        cache[row.key] = row.value;
      }
    }
  } catch {}
}

loadFromDb();

export function getMenuText() { return cache.menu_text; }
export function getInfoProduk() { return cache.info_produk; }
export function getCaraOrder() { return cache.cara_order; }
export function getInfoPembayaran() { return cache.info_pembayaran; }
