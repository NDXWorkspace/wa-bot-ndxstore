import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

import { fileURLToPath } from 'url';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || SUPABASE_KEY || 'wa-ai-bot-default-secret-2026').trim();

export function hasTar() {
  try {
    execSync('tar --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getDb() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

export function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encryptBuffer(buf, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptBuffer(b64, secret) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 28) throw new Error('Invalid encrypted payload');
  const key = deriveKey(secret);
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export async function publishUrl(tunnelUrl) {
  const cleanUrl = String(tunnelUrl || '').trim().replace(/\/+$/, '');
  if (!cleanUrl.startsWith('https://')) {
    console.error('[CloudRunner] Invalid tunnel URL:', cleanUrl);
    process.exit(1);
  }
  const payload = {
    url: cleanUrl,
    updatedAt: Date.now(),
    updatedIso: new Date().toISOString(),
    status: 'online',
  };

  // 1. Save to Supabase wa_bot_config if available
  const db = getDb();
  if (db) {
    try {
      await db.from('wa_bot_config').upsert({
        key: 'cloud_server_url',
        value: payload,
      }, { onConflict: 'key' });
      console.log('[CloudRunner] Saved tunnel URL to Supabase:', cleanUrl);
    } catch (e) {
      console.warn('[CloudRunner] Supabase save error:', e.message);
    }
  }

  // 2. Write local server.json for GitHub cloud-state branch push
  await fsp.writeFile('cloud-server.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log('[CloudRunner] Wrote cloud-server.json:', cleanUrl);
}

export async function backupSession() {
  const sessionDir = path.resolve('./wa-session');
  if (!fs.existsSync(sessionDir)) {
    console.log('[CloudRunner] No ./wa-session directory to backup.');
    return;
  }
  if (!hasTar()) {
    console.warn('[CloudRunner] "tar" executable not found in PATH, skipping backup.');
    return;
  }
  // Hanya backup sesi WA jika WhatsApp benar-benar sudah terhubung (jangan backup sesi kosong/unpaired)
  try {
    const port = process.env.PORT || 3000;
    let connected = false;

    // 1. Coba cek /ready (public health check tanpa butuh auth token)
    try {
      const readyRes = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(4000),
      });
      const rSt = await readyRes.json().catch(() => null);
      if (rSt && rSt.wa === 'connected') {
        connected = true;
      }
    } catch {}

    // 2. Fallback cek /api/status (sertakan header x-admin-token jika ADMIN_TOKEN disetel)
    if (!connected) {
      const headers = {};
      if (process.env.ADMIN_TOKEN) headers['x-admin-token'] = process.env.ADMIN_TOKEN;
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers,
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const st = await res.json();
        connected = st.wa === 'connected';
      }
    }

    if (!connected) {
      console.log('[CloudRunner] WhatsApp belum connected, skip backup sesi.');
      return;
    }
  } catch {
    return;
  }
  const tmpTar = path.resolve('./wa-session-backup.tar.gz');
  try {
    const excludes = [
      '--exclude=*Cache*',
      '--exclude=*Code Cache*',
      '--exclude=*GPUCache*',
      '--exclude=*DawnCache*',
      '--exclude=*ShaderCache*',
      '--exclude=*Service Worker*',
      '--exclude=*Crashpad*',
      '--exclude=*blob_storage*',
      '--exclude=*Singleton*',
      '--exclude=*.log',
    ].join(' ');
    execSync(`tar -czf "${tmpTar}" ${excludes} -C "${path.dirname(sessionDir)}" wa-session`, { stdio: 'pipe' });
    const buf = await fsp.readFile(tmpTar);
    console.log(`[CloudRunner] Compressed wa-session: ${(buf.length / 1024).toFixed(1)} KB`);
    if (buf.length > 35 * 1024 * 1024) {
      console.warn('[CloudRunner] Backup too large, skipping DB upload.');
      return;
    }
    const enc = encryptBuffer(buf, SESSION_SECRET);
    await fsp.writeFile('wa-session.enc', enc, 'utf8');

    const db = getDb();
    if (db) {
      await db.from('wa_bot_config').upsert({
        key: 'wa_cloud_session_enc',
        value: { data: enc, updatedAt: Date.now() },
      }, { onConflict: 'key' });
      console.log('[CloudRunner] Encrypted session backed up to Supabase.');
    }
  } catch (e) {
    console.warn('[CloudRunner] Backup warning:', e.message);
  } finally {
    try { await fsp.unlink(tmpTar); } catch {}
  }
}

export async function restoreSession() {
  let enc = null;
  const db = getDb();
  if (db) {
    try {
      const { data } = await db
        .from('wa_bot_config')
        .select('value')
        .eq('key', 'wa_cloud_session_enc')
        .single();
      if (data?.value?.data) {
        enc = data.value.data;
        console.log('[CloudRunner] Found encrypted session in Supabase.');
      }
    } catch {}
  }

  if (!enc && fs.existsSync('wa-session.enc')) {
    enc = await fsp.readFile('wa-session.enc', 'utf8');
    console.log('[CloudRunner] Found encrypted session in wa-session.enc.');
  }

  if (!enc) {
    console.log('[CloudRunner] No previous session backup found — starting fresh.');
    return;
  }

  if (!hasTar()) {
    console.warn('[CloudRunner] "tar" executable not found in PATH, skipping restore.');
    return;
  }

  const tmpTar = path.resolve('./wa-session-restore.tar.gz');
  try {
    const buf = decryptBuffer(enc.trim(), SESSION_SECRET);
    await fsp.writeFile(tmpTar, buf);
    await fsp.mkdir('./wa-session', { recursive: true });
    execSync(`tar -xzf "${tmpTar}" -C .`, { stdio: 'pipe' });
    console.log('[CloudRunner] Restored ./wa-session successfully.');
  } catch (e) {
    console.warn('[CloudRunner] Failed to restore session:', e.message);
  } finally {
    try { await fsp.unlink(tmpTar); } catch {}
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'publish-url') {
    publishUrl(process.argv[3]);
  } else if (cmd === 'backup') {
    backupSession();
  } else if (cmd === 'restore') {
    restoreSession();
  } else {
    console.log('Usage: node scripts/cloud-runner.mjs [publish-url <url> | backup | restore]');
  }
}
