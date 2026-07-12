const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MSG_CLEANUP_AGE_MS = 60 * 60 * 1000;

const handoverSessions = new Map();
const forwardedMessages = new Map();
const sessionTimers = new Map();

// Periodic cleanup for stale sessions + messages
setInterval(() => {
  const now = Date.now();

  for (const [userNumber, session] of handoverSessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`[Handover] Auto-ending stale session: ${userNumber}`);
      handoverSessions.delete(userNumber);
      sessionTimers.delete(userNumber);
    }
  }

  for (const [msgId, data] of forwardedMessages) {
    if (now - data.timestamp > MSG_CLEANUP_AGE_MS) {
      forwardedMessages.delete(msgId);
    }
  }
}, CLEANUP_INTERVAL_MS);

export function isHandoverActive(userNumber) {
  return handoverSessions.has(userNumber);
}

export function endHandover(userNumber) {
  handoverSessions.delete(userNumber);
  sessionTimers.delete(userNumber);
}

function touchSession(userNumber) {
  const session = handoverSessions.get(userNumber);
  if (session) {
    session.lastActivity = Date.now();
  }
}

export async function startHandover(client, msg, adminNumber) {
  const userNumber = msg.from;
  handoverSessions.set(userNumber, { adminNumber, lastActivity: Date.now() });

  await msg.reply('🔄 *Terhubung ke Customer Service*\nSilakan kirim pesan Anda. Admin akan membalas segera.\n\nKetik *selesai* untuk mengakhiri.');

  const body = msg.body.trim() === 'cs' || msg.body.trim() === '4' ? '(memulai CS)' : msg.body;
  const adminMsg = await client.sendMessage(adminNumber,
    `📞 *CS Request*\nDari: ${userNumber}\nPesan: ${body}\n\nBalas dengan reply untuk membalas.`
  );

  forwardedMessages.set(adminMsg.id._serialized, { userNumber, timestamp: Date.now() });
}

export async function handleAdminReply(client, msg) {
  if (!msg.hasQuotedMsg) return null;

  const quoted = await msg.getQuotedMessage();
  if (!quoted) return null;

  const data = forwardedMessages.get(quoted.id._serialized);
  if (!data) return null;

  await client.sendMessage(data.userNumber, `📨 *Pesan dari Admin:*\n\n${msg.body}`);

  forwardedMessages.set(msg.id._serialized, { userNumber: data.userNumber, timestamp: Date.now() });
  touchSession(data.userNumber);

  return data.userNumber;
}

export async function forwardToAdmin(client, userNumber, messageBody, adminNumber) {
  touchSession(userNumber);

  const adminMsg = await client.sendMessage(adminNumber,
    `📩 *Pesan dari ${userNumber}:*\n\n${messageBody}\n\nBalas dengan reply untuk membalas.`
  );
  forwardedMessages.set(adminMsg.id._serialized, { userNumber, timestamp: Date.now() });
}
