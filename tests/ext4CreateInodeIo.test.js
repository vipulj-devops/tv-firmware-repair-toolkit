import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSuperblock } from '../src/lib/ext4.js';
import { createBufferRangeReader } from '../src/lib/rangeReader.js';
import { createBlockOverlay, wrapReader } from '../src/lib/blockOverlay.js';
import { 
  allocateInodeIo, 
  allocateBlocksIo, 
  buildExtentTreeIo, 
  initializeFileInodeIo, 
  writeFileDataIo, 
  createNewFileInodeIo 
} from '../src/lib/ext4PatchIo.js';

function wU16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wU32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function buildMinimalExt4() {
  const blockSize = 1024;
  const bytes = new Uint8Array(64 * blockSize);
  const sb = 1024;
  wU32(bytes, sb + 0x00, 32); // s_inodes_count
  wU32(bytes, sb + 0x04, 32); // s_blocks_count_lo
  wU32(bytes, sb + 0x0C, 16); // s_free_blocks_count_lo
  wU32(bytes, sb + 0x10, 20); // s_free_inodes_count
  wU32(bytes, sb + 0x14, 1);  // s_first_data_block
  wU32(bytes, sb + 0x18, 0);  // s_log_block_size
  wU32(bytes, sb + 0x20, 16); // s_blocks_per_group
  wU32(bytes, sb + 0x28, 16); // s_inodes_per_group
  wU16(bytes, sb + 0x38, 0xef53);
  wU32(bytes, sb + 0x4c, 1);  // s_rev_level
  wU16(bytes, sb + 0x58, 128); // s_inode_size
  wU16(bytes, sb + 0xfe, 32);  // s_desc_size

  const gdt = 2048;
  // Group descriptor 0
  wU32(bytes, gdt + 0x00, 3);  // bg_block_bitmap
  wU32(bytes, gdt + 0x04, 4);  // bg_inode_bitmap
  wU32(bytes, gdt + 0x08, 5);  // bg_inode_table
  wU16(bytes, gdt + 0x0C, 16); // bg_free_blocks_count_lo
  wU16(bytes, gdt + 0x0E, 16); // bg_free_inodes_count_lo

  // Initialize bitmaps (all free initially)
  const blockBitmapOffset = 3 * blockSize;
  for (let i = 0; i < Math.ceil(16 / 8); i++) bytes[blockBitmapOffset + i] = 0;
  
  const inodeBitmapOffset = 4 * blockSize;
  for (let i = 0; i < Math.ceil(16 / 8); i++) bytes[inodeBitmapOffset + i] = 0;

  return bytes;
}

function overlayIoFor(image) {
  const overlay = createBlockOverlay();
  const base = createBufferRangeReader(image);
  return { overlay, io: wrapReader(base, overlay), sb: parseSuperblock(image) };
}

describe('buildExtentTreeIo', () => {
  it('builds simple extent tree that fits in inode (depth 0)', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);
    
    const rootOffset = 5 * sb.blockSize + 0x28; // Inode table block + i_block offset
    const extents = [
      { logical: 0, physical: 7, len: 3 },
      { logical: 3, physical: 10, len: 2 }
    ];
    
    await buildExtentTreeIo(io, rootOffset, sb, extents);
    
    const treeData = await io.read(rootOffset, 60);
    assert.equal(u16(treeData, 0), 0xF30A); // magic
    assert.equal(u16(treeData, 2), 2); // entries
    assert.equal(u16(treeData, 4), 4); // max
    assert.equal(u16(treeData, 6), 0); // depth 0
    
    const entry1 = treeData.subarray(12, 24);
    assert.equal(u32(entry1, 0), 0); // logical
    assert.equal(u16(entry1, 4), 3); // len
    assert.equal(u16(entry1, 6), 0); // physical hi
    assert.equal(u32(entry1, 8), 7); // physical lo
    
    const entry2 = treeData.subarray(24, 36);
    assert.equal(u32(entry2, 0), 3); // logical
    assert.equal(u16(entry2, 4), 2); // len
    assert.equal(u16(entry2, 6), 0); // physical hi
    assert.equal(u32(entry2, 8), 10); // physical lo
    
    assert.equal(overlay.hasWrites(), true);
  });

  it('builds depth 1 extent tree with leaf blocks', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);
    
    const rootOffset = 5 * sb.blockSize + 0x28;
    const extents = [];
    for (let i = 0; i < 100; i++) {
      extents.push({ logical: i * 2, physical: 20 + i, len: 2 });
    }
    
    await buildExtentTreeIo(io, rootOffset, sb, extents);
    
    const rootData = await io.read(rootOffset, 12);
    assert.equal(u16(rootData, 0), 0xF30A); // magic
    assert.equal(u16(rootData, 2), 2); // 2 leaf blocks (100 extents, 84 per leaf)
    assert.equal(u16(rootData, 4), 4); // max
    assert.equal(u16(rootData, 6), 1); // depth 1
    
    const leafBlockMap = new Map();
    for (let i = 0; i < 2; i++) {
      const indexEntry = await io.read(rootOffset + 12 + i * 12, 12);
      const logical = u32(indexEntry, 0);
      const blockLo = u32(indexEntry, 4);
      const blockHi = u16(indexEntry, 8);
      const leafBlock = blockLo + blockHi * 0x100000000;
      leafBlockMap.set(i, { logical, leafBlock });
    }
    
    for (const [idx, info] of leafBlockMap) {
      const leafData = await io.read(info.leafBlock * sb.blockSize, 12);
      assert.equal(u16(leafData, 0), 0xF30A); // leaf magic
      assert.equal(u16(leafData, 6), 0); // leaf depth 0
      assert.equal(overlay.hasWrites(), true);
    }
  });
});

