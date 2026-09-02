// Vendor firmware header + partition parser.
// Detects Amlogic, MediaTek, MStar, HiSilicon, Realtek, LG (EPK + webOS PKG/ZIP),
// Samsung, Novatek via binary magic at known offsets, then parses the vendor's
// partition table structure. Also handles ZIP-packed firmware containers by
// reading the central directory from the tail of the file. Falls back to a
// deep text scan for embedded scatter/mtdparts scripts.

const TEXT_SCAN_CAP = 2 * 1024 * 1024; // scan up to 2 MB of loaded chunk for text scripts
// Strong vendor IDs (e.g. RTD284X_DEMO) can sit past the 2 MB script window.
const STRONG_SCAN_CAP = 40 * 1024 * 1024;

const TIER_STRONG = 3;
const TIER_MEDIUM = 2;
const TIER_WEAK = 1;

// ---------- low-level helpers ----------

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function u64le(b, o) { return u32le(b, o) + u32le(b, o + 4) * 0x100000000; }

function asciiAt(b, o, len) {
  if (o + len > b.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = b[o + i];
    if (c === 0) break;
    s += c >= 32 && c <= 126 ? String.fromCharCode(c) : '.';
  }
  return s;
}

function hasBytes(b, o, sig) {
  if (o < 0 || o + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[o + i] !== sig[i]) return false;
  return true;
}

