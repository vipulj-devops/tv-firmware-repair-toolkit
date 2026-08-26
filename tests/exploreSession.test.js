import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  EXT4_EDIT_MEMORY_LIMIT,
  LARGE_PARTITION_READONLY_REASON,
  MEMORY_LOAD_FAILED_REASON,
  usesMemoryEditor,
  loadExplorePartition,
} from '../src/lib/exploreSession.js';
import { isExt4, parseSuperblock, listFiles, readFileBytes, patchFile } from '../src/lib/ext4.js';
import { getPartitionBlob } from '../src/lib/dumpCompose.js';
import { readPartition } from '../src/lib/emmc.js';

const dir = dirname(fileURLToPath(import.meta.url));

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

function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function mockDumpFile(image, { startByte = 0, onSlice, failFullSize } = {}) {
  return {
    slice(start, end) {
      onSlice?.(start, end);
      const len = end - start;
      if (failFullSize != null && len === failFullSize) {
        return {
          size: len,
          arrayBuffer: async () => {
            throw new RangeError('Failed to allocate ArrayBuffer');
          },
        };
      }
      const rel = start - startByte;
      const slice = image.subarray(Math.max(0, rel), Math.max(0, rel) + Math.min(len, image.length));
      return {
        size: len,
        arrayBuffer: async () => toArrayBuffer(slice),
      };
    },
  };
}

describe('usesMemoryEditor', () => {
  it('selects in-memory Explore at and below 1 GiB', () => {
    assert.equal(usesMemoryEditor(EXT4_EDIT_MEMORY_LIMIT), true);
    assert.equal(usesMemoryEditor(EXT4_EDIT_MEMORY_LIMIT - 1), true);
    assert.equal(usesMemoryEditor(16 * 1024), true);
  });

  it('selects range reader above 1 GiB', () => {
    assert.equal(usesMemoryEditor(EXT4_EDIT_MEMORY_LIMIT + 1), false);
    assert.equal(usesMemoryEditor(5 * EXT4_EDIT_MEMORY_LIMIT), false);
  });

  it('keeps replaced partitions on the in-memory path regardless of size', () => {
    assert.equal(usesMemoryEditor(EXT4_EDIT_MEMORY_LIMIT + 1, true), true);
  });
});

describe('loadExplorePartition — small / editable', () => {
  it('loads a <=1 GiB partition via full slice arrayBuffer into a Uint8Array', async () => {
    const image = buildMinimalExt4();
    const startByte = 0x1000;
    const slices = [];
    const file = mockDumpFile(image, { startByte, onSlice: (s, e) => slices.push([s, e]) });
    const session = await loadExplorePartition({
      file,
      startByte,
      size: image.length,
      name: 'system',
    });
    assert.equal(session.mode, 'memory');
    assert.equal(session.bytes instanceof Uint8Array, true);
    assert.equal(session.bytes.length, image.length);
    assert.equal(session.reader, null);
    assert.equal(session.readOnlyReason, null);
    assert.deepEqual(slices, [[startByte, startByte + image.length]]);
    assert.equal(isExt4(session.bytes), true);
  });

  it('keeps the existing patch path working on those bytes', async () => {
    const image = buildMinimalExt4();
    const file = mockDumpFile(image, { startByte: 0 });
    const session = await loadExplorePartition({
      file,
      startByte: 0,
      size: image.length,
      name: 'system',
    });
    const sb = parseSuperblock(session.bytes);
    const files = listFiles(session.bytes, sb);
    const hello = files.find((f) => f.path.endsWith('hello.txt'));
    assert.ok(hello);
    patchFile(session.bytes, hello.inode, sb, 'hi\n');
    assert.equal(Buffer.from(readFileBytes(session.bytes, hello.inode, sb)).toString('ascii').startsWith('hi'), true);
  });

  it('treats p.size === 1 GiB as the in-memory path (full partition slice)', async () => {
    const image = buildMinimalExt4();
    const startByte = 10;
    const size = EXT4_EDIT_MEMORY_LIMIT;
    const slices = [];
    const file = mockDumpFile(image, { startByte, onSlice: (s, e) => slices.push([s, e, e - s]) });
    const session = await loadExplorePartition({
      file,
      startByte,
      size,
      name: 'cache',
    });
    assert.equal(session.mode, 'memory');
    assert.equal(session.bytes instanceof Uint8Array, true);
    assert.ok(slices.some((c) => c[0] === startByte && c[1] === startByte + size));
  });
});

