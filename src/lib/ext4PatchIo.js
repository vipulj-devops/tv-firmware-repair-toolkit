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
