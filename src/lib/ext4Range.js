// Reader-backed ext4 access. Parsing matches src/lib/ext4.js but never
// requires a whole-partition Uint8Array.

import { isExt4, parseSuperblock } from './ext4.js';

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

function inodeSizeOf(inode) {
  return inode.sizeLo + inode.sizeHi * 0x100000000;
}
function isDir(inode) { return (inode.mode & 0xf000) === 0x4000; }
function isReg(inode) { return (inode.mode & 0xf000) === 0x8000; }
function isLnk(inode) { return (inode.mode & 0xf000) === 0xa000; }

export async function parseSuperblockRange(reader) {
  const head = await reader.read(0, Math.min(2048, reader.size));
  if (!isExt4(head)) return null;
  return parseSuperblock(head);
}

async function readInodeRange(reader, inodeNum, sb) {
  const group = Math.floor((inodeNum - 1) / sb.inodesPerGroup);
  const index = (inodeNum - 1) % sb.inodesPerGroup;
  const bgd = sb.gdtOffset + group * sb.descSize;
  const desc = await reader.read(bgd, sb.descSize);
  const lo = u32(desc, 0x08);
  const hi = sb.descSize >= 64 ? u32(desc, 0x28) : 0;
  const tableBlock = lo + hi * 0x100000000;
  const off = tableBlock * sb.blockSize + index * sb.inodeSize;
  const raw = await reader.read(off, sb.inodeSize);
  return {
    num: inodeNum,
    offset: off,
    mode: u16(raw, 0x00),
    sizeLo: u32(raw, 0x04),
    sizeHi: u32(raw, 0x6C),
    flags: u32(raw, 0x20),
    iBlock: raw.subarray(0x28, 0x28 + 60),
  };
}

async function collectExtentsRange(reader, node, sb, out) {
  const magic = u16(node, 0);
  if (magic !== 0xf30a) return;
  const entries = u16(node, 2);
  const depth = u16(node, 6);
  const buf = node;
  for (let i = 0; i < entries; i++) {
    const e = 12 + i * 12;
    if (e + 12 > buf.length) break;
    const logical = u32(buf, e);
    if (depth === 0) {
      const len = u16(buf, e + 4) & 0x7fff;
      const startHi = u16(buf, e + 6);
      const startLo = u32(buf, e + 8);
      const physical = startLo + startHi * 0x100000000;
      out.push({ logical, physical, len });
    } else {
      const leafLo = u32(buf, e + 4);
      const leafHi = u16(buf, e + 8);
      const leaf = leafLo + leafHi * 0x100000000;
      const child = await reader.read(leaf * sb.blockSize, sb.blockSize);
      await collectExtentsRange(reader, child, sb, out);
    }
  }
}

async function readDataRange(reader, inode, sb) {
  const extents = [];
  await collectExtentsRange(reader, inode.iBlock, sb, extents);
  const iSize = inodeSizeOf(inode);
  if (!extents.length) {
    if (isLnk(inode) && iSize <= 60) return inode.iBlock.subarray(0, iSize);
    return new Uint8Array(0);
  }
  extents.sort((a, b) => a.logical - b.logical);
  const totalBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);
  const buf = new Uint8Array(Math.min(totalBlocks * sb.blockSize, iSize + sb.blockSize));
  for (const e of extents) {
    for (let b = 0; b < e.len; b++) {
      const dst = (e.logical + b) * sb.blockSize;
      if (dst >= iSize && dst >= buf.length) continue;
      const srcOff = (e.physical + b) * sb.blockSize;
      if (srcOff >= reader.size) continue;
      const chunk = await reader.read(srcOff, Math.min(sb.blockSize, reader.size - srcOff));
      const take = Math.min(chunk.length, buf.length - dst);
      if (take > 0) buf.set(chunk.subarray(0, take), dst);
    }
  }
  return buf.subarray(0, Math.min(buf.length, iSize));
}

function parseDirents(block, blockSize) {
  const entries = [];
  let off = 0;
  while (off + 8 <= block.length) {
    const inode = u32(block, off);
    const recLen = u16(block, off + 4);
    const nameLen = block[off + 6];
    const fileType = block[off + 7];
    if (recLen < 8 || recLen > blockSize) break;
    if (inode !== 0 && nameLen > 0 && nameLen <= 255) {
      let name = '';
      for (let i = 0; i < nameLen; i++) name += String.fromCharCode(block[off + 8 + i]);
      if (name !== '.' && name !== '..') {
        entries.push({ inode, name, fileType, isDir: fileType === 2 });
      }
    }
    off += recLen;
    if (off % blockSize === 0) break;
  }
  return entries;
}

async function listDirRange(reader, inode, sb) {
  const data = await readDataRange(reader, inode, sb);
  const entries = [];
  for (let b = 0; b < data.length; b += sb.blockSize) {
    entries.push(...parseDirents(data.subarray(b, Math.min(b + sb.blockSize, data.length)), sb.blockSize));
  }
  const seen = new Set();
  return entries.filter((e) => {
    const k = e.inode + ':' + e.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function listFilesRange(reader, sb, maxDepth = 8) {
  const files = [];
  const walk = async (inodeNum, path, depth) => {
    if (depth > maxDepth) return;
    const inode = await readInodeRange(reader, inodeNum, sb);
    if (!isDir(inode)) return;
    const entries = await listDirRange(reader, inode, sb);
    for (const e of entries) {
      const child = await readInodeRange(reader, e.inode, sb);
      const childPath = path + '/' + e.name;
      if (isDir(child)) {
        files.push({ path: childPath + '/', inode: e.inode, size: 0, isDir: true, allocated: 0 });
        await walk(e.inode, childPath, depth + 1);
      } else if (isReg(child)) {
        const extents = [];
        await collectExtentsRange(reader, child.iBlock, sb, extents);
        const totalBlocks = extents.reduce((m, x) => Math.max(m, x.logical + x.len), 0);
        files.push({
          path: childPath,
          inode: e.inode,
          size: inodeSizeOf(child),
          isDir: false,
          allocated: extents.length ? totalBlocks * sb.blockSize : inodeSizeOf(child),
        });
      }
    }
  };
  await walk(2, '', 0);
  return files;
}

export async function readFileBytesRange(reader, inodeNum, sb) {
  const inode = await readInodeRange(reader, inodeNum, sb);
  return readDataRange(reader, inode, sb);
}

export async function getAllocatedSpaceRange(reader, inodeNum, sb) {
  const inode = await readInodeRange(reader, inodeNum, sb);
  const extents = [];
  await collectExtentsRange(reader, inode.iBlock, sb, extents);
  if (!extents.length) return inodeSizeOf(inode);
  const totalBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);
  return totalBlocks * sb.blockSize;
}

export async function getFreeSpaceRange(reader, sb) {
  let free = 0;
  for (let g = 0; g < sb.numGroups; g++) {
    const bgd = sb.gdtOffset + g * sb.descSize;
    const desc = await reader.read(bgd, sb.descSize);
    const lo = u16(desc, 0x0C);
    const hi = sb.descSize >= 64 ? u16(desc, 0x2C) : 0;
    free += lo + hi * 0x10000;
  }
  return free * sb.blockSize;
}
