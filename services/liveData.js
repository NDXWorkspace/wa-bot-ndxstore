// Gives the AI real, live data from the NDXStore API so it answers about prices
// and order status accurately instead of hallucinating. All fetches fail soft
// (return '') so the AI still replies from its base knowledge if the API is down.
//
// - Store context refreshes every 5 min in background (no wait on first call)
// - Product prices cached per-game with 5 min TTL
// - All fetches fail soft

import { config } from '../config.js';
import { formatPrice, formatTime } from '../utils/format.js';
import { pick } from '../utils/fieldResolver.js';
import { logger, throttleLog } from '../utils/logger.js';
import { bumpStoreCacheVersion } from '../utils/cache.js';

const TIMEOUT_MS = 9000;
const STORE_TTL_MS = 5 * 60 * 1000;
const PRODUCT_TTL_MS = 5 * 60 * 1000;

// ─── Games ─────────────────────────────────────────────────────────────

const GAMES = [
  { slug: 'bloxfruit', label: 'Blox Fruits', kw: ['blox fruit', 'bloxfruit', 'blox fruits'] },
  { slug: 'grow-a-garden-2', label: 'Grow a Garden', kw: ['grow a garden', 'grow garden', 'gag'] },
  { slug: 'brookhaven', label: 'Brookhaven', kw: ['brookhaven'] },
  { slug: 'jailbreak', label: 'Jailbreak', kw: ['jailbreak'] },
  { slug: 'fisch', label: 'Fisch', kw: ['fisch'] },
  { slug: 'blade-ball', label: 'Blade Ball', kw: ['blade ball', 'bladeball'] },
  { slug: 'bloxburg', label: 'Bloxburg', kw: ['bloxburg', 'blox burg'] },
  { slug: 'rivals', label: 'Rivals', kw: ['rivals'] },
  { slug: 'forsaken', label: 'Forsaken', kw: ['forsaken'] },
  { slug: 'slime-rng', label: 'Slime RNG', kw: ['slime rng', 'slime'] },
  { slug: 'towerdefense', label: 'Tower Defense', kw: ['tower defense', 'towerdefense', 'tds'] },
  { slug: 'driving-empire', label: 'Driving Empire', kw: ['driving empire'] },
  { slug: 'animevanguard', label: 'Anime Vanguard', kw: ['anime vanguard', 'animevanguard'] },
  { slug: 'car-driving-indonesia', label: 'Car Driving Indonesia', kw: ['car driving'] },
  { slug: 'simulasi-drag-drive', label: 'Simulasi Drag Drive', kw: ['drag drive', 'simulasi drag'] },
  { slug: 'bus-explorer-indonesia', label: 'Bus Explorer Indonesia', kw: ['bus explorer'] },
  { slug: 'midnight-chaser', label: 'Midnight Chaser', kw: ['midnight chaser'] },
  { slug: 'eagle-nation', label: 'Eagle Nation', kw: ['eagle nation'] },
];
const ML = { slug: 'ML', label: 'Mobile Legends', kw: ['mobile legend', 'mobile legends', 'mlbb'] };

const ORDER_KW = /\b(order|pesanan|pesan|status|proses|sampe|sampai|nyampe|masuk|udah|udh|belum|blm|blum|transaksi|gagal|refund|pending|cek|kapan)\b/i;
const PRICE_KW = /\b(harga|price|berapa|brp|murah|list|produk|item|diamond|robux|joki|beli|jual|katalog|dijual)\b/i;

const NON_USERNAMES = new Set([
  'DANA', 'GOPAY', 'OVO', 'NDX', 'ML', 'MLBB', 'CS', 'WA', 'ID', 'OK', 'OKE', 'TX', 'TXN',
  'ROBLOX', 'ROBUX', 'NDXSTORE', 'DIAMOND', 'WKWK', 'GG', 'HALO', 'HELLO', 'HI', 'MENU', 'CEK',
  'YA', 'YES', 'NO', 'DONG', 'WOI', 'WOY', 'THX', 'THANKS', 'MIN', 'BANG', 'KAK', 'BOT', 'AI',
  'PING', 'TEST', 'LOL', 'OMG', 'XD', 'GA', 'GAK', 'SIP', 'OTW', 'PM', 'DM', 'YAUDAH',
  'TOP', 'UP', 'GAME', 'FREE', 'FIRE', 'VALORANT', 'DLL', 'RP', 'IDR', 'WEB', 'APP',
]);

async function getJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) return null;
  return resp.json();
}

// ─── Store context (cached, background refresh) ────────────────────────

let storeCache = { text: '', ts: 0 };
let storeRefreshTimer = null;