describe('initializeFileInodeIo', () => {
  it('initializes file inode with correct metadata', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);
    
    const inodeOffset = 5 * sb.blockSize; // First inode in table
    const extents = [
      { logical: 0, physical: 7, len: 2 }
    ];
    const fileSize = 1500;
    
    await initializeFileInodeIo(io, inodeOffset, sb, 3, extents, fileSize);
    
    const inodeData = await io.read(inodeOffset, 128);
    assert.equal(u16(inodeData, 0x00), 0x81A4); // mode: regular file 0644
    assert.equal(u32(inodeData, 0x04), fileSize); // size lo
    assert.equal(u16(inodeData, 0x1A), 1); // links_count
    assert.equal(u32(inodeData, 0x20), 0x80000); // EXT4_EXTENTS_FL
    assert.equal(u32(inodeData, 0x1C), 2 * (sb.blockSize / 512)); // i_blocks
    
    const now = Math.floor(Date.now() / 1000);
    const atime = u32(inodeData, 0x08);
    const ctime = u32(inodeData, 0x0C);
    const mtime = u32(inodeData, 0x10);
    assert.ok(atime > 0 && atime <= now);
    assert.ok(ctime > 0 && ctime <= now);
    assert.ok(mtime > 0 && mtime <= now);
    
    assert.equal(overlay.hasWrites(), true);
  });
});

describe('writeFileDataIo', () => {
  it('writes file data to allocated blocks', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);
    
    const extents = [
      { logical: 0, physical: 7, len: 1 },
      { logical: 1, physical: 9, len: 1 }
    ];
    const data = new TextEncoder().encode("Hello, World! This is test data.");
    
    await writeFileDataIo(io, sb, data, extents);
    
    const block7Data = await io.read(7 * sb.blockSize, sb.blockSize);
    const block9Data = await io.read(9 * sb.blockSize, sb.blockSize);
    
    const expectedStart = new TextEncoder().encode("Hello, World! This is test data.");
    for (let i = 0; i < Math.min(data.length, sb.blockSize); i++) {
      assert.equal(block7Data[i], expectedStart[i]);
    }
    
    if (data.length > sb.blockSize) {
      for (let i = 0; i < data.length - sb.blockSize; i++) {
        assert.equal(block9Data[i], expectedStart[sb.blockSize + i]);
      }
    }
    
    assert.equal(overlay.hasWrites(), true);
  });
  
  it('zero-fills remaining space in data blocks', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);
    
    const extents = [
      { logical: 0, physical: 7, len: 1 }
    ];
    const data = new Uint8Array([1, 2, 3]);
    
    await writeFileDataIo(io, sb, data, extents);
    
    const blockData = await io.read(7 * sb.blockSize, sb.blockSize);
    assert.equal(blockData[0], 1);
    assert.equal(blockData[1], 2);
    assert.equal(blockData[2], 3);
    for (let i = 3; i < sb.blockSize; i++) {
      assert.equal(blockData[i], 0);
    }
    
    assert.equal(overlay.hasWrites(), true);
  });
});

