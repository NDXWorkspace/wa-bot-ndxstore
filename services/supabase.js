import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let supabase = null;
let supabaseRt = null;
let warnedNoKey = false;

export function getDb() {
  if (supabase) return supabase;
  if (!config.supabase.url || !config.supabase.key) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      logger.info('Supabase', 'SUPABASE_URL/KEY tidak diisi — berjalan dengan penyimpanan lokal');
    }
    return null;
  }
  supabase = createClient(config.supabase.url, config.supabase.key);
  return supabase;
}

export function getDbWithRealtime() {
  if (supabaseRt) return supabaseRt;
  if (!config.supabase.url || !config.supabase.key) {
    return null;
  }
  supabaseRt = createClient(config.supabase.url, config.supabase.key, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return supabaseRt;
}


