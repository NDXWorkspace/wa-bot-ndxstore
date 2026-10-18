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
const FF = { slug: 'FF', label: 'Free Fire', kw: ['free fire', 'freefire'] };
const ROBUX = { slug: 'ROBUX', label: 'Robux Roblox', kw: ['robux', 'rbx', 'roblox'] };

const ORDER_KW = /\b(order|pesanan|pesan|status|proses|sampe|sampai|nyampe|masuk|udah|udh|belum|blm|blum|transaksi|gagal|refund|pending|cek|kapan)\b/i;
const PRICE_KW = /\b(harga|price|berapa|brp|murah|list|produk|item|diamond|dm|wdp|weekly|starlight|twilight|robux|rbx|joki|beli|jual|katalog|dijual|top\s*up|topup|stok|ready)\b/i;

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
  const games = GAMES.map(g => g.label).join(', ');
  const text =
    `INFO TOKO (real-time):\n` +
    `- Pembayaran: DANA, GoPay, transfer bank\n` +
    `- Top up Roblox (Robux & Gamepass per-game): ${games}\n` +
    `- Juga melayani Mobile Legends (ML) dan Free Fire (FF)\n` +
    `- Cek status order: user ketik "cek [username]" atau kasih order ID (NDXSTORE/... atau TX-xxxx)\n` +
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
  refreshStoreContext().catch(() => {});
  storeRefreshTimer = setInterval(() => refreshStoreContext().catch(() => {}), STORE_TTL_MS).unref();
}

export async function getStoreContext() {
  if (storeCache.text && Date.now() - storeCache.ts < STORE_TTL_MS) return storeCache.text;
  return refreshStoreContext();
}

// ─── Product price cache (per-game, background refresh) ────────────────

const productCache = new Map(); // gameSlug -> { text: string, items: Array<{name, price}>, ts: number }
const PRODUCT_CACHE_MAX = 25;

function normalizeCatalogItems(gameSlug, rawData) {
  if (gameSlug === 'ML') {
    const categories = Array.isArray(rawData?.detail_product)
      ? rawData.detail_product
      : Array.isArray(rawData)
        ? rawData.flatMap(r => Array.isArray(r?.detail_product) ? r.detail_product : [r])
        : [];
    const seen = new Set();
    const out = [];
    for (const cat of categories) {
      const list = Array.isArray(cat?.items) ? cat.items : (cat?.name ? [cat] : []);
      for (const it of list) {
        const name = String(it?.name || '').trim();
        const price = typeof it?.price === 'object'
          ? (it.price?.discount_price ?? it.price?.real_price)
          : it?.price;
        if (!name || price == null || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, price: Number(price) });
      }
    }
    return out;
  }
  const arr = Array.isArray(rawData) ? rawData : (Array.isArray(rawData?.products) ? rawData.products : []);
  return arr
    .filter(p => p?.name && p?.price != null)
    .map(p => ({ name: String(p.name).trim(), price: Number(p.price) }));
}

