// Aggregates rapid consecutive messages from the same user ("penggalan bahasan")
// into one turn, so the AI reads the full thought before replying — instead of
// answering the first bubble and dropping the rest.
//
// Adaptive timing: short messages get a shorter window, long messages get more time.
// Max 5 fragments: beyond that, flush immediately (user is spamming).
//
// Uses per-jid promise chain to serialize concurrent buffer creation attempts.
// Buffer persistence (C4): pending fragments saved to file on shutdown.

import fsp from 'fs/promises';
import fs from 'fs';
import { logger } from '../utils/logger.js';

const SHORT_WINDOW_MS = 1000;
const LONG_WINDOW_MS = 2000;
const MAX_FRAGMENTS = 5;
const SHORT_MSG_THRESHOLD = 3; // words
const PENDING_FILE = './.buffer-pending.json';

const buffers = new Map(); // jid -> { parts: string[], image, timer, latestMsg }
const bufferChain = new Map(); // jid -> Promise (serialization chain)
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
        if (item.parts?.length) {
          buffers.set(item.jid, {
            parts: item.parts,
            image: item.image?.data ? { data: item.image.data, mime: (item.image.mime || 'image/png') } : null,
            timer: null,
            latestMsg: null,
          });
        }
      }
    }
    fs.unlinkSync(PENDING_FILE);
  }
} catch {
  try { fs.unlinkSync(PENDING_FILE); } catch {}
}

export function flushPendingBuffers() {
  if (!defaultFlushFn) return;
  const now = Date.now();
  for (const [jid, entry] of buffers) {
    if (!entry.timer && entry.parts.length) {
      buffers.delete(jid);
      const combined = entry.parts.join('\n').trim();
      if (combined) {
        Promise.resolve(defaultFlushFn(jid, combined, entry.image, null)).catch(() => {});
      }
    }
  }
}

export async function savePendingBuffers() {
  const pending = [];
  for (const [jid, entry] of buffers) {
    if (entry.parts.length) {
      pending.push({ jid, parts: entry.parts, image: entry.image ? { data: entry.image.data, mime: entry.image.mime } : null });
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
  for (const entry of buffers.values()) count += entry.parts.length;
  return count;
}

function pickWindow(parts) {
  for (const p of parts) {
    if (p && p.split(/\s+/).filter(Boolean).length > SHORT_MSG_THRESHOLD) return LONG_WINDOW_MS;
  }
  return SHORT_WINDOW_MS;
}

export function bufferAiMessage(jid, msg, text, image, flushFn) {
  const prev = bufferChain.get(jid) || Promise.resolve();
  const cur = prev.then(() => {
    let entry = buffers.get(jid);
    if (!entry) {
      entry = { parts: [], image: null, timer: null, latestMsg: msg };
      buffers.set(jid, entry);
    }

    if (text) entry.parts.push(text);
    if (image) entry.image = image;
    entry.latestMsg = msg;

    if (entry.parts.length >= MAX_FRAGMENTS) {
      if (entry.timer) clearTimeout(entry.timer);
      buffers.delete(jid);
      const combined = entry.parts.join('\n').trim();
      return Promise.resolve((flushFn || defaultFlushFn)(jid, combined, entry.image, entry.latestMsg)).catch(() => {});
    }

    if (entry.timer) clearTimeout(entry.timer);
    const windowMs = pickWindow(entry.parts);
    return new Promise(resolve => {
      entry.timer = setTimeout(() => {
        buffers.delete(jid);
        const combined = entry.parts.join('\n').trim();
        resolve(Promise.resolve((flushFn || defaultFlushFn)(jid, combined, entry.image, entry.latestMsg)).catch(() => {}));
      }, windowMs);
    });
  }).catch(() => {});
  bufferChain.set(jid, cur);
}
