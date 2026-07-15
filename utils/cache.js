let _storeCacheVersion = 0;

export function getStoreCacheVersion() {
  return _storeCacheVersion;
}

export function bumpStoreCacheVersion() {
  _storeCacheVersion++;
}
