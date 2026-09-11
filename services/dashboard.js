// ─── Localhost admin dashboard — pengganti konfigurasi via chat ──────────
// Semua konfigurasi bot (AI mode, settings, blokir, kirim pesan, dsb) HANYA
// lewat panel ini. Commands chat (!aimode, !reply, !block, ...) dimatikan.
//
// Keamanan: server bind ke HOST (default 127.0.0.1 = localhost only).
// Kalau di-expose (HOST=0.0.0.0), wajib isi ADMIN_TOKEN — semua /api/* dan
// /admin butuh header `x-admin-token` atau query `?token=`.
// Route publik tetap: /health, /qr, /code, /metrics.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { config } from '../config.js';
import { settings, flushSettings } from './settings.js';
import { getAiMetrics, clearHistory } from './ai.js';
import { getCurrentClient, getConnectionState } from '../client.js';
import { getDb } from './supabase.js';
import { isDbAvailable } from '../utils/db.js';
import { logger, getLogLevel, setLogLevel } from '../utils/logger.js';
import { VALID_ORDER_STATUSES } from '../utils/constants.js';
import { getStoreStats, getRecentOrders, getPendingOrders, getOrderDetail, updateOrderStatus } from './admin.js';

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

const ADMIN_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin.html');

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function authorized(req, query) {
  if (!config.adminToken) return true;
  const header = req.headers['x-admin-token'] || '';
  return header === config.adminToken || query.get('token') === config.adminToken;
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
  const waUser = client?.info?.wid?.user || null;
  sendJson(res, 200, {
    wa: waUser ? 'connected' : 'disconnected',
    waNumber: waUser || null,
    waState: getConnectionState?.() || null,
    db: (await dbOk()) ? 'connected' : 'error',
    dbAvailable: isDbAvailable(),
    uptime: os.uptime(),
    botUptime: getDashboardUptimeSec(),
    aiMode: settings.aiMode,
    jawabDuluan: settings.jawabDuluan,
    ungroup: settings.ungroup,
    blockedCount: deps ? deps.getBlocked().length : 0,
    logLevel: getLogLevel(),
    tokenRequired: Boolean(config.adminToken),
  });
}

async function handleSettings(body, res) {
  const out = {};
  if (body.aiMode !== undefined) {
    const m = Number(body.aiMode);
    if (![0, 1, 2].includes(m)) return sendJson(res, 400, { error: 'aiMode harus 0, 1, atau 2' });
    settings.aiMode = m;
    out.aiMode = m;
  }
  if (body.jawabDuluan !== undefined) {
    settings.jawabDuluan = Boolean(body.jawabDuluan);
    out.jawabDuluan = settings.jawabDuluan;
  }
  if (body.ungroup !== undefined) {
    settings.ungroup = Boolean(body.ungroup);
    out.ungroup = settings.ungroup;
  }
  await flushSettings();
  logger.info('Dashboard', `Settings updated: ${JSON.stringify(out)}`);
  sendJson(res, 200, { ok: true, settings: { aiMode: settings.aiMode, jawabDuluan: settings.jawabDuluan, ungroup: settings.ungroup } });
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

  if (pathname !== '/admin' && !pathname.startsWith('/api/')) return false;

  // Halaman dashboard
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
