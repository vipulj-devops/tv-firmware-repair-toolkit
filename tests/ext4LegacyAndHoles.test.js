import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isExt4, parseSuperblock, readFileBytes, readFileBytesWithInfo, getAllocatedSpace } from '../src/lib/ext4.js';
import { parseSuperblockRange, readFileBytesRange, readFileBytesRangeWithInfo, getAllocatedSpaceRange } from '../src/lib/ext4Range.js';
import { createRangeReader } from '../src/lib/rangeReader.js';
import { buildExt4FileOffsetMap } from '../src/lib/ext4OffsetMap.js';

function w16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function w32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}

// Create a minimal valid synthetic EXT4 filesystem image in a Uint8Array
function createTestExt4Fs({ blockSize = 1024, totalBlocks = 200 } = {}) {
  const bytes = new Uint8Array(totalBlocks * blockSize);
  const sbOff = 1024;
  w16(bytes, sbOff + 0x38, 0xef53); // magic
  w32(bytes, sbOff + 0x18, blockSize === 1024 ? 0 : 2); // logBlockSize (0 = 1024, 2 = 4096)
  w32(bytes, sbOff + 0x04, totalBlocks); // blocksCount
  w32(bytes, sbOff + 0x20, 1000); // blocksPerGroup
  w32(bytes, sbOff + 0x28, 32); // inodesPerGroup
  w16(bytes, sbOff + 0x58, 128); // inodeSize
  w16(bytes, sbOff + 0xfe, 32); // descSize
  w32(bytes, sbOff + 0x14, blockSize === 1024 ? 1 : 0); // firstDataBlock

  const gdtOff = blockSize === 1024 ? 2048 : blockSize;
  const inodeTableBlock = 3;
  w32(bytes, gdtOff + 0x08, inodeTableBlock); // GDT inode table lo block pointer

  return {
    bytes,
    sb: parseSuperblock(bytes),
    inodeTableOffset: inodeTableBlock * blockSize,
    setupInode(inodeNum, { mode = 0x81a4, size = 0, flags = 0 }) {
      const off = inodeTableBlock * blockSize + (inodeNum - 1) * 128;
      w16(bytes, off + 0x00, mode);
      w32(bytes, off + 0x04, size & 0xffffffff);
      w32(bytes, off + 0x6c, Math.floor(size / 0x100000000) & 0xffffffff);
      w32(bytes, off + 0x20, flags);
      return off;
    },
    writeBlock(blockNum, data) {
      const off = blockNum * blockSize;
      if (typeof data === 'string') {
        const enc = new TextEncoder().encode(data);
        bytes.set(enc, off);
      } else {
        bytes.set(data, off);
      }
    },
    writePointerArray(blockNum, pointers) {
      const off = blockNum * blockSize;
      for (let i = 0; i < pointers.length; i++) {
        w32(bytes, off + i * 4, pointers[i]);
      }
    },
    makeReader() {
      return createRangeReader({
        startByte: 0,
        size: bytes.length,
        maxRead: 64 * 1024,
        readAbsolute: async (start, end) => bytes.subarray(start, end),
      });
    }
  };
}

