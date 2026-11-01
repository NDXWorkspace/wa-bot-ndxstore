// ─── Localhost admin dashboard — pengganti konfigurasi via chat ──────────
// Semua konfigurasi bot (AI mode, settings, blokir, kirim pesan, dsb) HANYA
// lewat panel ini. Commands chat (!aimode, !reply, !block, ...) dimatikan.
//
// Keamanan: server bind ke HOST (default 127.0.0.1 = localhost only).
// Kalau di-expose (HOST=0.0.0.0), config.js MENOLAK boot tanpa ADMIN_TOKEN.
// Token hanya lewat header `x-admin-token` (jangan via ?token= — bocor ke
// history browser/log server). Route publik tetap: /health (liveness),
// /ready, /metrics, /. /qr + /code + /admin + /api/* butuh token begitu
// ADMIN_TOKEN diisi.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { config } from '../config.js';
import { settings, flushSettings } from './settings.js';
import { askAI, getAiMetrics, clearHistory, getProviderHealth } from './ai.js';
import {
  getCurrentClient,
  getConnectionState,
  getLoginDetails,
  requestDynamicPairingCode,
  switchToQrMode,
  logoutAndResetWa,
} from '../client.js';
import { getDb } from './supabase.js';
import { isDbAvailable } from '../utils/db.js';
import { logger, getLogLevel, setLogLevel } from '../utils/logger.js';
import { VALID_ORDER_STATUSES } from '../utils/constants.js';
import { getStoreStats, getRecentOrders, getPendingOrders, getOrderDetail, updateOrderStatus } from './admin.js';
import { getInstagramStatus } from './instagram.js';

const botStartedAt = Date.now();
export function getDashboardUptimeSec() {
  return Math.floor((Date.now() - botStartedAt) / 1000);
}

// Deps di-inject dari index.js (hindari circular import).
// { getBlocked(): string[], setBlocked(jid, on), saveBlocked(): Promise,
//   sendWaMessage(jid, text): Promise }
let deps = null;
export function initDashboard(d) {
  deps = d;
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ROOT_DIR = path.join(PUBLIC_DIR, '..');
const ADMIN_HTML = path.join(PUBLIC_DIR, 'admin.html');
const APP_HTML = path.join(PUBLIC_DIR, 'app.html');
const MANIFEST_JSON = path.join(PUBLIC_DIR, 'manifest.json');
const SW_JS = path.join(PUBLIC_DIR, 'sw.js');
const ICON_SVG = path.join(PUBLIC_DIR, 'icon.svg');
const APK_FILE = path.join(ROOT_DIR, 'WA-AI-Bot.apk');

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function authorized(req, query) {
  if (!config.adminToken) return true;
  const header = req.headers['x-admin-token'] || '';
  return header === config.adminToken;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Body bukan JSON valid');
  }
}

// Normalisasi input nomor → JID. Terima: 628xxx, +628xxx, 08xxx,
// 628xxx@c.us, xxx@g.us (grup, diteruskan apa adanya).
export function normalizeJid(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (s.includes('@g.us')) return s;
  if (s.includes('@c.us') || s.includes('@s.whatsapp.net')) {
    const num = s.split('@')[0].replace(/[^0-9]/g, '');
    return num ? `${num}@c.us` : null;
  }
  let digits = s.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  if (digits.length < 9 || digits.length > 16) return null;
  return `${digits}@c.us`;
}

async function dbOk() {
  try {
    const db = getDb();
    if (!db) return false;
    const { error } = await db.from('wa_bot_config').select('key').limit(1);
    return !error;
  } catch {
    return false;
  }
}

