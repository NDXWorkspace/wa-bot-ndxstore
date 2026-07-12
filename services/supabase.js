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

export async function ensureTables() {
  const sql = `
  CREATE TABLE IF NOT EXISTS wa_chat_history (
    id SERIAL PRIMARY KEY,
    user_number TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_wa_chat_user ON wa_chat_history(user_number, created_at DESC);

  CREATE TABLE IF NOT EXISTS wa_user_limits (
    user_number TEXT PRIMARY KEY,
    message_count INTEGER DEFAULT 0,
    last_reset_date DATE DEFAULT CURRENT_DATE,
    max_per_day INTEGER DEFAULT 50
  );

  CREATE TABLE IF NOT EXISTS wa_handover_sessions (
    user_number TEXT PRIMARY KEY,
    admin_number TEXT NOT NULL,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS wa_bot_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
  );

  INSERT INTO wa_bot_config (key, value) VALUES
    ('admin_numbers', to_jsonb(ARRAY['${config.adminNumber}']::text[]))
  ON CONFLICT (key) DO NOTHING;

  INSERT INTO wa_bot_config (key, value) VALUES
    ('max_per_day', to_jsonb(${config.maxDailyMessages}::int))
  ON CONFLICT (key) DO NOTHING;

  INSERT INTO wa_bot_config (key, value) VALUES
    ('delay_ms', to_jsonb(${config.delayMs}::int))
  ON CONFLICT (key) DO NOTHING;

  INSERT INTO wa_bot_config (key, value) VALUES
    ('bot_paused', to_jsonb(false))
  ON CONFLICT (key) DO NOTHING;
  `;

  const db = getDb();
  if (!db) return;
  const { error } = await db.rpc('exec_sql', { sql });
  if (error) {
    console.warn('[Supabase] Could not auto-create tables via RPC, create them manually in Supabase SQL Editor');
    console.warn('[Supabase] Error:', error.message);
  } else {
    console.log('[Supabase] Tables ensured');
  }
}

export async function getConfig(key) {
  const db = getDb();
  if (!db) return null;
  const { data, error } = await db.from('wa_bot_config').select('value').eq('key', key).single();
  if (error || !data) return null;
  return data.value;
}

export async function setConfig(key, value) {
  const db = getDb();
  if (!db) return;
  await db.from('wa_bot_config').upsert({ key, value }, { onConflict: 'key' });
}
