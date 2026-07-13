// Aggregates rapid consecutive messages from the same user ("penggalan bahasan")
// into one turn, so the AI reads the full thought before replying — instead of
// answering the first bubble and dropping the rest.

const BUFFER_WINDOW_MS = 4000; // wait this long after the last message before answering

const buffers = new Map(); // jid -> { parts: string[], image, timer, latestMsg }

/**
 * Buffer an incoming AI-bound message. Every new message resets the timer.
 * When the user stops for BUFFER_WINDOW_MS, flushFn is called once with the
 * joined text, the latest image (if any), and the last message (to reply to).
 *
 * @param {string} jid
 * @param {object} msg        whatsapp-web.js message (used only to reply to)
 * @param {string} text       this fragment's text (may be empty for image-only)
 * @param {?{data:string,mime:string}} image
 * @param {(jid:string, text:string, image:?object, latestMsg:object)=>any} flushFn
 */
export function bufferAiMessage(jid, msg, text, image, flushFn) {
  let entry = buffers.get(jid);
  if (!entry) {
    entry = { parts: [], image: null, timer: null, latestMsg: msg };
    buffers.set(jid, entry);
  }

  if (text) entry.parts.push(text);
  if (image) entry.image = image; // keep the most recent image
  entry.latestMsg = msg;

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    buffers.delete(jid);
    const combined = entry.parts.join('\n').trim();
    Promise.resolve(flushFn(jid, combined, entry.image, entry.latestMsg)).catch(() => {});
  }, BUFFER_WINDOW_MS);
}
