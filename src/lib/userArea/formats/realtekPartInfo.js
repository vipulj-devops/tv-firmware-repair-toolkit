// Realtek PART.INFO binary partition table format
// Primary table at offset 0x00100000 or 0x00500000, backup at 0x00140000 or 0x00540000
// Each entry is 96 bytes (0x60)
// Fields:
//   +0x00: name[32] (ASCII, null-terminated)
//   +0x20: offset (uint64_le)
//   +0x28: size (uint64_le)
//   +0x30: image_name[24] (ASCII, null-terminated)
//   +0x48: image_size (uint32_le)
//   +0x4C: image_crc (uint32_le)
//   +0x50: flags (uint32_le)
//   +0x54: type_id (uint32_le)
//   +0x58: padding[8]

import { SECTOR, ascii, u32le, u64le } from '../binary.js';

const MAGIC = 0x20120716;
const ENTRY_SIZE = 96; // 0x60
const HEADER_SIZE = 80; // 0x50
const MAX_PARTITIONS = 64;
const PARTINFO_ENTRY_NAME = 'partinfo';
const MAPBAK_ENTRY_NAME = 'mapbak';

function isRealtekPartInfoEntry(bytes, entryOff) {
  if (entryOff + ENTRY_SIZE > bytes.length) return false;
  const name = ascii(bytes, entryOff, 32);
  if (!name || !/^[\w.\-]{1,32}$/.test(name)) return false;
  const offset = u64le(bytes, entryOff + 0x20);
  const size = u64le(bytes, entryOff + 0x28);
  if (offset < 0 || size < 0) return false;
  if (offset > 0x10000000000 || size > 0x10000000000) return false;
  return true;
}

export function isRealtekPartInfoAt(bytes, off, fileSize) {
  if (off < 0 || off + HEADER_SIZE + ENTRY_SIZE > bytes.length) return false;
  if (u32le(bytes, off) !== MAGIC) return false;
  const device = ascii(bytes, off + 0x10, 32);
  if (!device || !/(emmc|mmc)/i.test(device)) return false;
  const maxParts = u32le(bytes, off + 0x0C);
  if (maxParts === 0 || maxParts > MAX_PARTITIONS) return false;
  const totalSize = u64le(bytes, off + 0x30);
  if (totalSize === 0) return false;
  if (!isRealtekPartInfoEntry(bytes, off + HEADER_SIZE)) return false;

  let foundTableMarker = false;
  for (let i = 0; i < Math.min(4, maxParts); i++) {
    const entryName = ascii(bytes, off + HEADER_SIZE + i * ENTRY_SIZE, 32);
    if (entryName === PARTINFO_ENTRY_NAME || entryName === MAPBAK_ENTRY_NAME) {
      foundTableMarker = true;
      break;
    }
  }
  if (!foundTableMarker) return false;

  return true;
}

export function findRealtekPartInfo(bytes, fileSize) {
  if (!bytes) return -1;
  const minLen = HEADER_SIZE + ENTRY_SIZE;
  for (let o = 0; o + minLen <= bytes.length; o += SECTOR) {
    if (isRealtekPartInfoAt(bytes, o, fileSize)) return o;
  }
  return -1;
}

export function isRealtekPartInfo(bytes, fileSize) {
  return findRealtekPartInfo(bytes, fileSize) >= 0;
}

export function parseRealtekPartInfo(bytes, fileSize) {
  const off = findRealtekPartInfo(bytes, fileSize);
  if (off < 0) return [];
  const parts = [];
  let entryOff = off + HEADER_SIZE;
  while (entryOff + ENTRY_SIZE <= bytes.length) {
    const name = ascii(bytes, entryOff, 32).replace(/\u0000.*$/, '');
    if (!name) break;
    const offset = u64le(bytes, entryOff + 0x20);
    const size = u64le(bytes, entryOff + 0x28);
    const declaredSize = size;
    const availableSize = Math.max(0, Math.min(declaredSize, fileSize - offset));
    const truncated = offset < fileSize && offset + declaredSize > fileSize;
    const unavailable = offset >= fileSize;
    const ro = false;
    parts.push({
      name,
      offset,
      size,
      declaredSize,
      availableSize,
      truncated,
      unavailable,
      ro,
    });
    entryOff += ENTRY_SIZE;
    if (parts.length >= MAX_PARTITIONS) break;
  }
  return parts;
}

export const realtekPartInfoFormat = {
  id: 'realtek_partinfo',
  soc: 'realtek',
  detect(bytes, fileSize) {
    const off = findRealtekPartInfo(bytes, fileSize);
    if (off < 0) return null;
    return { marker: `Realtek PART.INFO @0x${off.toString(16)}` };
  },
  parse: parseRealtekPartInfo,
};
