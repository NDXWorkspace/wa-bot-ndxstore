const cooldowns = new Map();
const COOLDOWN_MS = 2000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Periodic cleanup of stale cooldown entries
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [jid, ts] of cooldowns) {
    if (ts < cutoff) cooldowns.delete(jid);
  }
}, CLEANUP_INTERVAL_MS);

export function isOnCooldown(userJid) {
  const last = cooldowns.get(userJid);
  if (last && Date.now() - last < COOLDOWN_MS) return true;
  cooldowns.set(userJid, Date.now());
  return false;
}
