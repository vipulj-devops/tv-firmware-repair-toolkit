import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRangeReader } from '../src/lib/rangeReader.js';
import {
  OVERLAY_BLOCK_SIZE,
  createBlockOverlay,
  wrapReader,
  composeOverlayParts,
  composeOverlayBlob,
} from '../src/lib/blockOverlay.js';

function fillBytes(len, fn) {
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) u8[i] = fn(i) & 0xff;
  return u8;
}

describe('block overlay', () => {
  it('writes then reads the modified bytes (read-after-write)', () => {
    const overlay = createBlockOverlay();
    overlay.write(100, new Uint8Array([1, 2, 3]));
    const dest = new Uint8Array([9, 9, 9, 9, 9]);
    overlay.readInto(dest, 0, 99, 5);
    assert.deepEqual([...dest], [9, 1, 2, 3, 9]);
  });

  it('partial block writes do not invent zeros for unwritten bytes', () => {
    const overlay = createBlockOverlay();
    overlay.write(10, new Uint8Array([0xaa, 0xbb]));
    const dest = fillBytes(20, (i) => i);
    overlay.readInto(dest, 0, 0, 20);
    assert.equal(dest[9], 9);
    assert.equal(dest[10], 0xaa);
    assert.equal(dest[11], 0xbb);
    assert.equal(dest[12], 12);
  });

  it('applies multiple overlapping and disjoint writes', () => {
    const overlay = createBlockOverlay();
    overlay.write(0, new Uint8Array([1, 1, 1, 1]));
    overlay.write(2, new Uint8Array([2, 2]));
    overlay.write(OVERLAY_BLOCK_SIZE - 1, new Uint8Array([8, 9, 10]));
    const dest = new Uint8Array(OVERLAY_BLOCK_SIZE + 4);
    dest.fill(0xcc);
    overlay.readInto(dest, 0, 0, dest.length);
    assert.deepEqual([...dest.subarray(0, 4)], [1, 1, 2, 2]);
    assert.equal(dest[OVERLAY_BLOCK_SIZE - 1], 8);
    assert.equal(dest[OVERLAY_BLOCK_SIZE], 9);
    assert.equal(dest[OVERLAY_BLOCK_SIZE + 1], 10);
    assert.equal(dest[OVERLAY_BLOCK_SIZE + 2], 0xcc);
  });

  it('coalesces adjacent spans across overlay block boundaries', () => {
    const overlay = createBlockOverlay();
    overlay.write(OVERLAY_BLOCK_SIZE - 2, new Uint8Array([1, 2, 3, 4]));
    const spans = overlay.sortedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].offset, OVERLAY_BLOCK_SIZE - 2);
    assert.deepEqual([...spans[0].data], [1, 2, 3, 4]);
  });

  it('does not coalesce spans separated by a hole', () => {
    const overlay = createBlockOverlay();
    overlay.write(0, new Uint8Array([1]));
    overlay.write(2, new Uint8Array([2]));
    const spans = overlay.sortedSpans();
    assert.equal(spans.length, 2);
    assert.equal(spans[0].offset, 0);
    assert.equal(spans[1].offset, 2);
  });

  it('copies write input so later mutation does not change the overlay', () => {
    const overlay = createBlockOverlay();
    const src = new Uint8Array([5, 6]);
    overlay.write(0, src);
    src[0] = 99;
    const dest = new Uint8Array(2);
    overlay.readInto(dest, 0, 0, 2);
    assert.deepEqual([...dest], [5, 6]);
  });

  it('clear and stats track sparse dirty bytes', () => {
    const overlay = createBlockOverlay();
    assert.equal(overlay.hasWrites(), false);
    overlay.write(OVERLAY_BLOCK_SIZE - 1, new Uint8Array([1, 2, 3]));
    assert.equal(overlay.hasWrites(), true);
    assert.equal(overlay.stats.blockSize, OVERLAY_BLOCK_SIZE);
    assert.equal(overlay.stats.blocks, 2);
    assert.equal(overlay.stats.bytes, 3);
    assert.equal(overlay.stats.maxOffset, OVERLAY_BLOCK_SIZE + 1);
    overlay.clear();
    assert.equal(overlay.hasWrites(), false);
    assert.equal(overlay.stats.blocks, 0);
    assert.equal(overlay.stats.bytes, 0);
    assert.equal(overlay.stats.maxOffset, -1);
    assert.deepEqual(overlay.sortedSpans(), []);
  });
});

