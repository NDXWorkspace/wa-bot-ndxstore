import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let supabase = null;

export function getDb() {
  if (supabase) return supabase;
  if (!config.supabase.key) {
    console.warn('[Supabase] No SUPABASE_KEY set — some features will be unavailable');
    return null;
  }
  supabase = createClient(config.supabase.url, config.supabase.key);
  return supabase;
}
