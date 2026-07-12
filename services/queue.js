const cooldowns = new Map();
const COOLDOWN_MS = 2000;

export function isOnCooldown(userJid) {
  const last = cooldowns.get(userJid);
  if (last && Date.now() - last < COOLDOWN_MS) return true;
  cooldowns.set(userJid, Date.now());
  return false;
}

export function resetCooldown(userJid) {
  cooldowns.delete(userJid);
}
