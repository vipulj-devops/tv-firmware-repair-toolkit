// EMMC dump parser: GPT-based partition table for EMMC full dumps (RT809H style).
// Standard EMMC sector size = 512 bytes. Handles full dumps where boot partitions
// may precede the user area by scanning for the "EFI PART" GPT signature.

import { crc32Init, crc32Update, crc32Final } from './crc32.js';

const SECTOR = 512;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

function sigAt(bytes, off) {
  if (off + 8 > bytes.length) return false;
  return (
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3],
      bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]) === 'EFI PART'
  );
}

// GPT header CRC32 (IEEE) over bytes [0x00..0x5C) with the CRC field (0x10..0x17) zeroed.
function gptHeaderCrcValid(bytes, gptOff) {
  if (gptOff + 92 > bytes.length) return false;
  const copy = new Uint8Array(92);
  copy.set(bytes.subarray(gptOff, gptOff + 92));
  for (let i = 0x10; i < 0x18; i++) copy[i] = 0;
  let crc = crc32Init(0xFFFFFFFF);
  crc = crc32Update(crc, copy);
  return crc32Final(crc) === u64(bytes, gptOff + 0x10);
}

// Validate GPT header fields so random "EFI PART" strings inside boot code
// don't get mistaken for a partition table.
function gptHeaderFieldsValid(bytes, gptOff) {
  if (gptOff + 0x60 > bytes.length) return false;
  const myLba = u64(bytes, gptOff + 0x18);
  if (myLba === 0) return false;
  const baseOffset = gptOff - myLba * SECTOR;
  if (baseOffset < 0 || baseOffset > gptOff) return false;
  const numEntries = u32(bytes, gptOff + 0x50);
  const entrySize = u32(bytes, gptOff + 0x54);
  if (numEntries === 0 || numEntries > 256) return false;
  if (entrySize < 128 || entrySize > 512) return false;
  const partEntryLba = u64(bytes, gptOff + 0x48);
  const entryStart = baseOffset + partEntryLba * SECTOR;
  if (entryStart < baseOffset) return false;
  if (entryStart + numEntries * entrySize > bytes.length + 1024 * 1024) return false;
  return true;
}

// Find the primary GPT header. Scans up to 128 MB at sector boundaries for full
// dumps with prepended hardware partitions. Prefers a header whose CRC32 is
// valid; falls back to any "EFI PART" with sane fields. This rejects false
// "EFI PART" matches inside boot code while still accepting slightly-damaged
// headers from imperfect dump tools (which the old strict myLba==1 check rejected).
export function findGptOffset(bytes) {
  const maxScan = Math.min(bytes.length, 128 * 1024 * 1024);
  const cands = [];
  for (let off = 0; off < maxScan; off += SECTOR) {
    if (sigAt(bytes, off)) cands.push(off);
  }
  for (const off of cands) {
    if (gptHeaderFieldsValid(bytes, off) && gptHeaderCrcValid(bytes, off)) return off;
  }
  for (const off of cands) {
    if (gptHeaderFieldsValid(bytes, off)) return off;
  }
  return -1;
}

export function hasGpt(bytes) {
  return findGptOffset(bytes) >= 0;
}

function guidHex(b, off) {
  const h = [];
  for (let i = 0; i < 16; i++) h.push(b[off + i].toString(16).padStart(2, '0'));
  return [h[3] + h[2] + h[1] + h[0], h[5] + h[4], h[7] + h[6], h[8] + h[9],
    h[10] + h[11] + h[12] + h[13] + h[14] + h[15]].join('-');
}

