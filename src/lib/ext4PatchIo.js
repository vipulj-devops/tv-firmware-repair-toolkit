import { computeInPlacePatch } from './ext4.js';
import { readInodeRange, collectExtentsRange } from './ext4Range.js';

function encodePatchContent(newContent) {
  if (typeof newContent === 'string') return new TextEncoder().encode(newContent);
  if (!(newContent instanceof Uint8Array)) throw new Error('newContent must be a string or Uint8Array');
  return newContent;
}

function isReg(inode) {
  return (inode.mode & 0xf000) === 0x8000;
}

function inodeSizeOf(inode) {
  return inode.sizeLo + inode.sizeHi * 0x100000000;
}

export async function patchExistingFileIo(io, inodeNum, sb, newContent) {
  if (!io || typeof io.read !== 'function' || typeof io.write !== 'function') {
    throw new Error('io.read and io.write are required');
  }
  const inode = await readInodeRange(io, inodeNum, sb);
  if (!isReg(inode)) throw new Error('Not a regular file');
  const extents = [];
  await collectExtentsRange(io, inode.iBlock, sb, extents);
  const newBytes = encodePatchContent(newContent);
  const plan = computeInPlacePatch({
    extents,
    blockSize: sb.blockSize,
    inodeOffset: inode.offset,
    origSize: inodeSizeOf(inode),
    newContent: newBytes,
  });
  if (typeof io.writeAll === 'function') await io.writeAll(plan.writes);
  else for (const w of plan.writes) await io.write(w.offset, w.bytes);
  return {
    origSize: plan.origSize,
    newSize: plan.newSize,
    allocatedSpace: plan.allocatedSpace,
    extents: extents.length,
  };
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function wU16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wU32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}

function bgBitmapBlock(descData) {
  const lo = u32(descData, 0x00);
  const hi = u32(descData, 0x20);
  return lo + hi * 0x100000000;
}

function bgInodeBitmapBlock(descData) {
  const lo = u32(descData, 0x04);
  const hi = u32(descData, 0x24);
  return lo + hi * 0x100000000;
}

function bgFreeBlocks(descData) {
  const lo = u16(descData, 0x0C);
  const hi = u16(descData, 0x2C);
  return lo + hi * 0x10000;
}

function setBgFreeBlocks(descData, val) {
  wU16(descData, 0x0C, val & 0xffff);
  wU16(descData, 0x2C, (val >>> 16) & 0xffff);
}

function bgFreeInodes(descData) {
  const lo = u16(descData, 0x0E);
  const hi = u16(descData, 0x2E);
  return lo + hi * 0x10000;
}

function setBgFreeInodes(descData, val) {
  wU16(descData, 0x0E, val & 0xffff);
  wU16(descData, 0x2E, (val >>> 16) & 0xffff);
}

function readSbFreeBlocks(sbData) {
  return u32(sbData, 0x0C) + u32(sbData, 0x158) * 0x100000000;
}

function setSbFreeBlocks(sbData, val) {
  wU32(sbData, 0x0C, val & 0xffffffff);
  wU32(sbData, 0x158, Math.floor(val / 0x100000000) & 0xffffffff);
}

function readSbFreeInodes(sbData) {
  return u32(sbData, 0x10);
}

function setSbFreeInodes(sbData, val) {
  wU32(sbData, 0x10, val & 0xffffffff);
}

function readSbInodesCount(sbData) {
  return u32(sbData, 0x00);
}

export async function allocateInodeIo(io, sb) {
  const sbData = await io.read(1024, sb.descSize >= 64 ? 352 : 264);
  const totalInodes = readSbInodesCount(sbData);

  for (let g = 0; g < sb.numGroups; g++) {
    const descOffset = sb.gdtOffset + g * sb.descSize;
    const descData = await io.read(descOffset, sb.descSize);

    const bitmapBlock = bgInodeBitmapBlock(descData);
    const bitmapOffset = bitmapBlock * sb.blockSize;

    const inodesThisGroup = Math.min(sb.inodesPerGroup, totalInodes - g * sb.inodesPerGroup);
    const bitmapSize = Math.ceil(inodesThisGroup / 8);

    const bitmapData = await io.read(bitmapOffset, bitmapSize);

    for (let bit = 0; bit < inodesThisGroup; bit++) {
      const byteIdx = bit >> 3;
      const mask = 1 << (bit & 7);

      if ((bitmapData[byteIdx] & mask) === 0) {
        bitmapData[byteIdx] |= mask;
        await io.write(bitmapOffset + byteIdx, bitmapData.subarray(byteIdx, byteIdx + 1));

        const freeInodes = bgFreeInodes(descData);
        setBgFreeInodes(descData, freeInodes - 1);
        await io.write(descOffset, descData);

        const sbFreeInodes = readSbFreeInodes(sbData);
        setSbFreeInodes(sbData, sbFreeInodes - 1);
        await io.write(1024, sbData);

        return g * sb.inodesPerGroup + bit + 1;
      }
    }
  }

  throw new Error('No free inodes available.');
}

