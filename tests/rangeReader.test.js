import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRangeReader, createFileRangeReader } from '../src/lib/rangeReader.js';
import { isExt4, parseSuperblock, listFiles, readFileBytes } from '../src/lib/ext4.js';
import { parseSuperblockRange, listFilesRange, readFileBytesRange } from '../src/lib/ext4Range.js';

function mockFile(onSlice) {
  return {
    slice(start, end) {
      onSlice(start, end);
      return {
        arrayBuffer: async () => new ArrayBuffer(end - start),
      };
    },
  };
}

function wu16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wu32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
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

describe('range reader', () => {
  it('maps partition-relative offsets to absolute File.slice ranges', async () => {
    const calls = [];
    const startByte = 0x161500000;
    const reader = createFileRangeReader(mockFile((s, e) => calls.push([s, e])), startByte, 0x200000, {
      maxRead: 0x8000,
    });
    await reader.read(0x1000, 0x2000);
    assert.deepEqual(calls[0], [0x161501000, 0x161503000]);
  });

  it('does not wrap 32-bit for offsets above 0xFFFFFFFF', async () => {
    const calls = [];
    const startByte = 0x100000000;
    const reader = createFileRangeReader(mockFile((s, e) => calls.push([s, e])), startByte, 0x1000);
    await reader.read(0x10, 0x20);
    assert.deepEqual(calls[0], [0x100000010, 0x100000030]);
    assert.equal(calls[0][0] > 0xFFFFFFFF, true);
  });

  it('keeps backing reads bounded', async () => {
    const lens = [];
    const file = mockFile((s, e) => lens.push(e - s));
    const reader = createFileRangeReader(file, 0, 8 * 1024 * 1024, { maxRead: 4096 });
    await reader.read(0, 20000);
    assert.equal(lens.every((n) => n <= 4096), true);
    assert.equal(reader.stats.maxSliceLength <= 4096, true);
    assert.equal(reader.stats.fullPartitionSlices, 0);
  });

  it('does not arrayBuffer() an entire 4+ GiB partition', async () => {
    const size = 5 * 1024 * 1024 * 1024;
    const startByte = 0x161500000;
    let whole = false;
    const file = {
      slice(s, e) {
        if (s === startByte && e === startByte + size) whole = true;
        if (e - s === size) whole = true;
        return { arrayBuffer: async () => new ArrayBuffer(Math.min(e - s, 8192)) };
      },
    };
    const reader = createFileRangeReader(file, startByte, size, { maxRead: 8192 });
    await reader.read(0x1000, 0x2000);
    assert.equal(whole, false);
    assert.equal(reader.stats.fullPartitionSlices, 0);
    assert.equal(reader.stats.maxSliceLength <= 8192, true);
  });
});

describe('ext4 range vs in-memory parser', () => {
  it('lists the same root files as the full-buffer parser', async () => {
    const bytes = buildMinimalExt4();
    assert.equal(isExt4(bytes), true);
    const sb = parseSuperblock(bytes);
    const full = listFiles(bytes, sb);
    const reader = createRangeReader({
      startByte: 0,
      size: bytes.length,
      readAbsolute: async (a, b) => bytes.subarray(a, b),
    });
    const sb2 = await parseSuperblockRange(reader);
    assert.ok(sb2);
    const ranged = await listFilesRange(reader, sb2);
    assert.deepEqual(
      ranged.map((f) => ({ path: f.path, inode: f.inode, size: f.size, isDir: f.isDir })),
      full.map((f) => ({ path: f.path, inode: f.inode, size: f.size, isDir: f.isDir })),
    );
    const hello = full.find((f) => f.path.endsWith('hello.txt'));
    assert.ok(hello);
    const a = readFileBytes(bytes, hello.inode, sb);
    const b = await readFileBytesRange(reader, hello.inode, sb2);
    assert.deepEqual(Buffer.from(b), Buffer.from(a));
  });
});

describe('Explore 1 GiB gate removed', () => {
  it('EmmcTool no longer has EXPLORE_LIMIT or the 1 GB toast', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/pages/EmmcTool.jsx'), 'utf8');
    assert.equal(src.includes('EXPLORE_LIMIT'), false);
    assert.equal(/explore supports partitions up to 1 GB/i.test(src), false);
    assert.equal(src.includes('loadExplorePartition'), true);
  });
});