export function parsePartitions(bytes) {
  const gptOff = findGptOffset(bytes);
  if (gptOff < 0) return [];
  const myLba = u64(bytes, gptOff + 0x18);
  const baseOffset = gptOff - myLba * SECTOR;
  const partEntryLba = u64(bytes, gptOff + 0x48);
  const numEntries = Math.min(u32(bytes, gptOff + 0x50), 256);
  const entrySize = u32(bytes, gptOff + 0x54) || 128;
  const entryStart = baseOffset + partEntryLba * SECTOR;
  const parts = [];
  for (let i = 0; i < numEntries; i++) {
    const off = entryStart + i * entrySize;
    if (off + entrySize > bytes.length) break;
    // unused entries have an all-zero type GUID (first 16 bytes)
    let typeZero = true;
    for (let j = 0; j < 16; j++) { if (bytes[off + j] !== 0) { typeZero = false; break; } }
    if (typeZero) continue;
    const startLba = u64(bytes, off + 0x20);
    const endLba = u64(bytes, off + 0x28);
    // skip corrupt / empty LBA ranges that some dump tools leave behind
    if (startLba === 0 || endLba === 0 || endLba < startLba) continue;
    if (endLba - startLba > 0xFFFFFFFF) continue;
    const attrs = u64(bytes, off + 0x30);
    let name = '';
    for (let j = 0; j < 72; j += 2) {
      const code = u16(bytes, off + 0x38 + j);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    const startByte = baseOffset + startLba * SECTOR;
    const size = (endLba + 1 - startLba) * SECTOR;
    parts.push({ index: i, name, typeGuid: guidHex(bytes, off), startLba, endLba, startByte, size, attrs, baseOffset });
  }
  return parts;
}

export function analyzeDump(bytes) {
  const gptOff = findGptOffset(bytes);
  if (gptOff < 0) return { hasGpt: false, gptOffset: -1, partitions: [] };
  return { hasGpt: true, gptOffset: gptOff, partitions: parsePartitions(bytes) };
}

export function readPartition(bytes, part) {
  const readSize = part.availableSize ?? part.size;
  if (part.unavailable || readSize <= 0 || part.startByte >= bytes.length) return new Uint8Array(0);
  const end = Math.min(part.startByte + readSize, bytes.length);
  return bytes.subarray(part.startByte, end);
}

export function replacePartition(dumpBytes, part, newData) {
  if (newData.length > part.size) throw new Error(`Data (${newData.length} B) exceeds partition "${part.name}" size (${part.size} B)`);
  const next = new Uint8Array(dumpBytes);
  next.set(newData, part.startByte);
  return next;
}

// Async chunk-based comparison of two File/Blob objects. Reads 1 MB at a time
// so multi-GB dumps can be compared without loading either fully into memory.
export async function compareFiles(file1, file2, parts1, parts2) {
  if (parts1.length && parts2.length) {
    const names1 = new Set(parts1.map((p) => p.name));
    const names2 = new Set(parts2.map((p) => p.name));
    const onlyIn1 = parts1.filter((p) => !names2.has(p.name)).map((p) => p.name);
    const onlyIn2 = parts2.filter((p) => !names1.has(p.name)).map((p) => p.name);
    const common = [];
    for (const pa of parts1) {
      const pb = parts2.find((p) => p.name === pa.name);
      if (!pb) continue;
      const r = await compareRanges(file1, pa.startByte, pa.size, file2, pb.startByte, pb.size);
      common.push({ name: pa.name, ...r });
    }
    return { hasGpt: true, sizeDiff: file1.size - file2.size, common, onlyIn1, onlyIn2 };
  }
  const len = Math.min(file1.size, file2.size);
  const r = await compareRanges(file1, 0, len, file2, 0, len);
  return { hasGpt: false, sizeDiff: file1.size - file2.size, ...r, diffs: r.diffBlocks };
}

async function compareRanges(file1, off1, size1, file2, off2, size2) {
  const chunkSize = 1024 * 1024;
  const len = Math.min(size1, size2);
  let firstDiff = -1, diffBlocks = 0;
  const bs = 4096;
  for (let i = 0; i < len; i += chunkSize) {
    const end = Math.min(i + chunkSize, len);
    const b1 = new Uint8Array(await file1.slice(off1 + i, off1 + end).arrayBuffer());
    const b2 = new Uint8Array(await file2.slice(off2 + i, off2 + end).arrayBuffer());
    for (let j = 0; j < b1.length; j += bs) {
      for (let k = j; k < Math.min(j + bs, b1.length); k++) {
        if (b1[k] !== b2[k]) { if (firstDiff < 0) firstDiff = i + k; diffBlocks++; break; }
      }
    }
  }
  return { sizeMatch: size1 === size2, firstDiff, diffBlocks, len1: size1, len2: size2 };
}

// Compare two dumps. Returns per-partition diff stats when both have GPT,
// otherwise a raw byte-level comparison.
export function compareDumps(d1, d2) {
  const a1 = analyzeDump(d1);
  const a2 = analyzeDump(d2);
  if (!a1.hasGpt || !a2.hasGpt) {
    const len = Math.min(d1.length, d2.length);
    let firstDiff = -1, diffs = 0;
    for (let i = 0; i < len; i++) { if (d1[i] !== d2[i]) { if (firstDiff < 0) firstDiff = i; diffs++; } }
    return { hasGpt: false, sizeDiff: d1.length - d2.length, firstDiff, diffs, common: [], onlyIn1: [], onlyIn2: [] };
  }
  const names1 = new Set(a1.partitions.map((p) => p.name));
  const names2 = new Set(a2.partitions.map((p) => p.name));
  const onlyIn1 = a1.partitions.filter((p) => !names2.has(p.name)).map((p) => p.name);
  const onlyIn2 = a2.partitions.filter((p) => !names1.has(p.name)).map((p) => p.name);
  const common = [];
  for (const pa of a1.partitions) {
    const pb = a2.partitions.find((p) => p.name === pa.name);
    if (!pb) continue;
    const s1 = readPartition(d1, pa);
    const s2 = readPartition(d2, pb);
    let firstDiff = -1, diffBlocks = 0;
    const bs = 4096;
    const len = Math.min(s1.length, s2.length);
    for (let i = 0; i < len; i += bs) {
      const end = Math.min(i + bs, len);
      for (let j = i; j < end; j++) {
        if (s1[j] !== s2[j]) { if (firstDiff < 0) firstDiff = j; diffBlocks++; break; }
      }
    }
    common.push({ name: pa.name, sizeMatch: s1.length === s2.length, firstDiff, diffBlocks, len1: s1.length, len2: s2.length });
  }
  return { hasGpt: true, sizeDiff: d1.length - d2.length, common, onlyIn1, onlyIn2 };
}

// --- MBR (legacy DOS partition table) parsing ---

const MBR_TYPES = {
  0x01: 'FAT12', 0x04: 'FAT16', 0x05: 'Extended', 0x06: 'FAT16',
  0x07: 'NTFS/exFAT', 0x0B: 'FAT32', 0x0C: 'FAT32-LBA', 0x0E: 'FAT16-LBA',
  0x0F: 'Ext-LBA', 0x82: 'Linux swap', 0x83: 'Linux', 0x8E: 'LVM',
  0xEE: 'GPT-prot', 0xEF: 'EFI',
};

export function parseMbr(bytes, baseOffset) {
  if (baseOffset + 512 > bytes.length) return [];
  if (u16(bytes, baseOffset + 0x1FE) !== 0xAA55) return [];
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const e = baseOffset + 0x1BE + i * 16;
    const type = bytes[e + 4];
    if (type === 0) continue;
    const startLba = u32(bytes, e + 8);
    const numSectors = u32(bytes, e + 12);
    parts.push({
      name: `mbr${i}`,
      ptType: 'mbr',
      mbrType: type,
      typeName: MBR_TYPES[type] || `0x${type.toString(16).toUpperCase()}`,
      startByte: baseOffset + startLba * SECTOR,
      size: numSectors * SECTOR,
      attrs: 0,
      bootable: bytes[e] === 0x80,
    });
  }
  return parts;
}