export async function allocateBlocksIo(io, sb, count) {
  const allocated = [];
  const groupUsed = new Map();

  const sbData = await io.read(1024, sb.descSize >= 64 ? 352 : 264);

  for (let g = 0; g < sb.numGroups && allocated.length < count; g++) {
    const descOffset = sb.gdtOffset + g * sb.descSize;
    const descData = await io.read(descOffset, sb.descSize);

    const bitmapBlock = bgBitmapBlock(descData);
    const bitmapOffset = bitmapBlock * sb.blockSize;
    const bitmapSize = Math.ceil(sb.blocksPerGroup / 8);

    const bitmapData = await io.read(bitmapOffset, bitmapSize);

    for (let bit = 0; bit < sb.blocksPerGroup && allocated.length < count; bit++) {
      const globalBlock = sb.firstDataBlock + g * sb.blocksPerGroup + bit;
      if (globalBlock >= sb.blocksCount) break;

      const byteIdx = bit >> 3;
      const mask = 1 << (bit & 7);

      if ((bitmapData[byteIdx] & mask) === 0) {
        bitmapData[byteIdx] |= mask;
        await io.write(bitmapOffset + byteIdx, bitmapData.subarray(byteIdx, byteIdx + 1));

        allocated.push(globalBlock);
        groupUsed.set(g, (groupUsed.get(g) || 0) + 1);
      }
    }

    if (groupUsed.has(g)) {
      const freeBlocks = bgFreeBlocks(descData);
      setBgFreeBlocks(descData, freeBlocks - groupUsed.get(g));
      await io.write(descOffset, descData);
    }
  }

  if (allocated.length < count) {
    throw new Error(`Not enough free space: need ${count} blocks, only ${allocated.length} available.`);
  }

  const sbFreeBlocks = readSbFreeBlocks(sbData);
  setSbFreeBlocks(sbData, sbFreeBlocks - allocated.length);
  await io.write(1024, sbData);

  return allocated;
}

const ROOT_MAX = 4; // (60 - 12) / 12 entries in the inode i_block area
function leafMax(blockSize) { return Math.floor((blockSize - 12) / 12); }

function writeExtentHeader(bytes, off, entries, max, depth, gen) {
  wU16(bytes, off + 0, 0xF30A);
  wU16(bytes, off + 2, entries);
  wU16(bytes, off + 4, max);
  wU16(bytes, off + 6, depth);
  if (gen != null) wU32(bytes, off + 8, gen);
}

function writeLeafEntry(bytes, off, logical, len, physical) {
  wU32(bytes, off + 0, logical);
  wU16(bytes, off + 4, len & 0x7FFF);
  wU16(bytes, off + 6, Math.floor(physical / 0x100000000) & 0xffff);
  wU32(bytes, off + 8, physical & 0xffffffff);
}

function writeIndexEntry(bytes, off, logical, child) {
  wU32(bytes, off + 0, logical);
  wU32(bytes, off + 4, child & 0xffffffff);
  wU16(bytes, off + 8, Math.floor(child / 0x100000000) & 0xffff);
  wU16(bytes, off + 10, 0);
}

