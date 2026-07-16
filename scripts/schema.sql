-- ============================================
-- WA Bot NDXStore — Schema (single source of truth)
-- ============================================

CREATE TABLE IF NOT EXISTS wa_chat_history (
  id SERIAL PRIMARY KEY,
  user_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
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
  last_activity TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_bot_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

INSERT INTO wa_bot_config (key, value) VALUES
  ('admin_numbers', to_jsonb(ARRAY['CHANGE_ME']::text[])),
  ('max_per_day', to_jsonb(50)),
  ('delay_ms', to_jsonb(3000)),
  ('bot_paused', to_jsonb(false)),
  ('bot_settings', '{"jawabDuluan": false, "ungroup": false, "aiMode": 0}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE wa_chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_user_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_handover_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_bot_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role all" ON wa_chat_history FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role all" ON wa_user_limits FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role all" ON wa_handover_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role all" ON wa_bot_config FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "no anon access" ON wa_chat_history FOR ALL TO anon USING (false);
CREATE POLICY "no anon access" ON wa_user_limits FOR ALL TO anon USING (false);
CREATE POLICY "no anon access" ON wa_handover_sessions FOR ALL TO anon USING (false);
CREATE POLICY "no anon access" ON wa_bot_config FOR ALL TO anon USING (false);