// --- EMMC hardware partition auto-detection (JEDEC standard layout) ---
// JEDEC eMMC defines 8 hardware partitions: user area (P0), boot1 (P1), boot2 (P2),
// rpmb (P3), gp1-gp4 (P4-P7). In a full dump they're concatenated before the user
// area. We decompose the pre-GPT region by trying common JEDEC-configured sizes.

const BOOT_SIZES = [128*1024, 256*1024, 512*1024, 1024*1024, 2*1024*1024, 4*1024*1024, 8*1024*1024, 16*1024*1024, 32*1024*1024];
const RPMB_SIZES = [128*1024, 256*1024, 512*1024, 1024*1024, 2*1024*1024, 4*1024*1024, 8*1024*1024];
const GP_SIZES = [128*1024, 256*1024, 512*1024, 1024*1024, 2*1024*1024, 4*1024*1024, 8*1024*1024, 16*1024*1024, 32*1024*1024];

function mkBoot(B) {
  return [
    { name: 'boot1', ptType: 'emmc-boot', startByte: 0, size: B, attrs: 0 },
    { name: 'boot2', ptType: 'emmc-boot', startByte: B, size: B, attrs: 0 },
  ];
}
function mkRpmb(off, R) { return { name: 'rpmb', ptType: 'emmc-rpmb', startByte: off, size: R, attrs: 0 }; }
function mkGp(off, n, G) {
  const parts = [];
  let o = off;
  for (let g = 1; g <= n; g++) { parts.push({ name: `gp${g}`, ptType: 'emmc-gp', startByte: o, size: G, attrs: 0 }); o += G; }
  return parts;
}

