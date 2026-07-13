// Rate limiter untuk outgoing WhatsApp messages
// Mencegah rate-limit dari WhatsApp dengan antrean + delay

const queue = [];
let processing = false;
let lastSent = 0;
const MIN_INTERVAL_MS = 1200; // max ~50 messages per minute
const MAX_RETRIES = 3;

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const item = queue.shift();
    const now = Date.now();
    const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastSent));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await item.send();
        lastSent = Date.now();
        break;
      } catch (e) {
        console.error(`[RateLimit] send error (attempt ${attempt}/${MAX_RETRIES}):`, e.message);
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  processing = false;
}

export function enqueueSend(sendFn) {
  queue.push({ send: sendFn });
  processQueue();
}
