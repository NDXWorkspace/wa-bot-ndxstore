import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger, throttleLog } from '../utils/logger.js';
import { setDbAvailable, isDbAvailable } from '../utils/db.js';

let supabase = null;
let supabaseRt = null;
let dbFailureCount = 0;
const DB_FAILURE_THRESHOLD = 3;

function markDbResult(success) {
  if (success) {
    dbFailureCount = 0;
    if (!isDbAvailable()) {
      setDbAvailable(true);
      logger.info('Supabase', 'DB connection restored');
    }
  } else {
    dbFailureCount++;
    if (dbFailureCount >= DB_FAILURE_THRESHOLD && isDbAvailable()) {
      setDbAvailable(false);
      throttleLog('warn', 'Supabase', 'db-unavail', `DB marked unavailable after ${dbFailureCount} consecutive failures`, 30000);
    }
  }
}

export function getDb() {
  if (supabase) return supabase;
  if (!config.supabase.key) {
    logger.warn('Supabase', 'No SUPABASE_KEY set');
    return null;
  }
  supabase = createClient(config.supabase.url, config.supabase.key);
  return supabase;
}

export function getDbWithRealtime() {
  if (supabaseRt) return supabaseRt;
  if (!config.supabase.key) {
    logger.warn('Supabase', 'No SUPABASE_KEY set');
    return null;
  }
  supabaseRt = createClient(config.supabase.url, config.supabase.key, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return supabaseRt;
}


