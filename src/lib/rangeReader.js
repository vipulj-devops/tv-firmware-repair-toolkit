// Bounded range reader. 64-bit file positions use Number addition only.
// Misses issue exact File.slice(startByte+offset, startByte+offset+len) chunks
// capped at maxRead. A whole multi-GB partition is never arrayBuffer()'d.

export const DEFAULT_MAX_READ = 256 * 1024;
export const DEFAULT_CACHE_BLOCK = 4096;
export const DEFAULT_MAX_CACHE_BLOCKS = 256;

function assertSafeInt(n, label) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

export function createRangeReader({
  startByte,
  size,
  readAbsolute,
  maxRead = DEFAULT_MAX_READ,
  cacheBlockSize = DEFAULT_CACHE_BLOCK,
  maxCacheBlocks = DEFAULT_MAX_CACHE_BLOCKS,
} = {}) {
  assertSafeInt(startByte, 'startByte');
  assertSafeInt(size, 'size');
  if (startByte < 0 || size < 0) throw new Error('startByte/size must be >= 0');
  if (typeof readAbsolute !== 'function') throw new Error('readAbsolute is required');
  if (!Number.isSafeInteger(startByte + size)) {
    throw new Error('startByte + size exceeds Number.MAX_SAFE_INTEGER');
  }

  const cache = new Map();
  const lru = [];
  const stats = {
    slices: [],
    totalSliceBytes: 0,
    maxSliceLength: 0,
    fullPartitionSlices: 0,
  };

  function touch(key) {
    const i = lru.indexOf(key);
    if (i >= 0) lru.splice(i, 1);
    lru.push(key);
    while (lru.length > maxCacheBlocks) cache.delete(lru.shift());
  }

  async function sliceAbsolute(absStart, absEnd) {
    const len = absEnd - absStart;
    if (len > maxRead) throw new Error(`slice length ${len} exceeds maxRead ${maxRead}`);
    stats.slices.push({ absStart, absEnd, length: len });
    stats.totalSliceBytes += len;
    if (len > stats.maxSliceLength) stats.maxSliceLength = len;
    if (absStart === startByte && absEnd === startByte + size) stats.fullPartitionSlices += 1;
    const u8 = await readAbsolute(absStart, absEnd);
    return u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  }

  async function read(offset, length) {
    assertSafeInt(offset, 'offset');
    assertSafeInt(length, 'length');
    if (offset < 0 || length < 0) throw new Error('offset/length must be >= 0');
    if (offset + length > size) throw new Error('read past partition end');
    if (length === 0) return new Uint8Array(0);

    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const pos = offset + written;
      const blockIndex = Math.floor(pos / cacheBlockSize);
      const destOff = pos - blockIndex * cacheBlockSize;
      const cached = cache.get(blockIndex);
      if (cached && destOff < cached.length) {
        touch(blockIndex);
        const n = Math.min(cached.length - destOff, length - written);
        out.set(cached.subarray(destOff, destOff + n), written);
        written += n;
        continue;
      }
      const chunk = Math.min(maxRead, length - written);
      const data = await sliceAbsolute(startByte + pos, startByte + pos + chunk);
      out.set(data.subarray(0, chunk), written);
      if (destOff === 0 && chunk === Math.min(cacheBlockSize, size - pos)) {
        cache.set(blockIndex, data.subarray(0, chunk));
        touch(blockIndex);
      }
      written += chunk;
    }
    return out;
  }

  return { startByte, size, maxRead, read, stats };
}

export function createFileRangeReader(file, startByte, size, opts) {
  return createRangeReader({
    startByte,
    size,
    readAbsolute: async (absStart, absEnd) => {
      const buf = await file.slice(absStart, absEnd).arrayBuffer();
      return new Uint8Array(buf);
    },
    ...opts,
  });
}

export function createBufferRangeReader(bytes, opts) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return createRangeReader({
    startByte: 0,
    size: view.length,
    readAbsolute: async (absStart, absEnd) => view.subarray(absStart, absEnd),
    ...opts,
  });
}