describe('createNewFileInodeIo', () => {
  it('creates complete new file inode with data', async () => {
    const image = buildMinimalExt4();
    const { overlay, io, sb } = overlayIoFor(image);

    const inodeNum = await allocateInodeIo(io, sb);
    const blocks = await allocateBlocksIo(io, sb, 2);

    const extents = [
      { logical: 0, physical: blocks[0], len: 1 },
      { logical: 1, physical: blocks[1], len: 1 }
    ];
    const data = new TextEncoder().encode("Test file content");

    await createNewFileInodeIo(io, sb, inodeNum, extents, data);

    const inodeOffset = 5 * sb.blockSize;
    const inodeData = await io.read(inodeOffset, sb.inodeSize);

    assert.equal(u16(inodeData, 0x00), 0x81A4);
    assert.equal(u32(inodeData, 0x04), data.length);
    assert.equal(u16(inodeData, 0x28), 0xF30A);

    const extentRoot = inodeData.subarray(0x28, 0x28 + 60);
    assert.equal(u16(extentRoot, 0), 0xF30A);
    assert.equal(u16(extentRoot, 2), 2);
    assert.equal(u16(extentRoot, 6), 0);
    assert.equal(u32(extentRoot, 12), 0);
    assert.equal(u16(extentRoot, 16), 1);
    assert.equal(u32(extentRoot, 20), blocks[0]);
    assert.equal(u32(extentRoot, 24), 1);
    assert.equal(u16(extentRoot, 28), 1);
    assert.equal(u32(extentRoot, 32), blocks[1]);

    const block1Data = await io.read(blocks[0] * sb.blockSize, Math.min(sb.blockSize, data.length));
    const expectedStart = data.subarray(0, Math.min(sb.blockSize, data.length));
    for (let i = 0; i < expectedStart.length; i++) {
      assert.equal(block1Data[i], expectedStart[i]);
    }

    assert.equal(overlay.hasWrites(), true);
  });

  it('does not clobber the extent tree when initializing inode metadata', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);
    const inodeOffset = 5 * sb.blockSize;
    const extents = [
      { logical: 0, physical: 7, len: 3 },
      { logical: 3, physical: 10, len: 2 }
    ];

    await io.write(inodeOffset, new Uint8Array(sb.inodeSize));
    await buildExtentTreeIo(io, inodeOffset + 0x28, sb, extents);
    await initializeFileInodeIo(io, inodeOffset, sb, 1, extents, 1500);

    const inodeData = await io.read(inodeOffset, sb.inodeSize);
    assert.equal(u16(inodeData, 0x00), 0x81A4);
    assert.equal(u32(inodeData, 0x04), 1500);
    assert.equal(u16(inodeData, 0x28), 0xF30A);
    assert.equal(u16(inodeData, 0x2A), 2);
    assert.equal(u32(inodeData, 0x28 + 12), 0);
    assert.equal(u16(inodeData, 0x28 + 16), 3);
    assert.equal(u32(inodeData, 0x28 + 20), 7);
    assert.equal(u32(inodeData, 0x28 + 24), 3);
    assert.equal(u16(inodeData, 0x28 + 28), 2);
    assert.equal(u32(inodeData, 0x28 + 32), 10);
  });

  it('creates empty file with no data blocks', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const inodeNum = await allocateInodeIo(io, sb);
    const extents = [];
    const data = new Uint8Array(0);

    await createNewFileInodeIo(io, sb, inodeNum, extents, data);

    const inodeOffset = 5 * sb.blockSize;
    const inodeData = await io.read(inodeOffset, sb.inodeSize);

    assert.equal(u16(inodeData, 0x00), 0x81A4);
    assert.equal(u32(inodeData, 0x04), 0);
    assert.equal(u32(inodeData, 0x1C), 0);

    const extentRoot = inodeData.subarray(0x28, 0x28 + 12);
    assert.equal(u16(extentRoot, 0), 0xF30A);
    assert.equal(u16(extentRoot, 2), 0);
    assert.equal(u16(extentRoot, 4), 4);
    assert.equal(u16(extentRoot, 6), 0);
  });

  it('handles partial final block correctly', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const inodeNum = await allocateInodeIo(io, sb);
    const blocks = await allocateBlocksIo(io, sb, 2);

    const extents = [
      { logical: 0, physical: blocks[0], len: 2 }
    ];
    const data = new Uint8Array(1500);
    for (let i = 0; i < data.length; i++) data[i] = (i & 0xff);

    await createNewFileInodeIo(io, sb, inodeNum, extents, data);

    const block1 = await io.read(blocks[0] * sb.blockSize, sb.blockSize);
    const block2 = await io.read(blocks[1] * sb.blockSize, sb.blockSize);

    for (let i = 0; i < sb.blockSize; i++) {
      assert.equal(block1[i], i & 0xff);
    }

    for (let i = 0; i < 1500 - sb.blockSize; i++) {
      assert.equal(block2[i], (sb.blockSize + i) & 0xff);
    }

    for (let i = 1500 - sb.blockSize; i < sb.blockSize; i++) {
      assert.equal(block2[i], 0);
    }
  });
})