async function refreshStoreContext() {
  let dana = 'DANA';
  let admin = 'Admin';
  try {
    const j = await getJson(`${config.apiBase}/api/config`);
    if (j?.data) {
      dana = j.data.danaNumber || dana;
      admin = j.data.waNumber || j.data.adminWa || admin;
    }
  } catch (e) {
    throttleLog('debug', 'LiveData', 'config-fetch', `config fetch failed: ${e.message}`, 30000);
  }

  const games = GAMES.map(g => g.label).join(', ');
  const text =
    `INFO TOKO (real-time):\n` +
    `- Pembayaran: DANA, GoPay, transfer bank\n` +
    `- Top up Roblox per-game: ${games}\n` +
    `- Juga melayani Mobile Legends (ML)\n` +
    `- Cek status order: user ketik "cek [username]" atau kasih order ID (TX-xxxx)\n` +
    `- Kalo perlu cs / admin, arahin kirim "cs"`;

  if (text !== storeCache.text) {
    storeCache = { text, ts: Date.now() };
    bumpStoreCacheVersion();
  } else {
    storeCache.ts = Date.now();
  }
  return text;
}

export function startLiveDataRefresh() {
  refreshStoreContext();
  storeRefreshTimer = setInterval(() => refreshStoreContext().catch(() => {}), STORE_TTL_MS).unref();
}

export async function getStoreContext() {
  if (storeCache.text && Date.now() - storeCache.ts < STORE_TTL_MS) return storeCache.text;
  return refreshStoreContext();
}

// ─── Product price cache (per-game, background refresh) ────────────────

const productCache = new Map(); // gameSlug -> { text: string, ts: number }
const PRODUCT_CACHE_MAX = 20;

async function refreshProducts(game) {
  try {
    const url = game.slug === 'ML'
      ? `${config.apiBase}/api/ml/products`
      : `${config.apiBase}/api/belirbx/products?game=${encodeURIComponent(game.slug)}`;
    const j = await getJson(url);
    const items = Array.isArray(j?.data) ? j.data : [];
    if (!items.length) return '';
    const lines = items
      .slice(0, 10)
      .map(p => `- ${p.name}: ${formatPrice(p.price)}`);
    const shown = items.length > 10 ? `top 10 dari ${items.length}` : `${items.length}`;
    const text = `DAFTAR HARGA ${game.label} (${shown} item):\n${lines.join('\n')}`;
    productCache.set(game.slug, { text, ts: Date.now() });
    // Cap cache (D5)
    if (productCache.size > PRODUCT_CACHE_MAX) {
      const oldest = productCache.keys().next().value;
      productCache.delete(oldest);
    }
    return text;
  } catch { return ''; }
}

function getCachedProducts(game) {
  const cached = productCache.get(game.slug);
  if (cached && Date.now() - cached.ts < PRODUCT_TTL_MS) return cached.text;
  return null;
}

// ─── Per-message query context ─────────────────────────────────────────

function detectGame(lowerText) {
  if (/\b(mlbb|mobile legends?)\b/.test(lowerText) || /(?:^|\s)ml(?:\s|$)/.test(lowerText)) return ML;
  for (const g of GAMES) {
    if (g.kw.some(k => lowerText.includes(k))) return g;
  }
  return null;
}

function extractUsername(text) {
  const labelled = text.match(/(?:username|user|ign|akun|nick|nama)\s*[:=]?\s*([A-Za-z0-9_]{3,20})/i);
  if (labelled) return labelled[1];
  const caps = text.match(/\b([A-Z][A-Z0-9_]{2,19})\b/);
  if (caps && !NON_USERNAMES.has(caps[1].toUpperCase()) && !/^(.)\1+$/.test(caps[1])) return caps[1];
  return null;
}

function summarizeOrders(txs, who) {
  const top = txs.slice(0, 3).map(o => {
    const status = pick(o, 'orderStatus', 'order_status') || pick(o, 'paymentStatus', 'payment_status') || '-';
    return `- ${o.id} | ${pick(o, 'productName', 'product_name') || '-'} | ${status} | ${formatTime(pick(o, 'createdAt', 'created_at'))}`;
  });
  return `STATUS ORDER ${who} (${txs.length} order):\n${top.join('\n')}`;
}

async function fetchOrderById(id) {
  try {
    const j = await getJson(`${config.apiBase}/api/transaction/${encodeURIComponent(id)}`);
    const t = j?.transaction;
    if (!t) return '';
    return summarizeOrders([t], `${id}`);
  } catch { return ''; }
}

async function fetchOrdersByUser(username) {
  try {
    const j = await getJson(`${config.apiBase}/api/transactions/user/${encodeURIComponent(username.trim())}`);
    const txs = j?.transactions;
    if (!Array.isArray(txs) || !txs.length) return '';
    return summarizeOrders(txs, `"${username}"`);
  } catch { return ''; }
}

async function fetchProducts(game) {
  const cached = getCachedProducts(game);
  if (cached) return cached;
  return refreshProducts(game);
}

export async function getQueryContext(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const jobs = [];

  const idMatch = text.match(/\b((?:TX|TXN|NDX)-[A-Z0-9]+)\b/i);
  if (idMatch) {
    jobs.push(fetchOrderById(idMatch[1].toUpperCase()));
  } else if (ORDER_KW.test(lower)) {
    const uname = extractUsername(text);
    if (uname) jobs.push(fetchOrdersByUser(uname));
  }

  if (PRICE_KW.test(lower)) {
    const game = detectGame(lower);
    if (game) jobs.push(fetchProducts(game));
  }

  if (!jobs.length) return '';
  const results = await Promise.all(jobs);
  return results.filter(Boolean).join('\n\n');
}
