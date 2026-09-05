import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isExt4, parseSuperblock, listFiles, readFileBytes, patchFile, computeInPlacePatch } from '../src/lib/ext4.js';
import { createBufferRangeReader } from '../src/lib/rangeReader.js';
import { createBlockOverlay, wrapReader, composeOverlayParts } from '../src/lib/blockOverlay.js';
import { readFileBytesRange } from '../src/lib/ext4Range.js';
import { patchExistingFileIo } from '../src/lib/ext4PatchIo.js';

function wu16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wu32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function buildMinimalExt4() {
  const blockSize = 1024;
  const bytes = new Uint8Array(16 * blockSize);
  const sb = 1024;
  wu32(bytes, sb + 0x00, 16);
  wu32(bytes, sb + 0x04, 16);
  wu32(bytes, sb + 0x0C, 6);
  wu32(bytes, sb + 0x10, 13);
  wu32(bytes, sb + 0x14, 1);
  wu32(bytes, sb + 0x18, 0);
  wu32(bytes, sb + 0x20, 16);
  wu32(bytes, sb + 0x28, 16);
  wu16(bytes, sb + 0x38, 0xef53);
  wu32(bytes, sb + 0x4c, 1);
  wu16(bytes, sb + 0x58, 128);
  wu16(bytes, sb + 0xfe, 32);

  const gdt = 2048;
  wu32(bytes, gdt + 0x00, 3);
  wu32(bytes, gdt + 0x04, 4);
  wu32(bytes, gdt + 0x08, 5);
  wu16(bytes, gdt + 0x0C, 6);
  wu16(bytes, gdt + 0x0E, 13);

  function writeInode(num, { mode, size, physBlock }) {
    const off = 5 * blockSize + (num - 1) * 128;
    wu16(bytes, off + 0x00, mode);
    wu32(bytes, off + 0x04, size);
    wu32(bytes, off + 0x20, 0x80000);
    const eh = off + 0x28;
    wu16(bytes, eh + 0, 0xf30a);
    wu16(bytes, eh + 2, 1);
    wu16(bytes, eh + 4, 4);
    wu16(bytes, eh + 6, 0);
    wu32(bytes, eh + 12, 0);
    wu16(bytes, eh + 16, 1);
    wu16(bytes, eh + 18, 0);
    wu32(bytes, eh + 20, physBlock);
  }

  writeInode(2, { mode: 0x41ed, size: blockSize, physBlock: 8 });
  writeInode(12, { mode: 0x81a4, size: 6, physBlock: 9 });

  const dir = 8 * blockSize;
  function dirent(off, inode, recLen, name, typ) {
    wu32(bytes, off, inode);
    wu16(bytes, off + 4, recLen);
    bytes[off + 6] = name.length;
    bytes[off + 7] = typ;
    for (let i = 0; i < name.length; i++) bytes[off + 8 + i] = name.charCodeAt(i);
  }
  dirent(dir, 2, 12, '.', 2);
  dirent(dir + 12, 2, 12, '..', 2);
  dirent(dir + 24, 12, 1024 - 24, 'hello.txt', 1);
  bytes.set(Buffer.from('hello\n', 'ascii'), 9 * blockSize);
  return bytes;
}

function inode12Offset() {
  return 5 * 1024 + 11 * 128;
}

function overlayIoFor(image) {
  const overlay = createBlockOverlay();
  const base = createBufferRangeReader(image);
  return { overlay, io: wrapReader(base, overlay), sb: parseSuperblock(image) };
}

function recordingIo(image) {
  const { overlay, io, sb } = overlayIoFor(image);
  const writes = [];
  const innerWrite = io.write.bind(io);
  io.write = async (offset, bytes) => {
    writes.push({ offset, length: bytes.length });
    return innerWrite(offset, bytes);
  };
  const innerWriteAll = io.writeAll.bind(io);
  io.writeAll = async (list) => {
    for (const w of (list || [])) writes.push({ offset: w.offset, length: w.bytes.length });
    return innerWriteAll(list);
  };
  return { overlay, io, sb, writes };
}

function buildThreeBlockFile() {
  const bytes = buildMinimalExt4();
  const off = inode12Offset();
  wu16(bytes, off + 0x28 + 16, 3);
  wu32(bytes, off + 0x04, 2000);
  bytes.fill(0xaa, 9 * 1024, 12 * 1024);
  return bytes;
}

