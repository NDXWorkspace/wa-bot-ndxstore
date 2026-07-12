-- ============================================
-- WA Bot NDXStore — Supabase SQL Migration
-- Jalankan di Supabase Dashboard → SQL Editor
-- ============================================

-- Riwayat chat per user (konteks AI)
CREATE TABLE IF NOT EXISTS wa_chat_history (
  id SERIAL PRIMARY KEY,
  user_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_chat_user ON wa_chat_history(user_number, created_at DESC);

-- Limit harian per user
CREATE TABLE IF NOT EXISTS wa_user_limits (
  user_number TEXT PRIMARY KEY,
  message_count INTEGER DEFAULT 0,
  last_reset_date DATE DEFAULT CURRENT_DATE,
  max_per_day INTEGER DEFAULT 50
);

-- Sesi handover ke CS
CREATE TABLE IF NOT EXISTS wa_handover_sessions (
  user_number TEXT PRIMARY KEY,
  admin_number TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Konfigurasi bot (key-value JSON)
CREATE TABLE IF NOT EXISTS wa_bot_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Default config
INSERT INTO wa_bot_config (key, value) VALUES
  ('admin_numbers', to_jsonb(ARRAY['6285159898005']::text[]))
ON CONFLICT (key) DO NOTHING;

INSERT INTO wa_bot_config (key, value) VALUES
  ('max_per_day', to_jsonb(50))
ON CONFLICT (key) DO NOTHING;

INSERT INTO wa_bot_config (key, value) VALUES
  ('delay_ms', to_jsonb(3000))
ON CONFLICT (key) DO NOTHING;

INSERT INTO wa_bot_config (key, value) VALUES
  ('bot_paused', to_jsonb(false))
ON CONFLICT (key) DO NOTHING;

SELECT 'WA Bot NDXStore tables created successfully!' as result;
