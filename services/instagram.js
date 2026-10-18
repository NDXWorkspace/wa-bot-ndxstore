// ─── Official Meta Instagram Graph API & Webhook Auto-Reply Service ─────
// Menggunakan engine AI CS / Bima + Live Data NDXStore + Multi-Bubble Buffer
// yang sama persis dengan WhatsApp:
// 1. Baca semua penggalan DM dulu (tunggu opener/cliffhanger selesai diketik)
// 2. Kirim sender_action "mark_seen" (Dilihat) setelah jeda baca natural
// 3. Tampilkan indikator "typing_on" (...) sambil memproses AI + harga/order live
// 4. Jika ada DM susulan saat sedang mikir/ngetik, batalkan & gabungkan semua DM
// 5. Kirim 1 balasan utuh yang natural

import crypto from 'crypto';
import { config } from '../config.js';
import { settings } from './settings.js';
import { askAI, askAIWithImage } from './ai.js';
import { bufferAiMessage, cancelBuffer, holdBufferForMedia, releaseBufferForMedia } from './aiBuffer.js';
import { pick } from '../utils/fieldResolver.js';
import { formatPrice, formatTime } from '../utils/format.js';
import { logger, throttleLog } from '../utils/logger.js';

const SEEN_MID_MAX = 1000;
const seenMids = new Set();
const serviceStartedAt = Date.now();

let igAccountInfo = {
  id: null,
  username: null,
  connected: false,
  lastError: null,
  receivedCount: 0,
  repliedCount: 0,
  webhookHits: 0,
};
let pollTimer = null;

function rememberMid(mid) {
  if (!mid) return false;
  if (seenMids.has(mid)) return true;
  seenMids.add(mid);
  while (seenMids.size > SEEN_MID_MAX) {
    const oldest = seenMids.values().next().value;
    seenMids.delete(oldest);
  }
  return false;
}

function getGraphBase() {
  if (config.igGraphBase) return config.igGraphBase.replace(/\/+$/, '');
  const tok = config.igAccessToken || '';
  if (tok.startsWith('IGA')) return 'https://graph.instagram.com/v21.0';
  return 'https://graph.facebook.com/v21.0';
}

function resolveAiMode() {
  if (config.igAiMode === 1 || config.igAiMode === 2) return config.igAiMode;
  return settings.aiMode > 0 ? settings.aiMode : 2;
}