function hex(b, count = 16) {
  return Array.from(b.subarray(0, Math.min(count, b.length)))
    .map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function unique(items) { return [...new Set(items.filter(Boolean))]; }

// ---------- text scan (deep) ----------

function scanText(bytes, cap = TEXT_SCAN_CAP) {
  const len = Math.min(bytes.length, cap);
  // latin1 preserves each byte as a single char (0x00–0xFF) — fast and lossless
  // for the marker/regex scans below.
  return new TextDecoder('latin1').decode(bytes.subarray(0, len));
}

function extractTextScripts(text) {
  const lines = text.split(/\r?\n|\.\.\.+/);
  return unique(lines
    .map((l) => l.trim())
    .filter((l) => l.length >= 8 && l.length <= 400)
    .filter((l) =>
      /mtdparts\s*=|partition(?:s)?\s*[=:]|flash[_ -]?layout|part_name\s*=|partition_name\s*=|physical_start_addr|partition_size|file_name\s*=/i.test(l)
    ))
    .slice(0, 30);
}

// MediaTek scatter file (text): lines like:
//   partition_name: boot
//   physical_start_addr: 0x00000000
//   partition_size: 0x01000000
function parseScatter(text) {
  const blocks = text.split(/partition_name\s*:/i).slice(1);
  const parts = [];
  for (const block of blocks) {
    const name = (block.match(/^[\s]*([-\w.]+)/) || [])[1];
    const size = (block.match(/partition_size\s*:\s*(0x[0-9a-f]+|\d+)/i) || [])[1];
    const start = (block.match(/physical_start_addr\s*:\s*(0x[0-9a-f]+|\d+)/i) || [])[1];
    if (name) parts.push({ name, size: size || '—', start: start || '—', source: 'MTK scatter' });
  }
  return parts;
}

// mtdparts kernel cmdline: mtdparts=aml-nand:1M@0(boot),...
function parseMtdparts(text) {
  const parts = [];
  for (const m of text.matchAll(/mtdparts\s*=\s*[^:]+:\s*([^"'\s]+)/gi)) {
    const spec = m[1];
    for (const e of spec.matchAll(/(\d+[KMG]?)@?(0x[0-9a-f]+|\d+)?\(([^)]+)\)/gi)) {
      parts.push({ name: e[3], size: e[1], start: e[2] || '—', source: 'mtdparts' });
    }
  }
  return parts;
}

// Realtek / TCL C header definitions: #define FW_KERNEL " target=deaddead offset=3808000 size=179c100 type=aes "
// or #define PART0 " offset=c300000 size=100000 mount_point=/frp filesystem=ext4 partname=frp ... "
function parseBootParams(text) {
  const parts = [];
  const regex = /#define\s+([A-Z0-9_]+)\s+"([^"]+)"/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const macroName = m[1];
    const body = m[2];
    const offMatch = body.match(/offset=([0-9a-f]+)/i);
    const sizeMatch = body.match(/size=([0-9a-f]+)/i);
    const partNameMatch = body.match(/partname=([-\w.]+)/i);

    if (offMatch && sizeMatch) {
      const name = partNameMatch ? partNameMatch[1] : macroName;
      const off = parseInt(offMatch[1], 16);
      const sz = parseInt(sizeMatch[1], 16);
      if (Number.isFinite(off) && Number.isFinite(sz) && sz > 0) {
        parts.push({
          name,
          size: `0x${sz.toString(16)}`,
          start: `0x${off.toString(16)}`,
          source: 'bootparams',
        });
      }
    }
  }
  return parts;
}

// ---------- ZIP container parser ----------
// Many vendor firmwares (LG webOS .pkg, Realtek, MTK, generic) ship as ZIP
// archives whose entries are the partition images. The central directory lives
// near the end of the file, so we need the tail bytes to find it.

const ZIP_EOCD = [0x50, 0x4b, 0x05, 0x06]; // PK\x05\x06
const ZIP_CD_ENTRY = [0x50, 0x4b, 0x01, 0x02]; // PK\x01\x02

function findEocd(tail) {
  const min = Math.max(0, tail.length - (22 + 65535));
  for (let i = tail.length - 22; i >= min; i--) {
    if (hasBytes(tail, i, ZIP_EOCD)) return i;
  }
  return -1;
}

function parseZip(bytes, tailBytes, fileSize) {
  if (!tailBytes) return [];
  const eocdOff = findEocd(tailBytes);
  if (eocdOff < 0) return [];
  const count = u16(tailBytes, eocdOff + 10);
  const cdSize = u32le(tailBytes, eocdOff + 12);
  const cdOffset = u32le(tailBytes, eocdOff + 16);
  if (count === 0 || count > 500) return [];

  const parts = [];
  let cur = 0;
  for (let i = 0; i < count; i++) {
    const entryStart = tailBytes.length - (tailBytes.length - eocdOff) - cdSize + cur;
    if (entryStart < 0 || entryStart + 46 > tailBytes.length) break;
    if (!hasBytes(tailBytes, entryStart, ZIP_CD_ENTRY)) break;
    const compressedSize = u32le(tailBytes, entryStart + 20);
    const uncompressedSize = u32le(tailBytes, entryStart + 24);
    const nameLen = u16(tailBytes, entryStart + 28);
    const extraLen = u16(tailBytes, entryStart + 30);
    const commentLen = u16(tailBytes, entryStart + 32);
    const localHeaderOffset = u32le(tailBytes, entryStart + 42);
    const name = asciiAt(tailBytes, entryStart + 46, nameLen);
    if (name && !name.endsWith('/')) {
      const sz = uncompressedSize || compressedSize;
      parts.push({
        name,
        size: sz ? `0x${sz.toString(16)}` : '—',
        start: `0x${localHeaderOffset.toString(16)}`,
        source: 'ZIP',
      });
    }
    cur += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

// ---------- Amlogic uimage / aml_sdc_burn / aml_nand ----------

function parseAmlogic(bytes, fileSize) {
  const parts = [];
  const mkMagic = u32be(bytes, 0);
  if (mkMagic === 0x27051956) {
    parts.push({ name: 'u-boot', size: `0x${u32be(bytes, 4).toString(16)}`, start: '0x0', source: 'mkimage' });
  }
  const scan = Math.min(bytes.length, 4 * 1024 * 1024);
  for (let o = 0x40; o < scan - 48; o += 4) {
    if (bytes[o] < 32 || bytes[o] > 126) continue;
    const name = asciiAt(bytes, o, 32);
    if (!/^[\w.\-]{3,20}$/.test(name)) continue;
    const off = u64le(bytes, o + 32);
    const sz = u64le(bytes, o + 40);
    if (sz === 0 || sz > 0x1000000000) continue;
    if (off > 0 && off < 0x1000000000 && (!fileSize || off + sz <= fileSize)) {
      parts.push({ name, size: `0x${sz.toString(16)}`, start: `0x${off.toString(16)}`, source: 'AML item' });
      o += 44;
    }
  }
  return uniqueParts(parts);
}

// ---------- MediaTek scatter / preloader ----------

function parseMediaTek(bytes) {
  const parts = [];
  const scanLimit = Math.min(bytes.length, 0x2000);
  let brlyt = -1;
  for (let o = 0; o + 5 <= scanLimit; o++) {
    if (hasBytes(bytes, o, [0x42, 0x52, 0x4c, 0x59, 0x54])) { brlyt = o; break; }
  }
  if (brlyt < 0) return [];
  let p = brlyt + 0x60;
  for (let i = 0; i < 64 && p + 32 <= bytes.length; i++, p += 32) {
    const name = asciiAt(bytes, p, 16).replace(/\0.*$/, '');
    if (!name) continue;
    const startLba = u32le(bytes, p + 16);
    const blocks = u32le(bytes, p + 20);
    if (blocks === 0) continue;
    parts.push({ name, size: `0x${(blocks * 512).toString(16)}`, start: `0x${(startLba * 512).toString(16)}`, source: 'BRLYT' });
  }
  return uniqueParts(parts);
}

// ---------- LG EPK / webOS PKG ----------

function parseLg(bytes) {
  const parts = [];
  for (const sig of ['EPK0', 'EPK1', 'EPK2', 'EPK3']) {
    const sb = Array.from(sig, (c) => c.charCodeAt(0));
    if (hasBytes(bytes, 0, sb)) {
      const count = u32le(bytes, 0x14);
      let p = 0x400;
      for (let i = 0; i < count && p + 80 <= bytes.length; i++, p += 80) {
        const name = asciiAt(bytes, p, 32).replace(/\0.*$/, '');
        const off = u64le(bytes, p + 40);
        const sz = u64le(bytes, p + 48);
        if (name && sz > 0) parts.push({ name, size: `0x${sz.toString(16)}`, start: `0x${off.toString(16)}`, source: 'EPK' });
      }
      break;
    }
  }
  return uniqueParts(parts);
}

// ---------- HiSilicon fastboot ----------

function parseHiSilicon(bytes, fileSize) {
  const parts = [];
  const scan = Math.min(bytes.length, 2 * 1024 * 1024);
  for (let o = 0; o < scan - 48; o += 4) {
    if (bytes[o] < 32 || bytes[o] > 126) continue;
    const name = asciiAt(bytes, o, 32);
    if (!/^[\w.\-]{3,20}$/.test(name)) continue;
    const off = u64le(bytes, o + 32);
    const sz = u64le(bytes, o + 40);
    if (sz === 0 || sz > 0x1000000000) continue;
    if (off > 0x1000000000) continue;
    if (fileSize && off + sz > fileSize) continue;
    parts.push({ name, size: `0x${sz.toString(16)}`, start: `0x${off.toString(16)}`, source: 'HISI' });
    o += 44;
  }
  return uniqueParts(parts);
}

// ---------- MStar upgrade .bin ----------

function isMstarBin(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 16 * 1024));
  let ff = -1;
  for (let i = 0; i < head.length; i++) { if (head[i] === 0xff) { ff = i; break; } }
  if (ff < 4) return false;
  for (let i = 0; i < Math.min(ff, 256); i++) {
    const c = head[i];
    if (!(c === 0x0a || c === 0x0d || c === 0x09 || (c >= 0x20 && c <= 0x7e))) return false;
  }
  const text = new TextDecoder('latin1').decode(head.subarray(0, ff));
  return /mmc\s+write\.p\b|filepartload|sparse_write|store_secure_info|mmc\s+unlzo/.test(text);
}

function parseHexNum(s) {
  s = String(s).trim();
  if (/^0x/i.test(s)) return parseInt(s, 16);
  const n = parseInt(s, 16);
  return Number.isNaN(n) ? parseInt(s, 10) : n;
}

function parseMstarBin(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 16 * 1024));
  let ff = head.length;
  for (let i = 0; i < head.length; i++) { if (head[i] === 0xff) { ff = i; break; } }
  const script = new TextDecoder('latin1').decode(head.subarray(0, ff));
  const env = {};
  const parts = [];
  let curOffset = null, curSize = null;
  const counters = {};
  const applyEnv = (line) => line.replace(/\$\((\w+)\)/g, (m, k) => (env[k] != null ? env[k] : m));
  for (const raw of script.split(/\r?\n/)) {
    const line = applyEnv(raw).trim();
    if (!line) continue;
    const a = line.split(/\s+/);
    if (a[0] === 'setenv') {
      if (a.length >= 3) env[a[1]] = a.slice(2).join(' ');
      else if (a.length === 2) delete env[a[1]];
      continue;
    }
    if (a[0] === 'filepartload') {
      if (a.length >= 5) { curOffset = parseHexNum(a[3]); curSize = parseHexNum(a[4]); }
      continue;
    }
    if (curOffset == null || !curSize) continue;
    const push = (name, encoding, type) => {
      parts.push({
        name,
        size: `0x${curSize.toString(16)}`,
        start: `0x${curOffset.toString(16)}`,
        source: 'MStar bin' + (encoding ? ` ${encoding}` : '') + (type ? ` ${type}` : ''),
      });
    };
    if (a[0] === 'sparse_write' && a.length >= 4) {
      push(a[3], 'sparse');
    } else if (a[0] === 'store_secure_info' && a.length >= 2) {
      push(a[1], null, 'secureInfo');
    } else if (a[0] === 'store_nuttx_config' && a.length >= 2) {
      push(a[1], null, 'nuttxConfig');
    } else if (a[0] === 'mmc') {
      const action = a[1];
      if (action === 'write.p' && a.length >= 4) {
        push(a[3]);
      } else if (action === 'write.p.continue' || action === 'write.p.cont') {
        const name = a[3];
        counters[name] = (counters[name] || 0) + 1;
        push(counters[name] === 1 ? name : `${name}#${counters[name]}`);
      } else if (action === 'write.boot' || action === 'write') {
        push('sboot');
      } else if (action === 'unlzo' && a.length >= 5) {
        push(a[4], 'lzo');
      } else if (action === 'unlzo.continue' || action === 'unlzo.cont') {
        const name = a[4];
        counters[name] = (counters[name] || 0) + 1;
        push(counters[name] === 1 ? name : `${name}#${counters[name]}`, 'lzo');
      }
    }
  }
  return uniqueParts(parts);
}