function detectHardwarePartitions(preGptSize) {
  if (preGptSize === 0) return [];
  for (const B of BOOT_SIZES) {
    if (preGptSize === 2 * B) return mkBoot(B);
    const afterBoot = preGptSize - 2 * B;
    if (afterBoot <= 0) continue;
    // boot1+boot2+gp (no rpmb)
    for (let n = 1; n <= 4; n++) {
      for (const G of GP_SIZES) {
        if (afterBoot === n * G) return [...mkBoot(B), ...mkGp(2 * B, n, G)];
      }
    }
    // boot1+boot2+rpmb [+ gp]
    for (const R of RPMB_SIZES) {
      if (afterBoot === R) return [...mkBoot(B), mkRpmb(2 * B, R)];
      const afterRpmb = afterBoot - R;
      if (afterRpmb <= 0) continue;
      for (let n = 1; n <= 4; n++) {
        for (const G of GP_SIZES) {
          if (afterRpmb === n * G) return [...mkBoot(B), mkRpmb(2 * B, R), ...mkGp(2 * B + R, n, G)];
        }
      }
    }
  }
  // boot1 only (no boot2)
  for (const B of BOOT_SIZES) {
    if (preGptSize === B) return [{ name: 'boot1', ptType: 'emmc-boot', startByte: 0, size: B, attrs: 0 }];
  }
  // Fallback: single unlabeled hardware block (still extractable)
  return [{ name: 'boot_hw', ptType: 'emmc-hw', startByte: 0, size: preGptSize, attrs: 0 }];
}

// --- Unified auto-mapper: GPT + MBR + EMMC hardware partitions ---

export function autoMapPartitions(bytes, fileSize) {
  const gptOff = findGptOffset(bytes);
  const parts = [];
  let idx = 0;
  if (gptOff >= 0) {
    const myLba = u64(bytes, gptOff + 0x18);
    const baseOffset = gptOff - myLba * SECTOR;
    if (baseOffset > 0) {
      for (const p of detectHardwarePartitions(baseOffset)) { p.index = idx++; parts.push(p); }
    }
    for (const p of parsePartitions(bytes)) { p.ptType = 'gpt'; p.index = idx++; parts.push(p); }
  } else {
    for (const p of parseMbr(bytes, 0)) { p.index = idx++; parts.push(p); }
  }
  return parts;
}