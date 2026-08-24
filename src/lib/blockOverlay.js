// Sparse copy-on-write overlay over a range-backed partition.
// Storage is 4096-byte slots; only written bytes override the base.
// File offsets use Number addition/multiplication only (no bitwise shifts).

export const OVERLAY_BLOCK_SIZE = 4096;
export const OVERLAY_DIRTY_LIMIT = 256 * 1024 * 1024;

export function overlayLimitError(limit = OVERLAY_DIRTY_LIMIT) {
  const miB = Math.round(limit / (1024 * 1024));
  const err = new Error(`This edit would use more than ${miB} MiB of in-memory changes. Split the work or use a smaller file.`);
  err.code = 'OVERLAY_LIMIT';
  return err;
}

function assertSafeInt(n, label) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

function assertRange(offset, length, label) {
  assertSafeInt(offset, `${label} offset`);
  assertSafeInt(length, `${label} length`);
  if (offset < 0 || length < 0) throw new Error(`${label} offset/length must be >= 0`);
  assertSafeInt(offset + length, `${label} end`);
}

function copyU8(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('bytes must be a Uint8Array');
  }
  return bytes;
}

function blockIndex(offset, blockSize) {
  return Math.floor(offset / blockSize);
}

function blockStart(index, blockSize) {
  return index * blockSize;
}

export function createBlockOverlay({ blockSize = OVERLAY_BLOCK_SIZE, maxDirtyBytes = OVERLAY_DIRTY_LIMIT } = {}) {
  assertSafeInt(blockSize, 'blockSize');
  if (blockSize <= 0) throw new Error('blockSize must be > 0');
  if (maxDirtyBytes != null) {
    assertSafeInt(maxDirtyBytes, 'maxDirtyBytes');
    if (maxDirtyBytes < 0) throw new Error('maxDirtyBytes must be >= 0');
  }

  const blocks = new Map();

  function currentDirtyBytes() {
    let n = 0;
    for (const slot of blocks.values()) {
      for (let i = 0; i < blockSize; i += 1) if (slot.valid[i]) n += 1;
    }
    return n;
  }

  function projectedDirtyBytes(writes) {
    const extraValid = new Map();
    function validAt(index) {
      if (!extraValid.has(index)) {
        const slot = blocks.get(index);
        extraValid.set(index, slot ? Uint8Array.from(slot.valid) : new Uint8Array(blockSize));
      }
      return extraValid.get(index);
    }
    let additional = 0;
    for (const w of writes) {
      const src = copyU8(w.bytes);
      assertRange(w.offset, src.length, 'write');
      let pos = 0;
      while (pos < src.length) {
        const abs = w.offset + pos;
        const index = blockIndex(abs, blockSize);
        const local = abs - blockStart(index, blockSize);
        const n = Math.min(blockSize - local, src.length - pos);
        const valid = validAt(index);
        for (let i = 0; i < n; i += 1) {
          if (!valid[local + i]) {
            valid[local + i] = 1;
            additional += 1;
          }
        }
        pos += n;
      }
    }
    return currentDirtyBytes() + additional;
  }

  function getOrCreateBlock(index) {
    let slot = blocks.get(index);
    if (!slot) {
      slot = {
        data: new Uint8Array(blockSize),
        valid: new Uint8Array(blockSize),
      };
      blocks.set(index, slot);
    }
    return slot;
  }

  function writeUnchecked(offset, bytes) {
    const src = copyU8(bytes);
    assertRange(offset, src.length, 'write');
    if (src.length === 0) return;
    let pos = 0;
    while (pos < src.length) {
      const abs = offset + pos;
      const index = blockIndex(abs, blockSize);
      const local = abs - blockStart(index, blockSize);
      const n = Math.min(blockSize - local, src.length - pos);
      const slot = getOrCreateBlock(index);
      slot.data.set(src.subarray(pos, pos + n), local);
      slot.valid.fill(1, local, local + n);
      pos += n;
    }
  }

  function assertWithinLimit(writes) {
    if (maxDirtyBytes == null) return;
    if (projectedDirtyBytes(writes) > maxDirtyBytes) throw overlayLimitError(maxDirtyBytes);
  }

  function write(offset, bytes) {
    const src = copyU8(bytes);
    assertWithinLimit([{ offset, bytes: src }]);
    writeUnchecked(offset, src);
  }

  function writeAll(writes) {
    const list = (writes || []).map((w) => ({ offset: w.offset, bytes: copyU8(w.bytes) }));
    assertWithinLimit(list);
    for (const w of list) writeUnchecked(w.offset, w.bytes);
  }

  function readInto(dest, destOff, viewOffset, length) {
    if (!(dest instanceof Uint8Array)) throw new Error('dest must be a Uint8Array');
    assertRange(viewOffset, length, 'readInto');
    assertSafeInt(destOff, 'destOff');
    if (destOff < 0) throw new Error('destOff must be >= 0');
    if (destOff + length > dest.length) throw new Error('readInto past dest end');
    if (length === 0 || blocks.size === 0) return;

    const viewEnd = viewOffset + length;
    const first = blockIndex(viewOffset, blockSize);
    const last = blockIndex(viewEnd - 1, blockSize);
    for (let index = first; index <= last; index += 1) {
      const slot = blocks.get(index);
      if (!slot) continue;
      const absBlock = blockStart(index, blockSize);
      for (let local = 0; local < blockSize; local += 1) {
        if (!slot.valid[local]) continue;
        const abs = absBlock + local;
        if (abs < viewOffset || abs >= viewEnd) continue;
        dest[destOff + (abs - viewOffset)] = slot.data[local];
      }
    }
  }

  function sortedSpans() {
    const indexes = [...blocks.keys()].sort((a, b) => a - b);
    const spans = [];
    for (const index of indexes) {
      const slot = blocks.get(index);
      const absBlock = blockStart(index, blockSize);
      let runLocal = -1;
      for (let local = 0; local <= blockSize; local += 1) {
        const on = local < blockSize && slot.valid[local];
        if (on) {
          if (runLocal < 0) runLocal = local;
          continue;
        }
        if (runLocal < 0) continue;
        const offset = absBlock + runLocal;
        const data = slot.data.slice(runLocal, local);
        const last = spans[spans.length - 1];
        if (last && last.offset + last.data.length === offset) {
          const merged = new Uint8Array(last.data.length + data.length);
          merged.set(last.data, 0);
          merged.set(data, last.data.length);
          last.data = merged;
        } else {
          spans.push({ offset, data });
        }
        runLocal = -1;
      }
    }
    return spans;
  }

  function clear() {
    blocks.clear();
  }

  function hasWrites() {
    return stats.bytes > 0;
  }

  const stats = {
    get blockSize() { return blockSize; },
    get blocks() { return blocks.size; },
    get bytes() {
      let n = 0;
      for (const slot of blocks.values()) {
        for (let i = 0; i < blockSize; i += 1) if (slot.valid[i]) n += 1;
      }
      return n;
    },
    get maxOffset() {
      let max = -1;
      for (const [index, slot] of blocks) {
        const absBlock = blockStart(index, blockSize);
        for (let local = 0; local < blockSize; local += 1) {
          if (slot.valid[local] && absBlock + local > max) max = absBlock + local;
        }
      }
      return max;
    },
  };

  return { blockSize, maxDirtyBytes, write, writeAll, readInto, sortedSpans, clear, hasWrites, stats };
}