// Realtek / Novatek / MStar / Samsung: scan for partition descriptor blocks.
function parseGenericDescriptors(bytes, fileSize) {
  const parts = [];
  const scan = Math.min(bytes.length, 4 * 1024 * 1024);
  const limit = fileSize || 0x1000000000;
  for (let o = 0; o < scan - 48; o += 4) {
    if (bytes[o] < 32 || bytes[o] > 126) continue;
    const name = asciiAt(bytes, o, 24);
    if (!/^[\w.\-]{3,20}$/.test(name)) continue;
    for (const nameLen of [24, 32]) {
      const off = u64le(bytes, o + nameLen);
      const sz = u64le(bytes, o + nameLen + 8);
      if (sz >= 512 && sz <= 0x40000000 && off < limit && off + sz <= limit) {
        parts.push({ name, size: `0x${sz.toString(16)}`, start: `0x${off.toString(16)}`, source: 'descriptor' });
        o += nameLen + 12;
        break;
      }
      const off32 = u32le(bytes, o + nameLen);
      const sz32 = u32le(bytes, o + nameLen + 4);
      if (sz32 >= 512 && sz32 <= 0x40000000 && off32 < limit && off32 + sz32 <= limit && off32 > 0) {
        parts.push({ name, size: `0x${sz32.toString(16)}`, start: `0x${off32.toString(16)}`, source: 'descriptor' });
        o += nameLen + 4;
        break;
      }
    }
  }
  return uniqueParts(parts).slice(0, 40);
}

