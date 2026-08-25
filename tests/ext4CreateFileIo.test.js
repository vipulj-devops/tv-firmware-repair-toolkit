import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSuperblock } from '../src/lib/ext4.js';
import { createBufferRangeReader } from '../src/lib/rangeReader.js';
import { createBlockOverlay, wrapReader } from '../src/lib/blockOverlay.js';
import {
  listFilesRange,
  readFileBytesRange,
  getFreeSpaceRange,
  readInodeRange
} from '../src/lib/ext4Range.js';
import { createFileIo } from '../src/lib/ext4PatchIo.js';

function wU16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wU32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function buildExt4ImageWithRootDir() {
  const blockSize = 1024;
  const bytes = new Uint8Array(64 * blockSize);
  const sb = 1024;

  // Superblock
  wU32(bytes, sb + 0x00, 32); // s_inodes_count
  wU32(bytes, sb + 0x04, 32); // s_blocks_count_lo
  wU32(bytes, sb + 0x0C, 20); // s_free_blocks_count_lo
  wU32(bytes, sb + 0x10, 20); // s_free_inodes_count
  wU32(bytes, sb + 0x14, 1);  // s_first_data_block
  wU32(bytes, sb + 0x18, 0);  // s_log_block_size (1024)
  wU32(bytes, sb + 0x20, 16); // s_blocks_per_group
  wU32(bytes, sb + 0x28, 16); // s_inodes_per_group
  wU16(bytes, sb + 0x38, 0xef53); // s_magic
  wU32(bytes, sb + 0x4c, 1);  // s_rev_level
  wU16(bytes, sb + 0x58, 128); // s_inode_size
  wU16(bytes, sb + 0xfe, 32);  // s_desc_size

  // Group Descriptor 0
  const gdt = 2048;
  wU32(bytes, gdt + 0x00, 3);  // bg_block_bitmap
  wU32(bytes, gdt + 0x04, 4);  // bg_inode_bitmap
  wU32(bytes, gdt + 0x08, 5);  // bg_inode_table
  wU16(bytes, gdt + 0x0C, 20); // bg_free_blocks_count_lo
  wU16(bytes, gdt + 0x0E, 20); // bg_free_inodes_count_lo

  // Block bitmap (block 3): blocks 0..6 used (0x7F) -> blocks 0..6 reserved/used
  bytes[3 * blockSize + 0] = 0x7f;

  // Inode bitmap (block 4): inodes 1..2 used (0x03) -> inode 2 is root dir
  bytes[4 * blockSize + 0] = 0x03;

  // Root directory Inode 2 (at block 5 + index 1 * 128 = 5248)
  const rootInodeOff = 5 * blockSize + 1 * 128;
  wU16(bytes, rootInodeOff + 0x00, 0x41ed); // mode: dir 0755
  wU32(bytes, rootInodeOff + 0x04, blockSize); // size: 1024
  wU16(bytes, rootInodeOff + 0x1A, 2); // links_count
  wU32(bytes, rootInodeOff + 0x20, 0x80000); // flags: EXT4_EXTENTS_FL
  wU32(bytes, rootInodeOff + 0x1C, blockSize / 512); // i_blocks: 2 sectors

  // Extent root header in root inode (i_block at rootInodeOff + 0x28)
  const rootExtentOff = rootInodeOff + 0x28;
  wU16(bytes, rootExtentOff + 0, 0xF30A); // magic
  wU16(bytes, rootExtentOff + 2, 1);      // 1 entry
  wU16(bytes, rootExtentOff + 4, 4);      // max 4 entries
  wU16(bytes, rootExtentOff + 6, 0);      // depth 0

  // Extent entry: logical block 0 -> physical block 6, len 1
  wU32(bytes, rootExtentOff + 12 + 0, 0); // logical 0
  wU16(bytes, rootExtentOff + 12 + 4, 1); // len 1
  wU16(bytes, rootExtentOff + 12 + 6, 0); // physical hi
  wU32(bytes, rootExtentOff + 12 + 8, 6); // physical lo (block 6)

  // Root directory data block (block 6): contains "." and ".." dirents
  const rootDataOff = 6 * blockSize;
  // "." entry: inode 2, rec_len 12, name_len 1, file_type 2
  wU32(bytes, rootDataOff + 0, 2);
  wU16(bytes, rootDataOff + 4, 12);
  bytes[rootDataOff + 6] = 1;
  bytes[rootDataOff + 7] = 2; // dir
  bytes[rootDataOff + 8] = 46; // '.'

  // ".." entry: inode 2, rec_len 1012 (rest of block), name_len 2, file_type 2
  wU32(bytes, rootDataOff + 12 + 0, 2);
  wU16(bytes, rootDataOff + 12 + 4, blockSize - 12);
  bytes[rootDataOff + 12 + 6] = 2;
  bytes[rootDataOff + 12 + 7] = 2; // dir
  bytes[rootDataOff + 12 + 8] = 46; // '.'
  bytes[rootDataOff + 12 + 9] = 46; // '.'

  return bytes;
}