function formatProductSummary(game, items, queryText = '') {
  if (!items.length) return '';
  let selected = items.slice(0, 12);
  if (queryText) {
    const expandedQuery = queryText
      .toLowerCase()
      .replace(/\bwdp\b/g, 'weekly')
      .replace(/\bsl\b/g, 'starlight');
    const tokens = expandedQuery
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !['harga', 'berapa', 'brp', 'diamond', 'dm', 'ml', 'mlbb', 'mobile', 'legend', 'legends', 'free', 'fire', 'ff', 'roblox', 'robux', 'beli', 'top', 'up', 'kak', 'bang', 'min', 'mau', 'tanya', 'nanya', 'dong', 'ya'].includes(t));
    if (tokens.length) {
      let matched = items.filter(it => {
        const lowerName = it.name.toLowerCase();
        return tokens.some(tok => {
          if (/^\d+$/.test(tok)) return new RegExp(`\\b${tok}\\b`).test(lowerName);
          return lowerName.includes(tok);
        });
      });
      if (!matched.length) {
        const numTok = tokens.find(t => /^\d+$/.test(t));
        if (numTok) {
          const targetNum = Number(numTok);
          matched = items
            .map(it => {
              const m = it.name.match(/\b(\d+)\b/);
              return m ? { it, diff: Math.abs(Number(m[1]) - targetNum) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.diff - b.diff)
            .slice(0, 4)
            .map(x => x.it);
        }
      }
      if (matched.length) {
        const rest = items.filter(it => !matched.includes(it));
        selected = [...matched.slice(0, 8), ...rest.slice(0, Math.max(0, 12 - matched.length))];
      }
    }
  }
  const lines = selected.map(p => `- ${p.name}: ${formatPrice(p.price)}`);
  const shown = items.length > selected.length ? `${selected.length} dari ${items.length}` : `${items.length}`;
  return `DAFTAR HARGA ${game.label} (${shown} item):\n${lines.join('\n')}`;
}

async function refreshProducts(game, queryText = '') {
  try {
    if (game.slug === 'ROBUX') {
      const j = await getJson(`${config.apiBase}/api/belirbx/robux-rate`);
      const d = j?.data ?? j;
      if (!d || (!d.basePer100 && !d.markedUpPer100)) return '';
      const rate100 = Number(d.markedUpPer100 || d.basePer100 || 0);
      const inst100 = Number(d.instantPrice || 0);
      const text =
        `DAFTAR HARGA ${game.label} (Real-time):\n` +
        `- Robux Reguler (via Gamepass / 5 hari): ${formatPrice(rate100)} per 100 Robux (Stok: ${Number(d.stock || 0).toLocaleString('id-ID')}, min beli ${d.minPurchase || 25} Robux)\n` +
        (inst100 ? `- Robux Instant: ${formatPrice(inst100)} per 100 Robux (Stok: ${Number(d.instantStock || 0).toLocaleString('id-ID')})` : '');
      productCache.set(game.slug, { text, items: [], ts: Date.now() });
      return text;
    }

    const url = game.slug === 'ML'
      ? `${config.apiBase}/api/ml/products`
      : game.slug === 'FF'
        ? `${config.apiBase}/api/codashop/products?game=free-fire`
        : `${config.apiBase}/api/belirbx/products?game=${encodeURIComponent(game.slug)}`;
    const j = await getJson(url);
    const items = normalizeCatalogItems(game.slug, j?.data ?? j);
    if (!items.length) return '';
    const defaultText = formatProductSummary(game, items, '');
    productCache.set(game.slug, { text: defaultText, items, ts: Date.now() });
    if (productCache.size > PRODUCT_CACHE_MAX) {
      const oldest = productCache.keys().next().value;
      productCache.delete(oldest);
    }
    return queryText ? formatProductSummary(game, items, queryText) : defaultText;
  } catch { return ''; }
}

function getCachedProducts(game, queryText = '') {
  const cached = productCache.get(game.slug);
  if (cached && Date.now() - cached.ts < PRODUCT_TTL_MS) {
    if (cached.items?.length && queryText) {
      return formatProductSummary(game, cached.items, queryText);
    }
    return cached.text;
  }
  return null;
}

// ─── Per-message query context ─────────────────────────────────────────

function detectGame(lowerText) {
  if (/\b(mlbb|mobile legends?)\b/.test(lowerText) || /(?:^|\s)ml(?:\s|$)/.test(lowerText)) return ML;
  if (/\b(free\s*fire|freefire)\b/.test(lowerText) || /(?:^|\s)ff(?:\s|$)/.test(lowerText)) return FF;
  for (const g of GAMES) {
    if (g.kw.some(k => lowerText.includes(k))) return g;
  }
  if (/\b(robux|rbx|roblox)\b/.test(lowerText)) return ROBUX;
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
    const t = j?.data?.transaction ?? j?.transaction;
    if (!t) return '';
    return summarizeOrders([t], `${id}`);
  } catch { return ''; }
}

async function fetchOrdersByUser(username) {
  try {
    const clean = username.trim();
    const j = await getJson(`${config.apiBase}/api/transactions/user/${encodeURIComponent(clean)}`);
    let txs = j?.data?.transactions ?? j?.transactions;
    if ((!Array.isArray(txs) || !txs.length) && clean.length >= 3) {
      const s = await getJson(`${config.apiBase}/api/transactions/search/${encodeURIComponent(clean)}`);
      txs = s?.data?.transactions ?? s?.transactions;
    }
    if (!Array.isArray(txs) || !txs.length) return '';
    return summarizeOrders(txs, `"${clean}"`);
  } catch { return ''; }
}

async function fetchProducts(game, queryText = '') {
  const cached = getCachedProducts(game, queryText);
  if (cached) return cached;
  return refreshProducts(game, queryText);
}

export async function getQueryContext(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const jobs = [];

  const idMatch = text.match(/\b(NDXSTORE\/[A-Z0-9_-]+(?:\/[A-Z0-9_-]+){1,6}|(?:TX|TXN|NDX)-[A-Z0-9]+)\b/i);
  if (idMatch) {
    jobs.push(fetchOrderById(idMatch[1].toUpperCase()));
  } else if (ORDER_KW.test(lower)) {
    const uname = extractUsername(text);
    if (uname) jobs.push(fetchOrdersByUser(uname));
  }

  if (PRICE_KW.test(lower)) {
    const game = detectGame(lower);
    if (game) jobs.push(fetchProducts(game, text));
  }

  if (!jobs.length) return '';
  const results = await Promise.all(jobs);
  return results.filter(Boolean).join('\n\n');
}