describe('loadExplorePartition — large / range-backed', () => {
  it('uses the range reader and never arrayBuffers the whole partition', async () => {
    const image = buildMinimalExt4();
    const startByte = 0x161500000;
    const size = EXT4_EDIT_MEMORY_LIMIT + 1;
    const slices = [];
    const file = mockDumpFile(image, { startByte, onSlice: (s, e) => slices.push([s, e, e - s]) });
    const session = await loadExplorePartition({
      file,
      startByte,
      size,
      name: 'userdata',
    });
    assert.equal(session.mode, 'range');
    assert.equal(session.bytes, null);
    assert.ok(session.reader);
    assert.equal(session.readOnlyReason, LARGE_PARTITION_READONLY_REASON);
    assert.equal(slices.some((c) => c[2] === size || (c[0] === startByte && c[1] === startByte + size)), false);
    assert.equal(session.reader.stats.fullPartitionSlices, 0);
    const head = await session.reader.read(0, 2048);
    assert.equal(isExt4(head), true);
  });
});

describe('loadExplorePartition — replacements and memory failure', () => {
  it('uses replacement bytes without reading the dump File', async () => {
    const replacement = buildMinimalExt4();
    const file = {
      slice() {
        throw new Error('dump File should not be sliced for replacements');
      },
    };
    const session = await loadExplorePartition({
      file,
      startByte: 0,
      size: EXT4_EDIT_MEMORY_LIMIT + 50,
      name: 'system',
      replacementBytes: replacement,
    });
    assert.equal(session.mode, 'memory');
    assert.equal(session.bytes, replacement);
    assert.equal(session.reader, null);
  });

  it('falls back to range Explore when a <=1 GiB load cannot allocate', async () => {
    const image = buildMinimalExt4();
    const startByte = 0;
    const size = image.length;
    const file = mockDumpFile(image, { startByte, failFullSize: size });
    const session = await loadExplorePartition({
      file,
      startByte,
      size,
      name: 'system',
    });
    assert.equal(session.mode, 'range');
    assert.equal(session.bytes, null);
    assert.ok(session.reader);
    assert.equal(session.readOnlyReason, MEMORY_LOAD_FAILED_REASON);
    assert.ok(session.memoryError);
  });
});

describe('existing wiring is preserved', () => {
  it('EmmcTool uses loadExplorePartition and still patches via replacements', () => {
    const src = readFileSync(join(dir, '../src/pages/EmmcTool.jsx'), 'utf8');
    assert.equal(src.includes('EXPLORE_LIMIT'), false);
    assert.match(src, /loadExplorePartition/);
    assert.match(src, /setReplacements\(\(prev\) => \(\{ \.\.\.prev, \[explorePart\.name\]: patched \}\)\)/);
    assert.match(src, /const getPartitionBlob = \(p\) =>/);
    assert.match(src, /const buildOutputBlob = \(\) =>/);
    assert.match(src, /aria-label="Back to partition table"/);
    assert.match(src, /const resetToStart = \(\) =>/);
  });

  it('Ext4Browser remains writable when bytes are provided (TV Config + small Explore)', () => {
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    assert.match(src, /const memoryWritable = !!bytes;/);
    const tv = readFileSync(join(dir, '../src/pages/TVConfigTool.jsx'), 'utf8');
    assert.match(tv, /<Ext4Browser\s+bytes=\{bytes\}/);
  });

  it('does not restore a cannot-Explore size error', () => {
    const src = readFileSync(join(dir, '../src/pages/EmmcTool.jsx'), 'utf8');
    assert.equal(/partition too large to explore/i.test(src), false);
    assert.equal(/explore supports partitions up to 1 GB/i.test(src), false);
  });
});

