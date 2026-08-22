export const SECTOR = 512;

export function u16(b, o) { return b[o] | (b[o + 1] << 8); }
export function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function u64le(b, o) { return u32le(b, o) + u32le(b, o + 4) * 0x100000000; }

export function ascii(b, o, len) {
  if (o + len > b.length) len = Math.max(0, b.length - o);
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = b[o + i];
    if (c === 0) break;
    if (c >= 32 && c <= 126) s += String.fromCharCode(c);
    else break;
  }
  return s;
}

export function hasBytes(b, o, sig) {
  if (o < 0 || o + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[o + i] !== sig[i]) return false;
  return true;
}

export function validRange(off, sz, fileSize) {
  if (sz === 0 || sz > 0x1000000000) return false;
  if (off > 0x1000000000) return false;
  if (fileSize && off + sz > fileSize + SECTOR) return false;
  return true;
}
