import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let supabase = null;
let supabaseRt = null;

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