async function handleStatus(res) {
  const client = getCurrentClient();
  const login = getLoginDetails();
  const waUser = client?.info?.wid?.user || login.waNumber || null;
  sendJson(res, 200, {
    wa: login.connected ? 'connected' : 'disconnected',
    waNumber: waUser || null,
    waName: login.waName || null,
    waState: login.state || getConnectionState?.() || null,
    login,
    db: (await dbOk()) ? 'connected' : 'error',
    dbAvailable: isDbAvailable(),
    uptime: os.uptime(),
    botUptime: getDashboardUptimeSec(),
    aiMode: settings.aiMode,
    aiName: settings.aiName || 'Asisten AI',
    aiStyle: settings.aiStyle || 'santai',
    customPrompt: settings.customPrompt || '',
    customKnowledge: settings.customKnowledge || '',
    replyPrivate: settings.replyPrivate !== false,
    replyGroup: settings.replyGroup || 'mention',
    useStoreData: Boolean(settings.useStoreData),
    jawabDuluan: settings.jawabDuluan,
    ungroup: settings.ungroup,
    blockedCount: deps ? deps.getBlocked().length : 0,
    logLevel: getLogLevel(),
    tokenRequired: Boolean(config.adminToken),
    ig: getInstagramStatus(),
    aiProviders: getProviderHealth(),
  });
}

async function handleSettings(body, res) {
  const out = {};
  if (body.aiMode !== undefined) {
    const m = Number(body.aiMode);
    if (![0, 1, 2, 3].includes(m)) return sendJson(res, 400, { error: 'aiMode harus 0, 1, 2, atau 3' });
    settings.aiMode = m;
    out.aiMode = m;
  }
  if (body.aiName !== undefined) {
    settings.aiName = String(body.aiName || '').trim().slice(0, 80) || 'Asisten AI';
    out.aiName = settings.aiName;
  }
  if (body.aiStyle !== undefined) {
    const st = String(body.aiStyle || '').trim();
    if (['santai', 'ramah', 'profesional', 'custom'].includes(st)) {
      settings.aiStyle = st;
      out.aiStyle = st;
    }
  }
  if (body.customPrompt !== undefined) {
    settings.customPrompt = String(body.customPrompt || '').trim().slice(0, 4000);
    out.customPrompt = settings.customPrompt;
  }
  if (body.customKnowledge !== undefined) {
    settings.customKnowledge = String(body.customKnowledge || '').trim().slice(0, 8000);
    out.customKnowledge = settings.customKnowledge;
  }
  if (body.replyPrivate !== undefined) {
    settings.replyPrivate = Boolean(body.replyPrivate);
    out.replyPrivate = settings.replyPrivate;
  }
  if (body.replyGroup !== undefined) {
    const rg = String(body.replyGroup || '').trim();
    if (['all', 'mention', 'off'].includes(rg)) {
      settings.replyGroup = rg;
      settings.ungroup = rg !== 'all';
      out.replyGroup = rg;
    }
  }
  if (body.useStoreData !== undefined) {
    settings.useStoreData = Boolean(body.useStoreData);
    out.useStoreData = settings.useStoreData;
  }
  if (body.jawabDuluan !== undefined) {
    settings.jawabDuluan = Boolean(body.jawabDuluan);
    out.jawabDuluan = settings.jawabDuluan;
  }
  if (body.ungroup !== undefined) {
    settings.ungroup = Boolean(body.ungroup);
    out.ungroup = settings.ungroup;
  }
  if (body.groqKey !== undefined) {
    settings.groqKey = String(body.groqKey || '').trim().slice(0, 300);
    out.groqKey = settings.groqKey ? '***' : '';
  }
  if (body.geminiKey !== undefined) {
    settings.geminiKey = String(body.geminiKey || '').trim().slice(0, 300);
    out.geminiKey = settings.geminiKey ? '***' : '';
  }
  if (body.openrouterKey !== undefined) {
    settings.openrouterKey = String(body.openrouterKey || '').trim().slice(0, 300);
    out.openrouterKey = settings.openrouterKey ? '***' : '';
  }
  // Reset cache/history Custom AI bila prompt diubah agar perubahan langsung terasa
  if (body.customPrompt !== undefined || body.aiName !== undefined || body.aiStyle !== undefined || body.customKnowledge !== undefined) {
    clearHistory('all');
  }
  await flushSettings();
  logger.info('Dashboard', `Settings updated: ${JSON.stringify(Object.keys(out))}`);
  sendJson(res, 200, {
    ok: true,
    settings: {
      aiMode: settings.aiMode,
      aiName: settings.aiName,
      aiStyle: settings.aiStyle,
      customPrompt: settings.customPrompt,
      customKnowledge: settings.customKnowledge,
      replyPrivate: settings.replyPrivate,
      replyGroup: settings.replyGroup,
      useStoreData: settings.useStoreData,
      jawabDuluan: settings.jawabDuluan,
      ungroup: settings.ungroup,
    },
  });
}