function uniqueParts(parts) {
  const seen = new Set();
  return parts.filter((p) => !seen.has(p.name.toLowerCase() + p.source) && seen.add(p.name.toLowerCase() + p.source));
}

// ---------- family detection ----------

function isTokenChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95;
}

function isPrefixMarker(marker, prefixFlag) {
  if (prefixFlag) return true;
  return marker.endsWith('-') || marker.endsWith('_');
}

function findBoundedMarker(source, marker, from = 0, prefixFlag = false) {
  const prefix = isPrefixMarker(marker, prefixFlag);
  let i = from;
  while (i <= source.length - marker.length) {
    const at = source.indexOf(marker, i);
    if (at < 0) return -1;
    const leftOk = at === 0 || !isTokenChar(source[at - 1]);
    const after = at + marker.length;
    const rightOk = prefix || after >= source.length || !isTokenChar(source[after]);
    if (leftOk && rightOk) return at;
    i = at + 1;
  }
  return -1;
}

function collectMarkerHits(source, marker, family, tier, out, prefixFlag = false) {
  let from = 0;
  while (from <= source.length - marker.length) {
    const at = findBoundedMarker(source, marker, from, prefixFlag);
    if (at < 0) break;
    out.push({ family, marker, tier, offset: at });
    from = at + marker.length;
  }
}

