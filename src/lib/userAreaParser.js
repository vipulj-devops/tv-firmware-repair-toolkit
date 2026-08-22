// User-area partition parser for EMMC dumps.
// Detects the SoC / partition-table format from the USER AREA only (no boot0/boot1)
// and parses vendor-specific tables: Amlogic AMLS MBR, Amlogic MPT (not AMLS), MStar header, Novatek NVTK,
// HiSilicon fastboot, HiSilicon 512-byte eMMC map (0x1630/0x5840), Realtek U-Boot
// env (mtdparts). Also detects the filesystem type of each parsed partition (ext4,
// f2fs, Android boot, squashfs, sparse, UBIFS, JFFS2, raw). Standard GPT/MBR are
// detected here but parsed by emmc.js.

const SECTOR = 512;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64le(b, o) { return u32le(b, o) + u32le(b, o + 4) * 0x100000000; }
function ascii(b, o, len) {
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
function hasBytes(b, o, sig) {
  if (o < 0 || o + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[o + i] !== sig[i]) return false;
  return true;
}
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
const MPT = [0x4d, 0x50, 0x54, 0x00]; // "MPT\0" — Amlogic media partition table (not AMLS)
const EFI_PART = [0x45, 0x46, 0x49, 0x20, 0x50, 0x41, 0x52, 0x54]; // "EFI PART"
const MSTAR = [0x4d, 0x53, 0x54, 0x41, 0x52]; // "MSTAR"
const NVTK = [0x4e, 0x56, 0x54, 0x4b]; // "NVTK"
const ANDROID = [0x41, 0x4e, 0x44, 0x52, 0x4f, 0x49, 0x44, 0x21]; // "ANDROID!"
const HISILICON = [0x48, 0x49, 0x53, 0x49, 0x4c, 0x49, 0x43, 0x4f, 0x4e]; // "HISILICON"

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

function parseHisiEmmcMap(bytes, fileSize) {
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

// Amlogic MPT (media partition table): "MPT\0" header, ASCII version, u32 count
// at +0x10, 40-byte entries at +0x18. Offsets/sizes are bytes, not LBAs.
// Distinct from AMLS-at-0 and from a later "AMLSECURITY" blob (do not scan AMLS).
const AML_MPT_HDR = 0x18;
const AML_MPT_ENT = 40;
const AML_MPT_NAME_RE = /^[\w.\-]{2,16}$/;
const AML_MPT_VER_RE = /^\d{2}\.\d{2}\.\d{2}$/;
const AML_MPT_MAX_COUNT = 64;

function isAmlMptEntry(bytes, recOff, fileSize) {
  if (recOff + AML_MPT_ENT > bytes.length) return false;
  const name = ascii(bytes, recOff, 16);
  if (!AML_MPT_NAME_RE.test(name)) return false;
  const size = u64le(bytes, recOff + 16);
  const offset = u64le(bytes, recOff + 24);
  return validRange(offset, size, fileSize);
}

function isAmlMptAt(bytes, off, fileSize) {
  if (off < 0 || off + AML_MPT_HDR + AML_MPT_ENT > bytes.length) return false;
  if (!hasBytes(bytes, off, MPT)) return false;
  const version = ascii(bytes, off + 4, 8);
  if (!AML_MPT_VER_RE.test(version)) return false;
  const count = u32le(bytes, off + 0x10);
  if (count < 1 || count > AML_MPT_MAX_COUNT) return false;
  const tableEnd = off + AML_MPT_HDR + count * AML_MPT_ENT;
  if (tableEnd > bytes.length) return false;
  for (let i = 0; i < count; i++) {
    if (!isAmlMptEntry(bytes, off + AML_MPT_HDR + i * AML_MPT_ENT, fileSize)) return false;
  }
  return true;
}

export function findAmlMpt(bytes, fileSize) {
  if (!bytes) return -1;
  const minLen = AML_MPT_HDR + AML_MPT_ENT;
  // Sector-aligned scan: ROM1 MPT is at 0x2400000. Do not search for AMLS.
  for (let o = 0; o + minLen <= bytes.length; o += SECTOR) {
    if (isAmlMptAt(bytes, o, fileSize)) return o;
  }
  return -1;
}

export function isAmlMpt(bytes, fileSize) {
  return findAmlMpt(bytes, fileSize) >= 0;
}

function parseAmlogicMpt(bytes, fileSize) {
  const off = findAmlMpt(bytes, fileSize);
  if (off < 0) return [];
  const count = u32le(bytes, off + 0x10);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const e = off + AML_MPT_HDR + i * AML_MPT_ENT;
    const name = ascii(bytes, e, 16);
    const size = u64le(bytes, e + 16);
    const offset = u64le(bytes, e + 24);
    parts.push({ name, offset, size });
  }
  return parts;
}

// Detect SoC + partition-table type from the user area.
export function detectSocUserArea(bytes, fileSize) {
  if (hasBytes(bytes, 0, AMLS)) return { soc: 'amlogic', marker: 'AMLS MBR @0x0', tableType: 'aml_mbr' };
  if (hasBytes(bytes, 0x200, EFI_PART) || hasBytes(bytes, 0x400, EFI_PART)) return { soc: 'mtk', marker: 'EFI PART (GPT)', tableType: 'gpt' };
  if (hasBytes(bytes, 0x200, MSTAR)) return { soc: 'mstar', marker: 'MSTAR header @0x200', tableType: 'mstar' };
  if (hasBytes(bytes, 0, NVTK)) return { soc: 'novatek', marker: 'NVTK header @0x0', tableType: 'nvtk' };
  const hiScan = Math.min(bytes.length, 0x1000);
  for (let o = 0; o + 9 <= hiScan; o++) {
    if (hasBytes(bytes, o, HISILICON)) return { soc: 'hisilicon', marker: 'HISILICON magic', tableType: 'fastboot' };
  }
  const rtkScan = Math.min(bytes.length, 0x1000);
  const rtkText = new TextDecoder('latin1').decode(bytes.subarray(0, rtkScan)).toUpperCase();
  if (rtkText.includes('REALTEK') || rtkText.includes('RTK')) return { soc: 'realtek', marker: 'Realtek signature', tableType: 'uboot_env' };
  if (u16(bytes, 0x1FE) === 0xAA55) return { soc: 'unknown', marker: 'MBR 0x55AA', tableType: 'mbr' };
  // After existing signatures so GPT/MBR/MSTAR/NVTK/REALTEK/fastboot stay unchanged.
  if (isHisiEmmcMap(bytes)) {
    return { soc: 'hisilicon', marker: 'HISI eMMC map 0x1630/0x5840 @0', tableType: 'hisi_emmc_map' };
  }
  const mptOff = findAmlMpt(bytes, fileSize);
  if (mptOff >= 0) {
    return { soc: 'amlogic', marker: `Amlogic MPT @0x${mptOff.toString(16)}`, tableType: 'aml_mpt' };
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

function validRange(off, sz, fileSize) {
  if (sz === 0 || sz > 0x1000000000) return false;
  if (off > 0x1000000000) return false;
  if (fileSize && off + sz > fileSize + SECTOR) return false;
  return true;
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
    case 'hisi_emmc_map': parts = parseHisiEmmcMap(bytes, fileSize); break;
    case 'aml_mpt': parts = parseAmlogicMpt(bytes, fileSize); break;
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
    });
  }
  return out;
}