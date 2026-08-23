// Independent filesystem / container signature scan.
// Does not create partitions, set ptType, or participate in selectDumpParts.
// Callers pass an already-loaded prefix (e.g. the eMMC 128 MiB head) so this
// never reads a multi-GB dump in one piece.

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

const HSQS = [0x68, 0x73, 0x71, 0x73]; // "hsqs"
const EXT_MAGIC = 0xef53;
const SQUASH_HDR = 96;

function indexOfBytes(buf, sig, from) {
  const last = buf.length - sig.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (buf[i + j] !== sig[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function overlaps(hits, offset, size) {
  const end = offset + size;
  return hits.some((h) => offset < h.offset + (h.size || 1) && h.offset < end);
}

function parseSquashfs(bytes, offset, fileSize) {
  if (offset + SQUASH_HDR > bytes.length) return null;
  const inodes = u32(bytes, offset + 4);
  const blockSize = u32(bytes, offset + 12);
  const compression = u16(bytes, offset + 20);
  const blockLog = u16(bytes, offset + 22);
  const major = u16(bytes, offset + 28);
  const minor = u16(bytes, offset + 30);
  const bytesUsed = u64(bytes, offset + 40);
  if (major < 1 || major > 4) return null;
  if (inodes < 1 || inodes > 50_000_000) return null;
  if (compression < 1 || compression > 6) return null;
  if (blockLog < 12 || blockLog > 20) return null;
  if (blockSize !== (1 << blockLog)) return null;
  if (blockSize < 4096 || blockSize > 1048576) return null;
  if (bytesUsed < SQUASH_HDR) return null;
  if (fileSize && offset + bytesUsed > fileSize) return null;
  return {
    type: 'squashfs',
    offset,
    size: bytesUsed,
    version: `${major}.${minor}`,
    blockSize,
    inodes,
  };
}

function parseExt4At(bytes, fsStart, fileSize) {
  if (fsStart < 0 || fsStart + 2048 > bytes.length) return null;
  if (fsStart % 512 !== 0) return null;
  const sb = fsStart + 1024;
  if (u16(bytes, sb + 0x38) !== EXT_MAGIC) return null;
  const logBlockSize = u32(bytes, sb + 0x18);
  if (logBlockSize > 6) return null;
  const blockSize = 1024 << logBlockSize;
  const blocksLo = u32(bytes, sb + 0x04);
  const blocksHi = u32(bytes, sb + 0x150);
  const blocksCount = blocksLo + blocksHi * 0x100000000;
  const blocksPerGroup = u32(bytes, sb + 0x20);
  const inodesPerGroup = u32(bytes, sb + 0x28);
  const firstDataBlock = u32(bytes, sb + 0x14);
  const inodeSize = u16(bytes, sb + 0x58) || 128;
  const revLevel = u32(bytes, sb + 0x4c);
  if (blocksCount < 2 || !Number.isFinite(blocksCount)) return null;
  if (blocksPerGroup < 1 || blocksPerGroup > 0x80000) return null;
  if (inodesPerGroup < 1 || inodesPerGroup > 0x80000) return null;
  if (firstDataBlock > 1) return null;
  if (revLevel > 1) return null;
  if (![128, 256, 512, 1024].includes(inodeSize)) return null;
  const size = blocksCount * blockSize;
  if (size < 2048) return null;
  if (fileSize && fsStart + Math.min(size, 2048) > fileSize && fsStart >= fileSize) return null;
  return {
    type: 'ext4',
    offset: fsStart,
    size,
    blockSize,
    blocksCount,
  };
}

function findSquashfs(bytes, fileSize, hits) {
  let from = 0;
  while (from + SQUASH_HDR <= bytes.length) {
    const i = indexOfBytes(bytes, HSQS, from);
    if (i < 0) break;
    const rec = parseSquashfs(bytes, i, fileSize);
    if (rec && !overlaps(hits, rec.offset, rec.size)) hits.push(rec);
    from = i + 4;
  }
}

function findExt4(bytes, fileSize, hits) {
  const needle = [0x53, 0xef];
  let from = 0;
  while (from + 2 <= bytes.length) {
    const i = indexOfBytes(bytes, needle, from);
    if (i < 0) break;
    if ((i % 512) === 56) {
      const rec = parseExt4At(bytes, i - 1080, fileSize);
      if (rec && !overlaps(hits, rec.offset, Math.min(rec.size, 0x100000))) hits.push(rec);
    }
    from = i + 2;
  }
}

export function scanFilesystems(bytes, fileSize = 0) {
  if (!bytes || !bytes.length) return [];
  const limit = fileSize || bytes.length;
  const hits = [];
  findSquashfs(bytes, limit, hits);
  findExt4(bytes, limit, hits);
  hits.sort((a, b) => a.offset - b.offset);
  return hits;
}