async function handleHistory(query, res) {
  const limit = Math.min(Math.max(Number(query.get('limit')) || 20, 1), 50);
  try {
    const db = getDb();
    if (!db) return sendJson(res, 503, { error: 'DB tidak tersedia' });
    const { data, error } = await db
      .from('wa_chat_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    sendJson(res, 200, { history: data || [] });
  } catch (e) {
    sendJson(res, 500, { error: e.message?.slice(0, 200) });
  }
}

async function handleSend(body, res) {
  const jid = normalizeJid(body.to);
  const text = String(body.text || '').trim();
  if (!jid) return sendJson(res, 400, { error: 'Nomor tujuan tidak valid (format: 628xxx)' });
  if (text.length < 1) return sendJson(res, 400, { error: 'Pesan kosong' });
  if (text.length > 4000) return sendJson(res, 400, { error: 'Pesan kepanjangan (maks 4000)' });
  try {
    await deps.sendWaMessage(jid, text);
    logger.info('Dashboard', `Pesan terkirim ke ${jid}`);
    sendJson(res, 200, { ok: true, to: jid });
  } catch (e) {
    sendJson(res, 500, { error: e.message?.slice(0, 200) });
  }
}

async function handleBlock(body, on, res) {
  const jid = normalizeJid(body.jid || body.to);
  if (!jid) return sendJson(res, 400, { error: 'Nomor tidak valid (format: 628xxx)' });
  deps.setBlocked(jid, on);
  await deps.saveBlocked().catch(() => {});
  logger.info('Dashboard', `User ${on ? 'diblokir' : 'di-unblock'}: ${jid}`);
  sendJson(res, 200, { ok: true, jid, blocked: on });
}

async function handleStore(pathname, query, method, body, res) {
  try {
    if (pathname === '/api/store/stats' && method === 'GET') {
      return sendJson(res, 200, { stats: await getStoreStats() });
    }
    if (pathname === '/api/store/orders' && method === 'GET') {
      return sendJson(res, 200, await getRecentOrders(query.get('limit') || 5));
    }
    if (pathname === '/api/store/pending' && method === 'GET') {
      return sendJson(res, 200, await getPendingOrders(query.get('game') || ''));
    }
    if (pathname === '/api/store/order' && method === 'GET') {
      return sendJson(res, 200, { transaction: await getOrderDetail(query.get('id') || '') });
    }
    if (pathname === '/api/store/status' && method === 'POST') {
      return sendJson(res, 200, { ok: true, ...(await updateOrderStatus(body.id, body.status)) });
    }
    if (pathname === '/api/store/statuses' && method === 'GET') {
      return sendJson(res, 200, { statuses: VALID_ORDER_STATUSES });
    }
    return false;
  } catch (e) {
    sendJson(res, 500, { error: e.message?.slice(0, 200) });
    return true;
  }
}

// Return true kalau request ditangani (apapun statusnya).
export async function handleDashboardRequest(req, res) {
  const fullUrl = req.url || '/';
  const [rawPath, rawQuery] = fullUrl.split('?');
  const pathname = rawPath || '/';
  const query = new URLSearchParams(rawQuery || '');
  const method = (req.method || 'GET').toUpperCase();

  if (
    pathname !== '/' &&
    pathname !== '/app' &&
    pathname !== '/admin' &&
    pathname !== '/apk' &&
    pathname !== '/manifest.json' &&
    pathname !== '/sw.js' &&
    pathname !== '/icon.svg' &&
    !pathname.startsWith('/api/')
  ) {
    return false;
  }

  if (pathname === '/apk' && method === 'GET') {
    if (fs.existsSync(APK_FILE)) {
      const stat = fs.statSync(APK_FILE);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="WA-AI-Bot.apk"',
        'Content-Length': stat.size,
      });
      fs.createReadStream(APK_FILE).pipe(res);
      return true;
    }
    res.writeHead(302, {
      Location: 'https://github.com/NDXWorkspace/wa-bot-ndxstore/releases/latest/download/WA-AI-Bot.apk',
    });
    res.end();
    return true;
  }

  // Static files untuk Aplikasi Mobile / PWA (/ dan /app)
  if ((pathname === '/' || pathname === '/app') && method === 'GET') {
    try {
      const targetFile = fs.existsSync(APP_HTML) ? APP_HTML : ADMIN_HTML;
      const html = fs.readFileSync(targetFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      sendJson(res, 500, { error: 'File app.html tidak ditemukan' });
    }
    return true;
  }

  if (pathname === '/manifest.json' && method === 'GET') {
    try {
      const json = fs.readFileSync(MANIFEST_JSON, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(json);
    } catch {
      sendJson(res, 404, { error: 'manifest.json tidak ditemukan' });
    }
    return true;
  }

  if (pathname === '/sw.js' && method === 'GET') {
    try {
      const js = fs.readFileSync(SW_JS, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(js);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('self.addEventListener("fetch", () => {});');
    }
    return true;
  }

  if (pathname === '/icon.svg' && method === 'GET') {
    try {
      const svg = fs.readFileSync(ICON_SVG, 'utf8');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(svg);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return true;
  }

  // Halaman dashboard lama (/admin)
  if (pathname === '/admin' && method === 'GET') {
    try {
      const html = fs.readFileSync(ADMIN_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      sendJson(res, 500, { error: 'File admin.html tidak ditemukan' });
    }
    return true;
  }

  // API butuh auth (kalau ADMIN_TOKEN diisi) + deps siap
  if (!authorized(req, query)) {
    sendJson(res, 401, { error: 'Unauthorized — butuh token admin' });
    return true;
  }
  if (!deps) {
    sendJson(res, 503, { error: 'Dashboard belum siap, tunggu bot selesai init' });
    return true;
  }

  try {
    if (pathname === '/api/status' && method === 'GET') {
      await handleStatus(res);
      return true;
    }
    if (pathname === '/api/wa/login-state' && method === 'GET') {
      sendJson(res, 200, { ok: true, ...getLoginDetails(), aiMode: settings.aiMode });
      return true;
    }
    if (pathname === '/api/wa/pair' && method === 'POST') {
      const body = await readJson(req);
      const rawPhone = body.phoneNumber || body.phone || body.number || '';
      const result = await requestDynamicPairingCode(rawPhone);
      if (!settings.aiMode || settings.aiMode <= 0) {
        settings.aiMode = 3;
        await flushSettings();
      }
      sendJson(res, 200, { ok: true, ...result, aiMode: settings.aiMode });
      return true;
    }
    if (pathname === '/api/wa/qr' && method === 'POST') {
      const result = await switchToQrMode();
      if (!settings.aiMode || settings.aiMode <= 0) {
        settings.aiMode = 3;
        await flushSettings();
      }
      sendJson(res, 200, { ok: true, ...result, aiMode: settings.aiMode });
      return true;
    }
    if (pathname === '/api/wa/logout' && method === 'POST') {
      try {
        const db = getDb();
        if (db) await db.from('wa_bot_config').delete().eq('key', 'wa_cloud_session_enc');
      } catch {}
      await logoutAndResetWa();
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/api/ai/test' && method === 'POST') {
      const body = await readJson(req);
      const msg = String(body.message || body.text || '').trim();
      if (!msg) return sendJson(res, 400, { error: 'Pesan uji coba kosong' }), true;
      const activeMode = settings.aiMode > 0 ? settings.aiMode : 3;
      const reply = await askAI('apk-simulator@c.us', msg, activeMode, 'User', false);
      sendJson(res, 200, { ok: true, reply: reply || '(Tidak ada balasan)', mode: activeMode });
      return true;
    }
    if (pathname === '/api/settings' && method === 'POST') {
      await handleSettings(await readJson(req), res);
      return true;
    }
    if (pathname === '/api/metrics' && method === 'GET') {
      const m = getAiMetrics();
      const avg = m.responseTimes.length
        ? Math.round(m.responseTimes.reduce((a, b) => a + b, 0) / m.responseTimes.length)
        : 0;
      sendJson(res, 200, {
        totalCalls: m.calls, totalErrors: m.errors, avgResponseTimeMs: avg,
        promptTokens: m.promptTokens || 0, completionTokens: m.completionTokens || 0,
        byModel: m.byModel,
      });
      return true;
    }
    if (pathname === '/api/history' && method === 'GET') {
      await handleHistory(query, res);
      return true;
    }
    if (pathname === '/api/history/clear' && method === 'POST') {
      const body = await readJson(req);
      const jid = normalizeJid(body.jid);
      if (!jid) return sendJson(res, 400, { error: 'jid tidak valid' }), true;
      clearHistory(jid);
      logger.info('Dashboard', `History direset: ${jid}`);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/api/blocked' && method === 'GET') {
      sendJson(res, 200, { blocked: deps.getBlocked() });
      return true;
    }
    if (pathname === '/api/block' && method === 'POST') {
      await handleBlock(await readJson(req), true, res);
      return true;
    }
    if (pathname === '/api/unblock' && method === 'POST') {
      await handleBlock(await readJson(req), false, res);
      return true;
    }
    if (pathname === '/api/send' && method === 'POST') {
      await handleSend(await readJson(req), res);
      return true;
    }
    if (pathname === '/api/loglevel' && method === 'GET') {
      sendJson(res, 200, { level: getLogLevel() });
      return true;
    }
    if (pathname === '/api/loglevel' && method === 'POST') {
      const body = await readJson(req);
      if (!setLogLevel(body.level)) return sendJson(res, 400, { error: 'Level invalid (error/warn/info/debug)' }), true;
      sendJson(res, 200, { ok: true, level: getLogLevel() });
      return true;
    }
    if (pathname === '/api/groups' && method === 'GET') {
      // Pengganti !groupid — grup yang pernah chat tercatat di history.
      try {
        const db = getDb();
        let groups = [];
        if (db) {
          const { data } = await db.from('wa_chat_history')
            .select('user_number').like('user_number', '%@g.us')
            .order('created_at', { ascending: false }).limit(200);
          groups = [...new Set((data || []).map(r => r.user_number))].slice(0, 20);
        }
        sendJson(res, 200, { groups });
      } catch (e) {
        sendJson(res, 500, { error: e.message?.slice(0, 200) });
      }
      return true;
    }
    if (pathname.startsWith('/api/store/')) {
      const r = await handleStore(pathname, query, method, method === 'POST' ? await readJson(req) : {}, res);
      if (r !== false) return true;
    }
    sendJson(res, 404, { error: 'Endpoint tidak dikenal' });
    return true;
  } catch (e) {
    sendJson(res, 500, { error: e.message?.slice(0, 200) });
    return true;
  }
}
