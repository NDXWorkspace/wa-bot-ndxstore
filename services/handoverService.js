import { getDb } from './supabase.js';
import { logger } from '../utils/logger.js';
import { isRelationError } from '../utils/db.js';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MSG_CLEANUP_AGE_MS = 60 * 60 * 1000;

const handoverSessions = new Map();
const forwardedMessages = new Map();

function msgKey(msg) {
  return msg && msg.id ? `${msg.id.id}|${msg.id.fromMe}|${msg.id.remote}` : '';
}

async function loadSessionsFromDb() {
  try {
    const db = getDb();
    if (!db) return;
    const { data } = await db
      .from('wa_handover_sessions')
      .select('*')
      .eq('active', true);
    if (!data?.length) return;
    for (const s of data) {
      handoverSessions.set(s.user_number, {
        adminNumber: s.admin_number,
        lastActivity: new Date(s.last_activity || s.created_at).getTime(),
      });
    }
    logger.info('Handover', `Loaded ${data.length} active sessions`);
  } catch (e) {
    logger.warn('Handover', `Failed to load sessions from DB: ${e.message}`);
  }
}

async function persistSession(userNumber, adminNumber) {
  try {
    const db = getDb();
    if (!db) return;
    await db.from('wa_handover_sessions').upsert({
      user_number: userNumber,
      admin_number: adminNumber,
      active: true,
      last_activity: new Date().toISOString(),
    }, { onConflict: 'user_number' });
  } catch (e) {
    if (!isRelationError(e)) {
      logger.error('Handover', 'DB persist error:', e.message?.slice(0, 100));
    }
  }
}

async function touchSessionDb(userNumber) {
  try {
    const db = getDb();
    if (!db) return;
    await db.from('wa_handover_sessions')
      .update({ last_activity: new Date().toISOString() })
      .eq('user_number', userNumber);
  } catch {}
}

async function removeSessionFromDb(userNumber) {
  try {
    const db = getDb();
    if (!db) return;
    await db.from('wa_handover_sessions')
      .update({ active: false })
      .eq('user_number', userNumber);
  } catch {}
}

export async function initHandover() {
  await loadSessionsFromDb();
}

setInterval(() => {
  const now = Date.now();
  for (const [userNumber, session] of handoverSessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      handoverSessions.delete(userNumber);
      removeSessionFromDb(userNumber).catch(() => {});
    }
  }
  for (const [msgId, data] of forwardedMessages) {
    if (now - data.timestamp > MSG_CLEANUP_AGE_MS) {
      forwardedMessages.delete(msgId);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

export function isHandoverActive(userNumber) {
  return handoverSessions.has(userNumber);
}

export function endHandover(userNumber) {
  handoverSessions.delete(userNumber);
  removeSessionFromDb(userNumber).catch(() => {});
}

function touchSession(userNumber) {
  const session = handoverSessions.get(userNumber);
  if (session) {
    session.lastActivity = Date.now();
    touchSessionDb(userNumber).catch(() => {});
  }
}

export async function startHandover(client, msg, adminNumber) {
  const userNumber = msg.from;
  handoverSessions.set(userNumber, { adminNumber, lastActivity: Date.now() });
  persistSession(userNumber, adminNumber).catch(() => {});

  await msg.reply('Terhubung ke Customer Service\nSilakan kirim pesan Anda. Admin akan membalas segera.\n\nKetik *selesai* untuk mengakhiri.');

  const body = msg.body.trim() === 'cs' || msg.body.trim() === '4' ? '(memulai CS)' : msg.body;
  const adminMsg = await client.sendMessage(adminNumber,
    `📞 *CS Request*\nDari: ${userNumber}\nPesan: ${body}\n\nBalas dengan reply untuk membalas.`
  );

  forwardedMessages.set(msgKey(adminMsg), { userNumber, timestamp: Date.now() });
}

export async function handleAdminReply(client, msg) {
  if (!msg.hasQuotedMsg) return null;

  const quoted = await msg.getQuotedMessage();
  if (!quoted) return null;

  let userNumber = forwardedMessages.get(msgKey(quoted))?.userNumber;

  // Fallback that survives a restart (in-memory map is empty then): the bot's
  // forwarded messages embed the user's JID in their text — recover it from there.
  if (!userNumber && quoted.fromMe) {
    const m = quoted.body?.match(/(\d{6,}@c\.us)/);
    if (m) userNumber = m[1];
  }

  if (!userNumber) return null;

  await client.sendMessage(userNumber, `Pesan dari Admin:\n\n${msg.body}`);

  forwardedMessages.set(msgKey(msg), { userNumber, timestamp: Date.now() });
  touchSession(userNumber);

  return userNumber;
}

export async function forwardToAdmin(client, userNumber, messageBody, adminNumber) {
  touchSession(userNumber);

  const adminMsg = await client.sendMessage(adminNumber,
    `📩 *Pesan dari ${userNumber}:*\n\n${messageBody}\n\nBalas dengan reply untuk membalas.`
  );
  forwardedMessages.set(msgKey(adminMsg), { userNumber, timestamp: Date.now() });
}
