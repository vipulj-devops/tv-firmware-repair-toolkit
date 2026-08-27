const SECTOR = 512;
const SIZE_CAP = 0x1000000000;
const NAME_RE = /^[\w.\-]{1,32}$/;
const PREFIX = 'mtdparts=';

function isForbiddenDevice(id) {
  const d = String(id).toLowerCase();
  if (d.includes('nand') || d.includes('onenand')) return true;
  if (d.includes('spi')) return true;
  if (/(^|[_\-.])nor($|[_\-.\d])/.test(d) || d === 'nor' || d.startsWith('nor')) return true;
  return false;
}

function isEmmcDevice(id) {
  if (!id || isForbiddenDevice(id)) return false;
  const d = String(id).toLowerCase();
  return d.includes('emmc') || d.includes('mmc');
}

function parseSizeToken(tok) {
  if (tok == null) return null;
  const s = String(tok);
  if (s === '-') return -1;
  if (/^0x[0-9a-f]+$/i.test(s)) {
    const n = parseInt(s, 16);
    if (!Number.isSafeInteger(n) || n < 0 || n > SIZE_CAP) return null;
    return n;
  }
  const m = s.match(/^(\d+)([KMG]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  const u = (m[2] || '').toUpperCase();
  const mul = u === 'K' ? 1024 : u === 'M' ? 1048576 : u === 'G' ? 1073741824 : 1;
  const size = n * mul;
  if (!Number.isFinite(size) || size > SIZE_CAP) return null;
  return size;
}

function extractMtdpartsBody(bytes, specOff) {
  const start = specOff + PREFIX.length;
  if (start >= bytes.length) return '';
  let end = start;
  while (end < bytes.length) {
    const c = bytes[end];
    if (c === 0 || c === 32 || c === 9 || c === 10 || c === 13 || c === 34) break;
    end++;
  }
  if (end <= start) return '';
  return new TextDecoder('latin1').decode(bytes.subarray(start, end));
}

function parseMtdpartsEntries(spec, fileSize) {
  if (!spec || !fileSize) return null;
  const tokens = spec.split(',');
  if (!tokens.length) return null;
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const m = tok.match(/^((?:0x[0-9a-f]+|\d+[KMG]?|-))(?:@((?:0x[0-9a-f]+|\d+[KMG]?)))?\(([^)]+)\)(ro|enc|roenc|encro)?$/i);
    if (!m) return null;
    const name = m[3];
    if (!NAME_RE.test(name)) return null;
    const attr = (m[4] || '').toLowerCase();
    const ro = attr.includes('ro');
    const sizeTok = parseSizeToken(m[1]);
    if (sizeTok == null) return null;
    if (m[2] != null) {
      const abs = parseSizeToken(m[2]);
      if (abs == null || abs !== cursor) return null;
    }
    let declaredSize;
    if (sizeTok < 0) {
      if (i !== tokens.length - 1) return null;
      declaredSize = fileSize - cursor;
      if (declaredSize <= 0) return null;
    } else {
      declaredSize = sizeTok;
    }
    if (cursor < 0 || declaredSize <= 0) return null;
    if (cursor % SECTOR !== 0 || declaredSize % SECTOR !== 0) return null;

    const availableSize = Math.max(0, Math.min(declaredSize, fileSize - cursor));
    const truncated = cursor < fileSize && cursor + declaredSize > fileSize;
    const unavailable = cursor >= fileSize;

    parts.push({
      name,
      offset: cursor,
      size: declaredSize,
      declaredSize,
      availableSize,
      truncated,
      unavailable,
      ro,
    });
    cursor += declaredSize;
  }
  if (!parts.length) return null;
  return parts;
}

function parseMtdpartsBody(body, fileSize) {
  if (!body || !fileSize) return null;
  const segments = body.split(';');
  for (const seg of segments) {
    const colon = seg.indexOf(':');
    if (colon <= 0) continue;
    const device = seg.slice(0, colon);
    const spec = seg.slice(colon + 1);
    if (!isEmmcDevice(device)) continue;
    if (!spec) continue;
    const parts = parseMtdpartsEntries(spec, fileSize);
    if (parts) return parts;
  }
  return null;
}

export function findMtdpartsEmmc(bytes, fileSize) {
  if (!bytes || !fileSize) return -1;
  const text = new TextDecoder('latin1').decode(bytes);
  const lower = text.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const i = lower.indexOf(PREFIX, from);
    if (i < 0) return -1;
    if (parseMtdpartsBody(extractMtdpartsBody(bytes, i), fileSize)) return i;
    from = i + PREFIX.length;
  }
  return -1;
}

export function isMtdpartsEmmc(bytes, fileSize) {
  return findMtdpartsEmmc(bytes, fileSize) >= 0;
}

export function parseMtdpartsEmmc(bytes, fileSize) {
  const off = findMtdpartsEmmc(bytes, fileSize);
  if (off < 0) return [];
  return parseMtdpartsBody(extractMtdpartsBody(bytes, off), fileSize) || [];
}

export const mtdpartsEmmcFormat = {
  id: 'mtdparts_emmc',
  soc: 'linux',
  detect(bytes, fileSize) {
    const off = findMtdpartsEmmc(bytes, fileSize);
    if (off < 0) return null;
    return { marker: `mtdparts= @0x${off.toString(16)}` };
  },
  parse: parseMtdpartsEmmc,
};