function collectRtdSocHits(source, out) {
  const re = /RTD\d{3,4}[A-Z0-9_]*/g;
  let m;
  while ((m = re.exec(source))) {
    const at = m.index;
    const token = m[0];
    const leftOk = at === 0 || !isTokenChar(source[at - 1]);
    const after = at + token.length;
    const rightOk = after >= source.length || !isTokenChar(source[after]);
    if (leftOk && rightOk) {
      out.push({ family: 'Realtek', marker: token, tier: TIER_STRONG, offset: at });
    }
    if (re.lastIndex === at) re.lastIndex += 1;
  }
}

const FAMILY_TEXT_MARKERS = [
  {
    name: 'Amlogic',
    markers: [
      { text: 'AMLOGIC', tier: TIER_STRONG },
      { text: 'AMLBOOT', tier: TIER_STRONG },
      { text: 'UBOOT AML', tier: TIER_STRONG },
      { text: 'AML-', tier: TIER_MEDIUM },
      { text: 'AML_', tier: TIER_MEDIUM },
    ],
  },
  {
    name: 'MediaTek',
    markers: [
      { text: 'MEDIATEK', tier: TIER_STRONG },
      { text: 'BRLYT', tier: TIER_STRONG },
      { text: 'MTKBOOT', tier: TIER_STRONG },
      { text: 'MTK BOOT', tier: TIER_STRONG },
      { text: 'MTK-', tier: TIER_MEDIUM },
    ],
  },
  {
    name: 'MStar',
    markers: [
      { text: 'MSTAR', tier: TIER_STRONG },
      { text: 'MBOOT', tier: TIER_STRONG },
      { text: 'MST SEMICONDUCTORS', tier: TIER_STRONG },
    ],
  },
  {
    name: 'HiSilicon',
    markers: [
      { text: 'HI379', tier: TIER_STRONG, prefix: true },
      { text: 'HI371', tier: TIER_STRONG, prefix: true },
      { text: 'HISILICON', tier: TIER_MEDIUM },
      { text: 'HISI', tier: TIER_WEAK },
    ],
  },
  {
    name: 'Realtek',
    markers: [
      { text: 'REALTEK', tier: TIER_STRONG },
      { text: 'RTK-', tier: TIER_MEDIUM },
      { text: 'RTD', tier: TIER_WEAK },
    ],
  },
  {
    name: 'LG',
    markers: [
      { text: 'LG ELECTRONICS', tier: TIER_STRONG },
      { text: 'WEBOS', tier: TIER_STRONG },
    ],
  },
  {
    name: 'Samsung',
    markers: [
      { text: 'SAMSUNG', tier: TIER_STRONG },
      { text: 'TIZEN', tier: TIER_STRONG },
      { text: 'SECURO', tier: TIER_STRONG },
    ],
  },
  {
    name: 'Novatek',
    markers: [
      { text: 'NOVATEK', tier: TIER_STRONG },
      { text: 'NT726', tier: TIER_MEDIUM },
      { text: 'NT73', tier: TIER_MEDIUM },
      { text: 'NT72', tier: TIER_WEAK },
    ],
  },
];

const UNKNOWN_FAMILY = { family: 'Generic / unknown', marker: 'No vendor signature found' };

function pickFamilyEvidence(evidence) {
  if (!evidence.length) return UNKNOWN_FAMILY;
  let best = evidence[0];
  for (let i = 1; i < evidence.length; i++) {
    const e = evidence[i];
    if (e.tier > best.tier) {
      best = e;
    } else if (e.tier === best.tier) {
      if (e.offset < best.offset) best = e;
      else if (e.offset === best.offset && e.marker.length > best.marker.length) best = e;
    }
  }
  if (best.tier === TIER_WEAK && best.family !== 'Realtek') return UNKNOWN_FAMILY;
  return { family: best.family, marker: `text: ${best.marker}` };
}