describe('Phase 2B-A: Safe READ/EXTRACT handling of truncated partitions', () => {
  it('Complete partition: extracts/reads exact declaredSize bytes', async () => {
    const image = buildMinimalExt4();
    const file = mockDumpFile(image, { startByte: 0 });
    const part = {
      name: 'system',
      startByte: 0,
      size: image.length,
      declaredSize: image.length,
      availableSize: image.length,
      truncated: false,
      unavailable: false,
    };
    const blob = getPartitionBlob({ file, partition: part });
    assert.equal(blob.size, image.length);

    const session = await loadExplorePartition({
      file,
      startByte: part.startByte,
      size: part.size,
      availableSize: part.availableSize,
      unavailable: part.unavailable,
      name: part.name,
    });
    assert.equal(session.mode, 'memory');
    assert.equal(session.bytes.length, image.length);

    const sub = readPartition(image, part);
    assert.equal(sub.length, image.length);
  });

  it('Truncated partition: reads/extracts only availableSize bytes, never declaredSize', async () => {
    const image = buildMinimalExt4();
    const availableSize = 8192;
    const declaredSize = 10 * 1024 * 1024;
    const slices = [];
    const file = mockDumpFile(image, { startByte: 0, onSlice: (s, e) => slices.push([s, e]) });
    const part = {
      name: 'userdata',
      startByte: 0,
      size: declaredSize,
      declaredSize,
      availableSize,
      truncated: true,
      unavailable: false,
    };

    const blob = getPartitionBlob({ file, partition: part });
    assert.equal(blob.size, availableSize);

    const session = await loadExplorePartition({
      file,
      startByte: part.startByte,
      size: part.size,
      availableSize: part.availableSize,
      unavailable: part.unavailable,
      name: part.name,
    });
    assert.equal(session.mode, 'memory');
    assert.equal(session.bytes.length, availableSize);
    assert.ok(slices.every((s) => s[1] <= availableSize));

    const sub = readPartition(image, part);
    assert.equal(sub.length, availableSize);
  });

  it('Unavailable partition: returns 0-byte Blob or rejects loadExplorePartition cleanly', async () => {
    const image = buildMinimalExt4();
    const file = mockDumpFile(image, { startByte: 0 });
    const part = {
      name: 'cache',
      startByte: 0x72D00000,
      size: 768 * 1024 * 1024,
      declaredSize: 768 * 1024 * 1024,
      availableSize: 0,
      truncated: false,
      unavailable: true,
    };

    const blob = getPartitionBlob({ file, partition: part });
    assert.equal(blob.size, 0);

    await assert.rejects(
      () =>
        loadExplorePartition({
          file,
          startByte: part.startByte,
          size: part.size,
          availableSize: part.availableSize,
          unavailable: part.unavailable,
          name: part.name,
        }),
      /beyond physical dump EOF/i,
    );

    const sub = readPartition(image, part);
    assert.equal(sub.length, 0);
  });

  it('Range reader on truncated partition bounds all reads to availableSize', async () => {
    const image = buildMinimalExt4();
    const availableSize = EXT4_EDIT_MEMORY_LIMIT + 1;
    const declaredSize = EXT4_EDIT_MEMORY_LIMIT + 50 * 1024 * 1024;
    const slices = [];
    const file = mockDumpFile(image, { startByte: 0, onSlice: (s, e) => slices.push([s, e]) });
    const part = {
      name: 'userdata',
      startByte: 0,
      size: declaredSize,
      declaredSize,
      availableSize,
      truncated: true,
      unavailable: false,
    };

    const session = await loadExplorePartition({
      file,
      startByte: part.startByte,
      size: part.size,
      availableSize: part.availableSize,
      unavailable: part.unavailable,
      name: part.name,
    });
    assert.equal(session.mode, 'range');
    assert.ok(session.reader);
    assert.equal(session.reader.size, availableSize);
    assert.ok(slices.every((s) => s[1] <= availableSize));
  });
});
