// Standard CRC32 (IEEE 802.3) implementation with configurable parameters.
// Default: polynomial 0xEDB88320, init 0xFFFFFFFF, final XOR 0xFFFFFFFF, reflected.

const defaultTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function buildTable(poly) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? poly ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
}

export function crc32(bytes, { init = 0xffffffff, finalXor = 0xffffffff, polynomial = 0xedb88320, start = 0, end } = {}) {
  const table = polynomial === 0xedb88320 ? defaultTable : buildTable(polynomial);
  let crc = init >>> 0;
  const len = end != null ? end : bytes.length;
  for (let i = start; i < len; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ finalXor) >>> 0;
}

// Incremental CRC-32 for streaming/chunked computation on large files/blobs.
export function crc32Init(init = 0xffffffff) { return init >>> 0; }
export function crc32Update(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ defaultTable[(crc ^ bytes[i]) & 0xff];
  }
  return crc >>> 0;
}
export function crc32Final(crc, finalXor = 0xffffffff) { return (crc ^ finalXor) >>> 0; }

export function crc16Ccitt(bytes, { init = 0xffff, start = 0, end } = {}) {
  let crc = init & 0xffff;
  const len = end != null ? end : bytes.length;
  for (let i = start; i < len; i++) {
    crc ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

// Common CRC variants used in TV config / firmware packs.
export const CRC_VARIANTS = [
  { id: 'crc32_ieee', name: 'CRC-32 (IEEE 802.3) — most common', fn: crc32, bytes: 4 },
  { id: 'crc32_posix', name: 'CRC-32 (POSIX / cksum)', fn: (b, o) => crc32(b, { ...o, finalXor: 0xffffffff, init: 0 }), bytes: 4 },
  { id: 'crc16_ccitt', name: 'CRC-16 (CCITT-FALSE)', fn: (b, o) => crc16Ccitt(b, o), bytes: 2 },
];

export function toHex(num, width) {
  return num.toString(16).toUpperCase().padStart(width, '0');
}