function overlayIoFor(image) {
  const overlay = createBlockOverlay();
  const base = createBufferRangeReader(image);
  return { overlay, io: wrapReader(base, overlay), sb: parseSuperblock(image) };
}

describe('createFileIo', () => {
  it('creates a new regular file in root directory', async () => {
    const image = buildExt4ImageWithRootDir();
    const { overlay, io, sb } = overlayIoFor(image);

    const content = new TextEncoder().encode("Hello, range-backed EXT4!");
    const res = await createFileIo(io, sb, '/', 'test.txt', content);

    assert.ok(res.inode > 2);
    assert.equal(res.name, 'test.txt');
    assert.equal(res.size, content.length);

    // Verify listFilesRange finds the file
    const files = await listFilesRange(io, sb);
    const found = files.find((f) => f.path === '/test.txt');
    assert.ok(found);
    assert.equal(found.inode, res.inode);
    assert.equal(found.size, content.length);
    assert.equal(found.isDir, false);

    // Verify readFileBytesRange reads back exact data
    const readBack = await readFileBytesRange(io, res.inode, sb);
    assert.deepEqual(readBack, content);

    assert.equal(overlay.hasWrites(), true);
  });

  it('creates an empty file (0 bytes)', async () => {
    const image = buildExt4ImageWithRootDir();
    const { overlay, io, sb } = overlayIoFor(image);

    const res = await createFileIo(io, sb, '/', 'empty.dat', new Uint8Array(0));
    assert.equal(res.size, 0);

    const files = await listFilesRange(io, sb);
    const found = files.find((f) => f.path === '/empty.dat');
    assert.ok(found);
    assert.equal(found.size, 0);

    const readBack = await readFileBytesRange(io, res.inode, sb);
    assert.equal(readBack.length, 0);
  });

  it('creates a multi-block file', async () => {
    const image = buildExt4ImageWithRootDir();
    const { overlay, io, sb } = overlayIoFor(image);

    const data = new Uint8Array(2500); // 3 blocks (1024-byte blocks)
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const res = await createFileIo(io, sb, '/', 'large.bin', data);
    assert.equal(res.size, 2500);

    const readBack = await readFileBytesRange(io, res.inode, sb);
    assert.equal(readBack.length, 2500);
    assert.deepEqual(readBack, data);
  });

  it('rejects invalid filenames', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    await assert.rejects(
      async () => createFileIo(io, sb, '/', 'bad/name.txt', 'test'),
      /Invalid file name/
    );

    await assert.rejects(
      async () => createFileIo(io, sb, '/', '', 'test'),
      /Invalid file name/
    );
  });

  it('rejects creation in non-existent directory', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    await assert.rejects(
      async () => createFileIo(io, sb, '/no_such_dir', 'file.txt', 'test'),
      /Target directory not found/
    );
  });

  it('frees old index leaf blocks when expanding depth-1 parent directory (Bug A regression)', async () => {
    const blockSize = 1024;
    const bytes = new Uint8Array(64 * blockSize);
    const sbOff = 1024;

    wU32(bytes, sbOff + 0x00, 32);
    wU32(bytes, sbOff + 0x04, 32);
    wU32(bytes, sbOff + 0x0C, 20);
    wU32(bytes, sbOff + 0x10, 20);
    wU32(bytes, sbOff + 0x14, 0);
    wU32(bytes, sbOff + 0x18, 0);
    wU32(bytes, sbOff + 0x20, 32);
    wU32(bytes, sbOff + 0x28, 32);
    wU16(bytes, sbOff + 0x38, 0xef53);
    wU32(bytes, sbOff + 0x4c, 1);
    wU16(bytes, sbOff + 0x58, 128);
    wU16(bytes, sbOff + 0xfe, 32);

    const gdt = 2048;
    wU32(bytes, gdt + 0x00, 3);
    wU32(bytes, gdt + 0x04, 4);
    wU32(bytes, gdt + 0x08, 5);
    wU16(bytes, gdt + 0x0C, 20);
    wU16(bytes, gdt + 0x0E, 20);

    // Reserved blocks 0..6 used (0x7F), plus block 20 (old index leaf) used (0x10 at byte 2)
    bytes[3 * blockSize + 0] = 0x7f;
    bytes[3 * blockSize + 2] = 0x10;

    // Inode bitmap: inodes 1..2 used
    bytes[4 * blockSize + 0] = 0x03;

    // Root Inode 2 with DEPTH 1 tree
    const rootInodeOff = 5 * blockSize + 1 * 128;
    wU16(bytes, rootInodeOff + 0x00, 0x41ed);
    wU32(bytes, rootInodeOff + 0x04, 5 * blockSize);
    wU16(bytes, rootInodeOff + 0x1A, 2);
    wU32(bytes, rootInodeOff + 0x20, 0x80000);
    wU32(bytes, rootInodeOff + 0x1C, (5 * blockSize) / 512);

    // Root i_block: depth 1 extent header, 1 entry pointing to leaf block 20
    const rootExtentOff = rootInodeOff + 0x28;
    wU16(bytes, rootExtentOff + 0, 0xF30A);
    wU16(bytes, rootExtentOff + 2, 1);
    wU16(bytes, rootExtentOff + 4, 4);
    wU16(bytes, rootExtentOff + 6, 1);

    wU32(bytes, rootExtentOff + 12 + 0, 0);
    wU32(bytes, rootExtentOff + 12 + 4, 20);
    wU16(bytes, rootExtentOff + 12 + 8, 0);

    // Leaf block 20: depth 0 extent header containing 5 NON-CONTIGUOUS extents (blocks 6, 8, 10, 12, 14)
    const leaf20Off = 20 * blockSize;
    wU16(bytes, leaf20Off + 0, 0xF30A);
    wU16(bytes, leaf20Off + 2, 5); // 5 leaf extents
    wU16(bytes, leaf20Off + 4, 84);
    wU16(bytes, leaf20Off + 6, 0); // depth 0

    for (let i = 0; i < 5; i++) {
      wU32(bytes, leaf20Off + 12 + i * 12 + 0, i); // logical i
      wU16(bytes, leaf20Off + 12 + i * 12 + 4, 1); // len 1
      wU16(bytes, leaf20Off + 12 + i * 12 + 6, 0);
      wU32(bytes, leaf20Off + 12 + i * 12 + 8, 6 + i * 2); // physical 6, 8, 10, 12, 14
    }

    const { overlay, io, sb } = overlayIoFor(bytes);

    const bitmapBefore = await io.read(3 * blockSize, 4);
    assert.equal((bitmapBefore[2] & 0x10) !== 0, true, 'Block 20 initially allocated');

    await createFileIo(io, sb, '/', 'newfile.txt', 'test content');

    const bitmapAfter = await io.read(3 * blockSize, 4);
    assert.equal((bitmapAfter[2] & 0x10), 0, 'Old index leaf block 20 must be freed');

    const rootInodeNew = await readInodeRange(io, 2, sb);
    const rootExtentHeader = rootInodeNew.iBlock;
    assert.equal(u16(rootExtentHeader, 0), 0xF30A);
    assert.equal(u16(rootExtentHeader, 6), 1);
    const newLeafBlock = u32(rootExtentHeader, 16);
    assert.notEqual(newLeafBlock, 20, 'Parent tree should point to new index leaf, not block 20');

    const newLeafByteIdx = newLeafBlock >> 3;
    const newLeafMask = 1 << (newLeafBlock & 7);
    assert.equal((bitmapAfter[newLeafByteIdx] & newLeafMask) !== 0, true, 'New index leaf block allocated');

    const files = await listFilesRange(io, sb);
    const newFile = files.find((f) => f.path === '/newfile.txt');
    assert.ok(newFile, 'Newly added file listed');
  });
});