describe('buildExtentTreeIo edge cases', () => {
  it('builds depth-0 tree with exactly 4 extents', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const rootOffset = 5 * sb.blockSize + 0x28;
    const extents = [
      { logical: 0, physical: 7, len: 1 },
      { logical: 1, physical: 8, len: 1 },
      { logical: 2, physical: 9, len: 1 },
      { logical: 3, physical: 10, len: 1 }
    ];

    await buildExtentTreeIo(io, rootOffset, sb, extents);

    const treeData = await io.read(rootOffset, 60);
    assert.equal(u16(treeData, 0), 0xF30A);
    assert.equal(u16(treeData, 2), 4);
    assert.equal(u16(treeData, 4), 4);
    assert.equal(u16(treeData, 6), 0);
  });

  it('transitions to depth-1 tree with exactly 5 extents', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const rootOffset = 5 * sb.blockSize + 0x28;
    const extents = [
      { logical: 0, physical: 7, len: 1 },
      { logical: 1, physical: 8, len: 1 },
      { logical: 2, physical: 9, len: 1 },
      { logical: 3, physical: 10, len: 1 },
      { logical: 4, physical: 11, len: 1 }
    ];

    await buildExtentTreeIo(io, rootOffset, sb, extents);

    const rootData = await io.read(rootOffset, 12);
    assert.equal(u16(rootData, 0), 0xF30A);
    assert.equal(u16(rootData, 2), 1);
    assert.equal(u16(rootData, 4), 4);
    assert.equal(u16(rootData, 6), 1);

    const indexEntry = await io.read(rootOffset + 12, 12);
    const leafBlockLo = u32(indexEntry, 4);
    const leafBlockHi = u16(indexEntry, 8);
    const leafBlock = leafBlockLo + leafBlockHi * 0x100000000;

    const leafData = await io.read(leafBlock * sb.blockSize, 12);
    assert.equal(u16(leafData, 0), 0xF30A);
    assert.equal(u16(leafData, 2), 5);
    assert.equal(u16(leafData, 6), 0);
  });

  it('builds depth-1 tree with maximum 4 leaf blocks', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const rootOffset = 5 * sb.blockSize + 0x28;
    const perLeaf = Math.floor((sb.blockSize - 12) / 12);
    const maxExtents = 4 * perLeaf;
    const extents = [];
    for (let i = 0; i < maxExtents; i++) {
      extents.push({ logical: i, physical: 20 + i, len: 1 });
    }

    await buildExtentTreeIo(io, rootOffset, sb, extents);

    const rootData = await io.read(rootOffset, 12);
    assert.equal(u16(rootData, 0), 0xF30A);
    assert.equal(u16(rootData, 2), 4);
    assert.equal(u16(rootData, 4), 4);
    assert.equal(u16(rootData, 6), 1);

    for (let i = 0; i < 4; i++) {
      const indexEntry = await io.read(rootOffset + 12 + i * 12, 12);
      const leafBlockLo = u32(indexEntry, 4);
      const leafBlockHi = u16(indexEntry, 8);
      const leafBlock = leafBlockLo + leafBlockHi * 0x100000000;

      const leafHeader = await io.read(leafBlock * sb.blockSize, 12);
      assert.equal(u16(leafHeader, 0), 0xF30A);
      assert.equal(u16(leafHeader, 6), 0);
    }
  });

  it('preserves extent generation field', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const rootOffset = 5 * sb.blockSize + 0x28;

    const initialTree = new Uint8Array(12);
    wU16(initialTree, 0, 0xF30A);
    wU16(initialTree, 2, 0);
    wU16(initialTree, 4, 4);
    wU16(initialTree, 6, 0);
    wU32(initialTree, 8, 12345);
    await io.write(rootOffset, initialTree);

    const extents = [
      { logical: 0, physical: 7, len: 2 }
    ];

    await buildExtentTreeIo(io, rootOffset, sb, extents);

    const treeData = await io.read(rootOffset, 12);
    assert.equal(u16(treeData, 0), 0xF30A);
    assert.equal(u32(treeData, 8), 12345);
  });
});