export function formatForIg(text) {
  return String(text || '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .trim();
}

function splitIgChunks(text, maxLen = 950) {
  const clean = formatForIg(text);
  if (clean.length <= maxLen) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > maxLen) {
    let idx = rest.lastIndexOf('\n', maxLen);
    if (idx < 200) idx = rest.lastIndexOf('. ', maxLen);
    if (idx < 200) idx = rest.lastIndexOf(' ', maxLen);
    if (idx < 100) idx = maxLen;
    chunks.push(rest.slice(0, idx + 1).trim());
    rest = rest.slice(idx + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendIgAction(recipientId, action = 'mark_seen') {
  if (!config.igAccessToken || !recipientId) return false;
  const targetAccount = igAccountInfo.id || config.igAccountId || 'me';
  const url = `${getGraphBase()}/${encodeURIComponent(targetAccount)}/messages`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.igAccessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: String(recipientId) },
        sender_action: action,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function sendIgMessage(recipientId, text) {
  if (!config.igAccessToken) throw new Error('IG_ACCESS_TOKEN belum diisi');
  const chunks = splitIgChunks(text);
  const targetAccount = igAccountInfo.id || config.igAccountId || 'me';
  const url = `${getGraphBase()}/${encodeURIComponent(targetAccount)}/messages`;

  for (const chunk of chunks) {
    if (!chunk) continue;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.igAccessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: String(recipientId) },
        message: { text: chunk },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      igAccountInfo.lastError = `Send HTTP ${resp.status}: ${errText.slice(0, 120)}`;
      throw new Error(igAccountInfo.lastError);
    }
  }
  igAccountInfo.repliedCount++;
  return true;
}

async function resolveIgOrderCheck(rawArg) {
  const arg = (rawArg || '').trim();
  if (!arg) return null;
  const isOrderId = /^(?:NDXSTORE\/[A-Z0-9_-]+(?:\/[A-Z0-9_-]+){1,6}|(?:NDX|TX|TXN)-[A-Z0-9]+)$/i.test(arg);
  try {
    if (isOrderId) {
      const orderId = arg.toUpperCase();
      const resp = await fetch(`${config.apiBase}/api/transaction/${encodeURIComponent(orderId)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return `Order ${orderId} nggak ketemu kak. Pastikan ID order-nya benar ya.`;
      const data = await resp.json();
      const tx = data?.data?.transaction ?? data?.transaction;
      if (!tx) return `Order ${orderId} nggak ketemu kak.`;
      const status = pick(tx, 'orderStatus', 'order_status') || pick(tx, 'paymentStatus', 'payment_status') || '-';
      return `Status Order ${tx.id || orderId}\nProduk: ${pick(tx, 'productName', 'product_name') || '-'}\nUsername: ${tx.username || '-'}\nHarga: ${formatPrice(pick(tx, 'priceIdr', 'price_idr'))}\nStatus: ${status}\nWaktu: ${formatTime(pick(tx, 'createdAt', 'created_at'))}`;
    }

    let resp = await fetch(`${config.apiBase}/api/transactions/user/${encodeURIComponent(arg)}`, {
      signal: AbortSignal.timeout(8000),
    });
    let result = resp.ok ? await resp.json() : null;
    let txs = result?.data?.transactions ?? result?.transactions;
    if ((!Array.isArray(txs) || !txs.length) && arg.length >= 3) {
      resp = await fetch(`${config.apiBase}/api/transactions/search/${encodeURIComponent(arg)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        result = await resp.json();
        txs = result?.data?.transactions ?? result?.transactions;
      }
    }
    if (!Array.isArray(txs) || !txs.length) {
      return `Belum ada order untuk username "${arg}" kak.`;
    }
    const lines = [`Order untuk ${arg} (${txs.length} ditemukan):`];
    for (const o of txs.slice(0, 4)) {
      const status = pick(o, 'orderStatus', 'order_status') || pick(o, 'paymentStatus', 'payment_status') || '-';
      lines.push(`- ${o.id} | ${pick(o, 'productName', 'product_name') || '-'} | ${status}`);
    }
    return lines.join('\n');
  } catch {
    // Jangan kirim "gagal cek order" — biar AI yang jawab natural.
    return null;
  }
}

async function fetchImageAsBase64(imageUrl) {
  try {
    const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const mime = resp.headers.get('content-type') || 'image/jpeg';
    const buf = await resp.arrayBuffer();
    return {
      data: Buffer.from(buf).toString('base64'),
      mime,
    };
  } catch {
    return null;
  }
}

export async function processIncomingIgBubble({ senderId, mid, text, imageUrl, replyToText }) {
  if (!senderId) return;
  if (igAccountInfo.id && String(senderId) === String(igAccountInfo.id)) return;
  if (mid && rememberMid(mid)) return;

  igAccountInfo.receivedCount++;
  const jid = `ig:${senderId}`;
  let body = String(text || '').trim();
  if (replyToText && body) {
    body = `[Membalas DM: "${String(replyToText).replace(/\s+/g, ' ').slice(0, 120)}"] ${body}`;
  }

  logger.debug('IG', `DM from ${senderId} | "${body.slice(0, 50)}"`);

  // Auto-resolve "cek [username/id]"
  const cekArg = body.match(/^cek\s+(.+)$/i)?.[1]?.trim();
  if (cekArg) {
    cancelBuffer(jid);
    await sendIgAction(senderId, 'mark_seen');
    await sendIgAction(senderId, 'typing_on');
    const cekReply = await resolveIgOrderCheck(cekArg);
    await sendIgAction(senderId, 'typing_off');
    if (cekReply) {
      await sendIgMessage(senderId, cekReply).catch(e => logger.warn('IG', `Send cek failed: ${e.message}`));
      return;
    }
    // API gagal → lanjut ke AI (tanpa pesan error)
  }

  let mediaImage = null;
  if (imageUrl) {
    holdBufferForMedia(jid);
    try {
      mediaImage = await fetchImageAsBase64(imageUrl);
    } finally {
      releaseBufferForMedia(jid);
    }
  }
  if (!body && !mediaImage) return;

  const doIgReply = async (_bufKey, combinedText, img, _latestMsg, meta) => {
    const isCancelled = () => Boolean(meta?.isCancelled?.());
    const signal = meta?.signal || null;
    if (isCancelled()) return;

    // 1. TAHAP BACA: Jeda baca natural sesuai panjang semua DM yang masuk → mark_seen
    const wordCount = (combinedText || '').trim().split(/\s+/).filter(Boolean).length;
    const readDelayMs = Math.min(650 + wordCount * 45, 2000);
    await new Promise(r => setTimeout(r, readDelayMs));
    if (isCancelled()) return;

    await sendIgAction(senderId, 'mark_seen');
    if (isCancelled()) return;

    // 2. TAHAP MIKIR & MENGETIK: Tampilkan typing_on di DM Instagram sambil proses AI
    await sendIgAction(senderId, 'typing_on');
    const mode = resolveAiMode();
    const aiStart = Date.now();
    const reply = img
      ? await askAIWithImage(jid, combinedText, img.data, img.mime, mode, null, false, signal)
      : await askAI(jid, combinedText, mode, null, false, signal);

    if (isCancelled() || !reply || /^SKIP\b/.test(reply)) {
      await sendIgAction(senderId, 'typing_off');
      return;
    }

    const cleanReply = formatForIg(reply.replace(/^\[STICKER:.+?\]\s*/, ''));
    if (!cleanReply) {
      await sendIgAction(senderId, 'typing_off');
      return;
    }

    // 3. TAHAP DURASI MENGETIK REALISTIS + CEK CHAT SUSULAN TERAKHIR
    const aiElapsed = Date.now() - aiStart;
    const targetTypingMs = Math.min(Math.max(cleanReply.length * 26, 1000), 3400);
    const remainingTypingMs = Math.max(250, targetTypingMs - aiElapsed);
    await new Promise(r => setTimeout(r, remainingTypingMs));

    if (isCancelled()) {
      await sendIgAction(senderId, 'typing_off');
      return;
    }

    await sendIgAction(senderId, 'typing_off');
    await sendIgMessage(senderId, cleanReply).catch(e => {
      throttleLog('warn', 'IG', 'ig-reply-fail', `IG reply failed: ${e.message?.slice(0, 100)}`, 10000);
    });
  };

  bufferAiMessage(jid, { from: jid, body }, body, mediaImage, doIgReply, { isGroup: false });
}

function verifySignature(rawBody, signatureHeader) {
  if (!config.igAppSecret) return true;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', config.igAppSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function handleInstagramWebhook(req, res) {
  const fullUrl = req.url || '/';
  const [rawPath, rawQuery] = fullUrl.split('?');
  if (rawPath !== '/webhook/instagram' && rawPath !== '/api/webhook/instagram') {
    return false;
  }

  const method = (req.method || 'GET').toUpperCase();

  // 1. Meta Webhook Verification Challenge (GET)
  if (method === 'GET') {
    const query = new URLSearchParams(rawQuery || '');
    const mode = query.get('hub.mode');
    const token = query.get('hub.verify_token');
    const challenge = query.get('hub.challenge') || '';

    if (mode === 'subscribe' && token === config.igVerifyToken) {
      logger.info('IG', 'Webhook verified successfully by Meta!');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(challenge);
      return true;
    }
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid verify_token' }));
    return true;
  }

  // 2. Meta Webhook Event Delivery (POST)
  if (method === 'POST') {
    let rawBody = '';
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 2 * 1024 * 1024) throw new Error('Payload too large');
        chunks.push(c);
      }
      rawBody = Buffer.concat(chunks).toString('utf8');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request body' }));
      return true;
    }

    const sig = req.headers['x-hub-signature-256'] || '';
    if (!verifySignature(rawBody, sig)) {
      logger.warn('IG', 'Webhook signature verification failed');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return true;
    }

    let payload = null;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }

    // Respond 200 immediately as required by Meta Webhook spec
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('EVENT_RECEIVED');
    igAccountInfo.webhookHits++;

    if (payload?.object === 'instagram' && Array.isArray(payload.entry)) {
      for (const entry of payload.entry) {
        if (entry?.id && !igAccountInfo.id) {
          igAccountInfo.id = String(entry.id);
        }

        // Standard Instagram Messaging events: entry.messaging[]
        if (Array.isArray(entry?.messaging)) {
          for (const ev of entry.messaging) {
            const msg = ev?.message;
            if (!msg || msg.is_echo || msg.is_deleted) continue;
            const senderId = ev?.sender?.id;
            const recipientId = ev?.recipient?.id;
            if (!senderId || senderId === recipientId) continue;

            const text = msg.text || '';
            const imgAtt = Array.isArray(msg.attachments)
              ? msg.attachments.find(a => a?.type === 'image' && a?.payload?.url)
              : null;
            const imageUrl = imgAtt?.payload?.url || null;

            processIncomingIgBubble({
              senderId,
              mid: msg.mid,
              text,
              imageUrl,
              replyToText: null,
            }).catch(e => logger.debug('IG', `Event err: ${e.message}`));
          }
        }

        // Alternative Graph API changes[] format
        if (Array.isArray(entry?.changes)) {
          for (const ch of entry.changes) {
            if (ch?.field !== 'messages') continue;
            const val = ch?.value;
            const msg = val?.message;
            if (!msg || msg.is_echo) continue;
            const senderId = val?.sender?.id;
            const recipientId = val?.recipient?.id;
            if (!senderId || senderId === recipientId) continue;

            const text = msg.text || '';
            const imgAtt = Array.isArray(msg.attachments)
              ? msg.attachments.find(a => a?.type === 'image' && a?.payload?.url)
              : null;
            processIncomingIgBubble({
              senderId,
              mid: msg.mid,
              text,
              imageUrl: imgAtt?.payload?.url || null,
              replyToText: null,
            }).catch(e => logger.debug('IG', `Change event err: ${e.message}`));
          }
        }
      }
    }
    return true;
  }

  return false;
}

