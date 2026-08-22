// User-area partition parser for EMMC dumps.
// Detects the SoC / partition-table format from the USER AREA only (no boot0/boot1)
// and parses vendor-specific tables: Amlogic AMLS MBR, Amlogic MPT (not AMLS), MStar header, Novatek NVTK,
// HiSilicon fastboot, HiSilicon 512-byte eMMC map (0x1630/0x5840), Linux/U-Boot blkdevparts=mmcblk0:, Realtek U-Boot
// env (mtdparts). Also detects the filesystem type of each parsed partition (ext4,
// f2fs, Android boot, squashfs, sparse, UBIFS, JFFS2, raw). Standard GPT/MBR are
// detected here but parsed by emmc.js.

import { parseMbr } from './emmc.js';
import { SECTOR, ascii, hasBytes, u16, u32le, u64le, validRange } from './userArea/binary.js';
import { detectRegisteredFormat, parseRegisteredFormat } from './userArea/registry.js';

export { isHisiEmmcMap } from './userArea/formats/hisiEmmcMap.js';
export { findAmlMpt, isAmlMpt } from './userArea/formats/amlMpt.js';
export { findBlkdevpartsMmc, isBlkdevpartsMmc } from './userArea/formats/blkdevpartsMmc.js';

function parseSize(s) {
  s = String(s).trim();
  if (!s) return 0;
  if (s.startsWith('0x')) return parseInt(s, 16);
  const m = s.match(/^(\d+)([KMG]?)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n * (m[2] === 'K' ? 1024 : m[2] === 'M' ? 1048576 : m[2] === 'G' ? 1073741824 : 1);
}

const AMLS = [0x41, 0x4d, 0x4c, 0x53]; // "AMLS"
const EFI_PART = [0x45, 0x46, 0x49, 0x20, 0x50, 0x41, 0x52, 0x54]; // "EFI PART"
const MSTAR = [0x4d, 0x53, 0x54, 0x41, 0x52]; // "MSTAR"
const NVTK = [0x4e, 0x56, 0x54, 0x4b]; // "NVTK"
const ANDROID = [0x41, 0x4e, 0x44, 0x52, 0x4f, 0x49, 0x44, 0x21]; // "ANDROID!"
const HISILICON = [0x48, 0x49, 0x53, 0x49, 0x4c, 0x49, 0x43, 0x4f, 0x4e]; // "HISILICON"

function hasUsableParts(parts) {
  return Array.isArray(parts) && parts.length >= 1;
}

function hasHisiliconMagic(bytes) {
  const hiScan = Math.min(bytes.length, 0x1000);
  for (let o = 0; o + 9 <= hiScan; o++) {
    if (hasBytes(bytes, o, HISILICON)) return true;
  }
  return false;
}

function hasRealtekText(bytes) {
  const rtkScan = Math.min(bytes.length, 0x1000);
  const rtkText = new TextDecoder('latin1').decode(bytes.subarray(0, rtkScan)).toUpperCase();
  return rtkText.includes('REALTEK') || rtkText.includes('RTK');
}

// Detect SoC + partition-table type from the user area.
// GPT signature stays first (parsed by emmc.js). Strict registry is next.
// Heuristic magics / MBR only win if their existing parser returns >=1 partition.
export function detectSocUserArea(bytes, fileSize) {
  if (hasBytes(bytes, 0x200, EFI_PART) || hasBytes(bytes, 0x400, EFI_PART)) {
    return { soc: 'mtk', marker: 'EFI PART (GPT)', tableType: 'gpt' };
  }
  const registered = detectRegisteredFormat(bytes, fileSize);
  if (registered && hasUsableParts(parseRegisteredFormat(registered.tableType, bytes, fileSize))) {
    return registered;
  }
  if (hasBytes(bytes, 0, AMLS) && hasUsableParts(parseAmlogicMbr(bytes, fileSize))) {
    return { soc: 'amlogic', marker: 'AMLS MBR @0x0', tableType: 'aml_mbr' };
  }
  if (hasBytes(bytes, 0x200, MSTAR) && hasUsableParts(parseMstarHeader(bytes, fileSize))) {
    return { soc: 'mstar', marker: 'MSTAR header @0x200', tableType: 'mstar' };
  }
  if (hasBytes(bytes, 0, NVTK) && hasUsableParts(parseNovatekHeader(bytes, fileSize))) {
    return { soc: 'novatek', marker: 'NVTK header @0x0', tableType: 'nvtk' };
  }
  if (hasHisiliconMagic(bytes) && hasUsableParts(parseHisiliconFastboot(bytes, fileSize))) {
    return { soc: 'hisilicon', marker: 'HISILICON magic', tableType: 'fastboot' };
  }
  if (hasRealtekText(bytes) && hasUsableParts(parseRealtek(bytes))) {
    return { soc: 'realtek', marker: 'Realtek signature', tableType: 'uboot_env' };
  }
  if (u16(bytes, 0x1FE) === 0xAA55 && hasUsableParts(parseMbr(bytes, 0))) {
    return { soc: 'unknown', marker: 'MBR 0x55AA', tableType: 'mbr' };
  }
  return { soc: 'unknown', marker: 'No signature found', tableType: 'none' };
}

// Detect filesystem type at a byte offset within the dump.
export function detectFilesystem(bytes, offset) {
  if (offset + 1082 <= bytes.length && bytes[offset + 1080] === 0x53 && bytes[offset + 1081] === 0xEF) return 'ext4';
  if (offset + 1028 <= bytes.length && bytes[offset + 1024] === 0x10 && bytes[offset + 1025] === 0x20 && bytes[offset + 1026] === 0xF5 && bytes[offset + 1027] === 0xF2) return 'f2fs';
  if (hasBytes(bytes, offset, ANDROID)) return 'android_boot';
  if (offset + 4 <= bytes.length) {
    const m = u32le(bytes, offset);
    if (m === 0x73717368 || m === 0x68737173) return 'squashfs'; // 'sqsh' / 'hsqs'
  }
  if (hasBytes(bytes, offset, [0x3a, 0xff, 0x26, 0xed])) return 'android_sparse';
  if (hasBytes(bytes, offset, [0x55, 0x42, 0x49, 0x23])) return 'ubifs'; // "UBI#"
  if (offset + 2 <= bytes.length) {
    const m2 = u16(bytes, offset);
    if (m2 === 0x1985 || m2 === 0x8519) return 'jffs2';
  }
  return 'raw';
}

// Amlogic AMLS MBR: magic "AMLS" @0, version@4, entry_count@8, entries @0x10.
// Tries a few entry strides (name[32]/name[16]) since real images vary.
function parseAmlogicMbr(bytes, fileSize) {
  const tries = [[0x10, 48, 32], [0x10, 32, 16], [0x14, 40, 16], [0x10, 40, 16]];
  let best = [];
  for (const [es, stride, nl] of tries) {
    const parts = [];
    for (let i = 0; i < 32; i++) {
      const e = es + i * stride;
      if (e + nl + 16 > bytes.length) break;
      const name = ascii(bytes, e, nl);
      if (!name || !/^[\w.\-]{2,24}$/.test(name)) continue;
      const off = u64le(bytes, e + nl);
      const sz = u64le(bytes, e + nl + 8);
      if (!validRange(off, sz, fileSize)) continue;
      parts.push({ name, offset: off, size: sz });
    }
    if (parts.length > best.length) best = parts;
  }
  return best;
}

// MStar: "MSTAR" @0x200, count @0x20C, entries @0x210, 32-byte each
// (name[16] + offset[8] + size[8]).
function parseMstarHeader(bytes, fileSize) {
  const count = u32le(bytes, 0x200 + 12);
  const entryStart = 0x200 + 16;
  const parts = [];
  for (let i = 0; i < count && i < 32; i++) {
    const e = entryStart + i * 32;
    if (e + 32 > bytes.length) break;
    const name = ascii(bytes, e, 16);
    if (!name) continue;
    let off = u64le(bytes, e + 16);
    let sz = u64le(bytes, e + 24);
    if (off === 0 || sz === 0) { off = u32le(bytes, e + 16); sz = u32le(bytes, e + 20); }
    if (!validRange(off, sz, fileSize)) continue;
    parts.push({ name, offset: off, size: sz });
  }
  return parts;
}

// Novatek nvt_header: magic "NVTK" @0, version@4, total_size@8, part_count@12,
// parts @0x10. Each part: name[24] + offset[4] + size[4] + type[4] + crc[4] = 40 bytes.
// Some images pad to 52, so try both strides.
function parseNovatekHeader(bytes, fileSize) {
  const count = u32le(bytes, 12);
  const entryStart = 0x10;
  for (const stride of [40, 52]) {
    const parts = [];
    for (let i = 0; i < count && i < 32; i++) {
      const e = entryStart + i * stride;
      if (e + 40 > bytes.length) break;
      const name = ascii(bytes, e, 24);
      if (!name) continue;
      const off = u32le(bytes, e + 24);
      const sz = u32le(bytes, e + 28);
      if (!validRange(off, sz, fileSize)) continue;
      parts.push({ name, offset: off, size: sz });
    }
    if (parts.length) return parts;
  }
  return [];
}

// HiSilicon hi_fastboot_header: magic "HISILICON" @0, header_size@8,
// partition_count@12, partitions @0x10. Each: name[32] + offset[4] + size[4] +
// flags[4] + fs_type[16] = 60 bytes (some pad to 64). Offsets may be bytes or
// sectors, so try both. Falls back to a table at 0x200/0x400/0x800.
function parseHisiliconFastboot(bytes, fileSize) {
  if (hasBytes(bytes, 0, HISILICON)) {
    const count = u32le(bytes, 12);
    if (count > 0 && count <= 64) {
      for (const stride of [60, 64]) {
        for (const sector of [false, true]) {
          const parts = [];
          for (let i = 0; i < count; i++) {
            const e = 16 + i * stride;
            if (e + 60 > bytes.length) break;
            const name = ascii(bytes, e, 32);
            if (!name) continue;
            let off = u32le(bytes, e + 32);
            let sz = u32le(bytes, e + 36);
            if (sector) { off *= SECTOR; sz *= SECTOR; }
            if (!validRange(off, sz, fileSize)) continue;
            const fsType = ascii(bytes, e + 44, 16) || 'raw';
            parts.push({ name, offset: off, size: sz, fsType });
          }
          if (parts.length) return parts;
        }
      }
    }
  }
  for (const tbl of [0x200, 0x400, 0x800]) {
    if (tbl + 4 > bytes.length) continue;
    const count = u32le(bytes, tbl);
    if (count <= 0 || count > 64) continue;
    const parts = [];
    for (let i = 0; i < count; i++) {
      const e = tbl + 4 + i * 64;
      if (e + 60 > bytes.length) break;
      const name = ascii(bytes, e, 32);
      if (!name) continue;
      const off = u32le(bytes, e + 32) * SECTOR;
      const sz = u32le(bytes, e + 36) * SECTOR;
      if (!validRange(off, sz, fileSize)) continue;
      const fsType = ascii(bytes, e + 44, 16) || 'raw';
      parts.push({ name, offset: off, size: sz, fsType });
    }
    if (parts.length) return parts;
  }
  return [];
}

// Realtek: partition info lives in the U-Boot env (mtdparts=). Parse it from the
// first 2 MB; no fixed offsets are guessed.
function parseRealtek(bytes) {
  const sc = Math.min(bytes.length, 0x200000);
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, sc));
  const parts = [];
  for (const m of text.matchAll(/mtdparts\s*=\s*[^:]+:\s*([^"\x00\s]+)/gi)) {
    const spec = m[1];
    for (const e of spec.matchAll(/(\d+[KMG]?)@?(0x[0-9a-f]+|\d+)?\(([^)]+)\)/gi)) {
      const size = parseSize(e[1]);
      const off = e[2] ? parseSize(e[2]) : 0;
      if (size) parts.push({ name: e[3], offset: off, size });
    }
  }
  return parts;
}

// Parse an Android boot image header at offset (magic "ANDROID!"). Returns the
// component sizes and computed offsets so boot/recovery partitions can be
// inspected without extracting them.
export function parseAndroidBoot(bytes, offset) {
  if (!hasBytes(bytes, offset, ANDROID)) return null;
  if (offset + 1632 > bytes.length) return null;
  const kernelSize = u32le(bytes, offset + 8);
  const ramdiskSize = u32le(bytes, offset + 16);
  const secondSize = u32le(bytes, offset + 24);
  const pageSize = u32le(bytes, offset + 36) || 2048;
  const headerVersion = u32le(bytes, offset + 40);
  const name = ascii(bytes, offset + 48, 16);
  const cmdline = ascii(bytes, offset + 64, 512);
  const pages = (n) => Math.ceil(n / pageSize) * pageSize;
  return {
    kernelSize, ramdiskSize, secondSize, pageSize, headerVersion, name, cmdline,
    kernelOffset: offset + pageSize,
    ramdiskOffset: offset + pageSize + pages(kernelSize),
    secondOffset: offset + pageSize + pages(kernelSize) + pages(ramdiskSize),
  };
}

export function analyzeUserArea(bytes, fileSize) {
  if (!bytes) return null;
  const det = detectSocUserArea(bytes, fileSize);
  let parts = [];
  switch (det.tableType) {
    case 'aml_mbr': parts = parseAmlogicMbr(bytes, fileSize); break;
    case 'mstar': parts = parseMstarHeader(bytes, fileSize); break;
    case 'nvtk': parts = parseNovatekHeader(bytes, fileSize); break;
    case 'fastboot': parts = parseHisiliconFastboot(bytes, fileSize); break;
    case 'uboot_env': parts = parseRealtek(bytes); break;
    case 'hisi_emmc_map':
    case 'aml_mpt':
    case 'blkdevparts_mmc':
      parts = parseRegisteredFormat(det.tableType, bytes, fileSize);
      break;
    default: parts = [];
  }
  for (const p of parts) {
    if (!p.fsType) p.fsType = detectFilesystem(bytes, p.offset);
    if (p.fsType === 'android_boot') {
      const bi = parseAndroidBoot(bytes, p.offset);
      if (bi) p.bootInfo = bi;
    }
  }
  return { soc: det.soc, tableType: det.tableType, marker: det.marker, partitions: parts };
}

// Convert the user-area analysis into the PartitionTable shape so vendor
// user-area dumps (AMLS/MSTAR/NVTK/HISI) show an actionable partition table.
export function userAreaToParts(analysis) {
  if (!analysis || !analysis.partitions.length) return [];
  const out = [];
  let idx = 0;
  for (const p of analysis.partitions) {
    out.push({
      index: idx++,
      name: p.name,
      ptType: analysis.tableType,
      startByte: p.offset,
      size: p.size,
      fsType: p.fsType || 'raw',
      vendorSource: analysis.soc,
      ro: !!p.ro,
    });
  }
  return out;
}
