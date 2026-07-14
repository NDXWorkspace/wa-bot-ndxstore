// Aggregates rapid consecutive messages from the same user ("penggalan bahasan")
// into one turn, so the AI reads the full thought before replying — instead of
// answering the first bubble and dropping the rest.
//
// Adaptive timing: short messages get a shorter window, long messages get more time.
// Max 5 fragments: beyond that, flush immediately (user is spamming).

const SHORT_WINDOW_MS = 2000;
const LONG_WINDOW_MS = 4000;
const MAX_FRAGMENTS = 5;
const SHORT_MSG_THRESHOLD = 3; // words

const buffers = new Map(); // jid -> { parts: string[], image, timer, latestMsg }

function pickWindow(parts) {
  // If any part is long enough, use the long window
  for (const p of parts) {
    if (p && p.split(/\s+/).filter(Boolean).length > SHORT_MSG_THRESHOLD) return LONG_WINDOW_MS;
  }
  return SHORT_WINDOW_MS;
}

export function bufferAiMessage(jid, msg, text, image, flushFn) {
  let entry = buffers.get(jid);
  if (!entry) {
    entry = { parts: [], image: null, timer: null, latestMsg: msg };
    buffers.set(jid, entry);
  }

  if (text) entry.parts.push(text);
  if (image) entry.image = image;
  entry.latestMsg = msg;

  // Too many fragments — flush now
  if (entry.parts.length >= MAX_FRAGMENTS) {
    if (entry.timer) clearTimeout(entry.timer);
    buffers.delete(jid);
    const combined = entry.parts.join('\n').trim();
    Promise.resolve(flushFn(jid, combined, entry.image, entry.latestMsg)).catch(() => {});
    return;
  }

  if (entry.timer) clearTimeout(entry.timer);
  const windowMs = pickWindow(entry.parts);
  entry.timer = setTimeout(() => {
    buffers.delete(jid);
    const combined = entry.parts.join('\n').trim();
    Promise.resolve(flushFn(jid, combined, entry.image, entry.latestMsg)).catch(() => {});
  }, windowMs);
}
