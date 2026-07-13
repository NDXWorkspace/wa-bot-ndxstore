import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let supabase = null;

function getClient(realtime = false) {
  if (supabase) return supabase;
  if (!config.supabase.key) {
    console.warn('[Supabase] No SUPABASE_KEY set');
    return null;
  }
  const opts = realtime
    ? { realtime: { params: { eventsPerSecond: 10 } } }
    : {};
  supabase = createClient(config.supabase.url, config.supabase.key, opts);
  return supabase;
}

export function getDb() {
  return getClient(false);
}

export function getDbWithRealtime() {
  return getClient(true);
}
