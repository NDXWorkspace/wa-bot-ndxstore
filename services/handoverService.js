const handoverSessions = new Map();
const forwardedMessages = new Map();

export function isHandoverActive(userNumber) {
  return handoverSessions.has(userNumber);
}

export function endHandover(userNumber) {
  handoverSessions.delete(userNumber);
}

export async function startHandover(client, msg, adminNumber) {
  const userNumber = msg.from;
  handoverSessions.set(userNumber, { adminNumber, startTime: Date.now() });

  await msg.reply('🔄 *Terhubung ke Customer Service*\nSilakan kirim pesan Anda. Admin akan membalas segera.\n\nKetik *selesai* untuk mengakhiri.');

  const body = msg.body.trim() === 'cs' || msg.body.trim() === '4' ? '(memulai CS)' : msg.body;
  const adminMsg = await client.sendMessage(adminNumber,
    `📞 *CS Request*\nDari: ${userNumber}\nPesan: ${body}\n\nBalas dengan reply untuk membalas.`
  );

  forwardedMessages.set(adminMsg.id._serialized, userNumber);
}

export async function handleAdminReply(client, msg) {
  if (!msg.hasQuotedMsg) return null;

  const quoted = await msg.getQuotedMessage();
  if (!quoted) return null;

  const userNumber = forwardedMessages.get(quoted.id._serialized);
  if (!userNumber) return null;

  await client.sendMessage(userNumber, `📨 *Pesan dari Admin:*\n\n${msg.body}`);

  forwardedMessages.set(msg.id._serialized, userNumber);

  return userNumber;
}

export async function forwardToAdmin(client, userNumber, messageBody, adminNumber) {
  const adminMsg = await client.sendMessage(adminNumber,
    `📩 *Pesan dari ${userNumber}:*\n\n${messageBody}\n\nBalas dengan reply untuk membalas.`
  );
  forwardedMessages.set(adminMsg.id._serialized, userNumber);
}
