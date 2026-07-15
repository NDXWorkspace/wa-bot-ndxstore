import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Client } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');

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
