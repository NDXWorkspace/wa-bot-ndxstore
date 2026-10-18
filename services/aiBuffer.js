// Aggregates consecutive WhatsApp messages ("penggalan chat") from the same user
// into a single conversational turn so the bot reads ALL bubbles first before
// replying once — just like a real human on WhatsApp.
//
// Key features:
// 1. Immediate synchronous bubble collection (fixes the old promise-chain bug
//    where bubble #2 waited for bubble #1's timer + reply to finish).
// 2. Smart human wait windows:
//    - Opener / cliffhanger bubbles ("p", "halo", "min", "kak mau tanya",
//      uncaptioned images, etc.) wait longer (~5.5s) because the user is
//      almost certainly still typing their actual question.
//    - Follow-up bubbles reset the timer (~3.8s) until the user finishes typing.
// 3. In-flight cancellation & re-batching:
//    - If the user sends ANOTHER bubble while the bot is currently reading,
//      waiting on AI, or simulating typing (before the reply is sent to WA),
//      the in-flight reply is aborted immediately, the un-sent bubbles are
//      merged with the new bubble, and the bot waits to send ONE unified reply.
// 4. Crash persistence: pending buffers are saved to disk on shutdown.

import fsp from 'fs/promises';
import fs from 'fs';
import { logger } from '../utils/logger.js';

const OPENER_WINDOW_MS = 5500;      // Greeting / callout / uncaptioned image — user is still typing
const SHORT_FIRST_WINDOW_MS = 4500; // Short first bubble (<= 4 words)
const NORMAL_WINDOW_MS = 3800;      // Standard pause between bubbles
const CLIFFHANGER_WINDOW_MS = 4800; // Bubble ending mid-thought ("mau tanya", "jadi gini", etc.)
const GROUP_WINDOW_MS = 2800;       // Group direct mention/reply window
const GROUP_OPENER_WINDOW_MS = 3600;
const MAX_TOTAL_WAIT_MS = 18000;    // Max wait from first bubble in a burst
const MAX_FRAGMENTS = 10;           // Max bubbles before immediate flush
const PENDING_FILE = './.buffer-pending.json';

// Patterns that almost always precede another bubble from the user
const OPENER_EXACT_RE = /^(p|pp|ppp|tes|test|ping|halo+|hai+|hi+|hello+|hey+|pagi|siang|sore|malem|malam|assalamualaikum|asalamualaikum|permisi|punten|min|admin|kak|ka|bang|bg|bro|gan|sis|bima|cs|oi|woi|woy|eh|ehm|anu|bentar|cek)$/i;
const OPENER_PHRASE_RE = /^(halo+|hai+|hi+|permisi|punten|assalamualaikum|min|admin|kak|ka|bang|bg|bro|gan|bima)?[\s,.!]*(min|admin|kak|ka|bang|bg|bro|gan|bima)?[\s,.!]*(mau\s+(tanya|nanya|order|beli|top\s*up|topup|cek)|nanya\s+dong|tanya\s+dong|bisa\s+bantu|tolong\s+bantu|ada\s+orang|online\s+ga|on\s+ga|buka\s+ga)[\s?.!]*$/i;
const CLIFFHANGER_END_RE = /(\b(mau\s+tanya|mau\s+nanya|nanya\s+dong|tanya\s+dong|jadi\s+gini|gini\s+(kak|min|bang)|terus|trus|sama\s+satu\s+lagi|oh\s+iya|oya|eh\s+iya|bentar|tunggu)\s*[,.…]*|[,\-…:])$/i;

// jid -> {
//   parts: string[],
//   image: { data, mime } | null,
//   timer: Timeout | null,
//   latestMsg: any,
//   firstBubbleAt: number,
//   gen: number,
//   inFlight: { aborter: AbortController, parts: string[], image: any, gen: number } | null,
//   flushFn: Function | null,
//   options: { isGroup?: boolean }
// }
const buffers = new Map();
let defaultFlushFn = null;

export function setDefaultFlushFn(fn) {
  defaultFlushFn = fn;
}

try {
  if (fs.existsSync(PENDING_FILE)) {
    const raw = fs.readFileSync(PENDING_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data) && data.length) {
      logger?.info('Buffer', `Loaded ${data.length} pending fragments`);
      for (const item of data) {
        if (item.parts?.length || item.image?.data) {
          buffers.set(item.jid, {
            parts: Array.isArray(item.parts) ? item.parts : [],
            image: item.image?.data ? { data: item.image.data, mime: item.image.mime || 'image/png' } : null,
            timer: null,
            latestMsg: null,
            firstBubbleAt: Date.now(),
            gen: 1,
            inFlight: null,
            flushFn: null,
            options: {},
          });
        }
      }
    }
    fs.unlinkSync(PENDING_FILE);
  }
} catch {
  try { fs.unlinkSync(PENDING_FILE); } catch {}
}

export function isOpenerOrCliffhanger(text) {
  const clean = String(text || '').trim();
  if (!clean) return true;
  const stripped = clean.replace(/[?!.,…]+$/g, '').trim();
  if (OPENER_EXACT_RE.test(stripped)) return true;
  if (OPENER_PHRASE_RE.test(stripped)) return true;
  if (CLIFFHANGER_END_RE.test(clean)) return true;
  return false;
}