describe('patchFile Uint8Array (existing small-partition path)', () => {
  it('replaces hello.txt within allocated extents', () => {
    const bytes = buildMinimalExt4();
    const sb = parseSuperblock(bytes);
    assert.equal(isExt4(bytes), true);
    const hello = listFiles(bytes, sb).find((f) => f.path.endsWith('hello.txt'));
    const res = patchFile(bytes, hello.inode, sb, 'hi\n');
    assert.equal(res.newSize, 3);
    assert.equal(res.allocatedSpace, 1024);
    assert.equal(Buffer.from(readFileBytes(bytes, hello.inode, sb)).toString('ascii'), 'hi\n');
  });

  it('grows within already allocated extents and updates i_size_lo', () => {
    const bytes = buildMinimalExt4();
    const sb = parseSuperblock(bytes);
    const off = inode12Offset();
    const res = patchFile(bytes, 12, sb, 'abcdefghij');
    assert.equal(res.origSize, 6);
    assert.equal(res.newSize, 10);
    assert.equal(u32(bytes, off + 0x04), 10);
    assert.equal(u32(bytes, off + 0x6C), 0);
    assert.equal(Buffer.from(readFileBytes(bytes, 12, sb)).toString('ascii'), 'abcdefghij');
  });

  it('shrinks an existing file and zero-pads unused allocated space', () => {
    const bytes = buildMinimalExt4();
    const sb = parseSuperblock(bytes);
    patchFile(bytes, 12, sb, 'z');
    assert.equal(Buffer.from(readFileBytes(bytes, 12, sb)).toString('ascii'), 'z');
    assert.equal(bytes[9 * 1024 + 1], 0);
  });

  it('rejects content larger than allocated extents', () => {
    const bytes = buildMinimalExt4();
    const sb = parseSuperblock(bytes);
    assert.throws(
      () => patchFile(bytes, 12, sb, new Uint8Array(1025)),
      /exceeds allocated block space/,
    );
  });

  it('rejects a directory inode', () => {
    const bytes = buildMinimalExt4();
    const sb = parseSuperblock(bytes);
    assert.throws(() => patchFile(bytes, 2, sb, 'x'), /Not a regular file/);
  });
});

describe('computeInPlacePatch shared planner', () => {
  it('rejects unsupported layouts with no extents', () => {
    assert.throws(
      () => computeInPlacePatch({
        extents: [],
        blockSize: 1024,
        inodeOffset: 100,
        origSize: 1,
        newContent: new Uint8Array([1]),
      }),
      /unsupported layout/,
    );
  });

  it('emits physical writes above 4 GiB without wrapping', () => {
    const physical = Math.floor(0x100000000 / 1024);
    const plan = computeInPlacePatch({
      extents: [{ logical: 0, physical, len: 1 }],
      blockSize: 1024,
      inodeOffset: 50,
      origSize: 4,
      newContent: new Uint8Array([9, 8, 7, 6]),
    });
    assert.equal(plan.writes[0].offset, 0x100000000);
    assert.equal(plan.writes[0].offset > 0xffffffff, true);
    assert.equal(plan.allocatedSpace, 1024);
  });

  it('writes both i_size_lo and i_size_high when size changes across 4 GiB', () => {
    const origSize = 0x100000000 + 20;
    const plan = computeInPlacePatch({
      extents: [{ logical: 0, physical: 9, len: 1 }],
      blockSize: 1024,
      inodeOffset: 1000,
      origSize,
      newContent: new Uint8Array(8),
    });
    const lo = plan.writes.find((w) => w.offset === 1000 + 0x04);
    const hi = plan.writes.find((w) => w.offset === 1000 + 0x6C);
    assert.ok(lo);
    assert.ok(hi);
    assert.equal(u32(lo.bytes, 0), 8);
    assert.equal(u32(hi.bytes, 0), 0);
    assert.equal(plan.newSize, 8);
  });
});

