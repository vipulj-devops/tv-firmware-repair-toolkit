// Minimal ZIP writer (STORE + DEFLATE-RAW via CompressionStream).
import { crc32 } from './crc32.js';

function u16dv(buf, off, val) { new DataView(buf.buffer).setUint16(off, val, true); }
function u32dv(buf, off, val) { new DataView(buf.buffer).setUint32(off, val, true); }

async function deflateRaw(data) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  } catch (e) {
    return null;
  }
}

// files: [{ name: string, data: Uint8Array }]
export async function createZip(files) {
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const crc = crc32(file.data) >>> 0;
    let compMethod = 0;
    let stored = file.data;

    const deflated = await deflateRaw(file.data);
    if (deflated && deflated.length < file.data.length) {
      stored = deflated;
      compMethod = 8;
    }

    // Local file header (30 bytes + name)
    const lh = new Uint8Array(30 + nameBytes.length);
    u32dv(lh, 0, 0x04034b50);
    u16dv(lh, 4, 20);
    u16dv(lh, 6, 0);
    u16dv(lh, 8, compMethod);
    u16dv(lh, 10, 0);
    u16dv(lh, 12, 0);
    u32dv(lh, 14, crc);
    u32dv(lh, 18, stored.length);
    u32dv(lh, 22, file.data.length);
    u16dv(lh, 26, nameBytes.length);
    u16dv(lh, 28, 0);
    lh.set(nameBytes, 30);

    parts.push(lh);
    parts.push(stored);

    // Central directory entry (46 bytes + name)
    const cd = new Uint8Array(46 + nameBytes.length);
    u32dv(cd, 0, 0x02014b50);
    u16dv(cd, 4, 20);
    u16dv(cd, 6, 20);
    u16dv(cd, 8, 0);
    u16dv(cd, 10, compMethod);
    u16dv(cd, 12, 0);
    u16dv(cd, 14, 0);
    u32dv(cd, 16, crc);
    u32dv(cd, 20, stored.length);
    u32dv(cd, 24, file.data.length);
    u16dv(cd, 28, nameBytes.length);
    u16dv(cd, 30, 0);
    u16dv(cd, 32, 0);
    u16dv(cd, 34, 0);
    u16dv(cd, 36, 0);
    u32dv(cd, 38, 0);
    u32dv(cd, 42, offset);
    cd.set(nameBytes, 46);
    centralDir.push(cd);

    offset += lh.length + stored.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDir) { parts.push(cd); cdSize += cd.length; }

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  u32dv(eocd, 0, 0x06054b50);
  u16dv(eocd, 4, 0);
  u16dv(eocd, 6, 0);
  u16dv(eocd, 8, files.length);
  u16dv(eocd, 10, files.length);
  u32dv(eocd, 12, cdSize);
  u32dv(eocd, 16, cdOffset);
  u16dv(eocd, 20, 0);
  parts.push(eocd);

  return new Blob(parts, { type: 'application/zip' });
}

export function generateCollisionFreeNames(partitions) {
  if (!Array.isArray(partitions)) return [];
  const counts = {};
  for (const p of partitions) {
    const base = (p && p.name ? p.name : 'partition').trim();
    counts[base] = (counts[base] || 0) + 1;
  }

  const used = new Set();
  const result = [];

  for (const p of partitions) {
    const base = (p && p.name ? p.name : 'partition').trim();
    let fileName;
    if (counts[base] === 1) {
      fileName = `${base}.bin`;
    } else {
      const tag = (p.vendorSource || p.ptType || 'dup').toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
      fileName = `${base}_${tag}.bin`;
      if (used.has(fileName)) {
        let idx = 1;
        while (used.has(`${base}_${tag}_${idx}.bin`)) idx++;
        fileName = `${base}_${tag}_${idx}.bin`;
      }
    }
    used.add(fileName);
    result.push({ partition: p, fileName });
  }

  return result;
}