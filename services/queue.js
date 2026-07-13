const cooldowns = new Map();
const COOLDOWN_DEFAULT = 2500;
const COOLDOWN_AI = 5000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

// Periodic cleanup of stale cooldown entries
setInterval(() => {
  const now = Date.now();
  for (const [jid, entry] of cooldowns) {
    if (now - entry.ts > 60000) cooldowns.delete(jid);
  }
}, CLEANUP_INTERVAL_MS);

export function isOnCooldown(userJid, type = 'default') {
  const cooldown = type === 'ai' ? COOLDOWN_AI : COOLDOWN_DEFAULT;
  const now = Date.now();
  const entry = cooldowns.get(userJid);
  if (entry && now - entry.ts < cooldown) {
    if (entry.type === type) return true;
    if (type === 'ai' && now - entry.ts < COOLDOWN_DEFAULT) return true;
  }
  cooldowns.set(userJid, { ts: now, type });
  return false;
}

export function clearCooldown(userJid) {
  cooldowns.delete(userJid);
}
