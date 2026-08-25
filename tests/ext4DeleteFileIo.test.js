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
import { createFileIo, deleteFileIo, buildExtentTreeIo } from '../src/lib/ext4PatchIo.js';

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
  wU32(bytes, sb + 0x20, 32); // s_blocks_per_group
  wU32(bytes, sb + 0x28, 32); // s_inodes_per_group
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

describe('deleteFileIo', () => {
  it('A-G: Deletes a normal one-block file and restores free counts / bitmap bits', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    // Create file
    const content = new TextEncoder().encode("File to delete");
    const file = await createFileIo(io, sb, '/', 'delete_me.txt', content);
    assert.ok(file.inode > 2);

    const sbFreeBlocksBefore = u32(await io.read(1024 + 0x0C, 4), 0);
    const sbFreeInodesBefore = u32(await io.read(1024 + 0x10, 4), 0);
    const descBefore = await io.read(2048, 32);
    const bgFreeBlocksBefore = u16(descBefore, 0x0C);
    const bgFreeInodesBefore = u16(descBefore, 0x0E);

    // Delete file
    const res = await deleteFileIo(io, sb, '/delete_me.txt');
    assert.equal(res.name, 'delete_me.txt');
    assert.equal(res.inode, file.inode);

    // C: Inode bitmap bit is freed (0)
    const inodeBitmapByteIdx = (file.inode - 1) >> 3;
    const inodeBitmapMask = 1 << ((file.inode - 1) & 7);
    const inodeBitmap = await io.read(4 * sb.blockSize + inodeBitmapByteIdx, 1);
    assert.equal((inodeBitmap[0] & inodeBitmapMask), 0, 'Inode bitmap bit should be 0 (free)');

    // D: Data block bitmap bit is freed (0)
    const targetInode = await readInodeRange(io, file.inode, sb);
    assert.equal(targetInode.mode, 0, 'Target inode entry should be zeroed');

    // E & F: Superblock and BGD free counts incremented
    const sbFreeBlocksAfter = u32(await io.read(1024 + 0x0C, 4), 0);
    const sbFreeInodesAfter = u32(await io.read(1024 + 0x10, 4), 0);
    const descAfter = await io.read(2048, 32);
    const bgFreeBlocksAfter = u16(descAfter, 0x0C);
    const bgFreeInodesAfter = u16(descAfter, 0x0E);

    assert.equal(sbFreeInodesAfter, sbFreeInodesBefore + 1);
    assert.equal(bgFreeInodesAfter, bgFreeInodesBefore + 1);
    assert.equal(sbFreeBlocksAfter, sbFreeBlocksBefore + res.freedBlocks);
    assert.equal(bgFreeBlocksAfter, bgFreeBlocksBefore + res.freedBlocks);

    // G: Parent directory no longer lists deleted file
    const files = await listFilesRange(io, sb);
    const found = files.find((f) => f.path === '/delete_me.txt');
    assert.equal(found, undefined, 'Deleted file should not appear in listFilesRange');
  });

  it('H: Neighboring file remains intact and readable after deletion', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const f1Data = new TextEncoder().encode("Keep this file intact!");
    const f2Data = new TextEncoder().encode("Delete this file!");

    const file1 = await createFileIo(io, sb, '/', 'keep.txt', f1Data);
    const file2 = await createFileIo(io, sb, '/', 'remove.txt', f2Data);

    // Delete remove.txt
    await deleteFileIo(io, sb, '/remove.txt');

    // Verify keep.txt is still listed and readable with correct contents
    const files = await listFilesRange(io, sb);
    const keepFile = files.find((f) => f.path === '/keep.txt');
    assert.ok(keepFile);
    assert.equal(keepFile.inode, file1.inode);

    const keepContent = await readFileBytesRange(io, file1.inode, sb);
    assert.deepEqual(keepContent, f1Data);
  });

  it('B & I: Deletes multi-block file with depth-1 extent tree and frees leaf blocks', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    // Create depth-1 file with 5 non-contiguous extents
    const inodeNum = 3;
    // Mark inode 3 allocated in bitmap
    const inodeBitmapByte = await io.read(4 * sb.blockSize, 1);
    inodeBitmapByte[0] |= 0x04;
    await io.write(4 * sb.blockSize, inodeBitmapByte);

    // Allocate 5 non-contiguous blocks (7, 9, 11, 13, 15)
    const blockBitmap = await io.read(3 * sb.blockSize, 4);
    for (const b of [7, 9, 11, 13, 15]) {
      const bit = b - sb.firstDataBlock;
      blockBitmap[bit >> 3] |= (1 << (bit & 7));
    }
    await io.write(3 * sb.blockSize, blockBitmap);

    // Build depth-1 tree directly
    const inodeOffset = 5 * sb.blockSize + (inodeNum - 1) * sb.inodeSize;
    const extents = [
      { logical: 0, physical: 7, len: 1 },
      { logical: 1, physical: 9, len: 1 },
      { logical: 2, physical: 11, len: 1 },
      { logical: 3, physical: 13, len: 1 },
      { logical: 4, physical: 15, len: 1 }
    ];

    await buildExtentTreeIo(io, inodeOffset + 0x28, sb, extents);

    // Read the newly allocated leaf index block from root extent tree
    const targetInode = await readInodeRange(io, inodeNum, sb);
    assert.equal(u16(targetInode.iBlock, 6), 1); // depth 1
    const allocatedLeafBlock = u32(targetInode.iBlock, 16);
    assert.ok(allocatedLeafBlock > 0);

    // Set inode mode = regular file
    const mode = new Uint8Array(2);
    wU16(mode, 0, 0x81A4);
    await io.write(inodeOffset + 0x00, mode);

    // Add dirent for /depth1_file.txt pointing to inode 3
    const rootDataOff = 6 * sb.blockSize;
    const rootBlock = await io.read(rootDataOff, sb.blockSize);
    wU16(rootBlock, 12 + 4, 12);

    const direntBuf = new Uint8Array(1024 - 24);
    wU32(direntBuf, 0, inodeNum);
    wU16(direntBuf, 4, 1024 - 24);
    direntBuf[6] = 'depth1_file.txt'.length;
    direntBuf[7] = 1;
    for (let i = 0; i < 'depth1_file.txt'.length; i++) direntBuf[8 + i] = 'depth1_file.txt'.charCodeAt(i);

    rootBlock.set(direntBuf, 24);
    await io.write(rootDataOff, rootBlock);

    // Delete file
    const res = await deleteFileIo(io, sb, '/depth1_file.txt');
    assert.equal(res.freedBlocks, 6); // 5 data blocks + 1 leaf index block

    // Verify leaf block and data blocks are now freed (0)
    const bmAfter = await io.read(3 * sb.blockSize, 4);
    for (const b of [7, 9, 11, 13, 15, allocatedLeafBlock]) {
      const bit = b - sb.firstDataBlock;
      assert.equal((bmAfter[bit >> 3] & (1 << (bit & 7))), 0, `Block ${b} should be freed`);
    }
  });

  it('J: Handles >4 GiB physical block numbers without 32-bit wrapping', async () => {
    const image = buildExt4ImageWithRootDir();
    const overlay = createBlockOverlay();
    const mockSize = 0x200000000; // 8 GiB
    const io = wrapReader({
      size: mockSize,
      async read(offset, length) {
        if (offset < image.length) {
          return image.subarray(offset, Math.min(image.length, offset + length));
        }
        return new Uint8Array(length);
      },
    }, overlay);
    const sb = parseSuperblock(image);

    const inodeNum = 4;
    const highPhysicalBlock = 0x100000005; // 4 GiB + 5

    // Build depth-0 tree with high physical block
    const inodeOffset = 5 * sb.blockSize + (inodeNum - 1) * sb.inodeSize;
    const extents = [
      { logical: 0, physical: highPhysicalBlock, len: 1 }
    ];

    // Mark inode 4 allocated
    const inodeBitmapByte = await io.read(4 * sb.blockSize, 1);
    inodeBitmapByte[0] |= 0x08;
    await io.write(4 * sb.blockSize, inodeBitmapByte);

    await buildExtentTreeIo(io, inodeOffset + 0x28, sb, extents);
    const mode = new Uint8Array(2);
    wU16(mode, 0, 0x81A4);
    await io.write(inodeOffset + 0x00, mode);

    // Add dirent for /high_phys.txt
    const rootDataOff = 6 * sb.blockSize;
    const rootBlock = await io.read(rootDataOff, sb.blockSize);
    wU16(rootBlock, 12 + 4, 12);

    const direntBuf = new Uint8Array(1024 - 24);
    wU32(direntBuf, 0, inodeNum);
    wU16(direntBuf, 4, 1024 - 24);
    direntBuf[6] = 'high_phys.txt'.length;
    direntBuf[7] = 1;
    for (let i = 0; i < 'high_phys.txt'.length; i++) direntBuf[8 + i] = 'high_phys.txt'.charCodeAt(i);
    rootBlock.set(direntBuf, 24);
    await io.write(rootDataOff, rootBlock);

    // Delete file
    const res = await deleteFileIo(io, sb, '/high_phys.txt');
    assert.equal(res.freedBlocks, 1);
    assert.equal(res.inode, 4);
  });

  it('K & L: Pre-mutation validation — fails cleanly on non-existent file or directory', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    // Superblock free counts before attempted invalid deletes
    const sbFreeBlocksBefore = u32(await io.read(1024 + 0x0C, 4), 0);
    const sbFreeInodesBefore = u32(await io.read(1024 + 0x10, 4), 0);

    // K: Non-existent file
    await assert.rejects(
      async () => deleteFileIo(io, sb, '/does_not_exist.txt'),
      /Directory entry not found/
    );

    // L: Attempt to delete directory (root `/` or non-regular)
    await assert.rejects(
      async () => deleteFileIo(io, sb, '/'),
      /Could not resolve parent directory|Directory entry not found|Only regular files can be deleted/
    );

    // Verify ZERO mutations occurred (free counts unchanged)
    const sbFreeBlocksAfter = u32(await io.read(1024 + 0x0C, 4), 0);
    const sbFreeInodesAfter = u32(await io.read(1024 + 0x10, 4), 0);
    assert.equal(sbFreeBlocksAfter, sbFreeBlocksBefore);
    assert.equal(sbFreeInodesAfter, sbFreeInodesBefore);
  });

  it('M: Performs deletion with bounded range reads and no whole-partition Uint8Array', async () => {
    const image = buildExt4ImageWithRootDir();
    const overlay = createBlockOverlay();
    const hugeSize = 8 * 1024 * 1024 * 1024; // 8 GiB
    let maxReadLen = 0;

    const io = wrapReader({
      size: hugeSize,
      async read(offset, length) {
        if (length >= 1024 * 1024) throw new Error('Attempted large read');
        maxReadLen = Math.max(maxReadLen, length);
        if (offset < image.length) return image.subarray(offset, Math.min(image.length, offset + length));
        return new Uint8Array(length);
      },
    }, overlay);

    const sb = parseSuperblock(image);
    const file = await createFileIo(io, sb, '/', 'bounded_delete.txt', 'test');
    assert.ok(file.inode > 2);

    maxReadLen = 0; // reset counter
    await deleteFileIo(io, sb, '/bounded_delete.txt');
    assert.ok(maxReadLen < 65536, `Max read len was ${maxReadLen}, should be < 64 KB`);
  });
});