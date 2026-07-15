export function formatPrice(val) {
  const n = Number(val);
  return isNaN(n) ? '-' : `Rp${n.toLocaleString('id-ID')}`;
}

export function formatTime(val) {
  if (!val) return '-';
  try { return new Date(val).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); }
  catch { return String(val).slice(0, 19); }
}

export function formatWaNumber(raw) {
  if (!raw) return null;
  let n = String(raw).trim();
  if (n.startsWith('+')) {
    const stripped = n.slice(1).replace(/[^0-9]/g, '');
    if (stripped.length >= 10) return stripped + '@c.us';
    return null;
  }
  n = n.replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('62') && n.length >= 10) return n + '@c.us';
  return null;
}
