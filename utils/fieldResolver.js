export function pick(obj, ...keys) {
  if (obj === null || obj === undefined) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
