import 'dotenv/config';
import pkg from 'pg';
const { Client } = pkg;

const SUPABASE_URL = process.env.SUPABASE_URL;
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.SUPABASE_KEY;
const projectRef = SUPABASE_URL?.replace('https://', '').split('.')[0];

if (!SUPABASE_URL || !DB_PASSWORD) {
  console.error('Set SUPABASE_URL and DB_PASSWORD (or SUPABASE_KEY as fallback)');
  process.exit(1);
}

async function tryConnect(host, port, user) {
  const c = new Client({
    host,
    port,
    database: 'postgres',
    user,
    password: DB_PASSWORD,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 8000,
  });
  try {
    await c.connect();
    return c;
  } catch (e) {
    await c.end().catch(() => {});
    throw e;
  }
}

async function connect() {
  const attempts = [
    { host: `db.${projectRef}.supabase.co`, port: 5432, user: 'postgres' },
    { host: `db.${projectRef}.supabase.co`, port: 5432, user: `postgres.${projectRef}` },
    { host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 6543, user: `postgres.${projectRef}` },
    { host: `${projectRef}.supabase.co`, port: 6543, user: 'postgres' },
  ];

  for (const { host, port, user } of attempts) {
    try {
      console.log(`Trying ${user}@${host}:${port}...`);
      const c = await tryConnect(host, port, user);
      console.log(`Connected via ${host}:${port}`);
      return c;
    } catch (e) {
      console.log(`  -> ${e.message.slice(0, 100)}`);
    }
  }
  throw new Error('All connection attempts failed');
}

const RETRY_DELAYS = [2000, 5000, 10000];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function queryWithRetry(client, sql, label = 'query', retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await client.query(sql);
      return;
    } catch (e) {
      if (attempt < retries && (
        e.message?.includes('timeout') ||
        e.message?.includes('connection') ||
        e.message?.includes('terminated')
      )) {
        console.log(`  ${label}: retry ${attempt + 1}/${retries} after ${RETRY_DELAYS[attempt]}ms`);
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      throw e;
    }
  }
}

const SQL = `
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
  ('admin_numbers', to_jsonb(ARRAY['6285159898005']::text[])),
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
`;

async function main() {
  console.log('Connecting to Supabase PostgreSQL...');
  const client = await connect();
  console.log('Connected. Running migration...');

  console.log('Creating tables & indexes...');
  await queryWithRetry(client, SQL, 'schema');

  console.log('Verifying tables...');
  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('wa_chat_history', 'wa_handover_sessions', 'wa_bot_config', 'wa_user_limits')
    ORDER BY table_name
  `);
  console.log('Verified:', rows.map(r => r.table_name).join(', '));

  await client.end();
  console.log('Migration completed successfully!');
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