describe('64-bit offset handling', () => {
  it('encodes >4 GiB physical block numbers correctly', async () => {
    const image = buildMinimalExt4();
    const { io, sb } = overlayIoFor(image);

    const rootOffset = 5 * sb.blockSize + 0x28;
    const extents = [
      { logical: 0, physical: 0x100000001, len: 1 }
    ];

    await buildExtentTreeIo(io, rootOffset, sb, extents);

    const treeData = await io.read(rootOffset, 60);
    assert.equal(u16(treeData, 0), 0xF30A);

    const entry = treeData.subarray(12, 24);
    assert.equal(u32(entry, 0), 0);
    assert.equal(u16(entry, 4), 1);
    assert.equal(u16(entry, 6), 1);
    assert.equal(u32(entry, 8), 1);
  });

  it('handles >4 GiB inode table offset', async () => {
    // Use 1 KiB blocks so gdtOffset = 2 * 1024 = 2048, matching the GDT
    // written below. Set bg_inode_table lo=1, hi=1 so that
    //   inodeTableBlock = 1 + 1 * 0x100000000 = 0x100000001
    // and inodeOffset = 0x100000001 * 1024 > 4 GiB.
    const blockSize = 1024;
    const bytes = new Uint8Array(16 * blockSize);
    const sbOff = 1024;
    wU32(bytes, sbOff + 0x00, 16);
    wU32(bytes, sbOff + 0x04, 16);
    wU32(bytes, sbOff + 0x0C, 16);
    wU32(bytes, sbOff + 0x10, 16);
    wU32(bytes, sbOff + 0x14, 0);
    wU32(bytes, sbOff + 0x18, 0);  // s_log_block_size = 0 → 1 KiB blocks
    wU32(bytes, sbOff + 0x20, 16);
    wU32(bytes, sbOff + 0x28, 16);
    wU16(bytes, sbOff + 0x38, 0xef53);
    wU32(bytes, sbOff + 0x4c, 1);
    wU16(bytes, sbOff + 0x58, 128);
    wU16(bytes, sbOff + 0xfe, 64);  // 64-byte descriptors

    // gdtOffset = 2 * 1024 = 2048 for 1 KiB blocks
    const gdt = 2048;
    wU32(bytes, gdt + 0x00, 3);   // bg_block_bitmap
    wU32(bytes, gdt + 0x04, 4);   // bg_inode_bitmap
    wU32(bytes, gdt + 0x08, 1);   // bg_inode_table lo = 1
    wU32(bytes, gdt + 0x28, 1);   // bg_inode_table hi = 1  → block 0x100000001
    wU16(bytes, gdt + 0x0C, 16);
    wU16(bytes, gdt + 0x0E, 16);

    const overlay = createBlockOverlay();
    // inodeOffset = 0x100000001 * 1024 = 0x40000000400; size must exceed it.
    const mockSize = 0x40000001000;
    const io = wrapReader({
      size: mockSize,
      async read(offset, length) {
        if (offset < bytes.length) {
          return bytes.subarray(offset, Math.min(bytes.length, offset + length));
        }
        return new Uint8Array(length);
      },
    }, overlay);

    const parsedSb = parseSuperblock(bytes);
    assert.equal(parsedSb.blockSize, 1024);
    assert.equal(parsedSb.gdtOffset, 2048);
    assert.equal(parsedSb.descSize, 64);

    const inodeNum = 1;
    const group = Math.floor((inodeNum - 1) / parsedSb.inodesPerGroup);
    const index = (inodeNum - 1) % parsedSb.inodesPerGroup;
    const descOffset = parsedSb.gdtOffset + group * parsedSb.descSize;

    const descData = await io.read(descOffset, parsedSb.descSize);
    const inodeTableBlockLo = u32(descData, 0x08);
    const inodeTableBlockHi = parsedSb.descSize >= 64 ? u32(descData, 0x28) : 0;
    const inodeTableBlock = inodeTableBlockLo + inodeTableBlockHi * 0x100000000;
    const inodeOffset = inodeTableBlock * parsedSb.blockSize + index * parsedSb.inodeSize;

    assert.equal(inodeTableBlock, 0x100000001);
    assert.ok(inodeOffset > 0x100000000);

    const extents = [{ logical: 0, physical: 7, len: 1 }];
    await io.write(inodeOffset, new Uint8Array(parsedSb.inodeSize));
    await buildExtentTreeIo(io, inodeOffset + 0x28, parsedSb, extents);

    const spans = overlay.sortedSpans();
    const inodeSpan = spans.find((s) => s.offset >= 0x100000000);
    assert.ok(inodeSpan);
    assert.ok(inodeSpan.offset > 0xffffffff);
  });
});