describe('patchExistingFileIo + overlay', () => {
  it('replaces a file and reads the new bytes back through the overlay', async () => {
    const image = buildMinimalExt4();
    const original = Uint8Array.from(image);
    const { overlay, io, sb } = overlayIoFor(image);
    const res = await patchExistingFileIo(io, 12, sb, 'hi\n');
    assert.equal(res.newSize, 3);
    const got = await readFileBytesRange(io, 12, sb);
    assert.equal(Buffer.from(got).toString('ascii'), 'hi\n');
    assert.equal(overlay.hasWrites(), true);
    assert.deepEqual(image, original);
  });

  it('grows within allocated extents via overlay', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);
    const res = await patchExistingFileIo(io, 12, sb, 'abcdefghij');
    assert.equal(res.origSize, 6);
    assert.equal(res.newSize, 10);
    const got = await readFileBytesRange(io, 12, sb);
    assert.equal(Buffer.from(got).toString('ascii'), 'abcdefghij');
    const raw = await io.read(inode12Offset(), 128);
    assert.equal(u32(raw, 0x04), 10);
    assert.equal(u32(raw, 0x6C), 0);
  });

  it('shrinks via overlay and updates i_size_lo', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);
    await patchExistingFileIo(io, 12, sb, 'z');
    const got = await readFileBytesRange(io, 12, sb);
    assert.equal(Buffer.from(got).toString('ascii'), 'z');
    const raw = await io.read(inode12Offset(), 128);
    assert.equal(u32(raw, 0x04), 1);
  });

  it('clears i_size_high when shrinking from a >4 GiB logical size', async () => {
    const image = buildMinimalExt4();
    wu32(image, inode12Offset() + 0x6C, 1);
    const { io, sb } = overlayIoFor(image);
    const res = await patchExistingFileIo(io, 12, sb, 'abcd');
    assert.equal(res.origSize, 0x100000000 + 6);
    assert.equal(res.newSize, 4);
    const raw = await io.read(inode12Offset(), 128);
    assert.equal(u32(raw, 0x04), 4);
    assert.equal(u32(raw, 0x6C), 0);
  });

  it('rejects replacements that need block allocation', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);
    await assert.rejects(
      () => patchExistingFileIo(io, 12, sb, new Uint8Array(2000)),
      /exceeds allocated block space/,
    );
  });

  it('rejects a directory inode', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);
    await assert.rejects(() => patchExistingFileIo(io, 2, sb, 'x'), /Not a regular file/);
  });

  it('matches patchFile byte-for-byte for shrink, same-size, and in-allocation grow', async () => {
    const payloads = ['z', 'hello\n', 'abcdefghij'];
    for (const payload of payloads) {
      const mem = buildMinimalExt4();
      const ranged = buildMinimalExt4();
      const sb = parseSuperblock(mem);
      patchFile(mem, 12, sb, payload);
      const { io } = overlayIoFor(ranged);
      await patchExistingFileIo(io, 12, sb, payload);
      const merged = await io.read(0, ranged.length);
      assert.deepEqual(merged, mem, `mismatch for payload ${JSON.stringify(payload)}`);
    }
  });

  it('same-size replacement does not rewrite i_size but still updates file bytes', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb, writes } = recordingIo(image);
    const res = await patchExistingFileIo(io, 12, sb, 'HELLO\n');
    assert.equal(res.origSize, 6);
    assert.equal(res.newSize, 6);
    const got = await readFileBytesRange(io, 12, sb);
    assert.equal(Buffer.from(got).toString('ascii'), 'HELLO\n');
    const inodeOff = inode12Offset();
    assert.equal(writes.some((w) => w.offset === inodeOff + 0x04), false);
    assert.equal(writes.some((w) => w.offset === inodeOff + 0x6C), false);
    const raw = await io.read(inodeOff, 128);
    assert.equal(u32(raw, 0x04), 6);
    assert.equal(u32(raw, 0x6C), 0);
    assert.equal(overlay.stats.bytes, 1024);
  });

  it('only writes the file data block and inode size fields', async () => {
    const image = buildMinimalExt4();
    const { io, sb, writes } = recordingIo(image);
    await patchExistingFileIo(io, 12, sb, 'z');
    const dataOff = 9 * 1024;
    const inodeOff = inode12Offset();
    const allowed = new Set([dataOff, inodeOff + 0x04, inodeOff + 0x6C]);
    for (const w of writes) {
      assert.equal(allowed.has(w.offset), true, `unexpected write at ${w.offset}`);
      assert.equal(w.offset + w.length <= image.length, true);
    }
    assert.equal(writes.find((w) => w.offset === dataOff).length, 1024);
  });

  it('dirties every allocated filesystem block, not only the first modified block', async () => {
    const tiny = overlayIoFor(buildMinimalExt4());
    await patchExistingFileIo(tiny.io, 12, tiny.sb, 'x');
    assert.equal(tiny.overlay.stats.bytes, 1024 + 8);

    const multi = overlayIoFor(buildThreeBlockFile());
    await patchExistingFileIo(multi.io, 12, multi.sb, 'x');
    assert.equal(multi.overlay.stats.bytes, 3 * 1024 + 8);
    const got = await readFileBytesRange(multi.io, 12, multi.sb);
    assert.equal(Buffer.from(got).toString('ascii'), 'x');

    const overlay = createBlockOverlay();
    const plan = computeInPlacePatch({
      extents: [{ logical: 0, physical: 0, len: 64 }],
      blockSize: 1024,
      inodeOffset: 100,
      origSize: 10,
      newContent: new Uint8Array(10),
    });
    for (const w of plan.writes) overlay.write(w.offset, w.bytes);
    assert.equal(plan.writes.filter((w) => w.bytes.length === 1024).length, 64);
    assert.equal(overlay.stats.bytes, 64 * 1024);
  });

  it('maps partition-relative data writes to absolute dump offsets above 4 GiB', async () => {
    const startByte = 0x100000000;
    const image = buildMinimalExt4();
    const overlay = createBlockOverlay();
    const writes = [];
    const io = wrapReader({
      size: image.length,
      async read(offset, length) {
        return image.subarray(offset, offset + length);
      },
    }, overlay);
    const origWrite = io.write.bind(io);
    io.write = async (offset, bytes) => {
      writes.push(offset);
      return origWrite(offset, bytes);
    };
    const origWriteAll = io.writeAll.bind(io);
    io.writeAll = async (list) => {
      for (const w of (list || [])) writes.push(w.offset);
      return origWriteAll(list);
    };
    const sb = parseSuperblock(image);
    await patchExistingFileIo(io, 12, sb, 'z');
    assert.equal(writes.includes(9 * 1024), true);
    const dataSpan = overlay.sortedSpans().find((s) => s.offset === 9 * 1024);
    assert.ok(dataSpan);
    assert.equal(dataSpan.data[0], 'z'.charCodeAt(0));
    const parts = composeOverlayParts(startByte, image.length, overlay);
    const sliceBeforeData = parts.find((p) => p.kind === 'slice' && p.end === startByte + 9 * 1024);
    assert.ok(sliceBeforeData);
    assert.equal(sliceBeforeData.end, startByte + 9 * 1024);
    assert.equal(sliceBeforeData.end > 0xffffffff, true);
    assert.equal(Number.isSafeInteger(sliceBeforeData.end), true);
  });

  it('rejects an indirect (non-extent) regular inode', async () => {
    const image = buildMinimalExt4();
    const off = inode12Offset();
    wu32(image, off + 0x20, 0);
    for (let i = 0; i < 60; i += 1) image[off + 0x28 + i] = 0;
    const { io, sb } = overlayIoFor(image);
    await assert.rejects(() => patchExistingFileIo(io, 12, sb, 'x'), /unsupported layout/);
  });

  it('rejects an inline regular inode with no extents', async () => {
    const image = buildMinimalExt4();
    const off = inode12Offset();
    wu32(image, off + 0x20, 0);
    for (let i = 0; i < 60; i += 1) image[off + 0x28 + i] = i < 4 ? 'abcd'.charCodeAt(i) : 0;
    wu32(image, off + 0x04, 4);
    const { io, sb } = overlayIoFor(image);
    await assert.rejects(() => patchExistingFileIo(io, 12, sb, 'x'), /unsupported layout/);
  });

  it('does not allocate a full multi-GB partition Uint8Array', async () => {
    const huge = 6 * 1024 * 1024 * 1024;
    const image = buildMinimalExt4();
    const overlay = createBlockOverlay();
    let maxRead = 0;
    const io = wrapReader({
      size: huge,
      async read(offset, length) {
        if (length >= huge || (offset === 0 && length === huge)) {
          throw new Error('full partition read');
        }
        maxRead = Math.max(maxRead, length);
        const out = new Uint8Array(length);
        if (offset < image.length) {
          out.set(image.subarray(offset, Math.min(image.length, offset + length)));
        }
        return out;
      },
    }, overlay);
    const sb = parseSuperblock(image);
    await patchExistingFileIo(io, 12, sb, 'ok');
    assert.equal(maxRead < 1024 * 1024, true);
    assert.equal(overlay.stats.bytes < huge, true);
    const got = await readFileBytesRange(io, 12, sb);
    assert.equal(Buffer.from(got).toString('ascii'), 'ok');
  });
});
