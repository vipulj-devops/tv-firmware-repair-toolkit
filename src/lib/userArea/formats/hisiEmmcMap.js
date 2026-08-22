import { SECTOR, ascii, u32le, validRange } from '../binary.js';

// HiSilicon USER-area eMMC map (512-byte records). Header magic 0x1630 at 0;
// entries magic 0x5840. The u32 at header+0x10 is unused (not a partition count).
const HISI_EMMC_MAP_HDR = 0x1630;
const HISI_EMMC_MAP_ENT = 0x5840;
const HISI_EMMC_MAP_REC = 512;
const HISI_EMMC_MAP_NAME_RE = /^[\w.\-]{3,32}$/;

function hisiEmmcMapName(bytes, offset) {
  return ascii(bytes, offset, 32);
}

function isHisiEmmcMapEntry(bytes, recOff) {
  if (recOff + 0x20 > bytes.length) return false;
  if (u32le(bytes, recOff) !== HISI_EMMC_MAP_ENT) return false;
  if (u32le(bytes, recOff + 4) !== 0) return false;
  const startLba = u32le(bytes, recOff + 8);
  const sizeLba = u32le(bytes, recOff + 12);
  if (startLba === 0 || sizeLba === 0) return false;
  const name = hisiEmmcMapName(bytes, recOff + 16);
  if (!HISI_EMMC_MAP_NAME_RE.test(name)) return false;
  return true;
}

// Strict detector: header magics + reserved zeros + first 0x5840 entry with
// reserved-zero, non-zero LBAs, and a printable partition name. A lone 0x1630
// is not enough.
export function isHisiEmmcMap(bytes) {
  if (!bytes || bytes.length < HISI_EMMC_MAP_REC + 0x20) return false;
  if (u32le(bytes, 0) !== HISI_EMMC_MAP_HDR) return false;
  if (u32le(bytes, 4) !== 0 || u32le(bytes, 8) !== 0 || u32le(bytes, 12) !== 0) return false;
  return isHisiEmmcMapEntry(bytes, HISI_EMMC_MAP_REC);
}

export function parseHisiEmmcMap(bytes, fileSize) {
  const parts = [];
  const limit = Math.floor(bytes.length / HISI_EMMC_MAP_REC);
  for (let i = 1; i < limit; i++) {
    const e = i * HISI_EMMC_MAP_REC;
    if (!isHisiEmmcMapEntry(bytes, e)) break;
    const startLba = u32le(bytes, e + 8);
    const sizeLba = u32le(bytes, e + 12);
    const offset = startLba * SECTOR;
    const size = sizeLba * SECTOR;
    if (!validRange(offset, size, fileSize)) break;
    parts.push({ name: hisiEmmcMapName(bytes, e + 16), offset, size });
  }
  return parts;
}

export const hisiEmmcMapFormat = {
  id: 'hisi_emmc_map',
  soc: 'hisilicon',
  detect(bytes) {
    if (!isHisiEmmcMap(bytes)) return null;
    return { marker: 'HISI eMMC map 0x1630/0x5840 @0' };
  },
  parse: parseHisiEmmcMap,
};