describe('wrapReader overlay merge', () => {
  it('returns overlay bytes where present and base bytes in holes', async () => {
    const base = fillBytes(8192, (i) => (i + 7) & 0xff);
    const reader = createRangeReader({
      startByte: 0,
      size: base.length,
      readAbsolute: async (a, b) => base.subarray(a, b),
    });
    const overlay = createBlockOverlay();
    const io = wrapReader(reader, overlay);
    await io.write(100, new Uint8Array([0xde, 0xad]));
    const got = await io.read(98, 6);
    assert.deepEqual([...got], [base[98], base[99], 0xde, 0xad, base[102], base[103]]);
  });

  it('does not mutate the base buffer', async () => {
    const base = fillBytes(4096, () => 0x11);
    const snapshot = Uint8Array.from(base);
    const reader = createRangeReader({
      startByte: 0,
      size: base.length,
      readAbsolute: async (a, b) => base.subarray(a, b),
    });
    const overlay = createBlockOverlay();
    const io = wrapReader(reader, overlay);
    await io.write(0, new Uint8Array([0xff]));
    await io.read(0, 16);
    assert.deepEqual(base, snapshot);
  });
});

describe('overlay offsets beyond 4 GiB', () => {
  it('stores and reads a write at 0x100000000', () => {
    const offset = 0x100000000;
    const overlay = createBlockOverlay();
    overlay.write(offset, new Uint8Array([0xab, 0xcd]));
    const dest = new Uint8Array([0, 0, 0, 0]);
    overlay.readInto(dest, 0, offset - 1, 4);
    assert.deepEqual([...dest], [0, 0xab, 0xcd, 0]);
    assert.equal(overlay.stats.maxOffset, offset + 1);
    assert.equal(overlay.sortedSpans()[0].offset, offset);
  });

  it('composeOverlayParts uses Number addition for absolute dump ranges', () => {
    const startByte = 0x100000000;
    const size = 8192;
    const overlay = createBlockOverlay();
    overlay.write(16, new Uint8Array([9, 8]));
    const parts = composeOverlayParts(startByte, size, overlay);
    assert.deepEqual(
      parts.filter((p) => p.kind === 'slice').map((p) => [p.start, p.end]),
      [
        [startByte, startByte + 16],
        [startByte + 18, startByte + size],
      ],
    );
    assert.equal(parts[0].start > 0xffffffff, true);
    assert.equal(parts[0].end > 0xffffffff, true);
  });

  it('wrapReader read-after-write works with startByte above 4 GiB', async () => {
    const startByte = 0x100000000;
    const image = fillBytes(4096, (i) => i & 0xff);
    const reader = createRangeReader({
      startByte,
      size: image.length,
      readAbsolute: async (a, b) => {
        const rel = a - startByte;
        return image.subarray(rel, rel + (b - a));
      },
    });
    const overlay = createBlockOverlay();
    const io = wrapReader(reader, overlay);
    await io.write(8, new Uint8Array([0xee]));
    const got = await io.read(7, 3);
    assert.deepEqual([...got], [7, 0xee, 9]);
  });
});

describe('Blob composition', () => {
  it('inserts overlay bytes and leaves the original File backing unchanged', async () => {
    const backing = fillBytes(64, (i) => 0xa0 + (i & 0x0f));
    const original = Uint8Array.from(backing);
    const slices = [];
    const file = {
      slice(start, end) {
        slices.push([start, end, end - start]);
        return backing.subarray(start, end);
      },
    };
    const overlay = createBlockOverlay();
    overlay.write(10, new Uint8Array([1, 2, 3]));
    const blob = composeOverlayBlob(file, 0, backing.length, overlay);
    const out = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...out.subarray(10, 13)], [1, 2, 3]);
    assert.equal(out[9], original[9]);
    assert.equal(out[13], original[13]);
    assert.deepEqual(backing, original);
    assert.equal(slices.some((s) => s[2] === backing.length), false);
  });

  it('never arrayBuffer()s an entire multi-GB partition', async () => {
    const size = 5 * 1024 * 1024 * 1024;
    const startByte = 0x161500000;
    let wholeArrayBuffer = false;
    const slices = [];
    const file = {
      slice(start, end) {
        const len = end - start;
        slices.push(len);
        if (len === size) {
          return {
            arrayBuffer: async () => {
              wholeArrayBuffer = true;
              throw new Error('must not arrayBuffer the whole partition');
            },
          };
        }
        return new Uint8Array(Math.min(len, 16));
      },
    };
    const overlay = createBlockOverlay();
    overlay.write(100, new Uint8Array([7, 7]));
    const parts = composeOverlayParts(startByte, size, overlay);
    assert.equal(parts.some((p) => p.kind === 'slice' && p.end - p.start === size), false);
    composeOverlayBlob(file, startByte, size, overlay);
    assert.equal(wholeArrayBuffer, false);
    assert.equal(slices.some((len) => len === size), false);
    assert.equal(slices.reduce((a, b) => a + b, 0) < size, true);
  });
});