describe('EXT4 Legacy Block Mapping & Hole Handling Tests', () => {
  it('A. Legacy direct block file: parses 12 direct pointers and coalesces extents', async () => {
    const fs = createTestExt4Fs({ blockSize: 1024 });
    const inodeOff = fs.setupInode(12, { size: 2048, flags: 0 });

    // i_block pointers: blocks 10 and 11
    w32(fs.bytes, inodeOff + 0x28 + 0 * 4, 10);
    w32(fs.bytes, inodeOff + 0x28 + 1 * 4, 11);

    fs.writeBlock(10, 'BLOCK_10_DATA_AA');
    fs.writeBlock(11, 'BLOCK_11_DATA_BB');

    // Test Memory mode
    const memRes = readFileBytesWithInfo(fs.bytes, 12, fs.sb);
    assert.equal(memRes.bytes.length, 2048);
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(0, 16)), 'BLOCK_10_DATA_AA');
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(1024, 1040)), 'BLOCK_11_DATA_BB');
    assert.deepEqual(memRes.extents, [{ logical: 0, physical: 10, len: 2 }]);

    // Test Range-backed mode
    const reader = fs.makeReader();
    const sbRange = await parseSuperblockRange(reader);
    const rangeRes = await readFileBytesRangeWithInfo(reader, 12, sbRange);
    assert.equal(rangeRes.bytes.length, 2048);
    assert.equal(new TextDecoder().decode(rangeRes.bytes.subarray(0, 16)), 'BLOCK_10_DATA_AA');
    assert.equal(new TextDecoder().decode(rangeRes.bytes.subarray(1024, 1040)), 'BLOCK_11_DATA_BB');
    assert.deepEqual(rangeRes.extents, [{ logical: 0, physical: 10, len: 2 }]);
  });

  it('B. Legacy single indirect file: parses i_block[12] indirect table', async () => {
    const fs = createTestExt4Fs({ blockSize: 1024 });
    const ptrsPerBlock = 1024 / 4; // 256
    const size = (12 + 4) * 1024; // 16 blocks total
    const inodeOff = fs.setupInode(13, { size, flags: 0 });

    // 12 Direct blocks: blocks 20..31
    for (let i = 0; i < 12; i++) {
      w32(fs.bytes, inodeOff + 0x28 + i * 4, 20 + i);
      fs.writeBlock(20 + i, `DIR_${i.toString().padStart(2, '0')}`);
    }

    // Single indirect pointer: block 32
    w32(fs.bytes, inodeOff + 0x28 + 12 * 4, 32);
    // Write indirect table at block 32 pointing to blocks 33, 34, 35, 36
    fs.writePointerArray(32, [33, 34, 35, 36]);
    for (let i = 0; i < 4; i++) {
      fs.writeBlock(33 + i, `IND_${i.toString().padStart(2, '0')}`);
    }

    const memRes = readFileBytesWithInfo(fs.bytes, 13, fs.sb);
    assert.equal(memRes.bytes.length, size);
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(0, 6)), 'DIR_00');
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(12 * 1024, 12 * 1024 + 6)), 'IND_00');
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(15 * 1024, 15 * 1024 + 6)), 'IND_03');
    // Coalesced into a single 16-block extent since blocks 20..36 are contiguous!
    assert.deepEqual(memRes.extents, [{ logical: 0, physical: 20, len: 16 }]);

    const reader = fs.makeReader();
    const sbRange = await parseSuperblockRange(reader);
    const rangeRes = await readFileBytesRangeWithInfo(reader, 13, sbRange);
    assert.equal(rangeRes.bytes.length, size);
    assert.equal(new TextDecoder().decode(rangeRes.bytes.subarray(12 * 1024, 12 * 1024 + 6)), 'IND_00');
    assert.deepEqual(rangeRes.extents, [{ logical: 0, physical: 20, len: 16 }]);
  });

  it('C. Legacy double indirect file: parses i_block[13] double indirect table', async () => {
    const fs = createTestExt4Fs({ blockSize: 1024 });
    const ptrsPerBlock = 1024 / 4; // 256
    const logicalTarget = 12 + ptrsPerBlock; // 268th block
    const inodeOff = fs.setupInode(14, { size: (logicalTarget + 1) * 1024, flags: 0 });

    // Double indirect pointer: block 50
    w32(fs.bytes, inodeOff + 0x28 + 13 * 4, 50);
    // Block 50 (double ind) -> index 0 points to block 51 (single ind)
    fs.writePointerArray(50, [51]);
    // Block 51 (single ind) -> index 0 points to block 52 (data block)
    fs.writePointerArray(51, [52]);
    fs.writeBlock(52, 'DOUBLE_INDIRECT_DATA');

    const memRes = readFileBytesWithInfo(fs.bytes, 14, fs.sb);
    assert.equal(memRes.bytes.length, (logicalTarget + 1) * 1024);
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(logicalTarget * 1024, logicalTarget * 1024 + 20)), 'DOUBLE_INDIRECT_DATA');
    assert.deepEqual(memRes.extents, [{ logical: logicalTarget, physical: 52, len: 1 }]);

    const reader = fs.makeReader();
    const sbRange = await parseSuperblockRange(reader);
    const rangeRes = await readFileBytesRangeWithInfo(reader, 14, sbRange);
    assert.equal(new TextDecoder().decode(rangeRes.bytes.subarray(logicalTarget * 1024, logicalTarget * 1024 + 20)), 'DOUBLE_INDIRECT_DATA');
  });

  it('D. Legacy triple indirect file: parses i_block[14] triple indirect table', async () => {
    const fs = createTestExt4Fs({ blockSize: 1024 });
    const ptrsPerBlock = 1024 / 4; // 256
    const logicalTarget = 12 + ptrsPerBlock + ptrsPerBlock * ptrsPerBlock; // 65804th block
    const inodeOff = fs.setupInode(15, { size: 70000 * 1024, flags: 0 });

    // Triple indirect pointer: block 60
    w32(fs.bytes, inodeOff + 0x28 + 14 * 4, 60);
    // Block 60 (triple ind) -> index 0 points to block 61 (double ind)
    fs.writePointerArray(60, [61]);
    // Block 61 (double ind) -> index 0 points to block 62 (single ind)
    fs.writePointerArray(61, [62]);
    // Block 62 (single ind) -> index 0 points to block 63 (data block)
    fs.writePointerArray(62, [63]);
    fs.writeBlock(63, 'TRIPLE_INDIRECT_DATA');

    const memRes = readFileBytesWithInfo(fs.bytes, 15, fs.sb);
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(logicalTarget * 1024, logicalTarget * 1024 + 20)), 'TRIPLE_INDIRECT_DATA');
    assert.deepEqual(memRes.extents, [{ logical: logicalTarget, physical: 63, len: 1 }]);
  });

  it('E. Sparse file: zero-fills unallocated block holes up to inodeSize', async () => {
    const fs = createTestExt4Fs({ blockSize: 1024 });
    const inodeOff = fs.setupInode(16, { size: 5000, flags: 0 });

    // Only block 0 is allocated (block 10), blocks 1..4 are holes (unallocated)
    w32(fs.bytes, inodeOff + 0x28 + 0 * 4, 10);
    fs.writeBlock(10, 'SPARSE_HEADER_DATA');

    const memRes = readFileBytesWithInfo(fs.bytes, 16, fs.sb);
    assert.equal(memRes.bytes.length, 5000);
    assert.equal(new TextDecoder().decode(memRes.bytes.subarray(0, 18)), 'SPARSE_HEADER_DATA');
    // Verify bytes after block 0 are zero-filled
    assert.equal(memRes.bytes[1024], 0);
    assert.equal(memRes.bytes[4999], 0);

    const reader = fs.makeReader();
    const sbRange = await parseSuperblockRange(reader);
    const rangeRes = await readFileBytesRangeWithInfo(reader, 16, sbRange);
    assert.equal(rangeRes.bytes.length, 5000);
    assert.equal(rangeRes.bytes[1024], 0);
  });

  it('F. Inline data (EXT4_INLINE_DATA_FL): reads inline bytes without false physical offsets', async () => {
    const fs = createTestExt4Fs({ blockSize: 1024 });
    const INLINE_FLAG = 0x10000000;
    const inodeOff = fs.setupInode(17, { size: 24, flags: INLINE_FLAG });

    // Store "INLINE_EXT4_DATA_PAYLOAD!" in i_block area
    const enc = new TextEncoder().encode('INLINE_EXT4_DATA_PAYLOAD!');
    fs.bytes.set(enc, inodeOff + 0x28);

    const memRes = readFileBytesWithInfo(fs.bytes, 17, fs.sb);
    assert.equal(memRes.bytes.length, 24);
    assert.equal(new TextDecoder().decode(memRes.bytes), 'INLINE_EXT4_DATA_PAYLOAD');
    assert.deepEqual(memRes.extents, []); // No physical data block extents

    const reader = fs.makeReader();
    const sbRange = await parseSuperblockRange(reader);
    const rangeRes = await readFileBytesRangeWithInfo(reader, 17, sbRange);
    assert.equal(rangeRes.bytes.length, 24);
    assert.equal(new TextDecoder().decode(rangeRes.bytes), 'INLINE_EXT4_DATA_PAYLOAD');
    assert.deepEqual(rangeRes.extents, []);

    // Offset map check: inline data returns unmapped/sparse
    const { map } = buildExt4FileOffsetMap({
      extents: memRes.extents,
      blockSize: fs.sb.blockSize,
      partitionStartByte: 0,
      fileSize: 24,
    });
    assert.equal(map.toPhysical(0).reason, 'sparse');
  });

  it('G. WithInfo behavior: single extent traversal and correct physical offset calculation', async () => {
    const fs = createTestExt4Fs({ blockSize: 4096 });
    const inodeOff = fs.setupInode(51, { size: 852, flags: 0 });
    w32(fs.bytes, inodeOff + 0x28 + 0 * 4, 1326);
    fs.writeBlock(1326, 'PANEL_BIN_HEADER_TEST_BYTES');

    const info = readFileBytesWithInfo(fs.bytes, 51, fs.sb);
    assert.equal(info.bytes.length, 852);
    assert.deepEqual(info.extents, [{ logical: 0, physical: 1326, len: 1 }]);

    const { map } = buildExt4FileOffsetMap({
      extents: info.extents,
      blockSize: 4096,
      partitionStartByte: 100000,
      fileSize: 852,
    });

    const phys = map.toPhysical(0);
    assert.equal(phys.reason, 'mapped');
    assert.equal(phys.physicalOffset, 100000 + 1326 * 4096);
  });

  it('H. Real dump regression check (G:\\factory.bin panel.bin / inode 51) if file is present', () => {
    const factoryPath = 'G:\\factory.bin';
    if (!existsSync(factoryPath)) {
      return; // Skip if test runner machine doesn't have local G drive
    }
    const factoryBytes = readFileSync(factoryPath);
    const sb = parseSuperblock(factoryBytes);
    assert.ok(isExt4(factoryBytes), 'factory.bin should be valid ext4');

    const panelInfo = readFileBytesWithInfo(factoryBytes, 51, sb);
    assert.equal(panelInfo.bytes.length, 852, 'panel.bin should be 852 bytes');
    assert.deepEqual(panelInfo.extents, [{ logical: 0, physical: 1326, len: 1 }]);

    const hexSnippet = Buffer.from(panelInfo.bytes.subarray(0, 32)).toString('hex');
    assert.equal(hexSnippet, 'c13058024e023c0080b867233011ca080f05180118102d009d08007880433011');
  });
});
