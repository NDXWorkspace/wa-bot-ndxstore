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
  'DANA', 'GOPAY', 'OVO', 'QRIS', 'BCA', 'BRI', 'BNI', 'MANDIRI', 'NDX', 'ML', 'MLBB', 'CS', 'WA', 'ID',
  'OK', 'OKE', 'TX', 'TXN', 'ROBLOX', 'ROBUX', 'RBX', 'NDXSTORE', 'DIAMOND', 'DM', 'WDP', 'WKWK', 'GG',
  'HALO', 'HELLO', 'HI', 'HAI', 'MENU', 'CEK', 'CEKIN', 'YA', 'YAA', 'YES', 'NO', 'DONG', 'WOI', 'WOY',
  'THX', 'THANKS', 'MAKASIH', 'MIN', 'ADMIN', 'BANG', 'BG', 'KAK', 'KA', 'BRO', 'GAN', 'SIS', 'BIMA',
  'BOT', 'AI', 'PING', 'TEST', 'TES', 'LOL', 'OMG', 'XD', 'GA', 'GAK', 'GK', 'NGGAK', 'SIP', 'SIAP',
  'OTW', 'PM', 'YAUDAH', 'TOP', 'UP', 'TOPUP', 'GAME', 'FREE', 'FIRE', 'FF', 'VALORANT', 'DLL', 'RP',
  'IDR', 'WEB', 'APP', 'ORDER', 'ORDERAN', 'PESAN', 'PESANAN', 'STATUS', 'PROSES', 'MASUK', 'BELUM',
  'UDAH', 'SUDAH', 'BLUM', 'BLM', 'UDH', 'SDH', 'LAMA', 'BANGET', 'BGT', 'MANA', 'KAPAN', 'BERAPA',
  'BRP', 'HARGA', 'BELI', 'BAYAR', 'TRANSFER', 'TF', 'BUKTI', ' TOLONG', 'BANTU', 'MAU', 'NANYA', 'TANYA',
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
    `- Website resmi order: ndxstoreid.vercel.app\n` +
    `- Pembayaran: QRIS, DANA, GoPay, OVO, Transfer Bank (otomatis di web)\n` +
    `- Top up Roblox (Robux Reguler 5 hari, Robux Instant, & Gamepass/Item per-game): ${games}\n` +
    `- Top up Game Lain: Mobile Legends (Diamonds, Weekly Diamond Pass / WDP, Twilight Pass) & Free Fire (Diamonds, Membership)\n` +
    `- Cek status order: user bisa ketik "cek [username]" atau sebutkan username / ID order (NDXSTORE/... atau TX-xxxx)\n` +
    `- Kalo perlu bantuan CS / admin manusia, arahkan ketik "cs"`;

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

const productCache = new Map(); // gameSlug -> { text: string, items: Array<{name, price}>, meta?: any, ts: number }
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

function formatRobuxSummary(meta, queryText = '') {
  if (!meta) return '';
  const { rate100, inst100, stock, instantStock, minPurchase } = meta;
  let text =
    `DAFTAR HARGA Robux Roblox (Real-time):\n` +
    `- Robux Reguler (via Gamepass / estimasi 5 hari): ${formatPrice(rate100)} per 100 Robux (Stok: ${Number(stock || 0).toLocaleString('id-ID')}, min beli ${minPurchase || 25} Robux)` +
    (inst100 ? `\n- Robux Instant (langsung masuk): ${formatPrice(inst100)} per 100 Robux (Stok: ${Number(instantStock || 0).toLocaleString('id-ID')})` : '');

  if (queryText) {
    const nums = [...queryText.matchAll(/\b(\d{2,6})\b/g)]
      .map(m => Number(m[1]))
      .filter(n => n >= 10 && n <= 100000);
    if (nums.length) {
      const qty = nums[0];
      const regTotal = Math.round((qty / 100) * rate100);
      const instTotal = inst100 ? Math.round((qty / 100) * inst100) : 0;
      text += `\n- KALKULASI OTOMATIS untuk ${qty.toLocaleString('id-ID')} Robux: Reguler = ${formatPrice(regTotal)}` +
        (instTotal ? `, Instant = ${formatPrice(instTotal)}` : '');
    }
  }
  return text;
}

