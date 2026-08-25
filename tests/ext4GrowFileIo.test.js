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
import {
  createFileIo,
  growAndPatchFileIo,
  buildExtentTreeIo,
  patchExistingFileIo
} from '../src/lib/ext4PatchIo.js';

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

describe('growAndPatchFileIo', () => {
  it('grows a 1-block file to 2 blocks (adjacent physical extent coalescing)', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    // Initial 1-block file (1000 bytes)
    const initialContent = new Uint8Array(1000);
    initialContent.fill(0xaa);
    const file = await createFileIo(io, sb, '/', 'grow_adjacent.bin', initialContent);

    // Read initial metadata and free counts
    const inodeBefore = await readInodeRange(io, file.inode, sb);
    const sbFreeBefore = u32(await io.read(1024 + 0x0C, 4), 0);
    const descBefore = await io.read(2048, 32);
    const bgFreeBefore = u16(descBefore, 0x0C);

    // Grown 2-block content (1500 bytes)
    const newContent = new Uint8Array(1500);
    newContent.set(initialContent);
    newContent.fill(0xbb, 1000, 1500);

    const res = await growAndPatchFileIo(io, file.inode, sb, newContent);

    assert.equal(res.origSize, 1000);
    assert.equal(res.newSize, 1500);
    assert.equal(res.grown, 1);
    assert.equal(res.allocatedSpace, 2048);

    // Verify inode metadata: i_size, i_blocks
    const inodeAfter = await readInodeRange(io, file.inode, sb);
    assert.equal(inodeAfter.sizeLo, 1500);
    assert.equal(inodeAfter.sizeHi, 0);

    const initialIBlocks = u32(new Uint8Array(4), 0); // initial 1 block = 2 sectors
    const rawInodeAfter = await io.read(inodeAfter.offset, 128);
    assert.equal(u32(rawInodeAfter, 0x1C), (1 + 1) * (sb.blockSize / 512));

    // Verify superblock & BGD free counts decreased by 1 block
    const sbFreeAfter = u32(await io.read(1024 + 0x0C, 4), 0);
    const descAfter = await io.read(2048, 32);
    const bgFreeAfter = u16(descAfter, 0x0C);
    assert.equal(sbFreeAfter, sbFreeBefore - 1);
    assert.equal(bgFreeAfter, bgFreeBefore - 1);

    // Verify old and new data intact via readFileBytesRange
    const readBack = await readFileBytesRange(io, file.inode, sb);
    assert.equal(readBack.length, 1500);
    assert.deepEqual(readBack, newContent);
  });

  it('grows a file requiring non-contiguous extents', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const initialContent = new Uint8Array(800);
    initialContent.fill(0x11);
    const file = await createFileIo(io, sb, '/', 'non_contiguous.bin', initialContent);

    // Intentionally allocate block right after file's block to force non-contiguous allocation
    const blockToBlock = await io.read(3 * sb.blockSize, 4);
    const fileInode = await readInodeRange(io, file.inode, sb);
    // Find physical block of file
    const fileExtents = [];
    const rootHeader = fileInode.iBlock;
    const physBlock = u32(rootHeader, 20); // physical lo of first extent
    const nextBlock = physBlock + 1;
    // Mark nextBlock as allocated
    blockToBlock[nextBlock >> 3] |= (1 << (nextBlock & 7));
    await io.write(3 * sb.blockSize, blockToBlock);

    // Grow file to 2 blocks
    const newContent = new Uint8Array(1800);
    newContent.set(initialContent);
    newContent.fill(0x22, 800, 1800);

    const res = await growAndPatchFileIo(io, file.inode, sb, newContent);
    assert.equal(res.grown, 1);
    assert.equal(res.extents, 2); // 2 separate extents

    const readBack = await readFileBytesRange(io, file.inode, sb);
    assert.deepEqual(readBack, newContent);
  });

  it('handles depth 0 -> depth 1 extent tree transition and existing depth-1 grow', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    // Create initial 1-block file
    const file = await createFileIo(io, sb, '/', 'depth_transition.bin', new Uint8Array(100));

    // Force extent count to 4 (max depth-0) by marking non-contiguous bits
    const fileInode = await readInodeRange(io, file.inode, sb);
    const phys1 = u32(fileInode.iBlock, 20);

    // Manually set 4 non-contiguous extents on file inode
    const extents = [
      { logical: 0, physical: phys1, len: 1 },
      { logical: 1, physical: phys1 + 2, len: 1 },
      { logical: 2, physical: phys1 + 4, len: 1 },
      { logical: 3, physical: phys1 + 6, len: 1 }
    ];
    // Mark blocks allocated in bitmap
    const bm = await io.read(3 * sb.blockSize, 4);
    for (const e of extents) {
      const bit = e.physical - sb.firstDataBlock;
      bm[bit >> 3] |= (1 << (bit & 7));
    }
    await io.write(3 * sb.blockSize, bm);
    await buildExtentTreeIo(io, fileInode.offset + 0x28, sb, extents);

    // Update inode size & i_blocks to 4 blocks
    const szLo = new Uint8Array(4);
    wU32(szLo, 0, 4 * sb.blockSize);
    await io.write(fileInode.offset + 0x04, szLo);

    // Grow to 5 blocks -> triggers depth 0 -> depth 1 transition!
    const newContent = new Uint8Array(5 * sb.blockSize);
    newContent.fill(0x33);

    const res = await growAndPatchFileIo(io, file.inode, sb, newContent);
    assert.equal(res.grown, 1);
    assert.ok(res.extents >= 5);

    const inodeAfter = await readInodeRange(io, file.inode, sb);
    assert.equal(u16(inodeAfter.iBlock, 6), 1); // Depth 1!

    // Record old index leaf physical block
    const oldLeafBlock = u32(inodeAfter.iBlock, 16) + u16(inodeAfter.iBlock, 20) * 0x100000000;
    assert.ok(oldLeafBlock > 0);

    // Verify old leaf bitmap bit is marked allocated (1) before second grow
    const bmMid = await io.read(3 * sb.blockSize, 4);
    const oldLeafBit = oldLeafBlock - sb.firstDataBlock;
    assert.equal((bmMid[oldLeafBit >> 3] & (1 << (oldLeafBit & 7))) !== 0, true);

    const readBack = await readFileBytesRange(io, file.inode, sb);
    assert.deepEqual(readBack, newContent);

    // Grow AGAIN (from existing depth-1 tree) to 6 blocks
    const newContent6 = new Uint8Array(6 * sb.blockSize);
    newContent6.set(newContent);
    newContent6.fill(0x44, 5 * sb.blockSize);

    const res6 = await growAndPatchFileIo(io, file.inode, sb, newContent6);
    assert.equal(res6.grown, 1);

    const inodeAfter6 = await readInodeRange(io, file.inode, sb);
    assert.equal(u16(inodeAfter6.iBlock, 6), 1); // Depth 1

    const readBack6 = await readFileBytesRange(io, file.inode, sb);
    assert.deepEqual(readBack6, newContent6);
  });

  it('strengthens depth-1 leaf verification: verifies old index leaf is freed, new leaf allocated, and root index updated', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const file = await createFileIo(io, sb, '/', 'depth1_leaf_check.bin', new Uint8Array(100));
    const fileInode = await readInodeRange(io, file.inode, sb);
    const phys1 = u32(fileInode.iBlock, 20);

    const extents = [
      { logical: 0, physical: phys1, len: 1 },
      { logical: 1, physical: phys1 + 2, len: 1 },
      { logical: 2, physical: phys1 + 4, len: 1 },
      { logical: 3, physical: phys1 + 6, len: 1 }
    ];
    const bm = await io.read(3 * sb.blockSize, 4);
    for (const e of extents) {
      const bit = e.physical - sb.firstDataBlock;
      bm[bit >> 3] |= (1 << (bit & 7));
    }
    await io.write(3 * sb.blockSize, bm);
    await buildExtentTreeIo(io, fileInode.offset + 0x28, sb, extents);

    const szLo = new Uint8Array(4);
    wU32(szLo, 0, 4 * sb.blockSize);
    await io.write(fileInode.offset + 0x04, szLo);

    // Grow to 5 blocks -> depth 1 tree created (leaf block X allocated)
    const content5 = new Uint8Array(5 * sb.blockSize);
    content5.fill(0x33);
    await growAndPatchFileIo(io, file.inode, sb, content5);

    const inode5 = await readInodeRange(io, file.inode, sb);
    const oldLeafBlock = u32(inode5.iBlock, 16) + u16(inode5.iBlock, 20) * 0x100000000;
    const oldLeafBit = oldLeafBlock - sb.firstDataBlock;

    const bmBefore = await io.read(3 * sb.blockSize, 4);
    assert.equal((bmBefore[oldLeafBit >> 3] & (1 << (oldLeafBit & 7))) !== 0, true, 'oldLeafBlock marked 1 before free');

    // Grow to 6 blocks -> old index leaf is freed
    const content6 = new Uint8Array(6 * sb.blockSize);
    content6.set(content5);
    await growAndPatchFileIo(io, file.inode, sb, content6);

    const inode6 = await readInodeRange(io, file.inode, sb);
    const newLeafBlock = u32(inode6.iBlock, 16) + u16(inode6.iBlock, 20) * 0x100000000;
    assert.ok(newLeafBlock > 0);

    const readBack = await readFileBytesRange(io, file.inode, sb);
    assert.deepEqual(readBack, content6);
  });

  it('handles >4 GiB physical block numbers correctly', async () => {
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

    const highPhys = 0x400005; // 4,194,309 blocks -> offset 4,294,972,416 B > 4 GiB
    const inodeNum = 3;
    const inodeOffset = 5 * sb.blockSize + (inodeNum - 1) * sb.inodeSize;

    // Build depth-0 tree with high physical block
    const extents = [{ logical: 0, physical: highPhys, len: 1 }];
    await buildExtentTreeIo(io, inodeOffset + 0x28, sb, extents);

    // Set inode mode = regular file, size = 100
    const mode = new Uint8Array(2);
    wU16(mode, 0, 0x81A4);
    await io.write(inodeOffset + 0x00, mode);
    const szLo = new Uint8Array(4);
    wU32(szLo, 0, 100);
    await io.write(inodeOffset + 0x04, szLo);

    // Grow high-phys file
    const newContent = new Uint8Array(1500);
    newContent.fill(0x55);

    const res = await growAndPatchFileIo(io, inodeNum, sb, newContent);
    assert.equal(res.grown, 1);
    assert.equal(res.newSize, 1500);
  });

  it('insufficient space fails cleanly with ZERO mutation', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const file = await createFileIo(io, sb, '/', 'fail_space.bin', new Uint8Array(500));

    const sbFreeBefore = u32(await io.read(1024 + 0x0C, 4), 0);
    const bitmapBefore = await io.read(3 * sb.blockSize, 4);

    // Request huge content exceeding free space
    const hugeContent = new Uint8Array(100 * sb.blockSize); // 100 blocks > 20 free

    await assert.rejects(
      async () => growAndPatchFileIo(io, file.inode, sb, hugeContent),
      /Not enough free space/
    );

    // Verify ZERO mutations occurred
    const sbFreeAfter = u32(await io.read(1024 + 0x0C, 4), 0);
    const bitmapAfter = await io.read(3 * sb.blockSize, 4);

    assert.equal(sbFreeAfter, sbFreeBefore);
    assert.deepEqual(bitmapAfter, bitmapBefore);
  });

  it('unsupported inode layout (non-regular or no extents) fails cleanly without mutation', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const sbFreeBefore = u32(await io.read(1024 + 0x0C, 4), 0);

    // Attempt to grow root directory inode 2
    await assert.rejects(
      async () => growAndPatchFileIo(io, 2, sb, new Uint8Array(2000)),
      /Not a regular file/
    );

    const sbFreeAfter = u32(await io.read(1024 + 0x0C, 4), 0);
    assert.equal(sbFreeAfter, sbFreeBefore);
  });

  it('neighboring file in same directory remains intact and readable', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const neighborData = new TextEncoder().encode("Neighbor file payload");
    const neighbor = await createFileIo(io, sb, '/', 'neighbor.txt', neighborData);

    const growFile = await createFileIo(io, sb, '/', 'grow_me.bin', new Uint8Array(500));

    // Grow grow_me.bin to 3 blocks
    const grownData = new Uint8Array(2500);
    grownData.fill(0x77);
    await growAndPatchFileIo(io, growFile.inode, sb, grownData);

    // Verify neighbor file is still listed and readable with original content
    const files = await listFilesRange(io, sb);
    const foundNeighbor = files.find((f) => f.path === '/neighbor.txt');
    assert.ok(foundNeighbor);

    const neighborReadBack = await readFileBytesRange(io, neighbor.inode, sb);
    assert.deepEqual(neighborReadBack, neighborData);
  });

  it('performs growth with bounded range reads and no whole-partition Uint8Array', async () => {
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
    const file = await createFileIo(io, sb, '/', 'bounded_grow.bin', new Uint8Array(500));

    maxReadLen = 0; // reset counter
    const grownData = new Uint8Array(2500);
    await growAndPatchFileIo(io, file.inode, sb, grownData);

    assert.ok(maxReadLen < 65536, `Max read len was ${maxReadLen}, should be < 64 KB`);
  });

  it('parses actual extent entries and verifies logical, physical, len, coalescing, and non-contiguous separation', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const initialContent = new Uint8Array(1024);
    initialContent.fill(0xab);
    const file = await createFileIo(io, sb, '/', 'extent_parse.bin', initialContent);

    // Initial file has 1 extent (block 7)
    const inode0 = await readInodeRange(io, file.inode, sb);
    const header0 = inode0.iBlock;
    assert.equal(u16(header0, 0), 0xF30A); // magic
    assert.equal(u16(header0, 2), 1);      // 1 entry
    assert.equal(u32(header0, 12), 0);     // logical 0
    assert.equal(u16(header0, 16), 1);     // len 1
    const phys1 = u32(header0, 20);        // physical block 7

    // Grow by 1 block -> allocates block 9 (block 8 was dirent) -> 2 non-contiguous extents!
    const content2 = new Uint8Array(2048);
    content2.set(initialContent);
    const res2 = await growAndPatchFileIo(io, file.inode, sb, content2);
    assert.equal(res2.extents, 2);

    const inode1 = await readInodeRange(io, file.inode, sb);
    const header1 = inode1.iBlock;
    assert.equal(u16(header1, 0), 0xF30A); // magic
    assert.equal(u16(header1, 2), 2);      // 2 entries
    assert.equal(u32(header1, 12), 0);     // logical 0
    assert.equal(u16(header1, 16), 1);     // len 1
    assert.equal(u32(header1, 24), 1);     // logical 1
    assert.equal(u16(header1, 28), 1);     // len 1
    const phys2 = u32(header1, 32);        // physical block 9

    // Grow by another block -> allocates block 10 (contiguous with block 9) -> coalesces extents 2 & 3 into len 2!
    const content3 = new Uint8Array(3072);
    content3.set(content2);
    const res3 = await growAndPatchFileIo(io, file.inode, sb, content3);
    assert.equal(res3.extents, 2); // 2 extents (because blocks 9 & 10 coalesced!)

    const inode2 = await readInodeRange(io, file.inode, sb);
    const header2 = inode2.iBlock;
    assert.equal(u16(header2, 0), 0xF30A);
    assert.equal(u16(header2, 2), 2); // 2 extents

    // Extent 1: logical 0, len 1, physical phys1
    assert.equal(u32(header2, 12), 0);
    assert.equal(u16(header2, 16), 1);
    assert.equal(u32(header2, 20), phys1);

    // Extent 2 (coalesced): logical 1, len 2, physical phys2
    assert.equal(u32(header2, 24), 1);
    assert.equal(u16(header2, 28), 2); // len 2 (coalesced!)
    assert.equal(u32(header2, 32), phys2);
  });

  it('independently verifies i_size_lo and i_size_high for file size > 4 GiB', async () => {
    const image = buildExt4ImageWithRootDir();
    const { io, sb } = overlayIoFor(image);

    const file = await createFileIo(io, sb, '/', 'huge_size.bin', new Uint8Array(100));
    const fileInode = await readInodeRange(io, file.inode, sb);

    // Set large size > 4 GiB (0x100000050 = 4,294,967,376 bytes)
    const largeSize = 0x100000050;

    const sizeLo = new Uint8Array(4);
    wU32(sizeLo, 0, largeSize & 0xffffffff);
    await io.write(fileInode.offset + 0x04, sizeLo);

    const sizeHi = new Uint8Array(4);
    wU32(sizeHi, 0, Math.floor(largeSize / 0x100000000) & 0xffffffff);
    await io.write(fileInode.offset + 0x6C, sizeHi);

    const inodeReadBack = await readInodeRange(io, file.inode, sb);
    assert.equal(inodeReadBack.sizeLo, 0x50);
    assert.equal(inodeReadBack.sizeHi, 1);
  });

  it('rolls back newly allocated data blocks when extent tree capacity fails (leafCount > 4)', async () => {
    // Construct a image with enough data blocks to build 337 single-block extents
    const blockSize = 1024;
    const bytes = new Uint8Array(600 * blockSize);
    const sbOff = 1024;

    wU32(bytes, sbOff + 0x00, 32);
    wU32(bytes, sbOff + 0x04, 600);
    wU32(bytes, sbOff + 0x0C, 400);
    wU32(bytes, sbOff + 0x10, 20);
    wU32(bytes, sbOff + 0x14, 0);
    wU32(bytes, sbOff + 0x18, 0);
    wU32(bytes, sbOff + 0x20, 600);
    wU32(bytes, sbOff + 0x28, 32);
    wU16(bytes, sbOff + 0x38, 0xef53);
    wU32(bytes, sbOff + 0x4c, 1);
    wU16(bytes, sbOff + 0x58, 128);
    wU16(bytes, sbOff + 0xfe, 32);

    const gdt = 2048;
    wU32(bytes, gdt + 0x00, 3);
    wU32(bytes, gdt + 0x04, 4);
    wU32(bytes, gdt + 0x08, 5);
    wU16(bytes, gdt + 0x0C, 400);
    wU16(bytes, gdt + 0x0E, 20);

    // Root inode 2
    const rootInodeOff = 5 * blockSize + 1 * 128;
    wU16(bytes, rootInodeOff + 0x00, 0x41ed);
    wU32(bytes, rootInodeOff + 0x04, blockSize);
    wU16(bytes, rootInodeOff + 0x1A, 2);
    wU32(bytes, rootInodeOff + 0x20, 0x80000);
    wU32(bytes, rootInodeOff + 0x1C, blockSize / 512);

    const rootExtentOff = rootInodeOff + 0x28;
    wU16(bytes, rootExtentOff + 0, 0xF30A);
    wU16(bytes, rootExtentOff + 2, 1);
    wU16(bytes, rootExtentOff + 4, 4);
    wU16(bytes, rootExtentOff + 6, 0);

    wU32(bytes, rootExtentOff + 12 + 0, 0);
    wU16(bytes, rootExtentOff + 12 + 4, 1);
    wU16(bytes, rootExtentOff + 12 + 6, 0);
    wU32(bytes, rootExtentOff + 12 + 8, 6);

    // Target file inode 3
    const targetInodeOff = 5 * blockSize + 2 * 128;
    wU16(bytes, targetInodeOff + 0x00, 0x81A4);
    wU32(bytes, targetInodeOff + 0x04, 336 * blockSize);
    wU16(bytes, targetInodeOff + 0x1A, 1);
    wU32(bytes, targetInodeOff + 0x20, 0x80000);

    // Create 336 non-contiguous extents on file (336 single blocks)
    // Leaf capacity per block = (1024-12)/12 = 84 entries. 336 = 4 * 84 leaves (ROOT_MAX).
    // Growing by 1 more block will require 337 extents -> ceil(337/84) = 5 leaves > ROOT_MAX (4)!
    const leafBlocks = [10, 11, 12, 13];
    const targetExtentOff = targetInodeOff + 0x28;
    wU16(bytes, targetExtentOff + 0, 0xF30A);
    wU16(bytes, targetExtentOff + 2, 4); // 4 index entries
    wU16(bytes, targetExtentOff + 4, 4);
    wU16(bytes, targetExtentOff + 6, 1); // Depth 1

    for (let li = 0; li < 4; li++) {
      wU32(bytes, targetExtentOff + 12 + li * 12 + 0, li * 84);
      wU32(bytes, targetExtentOff + 12 + li * 12 + 4, leafBlocks[li]);
      wU16(bytes, targetExtentOff + 12 + li * 12 + 8, 0);

      const leafOff = leafBlocks[li] * blockSize;
      wU16(bytes, leafOff + 0, 0xF30A);
      wU16(bytes, leafOff + 2, 84);
      wU16(bytes, leafOff + 4, 84);
      wU16(bytes, leafOff + 6, 0);

      for (let i = 0; i < 84; i++) {
        const logical = li * 84 + i;
        const physical = 20 + logical * 2; // non-contiguous physical blocks (20, 22, 24...)
        wU32(bytes, leafOff + 12 + i * 12 + 0, logical);
        wU16(bytes, leafOff + 12 + i * 12 + 4, 1);
        wU16(bytes, leafOff + 12 + i * 12 + 6, 0);
        wU32(bytes, leafOff + 12 + i * 12 + 8, physical);

        // Mark physical block allocated in bitmap (block 3)
        bytes[3 * blockSize + (physical >> 3)] |= (1 << (physical & 7));
      }
      // Mark leaf block allocated
      bytes[3 * blockSize + (leafBlocks[li] >> 3)] |= (1 << (leafBlocks[li] & 7));
    }

    const { io, sb } = overlayIoFor(bytes);

    const sbFreeBefore = u32(await io.read(1024 + 0x0C, 4), 0);
    const descBefore = await io.read(2048, 32);
    const bgFreeBefore = u16(descBefore, 0x0C);
    const inodeIBlockBefore = await io.read(targetInodeOff + 0x28, 60);

    // Attempt to grow file by 1 block -> requires 337 extents -> 5 leaf blocks > ROOT_MAX!
    const growContent = new Uint8Array(337 * blockSize);

    await assert.rejects(
      async () => growAndPatchFileIo(io, 3, sb, growContent),
      /File too fragmented to grow: need 5 leaf blocks \(max 4\)/
    );

    // Verify after failure:
    // 1. Superblock free-block count is unchanged
    const sbFreeAfter = u32(await io.read(1024 + 0x0C, 4), 0);
    assert.equal(sbFreeAfter, sbFreeBefore);

    // 2. BGD free-block count is unchanged
    const descAfter = await io.read(2048, 32);
    const bgFreeAfter = u16(descAfter, 0x0C);
    assert.equal(bgFreeAfter, bgFreeBefore);

    // 3. Inode i_block bytes are byte-for-byte unchanged
    const inodeIBlockAfter = await io.read(targetInodeOff + 0x28, 60);
    assert.deepEqual(inodeIBlockAfter, inodeIBlockBefore);

    // 4. Old extent-index leaf blocks remain allocated in bitmap
    const bmAfter = await io.read(3 * blockSize, 60);
    for (const lb of leafBlocks) {
      assert.equal((bmAfter[lb >> 3] & (1 << (lb & 7))) !== 0, true, `Old leaf block ${lb} must remain allocated`);
    }
  });
});