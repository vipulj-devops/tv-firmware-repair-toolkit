// Vendor firmware header + partition parser.
// Detects Amlogic, MediaTek, MStar, HiSilicon, Realtek, LG (EPK + webOS PKG/ZIP),
// Samsung, Novatek via binary magic at known offsets, then parses the vendor's
// partition table structure. Also handles ZIP-packed firmware containers by
// reading the central directory from the tail of the file. Falls back to a
// deep text scan for embedded scatter/mtdparts scripts.

const TEXT_SCAN_CAP = 2 * 1024 * 1024; // scan up to 2 MB of loaded chunk for text scripts

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

function scanText(bytes) {
  const len = Math.min(bytes.length, TEXT_SCAN_CAP);
  // latin1 preserves each byte as a single char (0x00–0xFF) — fast and lossless
  // for the marker/regex scans below, and avoids the catastrophic cost of
  // building a multi-MB string byte-by-byte (the old loop hung the browser).
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

// ---------- ZIP container parser ----------
// Many vendor firmwares (LG webOS .pkg, Realtek, MTK, generic) ship as ZIP
// archives whose entries are the partition images. The central directory lives
// near the end of the file, so we need the tail bytes to find it.

const ZIP_EOCD = [0x50, 0x4b, 0x05, 0x06]; // PK\x05\x06
const ZIP_CD_ENTRY = [0x50, 0x4b, 0x01, 0x02]; // PK\x01\x02

function findEocd(tail) {
  // EOCD is at most 22 + 65535 (comment) bytes from the end.
  const min = Math.max(0, tail.length - (22 + 65535));
  for (let i = tail.length - 22; i >= min; i--) {
    if (hasBytes(tail, i, ZIP_EOCD)) return i;
  }
  return -1;
}

function parseZip(headBytes, tailBytes, fileSize) {
  if (!tailBytes) return [];
  const eocd = findEocd(tailBytes);
  if (eocd < 0) return [];
  const totalEntries = u16(tailBytes, eocd + 10);
  const cdSize = u32le(tailBytes, eocd + 12);
  const cdOffset = u32le(tailBytes, eocd + 16); // relative to file start
  if (totalEntries === 0 || cdSize === 0) return [];

  const tailStart = fileSize - tailBytes.length;
  let cd;
  if (cdOffset >= tailStart && cdOffset + cdSize <= fileSize) {
    cd = tailBytes.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
  } else if (headBytes && cdOffset + cdSize <= headBytes.length) {
    cd = headBytes.subarray(cdOffset, cdOffset + cdSize);
  } else {
    return []; // central directory not in the head or tail window
  }

  const parts = [];
  let p = 0;
  for (let i = 0; i < totalEntries && p + 46 <= cd.length; i++) {
    if (!hasBytes(cd, p, ZIP_CD_ENTRY)) break;
    const compSize = u32le(cd, p + 20);
    const uncompSize = u32le(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const localOffset = u32le(cd, p + 42);
    if (p + 46 + nameLen > cd.length) break;
    const rawName = asciiAt(cd, p + 46, nameLen).replace(/\0.*$/, '');
    const name = rawName.replace(/\\/g, '/');
    if (name && !name.endsWith('/')) {
      const base = name.split('/').pop() || name;
      parts.push({
        name: base,
        size: `0x${uncompSize.toString(16)}`,
        start: `0x${localOffset.toString(16)}`,
        source: 'ZIP',
        path: name,
        compSize,
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

// ---------- binary header parsers ----------

// Amlogic: aml_upgrade_package.img
// Header magic "AML" at 0, or U-Boot mkimage header (magic 0x27051956 BE) at 0/0x40.
// The upgrade package item table: after a fixed header, entries of
//   name[32] + offset[8] + size[8] + type[4] ... repeated.
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
      o += 44; // +4 from the for-loop step = 48-byte item slot (was +52, skipping every other item)
    }
  }
  return uniqueParts(parts);
}

// MediaTek: BRLYT header at 0x1018. BR_LAYOUT follows with partition entries.
// Each entry: name[16] + start_lba(4) + size_blocks(4).
function parseMediaTek(bytes) {
  const parts = [];
  // BRLYT magic ("BRLYT") sits at 0x1018 — NOT aligned to 0x200, so the old
  // stepped scan (o += 0x200) never landed on it and MTK dumps parsed empty.
  // Scan byte-by-byte through the first 0x2000 to find the signature.
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

// LG EPK: "EPK0"/"EPK1"/"EPK2"/"EPK3" magic at 0.
// Header: version, count, then entries with name + offset + size.
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

// HiSilicon: header magic "HISI" or "HI" at 0, partition table with
// name[32] + offset(8) + size(8) entries.
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

// Realtek / Novatek / MStar / Samsung: scan for partition descriptor blocks.
// Require a plausible name followed by an offset+size pair (u64le each, or
// u32le each) so we don't pick up random ascii strings as false partitions.
function parseGenericDescriptors(bytes, fileSize) {
  const parts = [];
  const scan = Math.min(bytes.length, 4 * 1024 * 1024);
  const limit = fileSize || 0x1000000000;
  for (let o = 0; o < scan - 48; o += 4) {
    if (bytes[o] < 32 || bytes[o] > 126) continue;
    const name = asciiAt(bytes, o, 24);
    if (!/^[\w.\-]{3,20}$/.test(name)) continue;
    // try u64le offset + u64le size right after a 24/32-byte name slot
    for (const nameLen of [24, 32]) {
      const off = u64le(bytes, o + nameLen);
      const sz = u64le(bytes, o + nameLen + 8);
      if (sz >= 512 && sz <= 0x40000000 && off < limit && off + sz <= limit) {
        parts.push({ name, size: `0x${sz.toString(16)}`, start: `0x${off.toString(16)}`, source: 'descriptor' });
        o += nameLen + 12; // +4 from the for-loop step = nameLen + 16 (full entry)
        break;
      }
      // try u32le offset + u32le size
      const off32 = u32le(bytes, o + nameLen);
      const sz32 = u32le(bytes, o + nameLen + 4);
      if (sz32 >= 512 && sz32 <= 0x40000000 && off32 < limit && off32 + sz32 <= limit && off32 > 0) {
        parts.push({ name, size: `0x${sz32.toString(16)}`, start: `0x${off32.toString(16)}`, source: 'descriptor' });
        o += nameLen + 4; // +4 from the for-loop step = nameLen + 8 (full entry)
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

// ---------- MStar .bin (U-Boot script header) ----------
// MStar upgrade .bin files start with a 16 KB U-Boot shell script (plain text,
// padded to 16 KB with 0xFF). The script is the partition table: `filepartload`
// loads a region (offset+size) from the .bin into DRAM, then `mmc write.p` /
// `unlzo` / `sparse_write` / `store_secure_info` write it to a named partition.
// We replay the script to recover each partition's offset+size in the .bin.

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

// ---------- family detection ----------

function detectFamily(bytes, fileName, tailBytes) {
  const fn = fileName.toUpperCase();
  // ZIP container (PK\x03\x04 local header at 0, or EOCD in tail)
  if (hasBytes(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return { family: 'ZIP', marker: 'ZIP local header @0' };
  if (tailBytes && findEocd(tailBytes) >= 0) return { family: 'ZIP', marker: 'ZIP EOCD in tail' };
  // binary magic checks
  if (hasBytes(bytes, 0, [0x41, 0x4d, 0x4c])) return { family: 'Amlogic', marker: '"AML" magic @0' }; // "AML"
  if (u32be(bytes, 0) === 0x27051956) return { family: 'Amlogic', marker: 'U-Boot mkimage @0' };
  if (hasBytes(bytes, 0x1018, [0x42, 0x52, 0x4c, 0x59, 0x54])) return { family: 'MediaTek', marker: 'BRLYT @0x1018' };
  for (const s of ['EPK0', 'EPK1', 'EPK2', 'EPK3']) {
    if (hasBytes(bytes, 0, Array.from(s, (c) => c.charCodeAt(0)))) return { family: 'LG', marker: `${s} magic @0` };
  }
  // MStar upgrade .bin: 16 KB U-Boot script header padded with 0xFF
  if (isMstarBin(bytes)) return { family: 'MStar', marker: 'U-Boot script header (16KB .bin)' };
  // text-based marker scan
  const text = scanText(bytes);
  const source = `${fn}\n${text}`.toUpperCase();
  const families = [
    { name: 'Amlogic', markers: ['AMLOGIC', 'AML-', 'AMLBOOT', 'UBOOT AML', 'AML_'] },
    { name: 'MediaTek', markers: ['MEDIATEK', 'MTK-', 'BRLYT', 'MTKBOOT', 'MTK BOOT'] },
    { name: 'MStar', markers: ['MSTAR', 'MBOOT', 'MST SEMICONDUCTORS'] },
    { name: 'HiSilicon', markers: ['HISILICON', 'HISI', 'HI379', 'HI371'] },
    { name: 'Realtek', markers: ['REALTEK', 'RTK-', 'RTD'] },
    { name: 'LG', markers: ['LGE', 'LG ELECTRONICS', 'WEBOS', 'EPK'] },
    { name: 'Samsung', markers: ['SAMSUNG', 'TIZEN', 'SECURO'] },
    { name: 'Novatek', markers: ['NOVATEK', 'NT72', 'NT73', 'NT726'] },
  ];
  for (const f of families) {
    const m = f.markers.find((mk) => source.includes(mk));
    if (m) return { family: f.name, marker: `text: ${m}` };
  }
  return { family: 'Generic / unknown', marker: 'No vendor signature found' };
}

// ---------- main entry ----------

// Convert firmware-parser partitions (hex-string start/size) into the
// PartitionTable shape (numeric startByte/size, ptType, index) so vendor
// firmware files show up in the actionable partition table.
export function firmwarePartitionsToParts(analysis, fileSize) {
  if (!analysis || !analysis.partitions.length) return [];
  const out = [];
  let idx = 0;
  for (const p of analysis.partitions) {
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

export function analyzeFirmware(bytes, fileName = '', fileSize = 0, tailBytes = null) {
  if (!bytes) return null;
  const detected = detectFamily(bytes, fileName, tailBytes);
  const text = scanText(bytes);
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
  // merge text-based partitions (scatter / mtdparts)
  const textParts = [...parseScatter(text), ...parseMtdparts(text)];
  for (const tp of textParts) {
    if (!parts.some((p) => p.name.toLowerCase() === tp.name.toLowerCase())) parts.push(tp);
  }

  const ext = fileName.includes('.') ? fileName.split('.').pop().toUpperCase() : 'BIN';
  return {
    family: detected.family,
    marker: detected.marker,
    header: [
      { label: 'Vendor family', value: detected.family },
      { label: 'Matched signature', value: detected.marker },
      { label: 'Container extension', value: ext },
      { label: 'Header bytes', value: hex(bytes, 16) },
      { label: 'Scanned region', value: `${Math.min(bytes.length, TEXT_SCAN_CAP).toLocaleString()} bytes` },
      { label: 'Partitions found', value: String(parts.length) },
    ],
    scripts,
    partitions: parts.slice(0, 48),
  };
}