function formatProductSummary(game, items, queryText = '') {
  if (!items.length) return '';
  let selected = items.slice(0, 12);
  let closestNote = '';
  if (queryText) {
    const expandedQuery = queryText
      .toLowerCase()
      .replace(/\bwdp\b/g, 'weekly')
      .replace(/\bsl\b/g, 'starlight');
    const tokens = expandedQuery
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !['harga', 'berapa', 'brp', 'diamond', 'diamonds', 'dm', 'ml', 'mlbb', 'mobile', 'legend', 'legends', 'free', 'fire', 'ff', 'roblox', 'robux', 'beli', 'top', 'up', 'topup', 'kak', 'bang', 'min', 'mau', 'tanya', 'nanya', 'dong', 'ya', 'kalo', 'kalau', 'untuk', 'buat'].includes(t));
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
          if (matched.length) {
            const topAlts = matched.slice(0, 2).map(m => `${m.name} (${formatPrice(m.price)})`).join(' atau ');
            closestNote = `\nCATATAN PENTING: Nominal "${numTok}" persis tidak ada di katalog ${game.label}. Nominal terdekat yang tersedia adalah ${topAlts}. Beritahu user bahwa nominal ${numTok} tidak ada dan langsung sebutkan harga nominal terdekat tersebut!`;
          }
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
  return `DAFTAR HARGA ${game.label} (${shown} item):\n${lines.join('\n')}${closestNote}`;
}

