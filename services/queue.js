import { getDb } from './supabase.js';
import { logger } from '../utils/logger.js';
import { withRetry, isRelationError } from '../utils/db.js';

const DAILY_LIMIT_DEFAULT = 50;
const CHAIN_CLEANUP_MS = 3600000;

// Serialize per user so the read-then-update below is atomic within this process
// (single instance) — stops concurrent message fragments from miscounting the limit.
const limitChains = new Map();

setInterval(() => {
  const cutoff = Date.now() - CHAIN_CLEANUP_MS;
  for (const [jid, entry] of limitChains) {
    if (entry.ts < cutoff || limitChains.size > 500) limitChains.delete(jid);
  }
}, 300000).unref();

export function checkDailyLimit(userJid) {
  if (!limitChains.has(userJid)) limitChains.set(userJid, { chain: Promise.resolve(), ts: Date.now() });
  const prev = limitChains.get(userJid).chain;
  const run = prev.then(() => checkDailyLimitInner(userJid), () => checkDailyLimitInner(userJid));
  const tail = run.catch(() => {});
  limitChains.set(userJid, { chain: tail, ts: Date.now() });
  tail.then(() => {
    const cur = limitChains.get(userJid);
    if (cur && cur.chain === tail) limitChains.delete(userJid);
  });
  return run;
}

async function checkDailyLimitInner(userJid) {
  const db = getDb();
  if (!db) return { allowed: true };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await withRetry(() => db
      .from('wa_user_limits')
      .select('message_count, last_reset_date, max_per_day')
      .eq('user_number', userJid)
      .single(), { label: 'Queue:select' });

    if (error?.code === 'PGRST116') {
      await withRetry(() => db.from('wa_user_limits').insert({
        user_number: userJid,
        message_count: 1,
        last_reset_date: today,
        max_per_day: DAILY_LIMIT_DEFAULT,
      }), { label: 'Queue:insert' });
      return { allowed: true, remaining: DAILY_LIMIT_DEFAULT - 1 };
    }

    if (data) {
      if (data.last_reset_date !== today) {
        await withRetry(() => db.from('wa_user_limits').update({
          message_count: 1,
          last_reset_date: today,
        }).eq('user_number', userJid), { label: 'Queue:update' });
        return { allowed: true, remaining: (data.max_per_day || DAILY_LIMIT_DEFAULT) - 1 };
      }
      if (data.message_count >= (data.max_per_day || DAILY_LIMIT_DEFAULT)) {
        return { allowed: false, remaining: 0 };
      }
      await withRetry(() => db.from('wa_user_limits').update({
        message_count: data.message_count + 1,
      }).eq('user_number', userJid), { label: 'Queue:update' });
      return { allowed: true, remaining: (data.max_per_day || DAILY_LIMIT_DEFAULT) - data.message_count - 1 };
    }
  } catch (e) {
    if (!isRelationError(e)) {
      logger.error('Queue', 'Daily limit error:', e.message);
    }
  }
  return { allowed: true };
}
