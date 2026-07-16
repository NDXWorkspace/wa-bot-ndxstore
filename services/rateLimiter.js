import { logger, throttleLog } from '../utils/logger.js';

const queue = [];
let processing = false;
let lastSent = 0;
const MIN_INTERVAL_MS = 1200;
const MAX_RETRIES = 3;
const MAX_QUEUE_SIZE = 2000;

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      const now = Date.now();
      const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastSent));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      lastSent = Date.now();
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await item.send();
          success = true;
          break;
        } catch (e) {
          const isRateLimit = e.message?.includes('rate') || e.message?.includes('429') || e.message?.includes('too many');
          const isNetwork = e.message?.includes('timeout') || e.message?.includes('ETIMEDOUT') || e.message?.includes('ECONN');
          const retryable = isRateLimit || isNetwork;
          if (!retryable || attempt >= MAX_RETRIES) {
            logger.error('RateLimit', `Send failed (${attempt}/${MAX_RETRIES}):`, e.message?.slice(0, 120));
          } else {
            const waitMs = isRateLimit ? 5000 * attempt : 2000 * attempt;
            throttleLog('warn', 'RateLimit', `retry-${item.send?.name || ''}`, `Retry ${attempt}/${MAX_RETRIES}: ${e.message?.slice(0, 80)}`, 5000);
            await new Promise(r => setTimeout(r, waitMs));
          }
        }
      }
      lastSent = Date.now(); // Always update to maintain spacing
      if (!success) {
        throttleLog('warn', 'RateLimit', 'dropped', 'Message dropped after exhausting retries', 60000);
      }
    }
  } finally {
    processing = false;
  }
}

export function enqueueSend(sendFn) {
  if (queue.length >= MAX_QUEUE_SIZE) {
    throttleLog('warn', 'RateLimit', 'queue-full', 'Queue full, dropping message', 60000);
    return;
  }
  queue.push({ send: sendFn });
  if (!processing) {
    processQueue();
  }
}
