export function findBlkdevpartsMmc(bytes, fileSize) {
  if (!bytes || !fileSize) return -1;
  const prefix = 'blkdevparts=mmcblk0:';
  const text = new TextDecoder('latin1').decode(bytes);
  const lower = text.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const i = lower.indexOf(prefix, from);
    if (i < 0) return -1;
    if (parseBlkdevpartsBody(extractBlkdevpartsBody(bytes, i), fileSize)) return i;
    from = i + prefix.length;
  }
  return -1;
}

export function isBlkdevpartsMmc(bytes, fileSize) {
  return findBlkdevpartsMmc(bytes, fileSize) >= 0;
}

function extractBlkdevpartsBody(bytes, specOff) {
  const prefixLen = 'blkdevparts=mmcblk0:'.length;
  let end = specOff + prefixLen;
  while (end < bytes.length) {
    const c = bytes[end];
    if (c === 0 || c === 32 || c === 9 || c === 10 || c === 13 || c === 34) break;
    end++;
  }
  if (end <= specOff + prefixLen) return '';
  return new TextDecoder('latin1').decode(bytes.subarray(specOff + prefixLen, end));
}

function parseBlkdevpartsSizeToken(tok) {
  if (tok === '-') return -1;
  const m = String(tok).match(/^(\d+)([KMG]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const u = (m[2] || '').toUpperCase();
  const mul = u === 'K' ? 1024 : u === 'M' ? 1048576 : u === 'G' ? 1073741824 : 1;
  const size = n * mul;
  if (!Number.isFinite(size) || size > 0x1000000000) return null;
  return size;
}

const BLKDEV_NAME_RE = /^[\w.\-]{1,32}$/;

// Strict parse of the comma-separated mmcblk0 body. Returns null unless every
// entry is valid and the map ends exactly at fileSize (remainder `-` required
// to consume the rest; no partial tables).
function parseBlkdevpartsBody(body, fileSize) {
  if (!body || !fileSize) return null;
  const tokens = body.split(',');
  if (!tokens.length) return null;
  const parts = [];
  let offset = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const m = tok.match(/^(\d+[KMG]?|-)\(([^)]+)\)(ro)?$/i);
    if (!m) return null;
    const name = m[2];
    if (!BLKDEV_NAME_RE.test(name)) return null;
    const ro = (m[3] || '').toLowerCase() === 'ro';
    const sizeTok = parseBlkdevpartsSizeToken(m[1]);
    if (sizeTok == null) return null;
    let size;
    if (sizeTok < 0) {
      if (i !== tokens.length - 1) return null;
      size = fileSize - offset;
      if (size <= 0) return null;
    } else {
      size = sizeTok;
    }
    if (offset < 0 || size <= 0) return null;
    if (offset + size > fileSize) return null;
    parts.push({ name, offset, size, ro });
    offset += size;
  }
  if (!parts.length) return null;
  if (offset !== fileSize) return null;
  return parts;
}

export function parseBlkdevpartsMmc(bytes, fileSize) {
  const off = findBlkdevpartsMmc(bytes, fileSize);
  if (off < 0) return [];
  return parseBlkdevpartsBody(extractBlkdevpartsBody(bytes, off), fileSize) || [];
}

export const blkdevpartsMmcFormat = {
  id: 'blkdevparts_mmc',
  soc: 'linux',
  detect(bytes, fileSize) {
    const off = findBlkdevpartsMmc(bytes, fileSize);
    if (off < 0) return null;
    return { marker: `blkdevparts=mmcblk0 @0x${off.toString(16)}` };
  },
  parse: parseBlkdevpartsMmc,
};
