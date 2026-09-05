import { SECTOR, ascii, u16, u32le, validRange } from '../binary.js';

// Vendor-neutral USER-area eMMC map (512-byte records). Header magic 0x1630 at 0;
// entries magic 0x5840. The u32 at header+0x10 is unused (not a partition count).
const EMMC_1630_HDR = 0x1630;
const EMMC_1630_ENT = 0x5840;
const EMMC_1630_REC = 512;
const EMMC_1630_NAME_RE = /^[\w.\-]{3,32}$/;

function emmc1630MapName(bytes, offset) {
  return ascii(bytes, offset, 32);
}

function isEmmc1630MapEntry(bytes, recOff) {
  if (recOff + 0x20 > bytes.length) return false;
  if (u16(bytes, recOff) !== EMMC_1630_ENT) return false;
  const startLba = u32le(bytes, recOff + 8);
  const sizeLba = u32le(bytes, recOff + 12);
  if (startLba === 0 || sizeLba === 0) return false;
  const name = emmc1630MapName(bytes, recOff + 16);
  if (!EMMC_1630_NAME_RE.test(name)) return false;
  return true;
}

// Strict detector: header magics + reserved zeros + first 0x5840 entry with
// reserved-zero, non-zero LBAs, and a printable partition name. A lone 0x1630
// is not enough.
export function isEmmc1630Map(bytes) {
  if (!bytes || bytes.length < EMMC_1630_REC + 0x20) return false;
  if (u32le(bytes, 0) !== EMMC_1630_HDR) return false;
  if (u32le(bytes, 4) !== 0 || u32le(bytes, 8) !== 0 || u32le(bytes, 12) !== 0) return false;
  return isEmmc1630MapEntry(bytes, EMMC_1630_REC);
}

export function parseEmmc1630Map(bytes, fileSize) {
  const parts = [];
  const limit = Math.floor(bytes.length / EMMC_1630_REC);
  for (let i = 1; i < limit; i++) {
    const e = i * EMMC_1630_REC;
    if (!isEmmc1630MapEntry(bytes, e)) break;
    const startLba = u32le(bytes, e + 8);
    const sizeLba = u32le(bytes, e + 12);
    const offset = startLba * SECTOR;
    const size = sizeLba * SECTOR;
    if (!validRange(offset, size, fileSize)) break;
    parts.push({ name: emmc1630MapName(bytes, e + 16), offset, size });
  }
  return parts;
}

/** @deprecated Use isEmmc1630Map. Temporary alias. */
export const isHisiEmmcMap = isEmmc1630Map;
/** @deprecated Use parseEmmc1630Map. Temporary alias. */
export const parseHisiEmmcMap = parseEmmc1630Map;

export const emmc1630MapFormat = {
  id: 'emmc_1630_5840',
  detect(bytes) {
    if (!isEmmc1630Map(bytes)) return null;
    return { marker: 'eMMC map 0x1630/0x5840 @0' };
  },
  parse: parseEmmc1630Map,
};