function detectFamily(bytes, fileName, tailBytes) {
  const fn = fileName.toUpperCase();
  if (hasBytes(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return { family: 'ZIP', marker: 'ZIP local header @0' };
  if (tailBytes && findEocd(tailBytes) >= 0) return { family: 'ZIP', marker: 'ZIP EOCD in tail' };
  if (hasBytes(bytes, 0, [0x41, 0x4d, 0x4c])) return { family: 'Amlogic', marker: '"AML" magic @0' };
  if (u32be(bytes, 0) === 0x27051956) return { family: 'Amlogic', marker: 'U-Boot mkimage @0' };
  if (hasBytes(bytes, 0x1018, [0x42, 0x52, 0x4c, 0x59, 0x54])) return { family: 'MediaTek', marker: 'BRLYT @0x1018' };
  for (const s of ['EPK0', 'EPK1', 'EPK2', 'EPK3']) {
    if (hasBytes(bytes, 0, Array.from(s, (c) => c.charCodeAt(0)))) return { family: 'LG', marker: `${s} magic @0` };
  }
  if (isMstarBin(bytes)) return { family: 'MStar', marker: 'U-Boot script header (16KB .bin)' };

  const textNear = scanText(bytes, TEXT_SCAN_CAP);
  const sourceNear = `${fn}\n${textNear}`.toUpperCase();
  const evidence = [];
  for (const family of FAMILY_TEXT_MARKERS) {
    for (const mk of family.markers) {
      collectMarkerHits(sourceNear, mk.text, family.name, mk.tier, evidence, mk.prefix);
    }
  }

  const strongLen = Math.min(bytes.length, STRONG_SCAN_CAP);
  if (strongLen > TEXT_SCAN_CAP) {
    const textStrong = scanText(bytes, strongLen);
    const sourceStrong = `${fn}\n${textStrong}`.toUpperCase();
    const realtek = FAMILY_TEXT_MARKERS.find((f) => f.name === 'Realtek');
    for (const mk of realtek.markers) {
      if (mk.tier !== TIER_STRONG) continue;
      collectMarkerHits(sourceStrong, mk.text, realtek.name, mk.tier, evidence, mk.prefix);
    }
    collectRtdSocHits(sourceStrong, evidence);
  } else {
    collectRtdSocHits(sourceNear, evidence);
  }

  return pickFamilyEvidence(evidence);
}

// ---------- main entry ----------

export function isDumpFirmwarePartition(p) {
  return p && p.source && p.source !== 'descriptor';
}

export function firmwarePartitionsToParts(analysis, fileSize) {
  if (!analysis || !analysis.partitions.length) return [];
  const out = [];
  let idx = 0;
  for (const p of analysis.partitions) {
    if (!isDumpFirmwarePartition(p)) continue;
    const size = parseSizeNum(p.size);
    const start = parseSizeNum(p.start);
    if (size == null && start == null) continue;
    out.push({
      index: idx++,
      name: p.name,
      ptType: p.source === 'ZIP' ? 'zip' : 'vendor',
      startByte: start != null ? start : 0,
      size: size != null ? size : (fileSize ? fileSize - (start || 0) : 0),
      vendorSource: p.source,
    });
  }
  return out;
}

function parseSizeNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '—') return null;
  if (s.startsWith('0x')) return parseInt(s, 16);
  const m = s.match(/^(\d+)([KMG]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n * (m[2] === 'K' ? 1024 : m[2] === 'M' ? 1024 * 1024 : m[2] === 'G' ? 1024 ** 3 : 1);
}

// ---------- Realtek system layout parser ----------
// Detects VERONA__ partition table signature at 0x3800000 and ustar tarball at 0x2000000.

const VERONA_SIG = [0x56, 0x45, 0x52, 0x4f, 0x4e, 0x41, 0x5f, 0x5f]; // "VERONA__"
const USTAR_SIG = [0x75, 0x73, 0x74, 0x61, 0x72]; // "ustar"

function parseRealtekSystemLayout(bytes, fileSize) {
  const parts = [];
  const hasVerona = hasBytes(bytes, 0x3800000, VERONA_SIG);
  if (!hasVerona) return parts;

  parts.push({
    name: 'fw table',
    start: '0x3800000',
    size: '0x8000',
    source: 'VERONA',
  });

  if (bytes.length >= 0x1800000) {
    parts.push({
      name: 'bootcode',
      start: '0x2000',
      size: '0x17df800',
      source: 'Realtek bootloader',
    });
  }

  if (bytes.length >= 0x1c00000) {
    parts.push({
      name: 'factory_ro',
      start: '0x1800000',
      size: '0x400000',
      source: 'Realtek layout',
    });
  }

  if (bytes.length >= 0x2000000) {
    parts.push({
      name: 'eeprom',
      start: '0x1c00000',
      size: '0x400000',
      source: 'Realtek layout',
    });
  }

  const hasTar = hasBytes(bytes, 0x2000000 + 0x101, USTAR_SIG) || hasBytes(bytes, 0x2000000, Array.from('tmp/factory', (c) => c.charCodeAt(0)));
  if (hasTar || bytes.length >= 0x3000000) {
    parts.push({
      name: 'factory',
      start: '0x2000000',
      size: '0x1000000',
      source: hasTar ? 'Realtek factory' : 'Realtek layout',
    });
  }

  if (bytes.length >= 0x3400000) {
    parts.push({
      name: 'secure store',
      start: '0x2800000',
      size: '0xc00000',
      source: 'Realtek layout',
    });
  }

  if (bytes.length >= 0x3800000) {
    parts.push({
      name: 'reserved',
      start: '0x3400000',
      size: '0x400000',
      source: 'Realtek layout',
    });
  }

  return parts;
}

export function analyzeFirmware(bytes, fileName = '', fileSize = 0, tailBytes = null) {
  if (!bytes) return null;
  const detected = detectFamily(bytes, fileName, tailBytes);
  // Scan text up to 40 MB for Realtek text headers / bootparams
  const scanCap = detected.family === 'Realtek' ? Math.min(bytes.length, STRONG_SCAN_CAP) : Math.min(bytes.length, TEXT_SCAN_CAP);
  const text = scanText(bytes, scanCap);
  const scripts = extractTextScripts(text);

  let parts = [];
  switch (detected.family) {
    case 'ZIP': parts = parseZip(bytes, tailBytes, fileSize); break;
    case 'Amlogic': parts = parseAmlogic(bytes, fileSize); break;
    case 'MediaTek': parts = parseMediaTek(bytes); break;
    case 'LG': parts = parseLg(bytes); break;
    case 'HiSilicon': parts = parseHiSilicon(bytes, fileSize); break;
    case 'MStar': parts = parseMstarBin(bytes); break;
    default: parts = parseGenericDescriptors(bytes, fileSize); break;
  }
  // merge text-based partitions (scatter / mtdparts / bootparams)
  const textParts = [...parseScatter(text), ...parseMtdparts(text), ...parseBootParams(text)];
  for (const tp of textParts) {
    if (!parts.some((p) => p.name.toLowerCase() === tp.name.toLowerCase())) parts.push(tp);
  }

  if (detected.family === 'Realtek') {
    const realtekLayout = parseRealtekSystemLayout(bytes, fileSize);
    for (const rlp of realtekLayout) {
      if (!parts.some((p) => p.name.toLowerCase() === rlp.name.toLowerCase())) {
        parts.push(rlp);
      }
    }
  }

  const ext = fileName.includes('.') ? fileName.split('.').pop().toUpperCase() : 'BIN';
  const dumpParts = parts.filter(isDumpFirmwarePartition);
  const finalPartitions = dumpParts.length > 0
    ? [...dumpParts, ...parts.filter((p) => !isDumpFirmwarePartition(p))].slice(0, 48)
    : parts.slice(0, 48);

  return {
    family: detected.family,
    marker: detected.marker,
    header: [
      { label: 'Vendor family', value: detected.family },
      { label: 'Matched signature', value: detected.marker },
      { label: 'Container extension', value: ext },
      { label: 'Header bytes', value: hex(bytes, 16) },
      { label: 'Scanned region', value: `${scanCap.toLocaleString()} bytes` },
      { label: 'Partitions found', value: String(dumpParts.length) },
    ],
    scripts,
    partitions: finalPartitions,
  };
}
