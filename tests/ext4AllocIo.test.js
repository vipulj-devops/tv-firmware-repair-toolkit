import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSuperblock } from '../src/lib/ext4.js';
import { createBufferRangeReader } from '../src/lib/rangeReader.js';
import { createBlockOverlay, wrapReader } from '../src/lib/blockOverlay.js';
import { allocateInodeIo, allocateBlocksIo } from '../src/lib/ext4PatchIo.js';

function wu16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wu32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function buildMinimalExt4() {
  const blockSize = 1024;
  const bytes = new Uint8Array(16 * blockSize);
  const sb = 1024;
  wu32(bytes, sb + 0x00, 16); // s_inodes_count
  wu32(bytes, sb + 0x04, 16); // s_blocks_count_lo
  wu32(bytes, sb + 0x0C, 6);  // s_free_blocks_count_lo
  wu32(bytes, sb + 0x10, 12); // s_free_inodes_count
  wu32(bytes, sb + 0x14, 1);  // s_first_data_block
  wu32(bytes, sb + 0x18, 0);  // s_log_block_size
  wu32(bytes, sb + 0x20, 16); // s_blocks_per_group
  wu32(bytes, sb + 0x28, 16); // s_inodes_per_group
  wu16(bytes, sb + 0x38, 0xef53);
  wu32(bytes, sb + 0x4c, 1);  // s_rev_level
  wu16(bytes, sb + 0x58, 128); // s_inode_size
  wu16(bytes, sb + 0xfe, 32);  // s_desc_size

  const gdt = 2048;
  wu32(bytes, gdt + 0x00, 3);  // bg_block_bitmap
  wu32(bytes, gdt + 0x04, 4);  // bg_inode_bitmap
  wu32(bytes, gdt + 0x08, 5);  // bg_inode_table
  wu16(bytes, gdt + 0x0C, 6);  // bg_free_blocks_count_lo
  wu16(bytes, gdt + 0x0E, 12); // bg_free_inodes_count_lo

  // Block bitmap at block 3 (offset 3072): blocks 0..9 used (0x3F, 0x03)
  bytes[3072] = 0x3f;
  bytes[3073] = 0x03;

  // Inode bitmap at block 4 (offset 4096): inodes 1,2,3,12 used (0x07, 0x08)
  bytes[4096] = 0x07;
  bytes[4097] = 0x08;

  return bytes;
}

function overlayIoFor(image) {
  const overlay = createBlockOverlay();
  const base = createBufferRangeReader(image);
  return { overlay, io: wrapReader(base, overlay), sb: parseSuperblock(image) };
}

describe('allocateInodeIo', () => {
  it('allocates a free inode and updates bitmap, BGD, and Superblock via overlay', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);

    const ino = await allocateInodeIo(io, sb);
    assert.equal(ino, 4); // inodes 1,2,3 used -> next free is 4

    // Verify read-after-write via io.read
    const bitmap = await io.read(4 * 1024, 2);
    assert.equal(bitmap[0], 0x0f); // bit 3 (inode 4) set -> 0x07 | 0x08 = 0x0f

    const desc = await io.read(2048, 32);
    assert.equal(u16(desc, 0x0E), 11); // free inodes 12 -> 11

    const sbHead = await io.read(1024, 32);
    assert.equal(u32(sbHead, 0x10), 11); // sb free inodes 12 -> 11

    assert.equal(overlay.hasWrites(), true);
  });
});

describe('allocateBlocksIo', () => {
  it('allocates single block and updates bitmap, BGD, and Superblock via overlay', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);

    const blocks = await allocateBlocksIo(io, sb, 1);
    assert.deepEqual(blocks, [7]); // blocks 1..6 used (bits 0..5) -> next free is 7 (bit 6)

    const bitmap = await io.read(3 * 1024, 2);
    assert.equal(bitmap[0], 0x7f); // bit 6 (block 7) set -> 0x3f | 0x40 = 0x7f

    const desc = await io.read(2048, 32);
    assert.equal(u16(desc, 0x0C), 5); // free blocks 6 -> 5

    const sbBuf = await io.read(1024 + 0x0C, 4);
    assert.equal(u32(sbBuf, 0), 5); // sb free blocks 6 -> 5

    assert.equal(overlay.hasWrites(), true);
  });

  it('allocates multiple blocks across continuous free bits', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const blocks = await allocateBlocksIo(io, sb, 3);
    assert.deepEqual(blocks, [7, 8, 11]); // bits 6,7 (blocks 7,8) free; bits 8,9 (blocks 9,10) used; bit 10 (block 11) free

    const bitmap = await io.read(3 * 1024, 2);
    assert.equal(bitmap[0], 0xff); // bits 6,7 (blocks 7,8) set -> byte 0 becomes 0xff
    assert.equal(bitmap[1], 0x07); // bit 2 (bit index 10, block 11) set -> 0x03 | 0x04 = 0x07

    const desc = await io.read(2048, 32);
    assert.equal(u16(desc, 0x0C), 3); // 6 -> 3

    const sbBuf = await io.read(1024 + 0x0C, 4);
    assert.equal(u32(sbBuf, 0), 3);
  });
});

