import { logger } from './logger.js';

const RETRYABLE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ECONNABORTED'];

let _dbAvailable = true;

export function isDbAvailable() {
  return _dbAvailable;
}

export function setDbAvailable(v) {
  _dbAvailable = v;
}

export function isRetryableError(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = (err.message || '').toLowerCase();
  return RETRYABLE_CODES.some(c => code === c || code.toLowerCase() === c.toLowerCase())
    || msg.includes('timeout')
    || msg.includes('fetch failed')
    || msg.includes('network')
    || msg.includes('socket')
    || msg.includes('econnreset')
    || msg.includes('econnrefused')
    || msg.includes('enotfound')
    || msg.includes('epipe');
}

export async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 500, label = 'DB' } = options;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), 3000);
        logger.warn(label, `Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${err.message?.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}
