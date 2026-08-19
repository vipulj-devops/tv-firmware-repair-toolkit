export function bytesToHex(bytes, offset = 0, length) {
  const end = length != null ? offset + length : bytes.length;
  let out = '';
  for (let i = offset; i < end; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
    if (i < end - 1) out += ' ';
  }
  return out;
}

export function hexToBytes(hexStr) {
  const clean = hexStr.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('Hex string has an odd number of digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToAscii(bytes, offset = 0, length) {
  const end = length != null ? offset + length : bytes.length;
  let out = '';
  for (let i = offset; i < end; i++) {
    const b = bytes[i];
    out += b >= 32 && b <= 126 ? String.fromCharCode(b) : '.';
  }
  return out;
}

export function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export function writeUint32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Try to detect printable-string config entries (key=value or NULL-separated).
export function scanStrings(bytes) {
  const entries = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] >= 32 && bytes[i] <= 126) {
      let j = i;
      while (j < bytes.length && bytes[j] >= 32 && bytes[j] <= 126) j++;
      const str = bytesToAscii(bytes, i, j - i);
      if (str.length >= 4) {
      const sec = str.match(/^\[([^\]]+)\]$/);
      if (sec) {
        entries.push({ offset: i, key: sec[1], value: str, raw: str, type: 'section' });
      } else {
        const eq = str.indexOf('=');
        if (eq > 0 && eq < str.length - 1) {
          entries.push({ offset: i, key: str.slice(0, eq), value: str.slice(eq + 1), raw: str, type: 'kv' });
        } else {
          entries.push({ offset: i, key: null, value: str, raw: str, type: 'string' });
        }
      }
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return entries;
}