function pickWindow(entry) {
  const isGroup = Boolean(entry.options?.isGroup);
  const parts = entry.parts;
  const lastPart = parts[parts.length - 1] || '';
  const cleanLast = lastPart.replace(/^\[Membalas pesan:[^\]]*\]\s*/i, '').trim();

  // If user sent an image without caption yet, wait for their follow-up text bubble
  if (entry.image && parts.length === 0) {
    return isGroup ? GROUP_OPENER_WINDOW_MS : OPENER_WINDOW_MS;
  }

  if (isOpenerOrCliffhanger(cleanLast)) {
    return isGroup
      ? GROUP_OPENER_WINDOW_MS
      : (parts.length === 1 ? OPENER_WINDOW_MS : CLIFFHANGER_WINDOW_MS);
  }

  if (isGroup) return GROUP_WINDOW_MS;

  const words = cleanLast.split(/\s+/).filter(Boolean).length;
  if (parts.length === 1 && words <= 4) {
    return SHORT_FIRST_WINDOW_MS;
  }

  return NORMAL_WINDOW_MS;
}

export function cancelBuffer(jid) {
  const entry = buffers.get(jid);
  if (!entry) return;
  entry.gen++;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.inFlight) {
    try { entry.inFlight.aborter.abort(); } catch {}
    entry.inFlight = null;
  }
  buffers.delete(jid);
}

export function hasActiveBuffer(jid) {
  const entry = buffers.get(jid);
  if (!entry) return false;
  return Boolean(entry.timer || entry.inFlight || entry.parts.length || entry.image);
}

export function flushPendingBuffers() {
  if (!defaultFlushFn) return;
  for (const [jid, entry] of buffers) {
    if (!entry.timer && !entry.inFlight && (entry.parts.length || entry.image)) {
      triggerFlush(jid, entry);
    }
  }
}

export async function savePendingBuffers() {
  const pending = [];
  for (const [jid, entry] of buffers) {
    const allParts = [
      ...(entry.inFlight?.parts || []),
      ...entry.parts,
    ];
    const img = entry.image || entry.inFlight?.image || null;
    if (allParts.length || img) {
      pending.push({
        jid,
        parts: allParts,
        image: img ? { data: img.data, mime: img.mime } : null,
      });
    }
  }
  if (pending.length) {
    try {
      await fsp.writeFile(PENDING_FILE, JSON.stringify(pending));
    } catch {}
  }
}

export function getPendingCount() {
  let count = 0;
  for (const entry of buffers.values()) {
    count += entry.parts.length + (entry.inFlight?.parts?.length || 0);
  }
  return count;
}

function triggerFlush(jid, entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  const parts = [...entry.parts];
  const image = entry.image;
  const latestMsg = entry.latestMsg;
  const fn = entry.flushFn || defaultFlushFn;

  entry.parts = [];
  entry.image = null;
  entry.firstBubbleAt = 0;

  const combined = parts.join('\n').trim();
  if (!combined && !image) {
    if (!entry.inFlight) buffers.delete(jid);
    return;
  }
  if (!fn) {
    buffers.delete(jid);
    return;
  }

  const myGen = entry.gen;
  const aborter = new AbortController();
  entry.inFlight = { aborter, parts, image, gen: myGen };

  const meta = {
    signal: aborter.signal,
    isCancelled: () => entry.gen !== myGen || aborter.signal.aborted,
    bubbleCount: parts.length,
    parts,
  };

  Promise.resolve(fn(jid, combined, image, latestMsg, meta))
    .catch((err) => {
      if (!aborter.signal.aborted) {
        logger?.debug('Buffer', `Flush error for ${jid}: ${err?.message || err}`);
      }
    })
    .finally(() => {
      const current = buffers.get(jid);
      if (!current) return;
      if (current.inFlight && current.inFlight.gen === myGen) {
        current.inFlight = null;
      }
      if (!current.timer && !current.inFlight && !current.parts.length && !current.image) {
        buffers.delete(jid);
      }
    });
}

export function bufferAiMessage(jid, msg, text, image, flushFn, options = {}) {
  let entry = buffers.get(jid);
  if (!entry) {
    entry = {
      parts: [],
      image: null,
      timer: null,
      latestMsg: msg,
      firstBubbleAt: Date.now(),
      gen: 0,
      inFlight: null,
      flushFn: flushFn || defaultFlushFn,
      options,
    };
    buffers.set(jid, entry);
  }

  entry.gen++;
  if (flushFn) entry.flushFn = flushFn;
  if (options && Object.keys(options).length) entry.options = { ...entry.options, ...options };

  // If a reply for earlier bubbles is currently in-flight (not yet sent to WA),
  // abort it and merge those earlier bubbles with this new incoming bubble!
  if (entry.inFlight) {
    const prevFlight = entry.inFlight;
    entry.inFlight = null;
    try { prevFlight.aborter.abort(); } catch {}
    if (prevFlight.parts?.length) {
      entry.parts = [...prevFlight.parts, ...entry.parts];
    }
    if (prevFlight.image && !entry.image) {
      entry.image = prevFlight.image;
    }
    if (!entry.firstBubbleAt) {
      entry.firstBubbleAt = Date.now();
    }
    logger?.debug('Buffer', `Chat susulan dari ${jid.replace(/@.*/, '')} — menggabungkan ${entry.parts.length + (text ? 1 : 0)} bubble sebelum membalas`);
  }

  if (!entry.firstBubbleAt) entry.firstBubbleAt = Date.now();
  if (text && text.trim()) entry.parts.push(text.trim());
  if (image) entry.image = image;
  if (msg) entry.latestMsg = msg;

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  const elapsedSinceFirst = Date.now() - entry.firstBubbleAt;
  if (entry.parts.length >= MAX_FRAGMENTS || elapsedSinceFirst >= MAX_TOTAL_WAIT_MS) {
    triggerFlush(jid, entry);
    return;
  }

  const desiredWindow = pickWindow(entry);
  const remainingCap = Math.max(1200, MAX_TOTAL_WAIT_MS - elapsedSinceFirst);
  const windowMs = Math.min(desiredWindow, remainingCap);

  entry.timer = setTimeout(() => {
    entry.timer = null;
    triggerFlush(jid, entry);
  }, windowMs);
}