describe('allocateBlocksIo across multiple groups', () => {
  it('spills allocation into group 1 when group 0 is full', async () => {
    const blockSize = 1024;
    const bytes = new Uint8Array(64 * blockSize);
    const sb = 1024;
    wu32(bytes, sb + 0x00, 32); // 32 inodes
    wu32(bytes, sb + 0x04, 32); // 32 blocks
    wu32(bytes, sb + 0x0C, 8);  // 8 free blocks total
    wu32(bytes, sb + 0x10, 16); // 16 free inodes
    wu32(bytes, sb + 0x14, 0);  // s_first_data_block
    wu32(bytes, sb + 0x18, 0);
    wu32(bytes, sb + 0x20, 16); // 16 blocks per group
    wu32(bytes, sb + 0x28, 16);
    wu16(bytes, sb + 0x38, 0xef53);
    wu16(bytes, sb + 0x58, 128);
    wu16(bytes, sb + 0xfe, 32);

    const gdt = 2048;
    // Group 0: block bitmap 3, free blocks 2
    wu32(bytes, gdt + 0x00, 3);
    wu16(bytes, gdt + 0x0C, 2);

    // Group 1: block bitmap 4, free blocks 6
    wu32(bytes, gdt + 32 + 0x00, 4);
    wu16(bytes, gdt + 32 + 0x0C, 6);

    // Group 0 bitmap (block 3): 14 blocks used, 2 free (blocks 14, 15)
    bytes[3072] = 0xff;
    bytes[3073] = 0x3f;

    // Group 1 bitmap (block 4): 10 blocks used, 6 free (blocks 16..25 used, 26..31 free)
    bytes[4096] = 0xff;
    bytes[4097] = 0x03;

    const { io, sb: parsedSb } = overlayIoFor(bytes);

    // Request 4 blocks: should take 2 from Group 0 (14, 15) and 2 from Group 1 (26, 27)
    const blocks = await allocateBlocksIo(io, parsedSb, 4);
    assert.deepEqual(blocks, [14, 15, 26, 27]);

    // Check Group 0 BGD
    const desc0 = await io.read(gdt, 32);
    assert.equal(u16(desc0, 0x0C), 0); // 2 -> 0

    // Check Group 1 BGD
    const desc1 = await io.read(gdt + 32, 32);
    assert.equal(u16(desc1, 0x0C), 4); // 6 -> 4

    // Check Superblock free blocks
    const sbBuf = await io.read(sb + 0x0C, 4);
    assert.equal(u32(sbBuf, 0), 4); // 8 -> 4
  });
});

describe('allocateBlocksIo >4 GiB physical block offset mapping', () => {
  it('correctly maps 64-bit BGD block bitmap pointers above 4 GiB', async () => {
    const blockSize = 1024;
    const bytes = new Uint8Array(16 * blockSize);
    const sb = 1024;
    wu32(bytes, sb + 0x00, 16);
    wu32(bytes, sb + 0x04, 16);
    wu32(bytes, sb + 0x0C, 16);
    wu32(bytes, sb + 0x10, 16);
    wu32(bytes, sb + 0x14, 0);
    wu32(bytes, sb + 0x18, 0);
    wu32(bytes, sb + 0x20, 16);
    wu32(bytes, sb + 0x28, 16);
    wu16(bytes, sb + 0x38, 0xef53);
    wu16(bytes, sb + 0x58, 128);
    wu16(bytes, sb + 0xfe, 64); // 64-bit BGD

    const gdt = 2048;
    // Set block bitmap block to 0x100000000 / 1024 = 0x400000
    wu32(bytes, gdt + 0x00, 0x400000); // lo
    wu32(bytes, gdt + 0x20, 0);        // hi
    wu16(bytes, gdt + 0x0C, 16);       // 16 free blocks

    const overlay = createBlockOverlay();
    const io = wrapReader({
      size: 0x200000000, // 8 GiB mock size
      async read(offset, length) {
        if (offset >= 0x100000000) {
          // Bitmap at 4 GiB
          return new Uint8Array(length);
        }
        return bytes.subarray(offset, offset + length);
      },
    }, overlay);

    const parsedSb = parseSuperblock(bytes);
    const blocks = await allocateBlocksIo(io, parsedSb, 1);
    assert.deepEqual(blocks, [0]);

    // Verify write offset to overlay is above 4 GiB (0x100000000)
    const spans = overlay.sortedSpans();
    const bitmapSpan = spans.find((s) => s.offset === 0x100000000);
    assert.ok(bitmapSpan);
    assert.equal(bitmapSpan.offset > 0xffffffff, true);
    assert.equal(bitmapSpan.data[0], 1); // bit 0 set
  });
});

describe('no full-partition Uint8Array allocation during allocation IO', () => {
  it('never reads large chunks when allocating inodes or blocks', async () => {
    const image = buildMinimalExt4();
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
    const ino = await allocateInodeIo(io, sb);
    assert.ok(ino > 0);
    const blks = await allocateBlocksIo(io, sb, 2);
    assert.equal(blks.length, 2);
    assert.ok(maxReadLen < 65536);
  });
});