async function refreshProducts(game, queryText = '') {
  try {
    if (game.slug === 'ROBUX') {
      const j = await getJson(`${config.apiBase}/api/belirbx/robux-rate`);
      const d = j?.data ?? j;
      if (!d || (!d.basePer100 && !d.markedUpPer100)) return '';
      const meta = {
        rate100: Number(d.markedUpPer100 || d.basePer100 || 0),
        inst100: Number(d.instantPrice || 0),
        stock: Number(d.stock || 0),
        instantStock: Number(d.instantStock || 0),
        minPurchase: d.minPurchase || 25,
      };
      const defaultText = formatRobuxSummary(meta, '');
      productCache.set(game.slug, { text: defaultText, items: [], meta, ts: Date.now() });
      return queryText ? formatRobuxSummary(meta, queryText) : defaultText;
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
    if (game.slug === 'ROBUX' && cached.meta) {
      return formatRobuxSummary(cached.meta, queryText);
    }
    if (cached.items?.length && queryText) {
      return formatProductSummary(game, cached.items, queryText);
    }
    return cached.text;
  }
  return null;
}

// ─── Per-message query context ─────────────────────────────────────────

function detectGames(lowerText, fallbackGameSlug = null) {
  const found = [];
  const add = (g) => {
    if (g && !found.some(x => x.slug === g.slug)) found.push(g);
  };

  if (/\b(ml|mlbb|mobile\s*legends?|wdp|weekly\s*diamond|starlight|twilight\s*pass)\b/i.test(lowerText)) {
    add(ML);
  }
  if (/\b(ff|free\s*fire|freefire|epep|booyah\s*pass)\b/i.test(lowerText)) {
    add(FF);
  }
  for (const g of GAMES) {
    if (g.kw.some(k => lowerText.includes(k))) add(g);
  }
  if (/\b(robux|rbx|roblox)\b/i.test(lowerText)) {
    add(ROBUX);
  }

  // If user asked about "diamond" / "dm" without specifying a game, use their
  // recent profile game or default to ML (+ FF) so they get real prices.
  if (!found.length && /\b(diamond|diamonds|dm)\b/i.test(lowerText)) {
    if (fallbackGameSlug === 'ff') add(FF);
    else add(ML);
  } else if (!found.length && fallbackGameSlug) {
    if (fallbackGameSlug === 'ml') add(ML);
    else if (fallbackGameSlug === 'ff') add(FF);
    else if (fallbackGameSlug === 'roblox') add(ROBUX);
  }

  return found.slice(0, 3);
}

function isValidUsernameCandidate(token) {
  if (!token || token.length < 3 || token.length > 24) return false;
  const upper = token.toUpperCase();
  if (NON_USERNAMES.has(upper)) return false;
  if (/^\d+$/.test(token)) return false; // pure numbers aren't usernames
  if (/^(.)\1+$/.test(token)) return false; // "aaaa", "wwww"
  return true;
}

export function extractUsername(text) {
  if (!text) return null;
  // 1. Explicit label: "username: xxx", "atas nama xxx", "cek xxx", "pesanan xxx"
  const labelledMatches = text.matchAll(/(?:username|user|ign|akun|nick|nickname|nama|atas\s+nama|a\/n|cek|cekin)\s*(?:order|pesanan|orderan)?\s*[:=]?\s*([A-Za-z0-9_.]{3,24})/gi);
  for (const m of labelledMatches) {
    if (isValidUsernameCandidate(m[1])) return m[1];
  }

  // 2. Standalone single-token bubble in a multi-bubble chat (e.g. Bubble 1: "kak cek order", Bubble 2: "rian_gaming")
  const lines = text.split('\n').map(l => l.replace(/^\[Chat\s*\d+\]\s*:\s*/i, '').trim()).filter(Boolean);
  for (const line of lines) {
    if (/^[A-Za-z0-9_.]{3,24}$/.test(line) && isValidUsernameCandidate(line)) {
      return line;
    }
  }

  // 3. Token containing both letters and digits/underscores (typical gamer ign: budi123, rian_gaming)
  const gamerTokens = text.matchAll(/\b([A-Za-z][A-Za-z0-9_]{2,23})\b/g);
  for (const m of gamerTokens) {
    const tok = m[1];
    if ((/[0-9_]/.test(tok)) && isValidUsernameCandidate(tok)) {
      return tok;
    }
  }

  // 4. ALL-CAPS word (e.g. "ROWSOWS")
  const caps = text.match(/\b([A-Z][A-Z0-9_]{2,19})\b/);
  if (caps && isValidUsernameCandidate(caps[1])) return caps[1];

  return null;
}

function summarizeOrders(txs, who) {
  const top = txs.slice(0, 4).map(o => {
    const ordStatus = pick(o, 'orderStatus', 'order_status') || '-';
    const payStatus = pick(o, 'paymentStatus', 'payment_status') || '-';
    const price = formatPrice(pick(o, 'priceIdr', 'price_idr'));
    const game = pick(o, 'gameName', 'game_name') || '';
    const prod = pick(o, 'productName', 'product_name') || '-';
    const time = formatTime(pick(o, 'createdAt', 'created_at'));
    return `- ID: ${o.id} | ${game ? game + ' - ' : ''}${prod} (${price}) | Bayar: ${payStatus} | Status Order: ${ordStatus} | Waktu: ${time}`;
  });
  return `STATUS ORDER REAL-TIME ${who} (${txs.length} order ditemukan):\n${top.join('\n')}`;
}

async function fetchOrderById(id) {
  try {
    const j = await getJson(`${config.apiBase}/api/transaction/${encodeURIComponent(id)}`);
    const t = j?.data?.transaction ?? j?.transaction;
    if (!t) return `STATUS ORDER REAL-TIME: ID Order ${id} TIDAK DITEMUKAN di database NDXStore.`;
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
    if (!Array.isArray(txs) || !txs.length) {
      return `STATUS ORDER REAL-TIME: Belum ditemukan order untuk username "${clean}".`;
    }
    return summarizeOrders(txs, `"${clean}"`);
  } catch { return ''; }
}

async function fetchProducts(game, queryText = '') {
  const cached = getCachedProducts(game, queryText);
  if (cached) return cached;
  return refreshProducts(game, queryText);
}

export async function getQueryContext(text, fallbackGameSlug = null) {
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

  const games = detectGames(lower, PRICE_KW.test(lower) ? fallbackGameSlug : null);
  if (games.length && (PRICE_KW.test(lower) || /\b\d+\s*(dm|diamond|robux|rbx|wdp)\b/i.test(lower))) {
    for (const g of games) {
      jobs.push(fetchProducts(g, text));
    }
  }

  if (!jobs.length) return '';
  const results = await Promise.all(jobs);
  return results.filter(Boolean).join('\n\n');
}


