// Gives the AI real, live data from the NDXStore API so it answers about prices
// and order status accurately instead of hallucinating. All fetches fail soft
// (return '') so the AI still replies from its base knowledge if the API is down.

import { API_BASE } from '../utils/constants.js';
import { formatPrice, formatTime } from '../utils/format.js';
import { logger } from '../utils/logger.js';

const TIMEOUT_MS = 9000;
const STORE_TTL_MS = 5 * 60 * 1000;

// Mirrors the backend's GAME_SLUG_MAP (this bot can't import the store repo).
// `kw` are lowercase phrases we match against the user's message.
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

// Tokens that look like usernames but aren't, to avoid spurious API calls.
const NON_USERNAMES = new Set(['DANA', 'GOPAY', 'OVO', 'NDX', 'ML', 'MLBB', 'CS', 'WA', 'ID', 'OK', 'TX', 'TXN', 'ROBLOX', 'ROBUX', 'NDXSTORE']);

async function getJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) return null;
  return resp.json();
}

// ─── Store context (cached) ────────────────────────────────────────────

let storeCache = { text: '', ts: 0 };

export async function getStoreContext() {
  if (storeCache.text && Date.now() - storeCache.ts < STORE_TTL_MS) return storeCache.text;

  let dana = '6285159898005';
  let admin = '6285159898005';
  try {
    const j = await getJson(`${API_BASE}/api/config`);
    if (j?.data) {
      dana = j.data.danaNumber || dana;
      admin = j.data.waNumber || j.data.adminWa || admin;
    }
  } catch (e) {
    logger.debug('LiveData', 'config fetch failed:', e.message);
  }

  const games = GAMES.map(g => g.label).join(', ');
  const text =
    `INFO TOKO (real-time):\n` +
    `- Pembayaran DANA: ${dana} a.n NDXStore\n` +
    `- WA Admin: ${admin}\n` +
    `- Top up Roblox per-game: ${games}\n` +
    `- Juga melayani Mobile Legends (ML)\n` +
    `- Cek status order: user ketik "cek [username]" atau kasih order ID (TX-xxxx)`;

  storeCache = { text, ts: Date.now() };
  return text;
}

// ─── Per-message query context ─────────────────────────────────────────

function detectGame(lowerText) {
  if (/\b(mlbb|mobile legends?)\b/.test(lowerText) || /\bml\b/.test(lowerText)) return ML;
  for (const g of GAMES) {
    if (g.kw.some(k => lowerText.includes(k))) return g;
  }
  return null;
}

function extractUsername(text) {
  const labelled = text.match(/(?:username|user|ign|akun|nick|nama)\s*[:=]?\s*([A-Za-z0-9_]{3,20})/i);
  if (labelled) return labelled[1];
  // Fallback: a prominent ALL-CAPS token (Roblox usernames are often uppercase).
  const caps = text.match(/\b([A-Z][A-Z0-9_]{2,19})\b/);
  if (caps && !NON_USERNAMES.has(caps[1].toUpperCase())) return caps[1];
  return null;
}

function summarizeOrders(txs, who) {
  const top = txs.slice(0, 3).map(o => {
    const status = o.orderStatus || o.paymentStatus || '-';
    return `- ${o.id} | ${o.productName || '-'} | ${status} | ${formatTime(o.createdAt)}`;
  });
  return `STATUS ORDER ${who} (${txs.length} order):\n${top.join('\n')}`;
}

async function fetchOrderById(id) {
  try {
    const j = await getJson(`${API_BASE}/api/transaction/${encodeURIComponent(id)}`);
    const t = j?.transaction;
    if (!t) return '';
    return summarizeOrders([t], `${id}`);
  } catch { return ''; }
}

async function fetchOrdersByUser(username) {
  try {
    const j = await getJson(`${API_BASE}/api/transactions/user/${encodeURIComponent(username.trim())}`);
    const txs = j?.transactions;
    if (!Array.isArray(txs) || !txs.length) return '';
    return summarizeOrders(txs, `"${username}"`);
  } catch { return ''; }
}

async function fetchProducts(game) {
  try {
    const url = game.slug === 'ML'
      ? `${API_BASE}/api/ml/products`
      : `${API_BASE}/api/belirbx/products?game=${encodeURIComponent(game.slug)}`;
    const j = await getJson(url);
    const items = Array.isArray(j?.data) ? j.data : [];
    if (!items.length) return '';
    const lines = items
      .slice(0, 8)
      .map(p => `- ${p.name}: ${formatPrice(p.price)}`);
    const shown = items.length > 8 ? `top 8 dari ${items.length}` : `${items.length}`;
    return `PRODUK ${game.label} (harga real, ${shown} item):\n${lines.join('\n')}`;
  } catch { return ''; }
}

/**
 * Inspect a user message and, if it's asking about an order or a product,
 * fetch the real data and return a compact block to inject into the prompt.
 * Returns '' when nothing relevant is found.
 */
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