export function wrapReader(baseReader, overlay) {
  if (!baseReader || typeof baseReader.read !== 'function') {
    throw new Error('baseReader.read is required');
  }
  if (!overlay || typeof overlay.write !== 'function' || typeof overlay.readInto !== 'function') {
    throw new Error('overlay is required');
  }

  async function read(offset, length) {
    const base = await baseReader.read(offset, length);
    const dest = new Uint8Array(length);
    dest.set(base instanceof Uint8Array ? base.subarray(0, length) : new Uint8Array(base).subarray(0, length));
    overlay.readInto(dest, 0, offset, length);
    return dest;
  }

  async function write(offset, bytes) {
    const src = copyU8(bytes);
    assertRange(offset, src.length, 'write');
    if (typeof baseReader.size === 'number' && offset + src.length > baseReader.size) {
      throw new Error('write past partition end');
    }
    overlay.write(offset, src);
  }

  async function writeAll(writes) {
    const list = writes || [];
    for (const w of list) {
      assertRange(w.offset, w.bytes.length, 'write');
      if (typeof baseReader.size === 'number' && w.offset + w.bytes.length > baseReader.size) {
        throw new Error('write past partition end');
      }
    }
    if (typeof overlay.writeAll === 'function') overlay.writeAll(list);
    else for (const w of list) overlay.write(w.offset, w.bytes);
  }

  return {
    startByte: baseReader.startByte,
    size: baseReader.size,
    maxRead: baseReader.maxRead,
    stats: baseReader.stats,
    overlay,
    read,
    write,
    writeAll,
  };
}

export function composeOverlayParts(startByte, size, overlay) {
  assertSafeInt(startByte, 'startByte');
  assertSafeInt(size, 'size');
  if (startByte < 0 || size < 0) throw new Error('startByte/size must be >= 0');
  assertSafeInt(startByte + size, 'startByte + size');

  const parts = [];
  let cursor = 0;
  for (const span of overlay.sortedSpans()) {
    assertSafeInt(span.offset, 'span.offset');
    assertSafeInt(span.data.length, 'span.length');
    const end = span.offset + span.data.length;
    if (span.offset < 0 || end > size) {
      throw new Error('overlay span is outside the partition');
    }
    if (span.offset > cursor) {
      parts.push({
        kind: 'slice',
        start: startByte + cursor,
        end: startByte + span.offset,
      });
    }
    parts.push({ kind: 'bytes', data: span.data });
    cursor = end;
  }
  if (cursor < size) {
    parts.push({
      kind: 'slice',
      start: startByte + cursor,
      end: startByte + size,
    });
  }
  return parts;
}

export function composeOverlayBlob(file, startByte, size, overlay) {
  if (!file || typeof file.slice !== 'function') {
    throw new Error('file.slice is required');
  }
  const blobParts = composeOverlayParts(startByte, size, overlay).map((part) => {
    if (part.kind === 'slice') return file.slice(part.start, part.end);
    return part.data;
  });
  return new Blob(blobParts, { type: 'application/octet-stream' });
}