async function pollInstagramInbox() {
  if (!config.igAccessToken) return;
  const targetAccount = igAccountInfo.id || config.igAccountId || 'me';
  const url = `${getGraphBase()}/${encodeURIComponent(targetAccount)}/conversations?platform=instagram&fields=participants,messages.limit(4){id,message,from,created_time,attachments}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${config.igAccessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const convos = Array.isArray(data?.data) ? data.data : [];

    for (const conv of convos) {
      const msgs = Array.isArray(conv?.messages?.data) ? [...conv.messages.data].reverse() : [];
      for (const m of msgs) {
        if (!m?.id || seenMids.has(m.id)) continue;
        const createdMs = m.created_time ? new Date(m.created_time).getTime() : 0;
        // Skip historical messages older than when the bot process booted
        if (createdMs && createdMs < serviceStartedAt - 5000) {
          rememberMid(m.id);
          continue;
        }
        const fromId = m?.from?.id;
        const fromUsername = m?.from?.username;
        if (!fromId) continue;
        if (igAccountInfo.id && String(fromId) === String(igAccountInfo.id)) {
          rememberMid(m.id);
          continue;
        }
        if (igAccountInfo.username && fromUsername && fromUsername === igAccountInfo.username) {
          rememberMid(m.id);
          continue;
        }

        const attList = Array.isArray(m?.attachments?.data) ? m.attachments.data : [];
        const imgAtt = attList.find(a => a?.image_data?.url || a?.file_url);
        await processIncomingIgBubble({
          senderId: fromId,
          mid: m.id,
          text: m.message || '',
          imageUrl: imgAtt?.image_data?.url || imgAtt?.file_url || null,
          replyToText: null,
        });
      }
    }
  } catch (e) {
    throttleLog('debug', 'IG', 'poll-err', `IG inbox poll skipped: ${e.message?.slice(0, 80)}`, 60000);
  }
}

export async function startInstagramService() {
  if (!config.igAccessToken) {
    logger.info('IG', 'Instagram Auto-Reply standby (isi IG_ACCESS_TOKEN di .env untuk mengaktifkan)');
    return;
  }

  try {
    const target = config.igAccountId || 'me';
    const resp = await fetch(`${getGraphBase()}/${encodeURIComponent(target)}?fields=id,username,name`, {
      headers: { Authorization: `Bearer ${config.igAccessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const info = await resp.json();
      igAccountInfo.id = info.id || (config.igAccountId !== 'me' ? config.igAccountId : null);
      igAccountInfo.username = info.username || info.name || null;
      igAccountInfo.connected = true;
      igAccountInfo.lastError = null;
      logger.info('IG', `Instagram Auto-Reply AKTIF — Akun: @${igAccountInfo.username || igAccountInfo.id}`);
    } else {
      const errText = await resp.text().catch(() => '');
      igAccountInfo.lastError = `HTTP ${resp.status}: ${errText.slice(0, 100)}`;
      logger.warn('IG', `Gagal verifikasi IG_ACCESS_TOKEN (${resp.status}): ${errText.slice(0, 120)}`);
    }
  } catch (e) {
    igAccountInfo.lastError = e.message;
    logger.warn('IG', `Gagal terhubung ke Graph API: ${e.message}`);
  }

  if (config.igPollIntervalMs > 0) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      pollInstagramInbox().catch(() => {});
    }, Math.max(5000, config.igPollIntervalMs));
    if (pollTimer.unref) pollTimer.unref();
    logger.info('IG', `Polling inbox Instagram aktif (interval ${Math.round(config.igPollIntervalMs / 1000)}s) + Webhook siap di /webhook/instagram`);
  } else {
    logger.info('IG', 'Webhook Instagram siap di /webhook/instagram');
  }
}

export function getInstagramStatus() {
  return {
    enabled: Boolean(config.igAccessToken),
    connected: igAccountInfo.connected,
    accountId: igAccountInfo.id || (config.igAccountId !== 'me' ? config.igAccountId : null),
    username: igAccountInfo.username,
    webhookPath: '/webhook/instagram',
    verifyToken: config.igVerifyToken,
    pollIntervalMs: config.igPollIntervalMs,
    receivedCount: igAccountInfo.receivedCount,
    repliedCount: igAccountInfo.repliedCount,
    webhookHits: igAccountInfo.webhookHits,
    lastError: igAccountInfo.lastError,
  };
}