export async function buildExtentTreeIo(io, rootOffset, sb, allExtents) {
  const rootHeader = await io.read(rootOffset, 12);
  const gen = u32(rootHeader, 8);

  if (allExtents.length <= ROOT_MAX) {
    const header = new Uint8Array(12);
    writeExtentHeader(header, 0, allExtents.length, ROOT_MAX, 0, gen);
    await io.write(rootOffset, header);

    for (let i = 0; i < allExtents.length; i++) {
      const entry = new Uint8Array(12);
      const e = allExtents[i];
      writeLeafEntry(entry, 0, e.logical, e.len, e.physical);
      await io.write(rootOffset + 12 + i * 12, entry);
    }

    const zeroEntry = new Uint8Array(12);
    for (let i = allExtents.length; i < ROOT_MAX; i++) {
      await io.write(rootOffset + 12 + i * 12, zeroEntry);
    }
    return;
  }

  const perLeaf = leafMax(sb.blockSize);
  const leafCount = Math.ceil(allExtents.length / perLeaf);
  if (leafCount > ROOT_MAX) {
    throw new Error(`File too fragmented to grow: need ${leafCount} leaf blocks (max ${ROOT_MAX}).`);
  }

  const leafBlocks = await allocateBlocksIo(io, sb, leafCount);
  const indexEntries = [];

  for (let li = 0; li < leafCount; li++) {
    const chunk = allExtents.slice(li * perLeaf, (li + 1) * perLeaf);
    const leafOff = leafBlocks[li] * sb.blockSize;

    const leafHeader = new Uint8Array(12);
    writeExtentHeader(leafHeader, 0, chunk.length, perLeaf, 0, 0);
    await io.write(leafOff, leafHeader);

    for (let i = 0; i < chunk.length; i++) {
      const entry = new Uint8Array(12);
      writeLeafEntry(entry, 0, chunk[i].logical, chunk[i].len, chunk[i].physical);
      await io.write(leafOff + 12 + i * 12, entry);
    }

    const zeroEntry = new Uint8Array(12);
    for (let i = chunk.length; i < perLeaf; i++) {
      await io.write(leafOff + 12 + i * 12, zeroEntry);
    }

    indexEntries.push({ logical: chunk[0].logical, block: leafBlocks[li] });
  }

  const rootHeader2 = new Uint8Array(12);
  writeExtentHeader(rootHeader2, 0, leafCount, ROOT_MAX, 1, gen);
  await io.write(rootOffset, rootHeader2);

  for (let i = 0; i < leafCount; i++) {
    const entry = new Uint8Array(12);
    writeIndexEntry(entry, 0, indexEntries[i].logical, indexEntries[i].block);
    await io.write(rootOffset + 12 + i * 12, entry);
  }

  const zeroEntry = new Uint8Array(12);
  for (let i = leafCount; i < ROOT_MAX; i++) {
    await io.write(rootOffset + 12 + i * 12, zeroEntry);
  }
}

export async function initializeFileInodeIo(io, inodeOffset, sb, inodeNum, extents, fileSize) {
  const blockSize = sb.blockSize;
  const totalBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);
  const now = Math.floor(Date.now() / 1000);

  const mode = new Uint8Array(2);
  wU16(mode, 0, 0x81A4);
  await io.write(inodeOffset + 0x00, mode);

  const sizeLo = new Uint8Array(4);
  wU32(sizeLo, 0, fileSize & 0xffffffff);
  await io.write(inodeOffset + 0x04, sizeLo);

  const sizeHi = new Uint8Array(4);
  wU32(sizeHi, 0, Math.floor(fileSize / 0x100000000) & 0xffffffff);
  await io.write(inodeOffset + 0x6C, sizeHi);

  const links = new Uint8Array(2);
  wU16(links, 0, 1);
  await io.write(inodeOffset + 0x1A, links);

  const flags = new Uint8Array(4);
  wU32(flags, 0, 0x80000);
  await io.write(inodeOffset + 0x20, flags);

  const iBlocks = new Uint8Array(4);
  wU32(iBlocks, 0, (totalBlocks * (blockSize / 512)) & 0xffffffff);
  await io.write(inodeOffset + 0x1C, iBlocks);

  const ts = new Uint8Array(4);
  wU32(ts, 0, now);
  await io.write(inodeOffset + 0x08, ts);
  await io.write(inodeOffset + 0x0C, ts);
  await io.write(inodeOffset + 0x10, ts);
}

export async function writeFileDataIo(io, sb, data, extents) {
  const blockSize = sb.blockSize;
  let written = 0;

  for (const e of extents) {
    for (let b = 0; b < e.len; b++) {
      const dst = (e.physical + b) * blockSize;
      const blockData = new Uint8Array(blockSize);

      if (written < data.length) {
        const chunk = data.subarray(written, Math.min(written + blockSize, data.length));
        blockData.set(chunk);
        written += chunk.length;
        await io.write(dst, blockData);
      } else {
        await io.write(dst, blockData);
      }
    }
  }
}

export async function createNewFileInodeIo(io, sb, inodeNum, extents, data) {
  const inodeSize = sb.inodeSize;
  const group = Math.floor((inodeNum - 1) / sb.inodesPerGroup);
  const index = (inodeNum - 1) % sb.inodesPerGroup;
  const descOffset = sb.gdtOffset + group * sb.descSize;

  const descData = await io.read(descOffset, sb.descSize);
  const inodeTableBlockLo = u32(descData, 0x08);
  const inodeTableBlockHi = sb.descSize >= 64 ? u32(descData, 0x28) : 0;
  const inodeTableBlock = inodeTableBlockLo + inodeTableBlockHi * 0x100000000;

  const inodeOffset = inodeTableBlock * sb.blockSize + index * inodeSize;

  await io.write(inodeOffset, new Uint8Array(inodeSize));
  await writeFileDataIo(io, sb, data, extents);
  await buildExtentTreeIo(io, inodeOffset + 0x28, sb, extents);
  await initializeFileInodeIo(io, inodeOffset, sb, inodeNum, extents, data.length);
}
