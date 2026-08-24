// Minimal ext4 read-only parser + in-place file patcher.
// Supports: superblock, 64-bit block group descriptors, extents (incl. index depth),
// linear directory entries. Patching writes new content into existing data blocks
// (same size or smaller; updates i_size). No block allocation / repack.

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u48(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

export function isExt4(bytes) {
  if (bytes.length < 2048) return false;
  return u16(bytes, 1024 + 0x38) === 0xef53;
}

export function parseSuperblock(bytes) {
  const sb = 1024;
  const logBlockSize = u32(bytes, sb + 0x18);
  const blockSize = 1024 << logBlockSize;
  const blocksCount = u32(bytes, sb + 0x04) + u32(bytes, sb + 0x150) * 0x100000000;
  const blocksPerGroup = u32(bytes, sb + 0x20);
  const inodesPerGroup = u32(bytes, sb + 0x28);
  const inodeSize = u16(bytes, sb + 0x58) || 128;
  let descSize = u16(bytes, sb + 0xFE);
  if (!descSize) descSize = 32;
  const numGroups = Math.ceil(blocksCount / blocksPerGroup);
  const gdtBlock = blockSize === 1024 ? 2 : 1;
  return {
    magic: u16(bytes, sb + 0x38),
    blockSize,
    blocksCount,
    blocksPerGroup,
    inodesPerGroup,
    inodeSize,
    descSize,
    numGroups,
    firstDataBlock: u32(bytes, sb + 0x14),
    gdtOffset: gdtBlock * blockSize,
  };
}

function inodeTableOffset(bytes, inodeNum, sb) {
  const group = Math.floor((inodeNum - 1) / sb.inodesPerGroup);
  const index = (inodeNum - 1) % sb.inodesPerGroup;
  const bgd = sb.gdtOffset + group * sb.descSize;
  const lo = u32(bytes, bgd + 0x08);
  const hi = sb.descSize >= 64 ? u32(bytes, bgd + 0x28) : 0;
  const tableBlock = lo + hi * 0x100000000;
  return tableBlock * sb.blockSize + index * sb.inodeSize;
}

function readInode(bytes, inodeNum, sb) {
  const off = inodeTableOffset(bytes, inodeNum, sb);
  return {
    num: inodeNum,
    offset: off,
    mode: u16(bytes, off + 0x00),
    sizeLo: u32(bytes, off + 0x04),
    sizeHi: u32(bytes, off + 0x6C),
    flags: u32(bytes, off + 0x20),
    blockOff: off + 0x28,
  };
}

function inodeSize(inode) {
  return inode.sizeLo + inode.sizeHi * 0x100000000;
}

function isDir(inode) { return (inode.mode & 0xf000) === 0x4000; }
function isReg(inode) { return (inode.mode & 0xf000) === 0x8000; }
function isSymlink(inode) { return (inode.mode & 0xf000) === 0xa000; }

// Collect (logicalBlock, physicalBlock, len) by walking the extent tree.
function collectExtents(bytes, blockOff, sb, out) {
  const magic = u16(bytes, blockOff);
  if (magic !== 0xf30a) return; // not extent-mapped (legacy indirect blocks unsupported)
  const entries = u16(bytes, blockOff + 2);
  const depth = u16(bytes, blockOff + 6);
  for (let i = 0; i < entries; i++) {
    const e = blockOff + 12 + i * 12;
    const logical = u32(bytes, e);
    if (depth === 0) {
      let len = u16(bytes, e + 4) & 0x7fff;
      const startHi = u16(bytes, e + 6);
      const startLo = u32(bytes, e + 8);
      const physical = startLo + startHi * 0x100000000;
      out.push({ logical, physical, len });
    } else {
      const leafLo = u32(bytes, e + 4);
      const leafHi = u16(bytes, e + 8);
      const leaf = leafLo + leafHi * 0x100000000;
      collectExtents(bytes, leaf * sb.blockSize, sb, out);
    }
  }
}

function readDataBytes(bytes, inode, sb) {
  const extents = [];
  collectExtents(bytes, inode.blockOff, sb, extents);
  if (!extents.length) {
    // fast symlink: data stored inline in i_block area
    if (isSymlink(inode) && inodeSize(inode) <= 60) {
      const s = inodeSize(inode);
      const arr = new Uint8Array(s);
      for (let i = 0; i < s; i++) arr[i] = bytes[inode.blockOff + i];
      return arr;
    }
    return new Uint8Array(0);
  }
  extents.sort((a, b) => a.logical - b.logical);
  const totalBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);
  const buf = new Uint8Array(totalBlocks * sb.blockSize);
  for (const e of extents) {
    for (let b = 0; b < e.len; b++) {
      const src = (e.physical + b) * sb.blockSize;
      const dst = (e.logical + b) * sb.blockSize;
      if (src + sb.blockSize > bytes.length) continue;
      buf.set(bytes.subarray(src, src + sb.blockSize), dst);
    }
  }
  return buf.subarray(0, Math.min(buf.length, inodeSize(inode)));
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
    if (off % blockSize === 0) break; // next block
  }
  return entries;
}

function listDirEntries(bytes, inode, sb) {
  const data = readDataBytes(bytes, inode, sb);
  const entries = [];
  for (let b = 0; b < data.length; b += sb.blockSize) {
    const block = data.subarray(b, Math.min(b + sb.blockSize, data.length));
    entries.push(...parseDirents(block, sb.blockSize));
  }
  // dedupe by inode+name (htree index blocks may produce duplicates)
  const seen = new Set();
  return entries.filter((e) => {
    const k = e.inode + ':' + e.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function listFiles(bytes, sb, maxDepth = 8) {
  if (!isExt4(bytes)) return [];
  const files = [];
  const walk = (inodeNum, path, depth) => {
    if (depth > maxDepth) return;
    const inode = readInode(bytes, inodeNum, sb);
    if (!isDir(inode)) return;
    const entries = listDirEntries(bytes, inode, sb);
    for (const e of entries) {
      const child = readInode(bytes, e.inode, sb);
      const childPath = path + '/' + e.name;
      if (isDir(child)) {
        files.push({ path: childPath + '/', inode: e.inode, size: 0, isDir: true });
        walk(e.inode, childPath, depth + 1);
      } else if (isReg(child)) {
        files.push({ path: childPath, inode: e.inode, size: inodeSize(child), isDir: false });
      }
    }
  };
  walk(2, '', 0);
  return files;
}

export function readFileBytes(bytes, inodeNum, sb) {
  const inode = readInode(bytes, inodeNum, sb);
  return readDataBytes(bytes, inode, sb);
}

// Get the total allocated block space for a file (block-aligned, >= i_size).
export function getAllocatedSpace(bytes, inodeNum, sb) {
  const inode = readInode(bytes, inodeNum, sb);
  const extents = [];
  collectExtents(bytes, inode.blockOff, sb, extents);
  if (!extents.length) return inodeSize(inode);
  extents.sort((a, b) => a.logical - b.logical);
  const totalBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);
  return totalBlocks * sb.blockSize;
}

function encodePatchContent(newContent) {
  if (typeof newContent === 'string') return new TextEncoder().encode(newContent);
  if (!(newContent instanceof Uint8Array)) throw new Error('newContent must be a string or Uint8Array');
  return newContent;
}

function u32le(value) {
  const out = new Uint8Array(4);
  let v = value;
  for (let i = 0; i < 4; i += 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

// Shared in-place patch planner. Writes existing extent blocks only;
// never allocates filesystem blocks. Callers apply `writes` to a Uint8Array
// or overlay IO.
export function computeInPlacePatch({ extents, blockSize, inodeOffset, origSize, newContent }) {
  if (!(newContent instanceof Uint8Array)) throw new Error('newContent must be a Uint8Array');
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('blockSize must be a positive safe integer');
  if (!Number.isSafeInteger(inodeOffset) || inodeOffset < 0) throw new Error('inodeOffset must be a safe integer >= 0');
  if (!Number.isSafeInteger(origSize) || origSize < 0) throw new Error('origSize must be a safe integer >= 0');
  if (!extents || !extents.length) {
    throw new Error('File has no extent-mapped data blocks (unsupported layout).');
  }
  const sorted = extents.slice().sort((a, b) => a.logical - b.logical);
  const totalBlocks = sorted.reduce((m, e) => Math.max(m, e.logical + e.len), 0);
  const allocatedSpace = totalBlocks * blockSize;
  if (!Number.isSafeInteger(allocatedSpace)) {
    throw new Error('allocated extent span is not a safe integer');
  }
  if (newContent.length > allocatedSpace) {
    throw new Error(`New content (${newContent.length} B) exceeds allocated block space (${allocatedSpace} B). In-place edit cannot grow beyond allocated blocks.`);
  }

  const writes = [];
  let written = 0;
  for (const e of sorted) {
    for (let b = 0; b < e.len; b += 1) {
      const dst = (e.physical + b) * blockSize;
      if (!Number.isSafeInteger(dst) || dst < 0) {
        throw new Error('extent physical offset is not a safe integer');
      }
      const chunk = new Uint8Array(blockSize);
      if (written < newContent.length) {
        const take = Math.min(blockSize, newContent.length - written);
        chunk.set(newContent.subarray(written, written + take), 0);
        written += take;
      }
      writes.push({ offset: dst, bytes: chunk });
    }
  }

  const newSize = newContent.length;
  if (newSize !== origSize) {
    const sizeLo = newSize % 0x100000000;
    const sizeHi = Math.floor(newSize / 0x100000000);
    writes.push({ offset: inodeOffset + 0x04, bytes: u32le(sizeLo) });
    writes.push({ offset: inodeOffset + 0x6C, bytes: u32le(sizeHi) });
  }
  return { writes, origSize, newSize, allocatedSpace };
}

// Patch a regular file's content in place. newContent can grow up to the
// file's allocated block space (block-aligned size), but not beyond it.
export function patchFile(bytes, inodeNum, sb, newContent) {
  const inode = readInode(bytes, inodeNum, sb);
  if (!isReg(inode)) throw new Error('Not a regular file');
  const origSize = inodeSize(inode);
  const newBytes = encodePatchContent(newContent);
  const extents = [];
  collectExtents(bytes, inode.blockOff, sb, extents);
  const plan = computeInPlacePatch({
    extents,
    blockSize: sb.blockSize,
    inodeOffset: inode.offset,
    origSize,
    newContent: newBytes,
  });
  for (const w of plan.writes) bytes.set(w.bytes, w.offset);
  return { origSize: plan.origSize, newSize: plan.newSize, allocatedSpace: plan.allocatedSpace, extents: extents.length };
}

// ============================================================
// Block allocation & extent-tree growth
// ============================================================

function wU16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wU32(b, o, v) {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}

function bgBitmapBlock(bytes, group, sb) {
  const bgd = sb.gdtOffset + group * sb.descSize;
  const lo = u32(bytes, bgd + 0x00);
  const hi = sb.descSize >= 64 ? u32(bytes, bgd + 0x20) : 0;
  return lo + hi * 0x100000000;
}
function bgFreeBlocks(bytes, group, sb) {
  const bgd = sb.gdtOffset + group * sb.descSize;
  const lo = u16(bytes, bgd + 0x0C);
  const hi = sb.descSize >= 64 ? u16(bytes, bgd + 0x2C) : 0;
  return lo + hi * 0x10000;
}
function setBgFreeBlocks(bytes, group, sb, val) {
  const bgd = sb.gdtOffset + group * sb.descSize;
  wU16(bytes, bgd + 0x0C, val & 0xffff);
  if (sb.descSize >= 64) wU16(bytes, bgd + 0x2C, (val >>> 16) & 0xffff);
}
function sbFreeBlocks(bytes) {
  return u32(bytes, 1024 + 0x0C) + u32(bytes, 1024 + 0x158) * 0x100000000;
}
function setSbFreeBlocks(bytes, val) {
  wU32(bytes, 1024 + 0x0C, val & 0xffffffff);
  wU32(bytes, 1024 + 0x158, Math.floor(val / 0x100000000) & 0xffffffff);
}

// Total free space in the filesystem, in bytes (block-aligned).
export function getFreeSpace(bytes, sb) {
  let free = 0;
  for (let g = 0; g < sb.numGroups; g++) free += bgFreeBlocks(bytes, g, sb);
  return free * sb.blockSize;
}

// Allocate `count` free blocks, mark them used in the bitmaps, and decrement
// free-block counts in every affected group descriptor + the superblock.
// Returns an array of global block numbers (not necessarily contiguous).
function allocateBlocks(bytes, sb, count) {
  const allocated = [];
  const groupUsed = new Map();
  for (let g = 0; g < sb.numGroups && allocated.length < count; g++) {
    const bitmapOff = bgBitmapBlock(bytes, g, sb) * sb.blockSize;
    if (bitmapOff + Math.ceil(sb.blocksPerGroup / 8) > bytes.length) break;
    for (let bit = 0; bit < sb.blocksPerGroup && allocated.length < count; bit++) {
      const globalBlock = sb.firstDataBlock + g * sb.blocksPerGroup + bit;
      if (globalBlock >= sb.blocksCount) break;
      const byteIdx = bit >> 3;
      const mask = 1 << (bit & 7);
      if (bytes[bitmapOff + byteIdx] & mask) continue;
      bytes[bitmapOff + byteIdx] |= mask;
      allocated.push(globalBlock);
      groupUsed.set(g, (groupUsed.get(g) || 0) + 1);
    }
  }
  if (allocated.length < count) {
    throw new Error(`Not enough free space: need ${count} blocks, only ${allocated.length} available.`);
  }
  for (const [g, c] of groupUsed) setBgFreeBlocks(bytes, g, sb, bgFreeBlocks(bytes, g, sb) - c);
  setSbFreeBlocks(bytes, sbFreeBlocks(bytes) - allocated.length);
  return allocated;
}

// Free a set of blocks (mark unused, increment counts). Used when rebuilding
// an existing index tree so old leaf blocks are returned to the pool.
function freeBlocks(bytes, sb, blocks) {
  const groupFreed = new Map();
  for (const blk of blocks) {
    const g = Math.floor((blk - sb.firstDataBlock) / sb.blocksPerGroup);
    const bit = (blk - sb.firstDataBlock) - g * sb.blocksPerGroup;
    const bitmapOff = bgBitmapBlock(bytes, g, sb) * sb.blockSize;
    bytes[bitmapOff + (bit >> 3)] &= ~(1 << (bit & 7));
    groupFreed.set(g, (groupFreed.get(g) || 0) + 1);
  }
  for (const [g, c] of groupFreed) setBgFreeBlocks(bytes, g, sb, bgFreeBlocks(bytes, g, sb) + c);
  setSbFreeBlocks(bytes, sbFreeBlocks(bytes) + blocks.length);
}

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

const ROOT_MAX = 4; // (60 - 12) / 12 entries in the inode i_block area
function leafMax(blockSize) { return Math.floor((blockSize - 12) / 12); }

// Collect leaf block numbers from an existing index (depth > 0) so they can be
// freed before the tree is rebuilt.
function collectIndexLeafBlocks(bytes, blockOff) {
  const depth = u16(bytes, blockOff + 6);
  const entries = u16(bytes, blockOff + 2);
  if (depth === 0) return [];
  const leaves = [];
  for (let i = 0; i < entries; i++) {
    const e = blockOff + 12 + i * 12;
    leaves.push(u32(bytes, e + 4) + u16(bytes, e + 8) * 0x100000000);
  }
  return leaves;
}

// Rewrite the inode extent tree from a merged, coalesced, sorted extent list.
// Handles depth 0 (fits in inode) and depth 1 (spills into leaf blocks).
function buildExtentTree(bytes, inode, sb, allExtents) {
  const rootOff = inode.blockOff;
  const gen = u32(bytes, rootOff + 8);
  if (allExtents.length <= ROOT_MAX) {
    writeExtentHeader(bytes, rootOff, allExtents.length, ROOT_MAX, 0, gen);
    for (let i = 0; i < allExtents.length; i++) {
      const e = allExtents[i];
      writeLeafEntry(bytes, rootOff + 12 + i * 12, e.logical, e.len, e.physical);
    }
    for (let i = allExtents.length; i < ROOT_MAX; i++) {
      for (let j = 0; j < 12; j++) bytes[rootOff + 12 + i * 12 + j] = 0;
    }
    return;
  }
  const perLeaf = leafMax(sb.blockSize);
  const leafCount = Math.ceil(allExtents.length / perLeaf);
  if (leafCount > ROOT_MAX) {
    throw new Error(`File too fragmented to grow: need ${leafCount} leaf blocks (max ${ROOT_MAX}).`);
  }
  const leafBlocks = allocateBlocks(bytes, sb, leafCount);
  const indexEntries = [];
  for (let li = 0; li < leafCount; li++) {
    const chunk = allExtents.slice(li * perLeaf, (li + 1) * perLeaf);
    const leafOff = leafBlocks[li] * sb.blockSize;
    writeExtentHeader(bytes, leafOff, chunk.length, perLeaf, 0, 0);
    for (let i = 0; i < chunk.length; i++) {
      writeLeafEntry(bytes, leafOff + 12 + i * 12, chunk[i].logical, chunk[i].len, chunk[i].physical);
    }
    indexEntries.push({ logical: chunk[0].logical, block: leafBlocks[li] });
  }
  writeExtentHeader(bytes, rootOff, leafCount, ROOT_MAX, 1, gen);
  for (let i = 0; i < leafCount; i++) {
    writeIndexEntry(bytes, rootOff + 12 + i * 12, indexEntries[i].logical, indexEntries[i].block);
  }
  for (let i = leafCount; i < ROOT_MAX; i++) {
    for (let j = 0; j < 12; j++) bytes[rootOff + 12 + i * 12 + j] = 0;
  }
}

// Grow a file's allocation so `newContent` (which may be larger than the
// currently allocated blocks) fits, allocating fresh blocks from the
// filesystem's free pool, updating the extent tree, block bitmaps, free counts,
// inode size and i_blocks. Falls back to patchFile when no growth is needed.
export function growAndPatchFile(bytes, inodeNum, sb, newContent) {
  const inode = readInode(bytes, inodeNum, sb);
  if (!isReg(inode)) throw new Error('Not a regular file');
  const data = typeof newContent === 'string' ? new TextEncoder().encode(newContent) : newContent;
  const blockSize = sb.blockSize;
  const origSize = inodeSize(inode);
  const neededBlocks = data.length === 0 ? 0 : Math.ceil(data.length / blockSize);

  const extents = [];
  collectExtents(bytes, inode.blockOff, sb, extents);
  if (!extents.length) throw new Error('File has no extent-mapped data blocks (unsupported layout).');
  extents.sort((a, b) => a.logical - b.logical);
  const currentBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);

  if (neededBlocks <= currentBlocks) {
    return patchFile(bytes, inodeNum, sb, data);
  }

  const extra = neededBlocks - currentBlocks;
  // 1. Allocate data blocks and coalesce into contiguous runs.
  const newBlocks = allocateBlocks(bytes, sb, extra).slice().sort((a, b) => a - b);
  const runs = [];
  for (const blk of newBlocks) {
    const last = runs[runs.length - 1];
    if (last && last.physical + last.len === blk) last.len++;
    else runs.push({ physical: blk, len: 1 });
  }
  // 2. Assign logical offsets right after the current allocation.
  let cursor = currentBlocks;
  const newExtents = runs.map((r) => {
    const e = { logical: cursor, physical: r.physical, len: r.len };
    cursor += r.len;
    return e;
  });
  // 3. Merge + coalesce with existing extents.
  const merged = [...extents, ...newExtents].sort((a, b) => a.logical - b.logical);
  const coalesced = [];
  for (const e of merged) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.logical + last.len === e.logical && last.physical + last.len === e.physical) {
      last.len += e.len;
    } else {
      coalesced.push({ ...e });
    }
  }
  // 4. Free old index leaf blocks (if depth > 0) before rebuilding the tree.
  if (u16(bytes, inode.blockOff + 6) > 0) {
    const oldLeaves = collectIndexLeafBlocks(bytes, inode.blockOff);
    if (oldLeaves.length) freeBlocks(bytes, sb, oldLeaves);
  }
  // 5. Rebuild the extent tree (may allocate leaf blocks for depth 1).
  buildExtentTree(bytes, inode, sb, coalesced);
  // 6. Write file content into all data blocks (old + new).
  const finalExtents = [];
  collectExtents(bytes, inode.blockOff, sb, finalExtents);
  finalExtents.sort((a, b) => a.logical - b.logical);
  let written = 0;
  for (const e of finalExtents) {
    for (let b = 0; b < e.len; b++) {
      const dst = (e.physical + b) * blockSize;
      if (written < data.length) {
        const chunk = data.subarray(written, Math.min(written + blockSize, data.length));
        bytes.set(chunk, dst);
        for (let i = chunk.length; i < blockSize; i++) bytes[dst + i] = 0;
        written += chunk.length;
      } else {
        for (let i = 0; i < blockSize; i++) bytes[dst + i] = 0;
      }
    }
  }
  // 7. Update inode i_size (lo + hi) and i_blocks (512-byte units).
  const off = inode.offset;
  wU32(bytes, off + 0x04, data.length & 0xffffffff);
  wU32(bytes, off + 0x6C, Math.floor(data.length / 0x100000000) & 0xffffffff);
  const sectorsPerBlock = blockSize / 512;
  wU32(bytes, off + 0x1C, (u32(bytes, off + 0x1C) + extra * sectorsPerBlock) & 0xffffffff);
  return {
    origSize,
    newSize: data.length,
    allocatedSpace: neededBlocks * blockSize,
    extents: coalesced.length,
    grown: extra,
  };
}

// ============================================================
// File deletion
// ============================================================

// Resolve the parent directory inode + leaf name for a full path (e.g. "/a/b.txt").
function resolveParent(bytes, sb, path) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return null;
  const name = parts.pop();
  let inodeNum = 2; // root
  for (const part of parts) {
    const inode = readInode(bytes, inodeNum, sb);
    if (!isDir(inode)) return null;
    const entries = listDirEntries(bytes, inode, sb);
    const found = entries.find((e) => e.name === part && e.isDir);
    if (!found) return null;
    inodeNum = found.inode;
  }
  return { parentInode: inodeNum, name };
}

// Zero a directory entry's inode field (marks it unused) for the entry matching
// `name` in the parent directory's physical data blocks.
function removeDirent(bytes, parentInodeNum, sb, name) {
  const inode = readInode(bytes, parentInodeNum, sb);
  if (!isDir(inode)) return false;
  const extents = [];
  collectExtents(bytes, inode.blockOff, sb, extents);
  for (const e of extents) {
    for (let b = 0; b < e.len; b++) {
      const blockOff = (e.physical + b) * sb.blockSize;
      if (blockOff + sb.blockSize > bytes.length) continue;
      let off = blockOff;
      while (off + 8 <= blockOff + sb.blockSize) {
        const direntInode = u32(bytes, off);
        const recLen = u16(bytes, off + 4);
        const nameLen = bytes[off + 6];
        if (recLen < 8) break;
        if (direntInode !== 0 && nameLen === name.length) {
          let match = true;
          for (let i = 0; i < nameLen; i++) {
            if (bytes[off + 8 + i] !== name.charCodeAt(i)) { match = false; break; }
          }
          if (match) { wU32(bytes, off, 0); return true; }
        }
        off += recLen;
      }
    }
  }
  return false;
}

// Delete a regular file: free its data + index blocks, zero its inode, and
// remove its directory entry. Space is reclaimed for future growth operations.
export function deleteFile(bytes, inodeNum, sb, path) {
  const parent = resolveParent(bytes, sb, path);
  if (!parent) throw new Error('Could not resolve parent directory for ' + path);
  const inode = readInode(bytes, inodeNum, sb);
  if (!isReg(inode)) throw new Error('Only regular files can be deleted');
  const freed = [];
  const extents = [];
  collectExtents(bytes, inode.blockOff, sb, extents);
  for (const e of extents) {
    for (let b = 0; b < e.len; b++) freed.push(e.physical + b);
  }
  if (u16(bytes, inode.blockOff + 6) > 0) {
    for (const l of collectIndexLeafBlocks(bytes, inode.blockOff)) freed.push(l);
  }
  if (freed.length) freeBlocks(bytes, sb, freed);
  // zero the inode
  for (let i = 0; i < sb.inodeSize; i++) bytes[inode.offset + i] = 0;
  if (!removeDirent(bytes, parent.parentInode, sb, parent.name)) {
    throw new Error('Directory entry not found for ' + path);
  }
  return { freedBlocks: freed.length, name: parent.name };
}

// ============================================================
// File creation (add a file into a directory)
// ============================================================

function bgInodeBitmapBlock(bytes, group, sb) {
  const bgd = sb.gdtOffset + group * sb.descSize;
  const lo = u32(bytes, bgd + 0x04);
  const hi = sb.descSize >= 64 ? u32(bytes, bgd + 0x24) : 0;
  return lo + hi * 0x100000000;
}
function bgFreeInodes(bytes, group, sb) {
  const bgd = sb.gdtOffset + group * sb.descSize;
  const lo = u16(bytes, bgd + 0x0E);
  const hi = sb.descSize >= 64 ? u16(bytes, bgd + 0x2E) : 0;
  return lo + hi * 0x10000;
}
function setBgFreeInodes(bytes, group, sb, val) {
  const bgd = sb.gdtOffset + group * sb.descSize;
  wU16(bytes, bgd + 0x0E, val & 0xffff);
  if (sb.descSize >= 64) wU16(bytes, bgd + 0x2E, (val >>> 16) & 0xffff);
}
function sbFreeInodes(bytes) { return u32(bytes, 1024 + 0x10); }
function setSbFreeInodes(bytes, val) { wU32(bytes, 1024 + 0x10, val & 0xffffffff); }
function sbInodesCount(bytes) { return u32(bytes, 1024 + 0x00); }

// Allocate a free inode: mark it used in the bitmap, decrement free-inode counts.
function allocateInode(bytes, sb) {
  const totalInodes = sbInodesCount(bytes);
  for (let g = 0; g < sb.numGroups; g++) {
    const bitmapOff = bgInodeBitmapBlock(bytes, g, sb) * sb.blockSize;
    const inodesThisGroup = Math.min(sb.inodesPerGroup, totalInodes - g * sb.inodesPerGroup);
    for (let bit = 0; bit < inodesThisGroup; bit++) {
      const byteIdx = bit >> 3;
      const mask = 1 << (bit & 7);
      if (!(bytes[bitmapOff + byteIdx] & mask)) {
        bytes[bitmapOff + byteIdx] |= mask;
        setBgFreeInodes(bytes, g, sb, bgFreeInodes(bytes, g, sb) - 1);
        setSbFreeInodes(bytes, sbFreeInodes(bytes) - 1);
        return g * sb.inodesPerGroup + bit + 1;
      }
    }
  }
  throw new Error('No free inodes available.');
}

// Resolve a directory path (e.g. "/a/b") to its inode number, or null.
function resolveDirInode(bytes, sb, dirPath) {
  const parts = dirPath.split('/').filter(Boolean);
  let inodeNum = 2;
  for (const part of parts) {
    const inode = readInode(bytes, inodeNum, sb);
    if (!isDir(inode)) return null;
    const entries = listDirEntries(bytes, inode, sb);
    const found = entries.find((e) => e.name === part && e.isDir);
    if (!found) return null;
    inodeNum = found.inode;
  }
  const inode = readInode(bytes, inodeNum, sb);
  return isDir(inode) ? inodeNum : null;
}

// Append a directory entry for `name` -> `targetInode` by growing the parent
// directory by one block (always succeeds, no dirent splitting needed).
function addDirent(bytes, parentInode, sb, name, targetInode) {
  const blockSize = sb.blockSize;
  const extents = [];
  collectExtents(bytes, parentInode.blockOff, sb, extents);
  extents.sort((a, b) => a.logical - b.logical);
  const currentBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);

  const newBlock = allocateBlocks(bytes, sb, 1)[0];
  const merged = [...extents, { logical: currentBlocks, physical: newBlock, len: 1 }].sort((a, b) => a.logical - b.logical);
  const coalesced = [];
  for (const e of merged) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.logical + last.len === e.logical && last.physical + last.len === e.physical) last.len += e.len;
    else coalesced.push({ ...e });
  }
  if (u16(bytes, parentInode.blockOff + 6) > 0) {
    const oldLeaves = collectIndexLeafBlocks(bytes, parentInode.blockOff);
    if (oldLeaves.length) freeBlocks(bytes, sb, oldLeaves);
  }
  buildExtentTree(bytes, parentInode, sb, coalesced);

  // write the dirent into the new block (single entry filling the whole block)
  const blockOff = newBlock * blockSize;
  for (let i = 0; i < blockSize; i++) bytes[blockOff + i] = 0;
  wU32(bytes, blockOff + 0, targetInode);
  wU16(bytes, blockOff + 4, blockSize);
  bytes[blockOff + 6] = name.length;
  bytes[blockOff + 7] = 1; // EXT4_FT_REG_FILE
  for (let i = 0; i < name.length; i++) bytes[blockOff + 8 + i] = name.charCodeAt(i);

  // update parent i_size + i_blocks
  const newSize = (currentBlocks + 1) * blockSize;
  wU32(bytes, parentInode.offset + 0x04, newSize & 0xffffffff);
  wU32(bytes, parentInode.offset + 0x6C, Math.floor(newSize / 0x100000000) & 0xffffffff);
  const sectorsPerBlock = blockSize / 512;
  wU32(bytes, parentInode.offset + 0x1C, (u32(bytes, parentInode.offset + 0x1C) + sectorsPerBlock) & 0xffffffff);
}

// Create a new regular file inside `dirPath` with the given `name` and `content`.
// Allocates an inode + data blocks, builds the extent tree, and adds a dirent.
export function createFile(bytes, sb, dirPath, name, content) {
  if (!name || name.includes('/')) throw new Error('Invalid file name: ' + name);
  const parentInodeNum = resolveDirInode(bytes, sb, dirPath);
  if (!parentInodeNum) throw new Error('Target directory not found: ' + (dirPath || '/'));
  const parentInode = readInode(bytes, parentInodeNum, sb);
  if (!isDir(parentInode)) throw new Error('Target is not a directory: ' + (dirPath || '/'));

  const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const blockSize = sb.blockSize;

  // 1. Allocate + zero the inode
  const newInodeNum = allocateInode(bytes, sb);
  const inodeOff = inodeTableOffset(bytes, newInodeNum, sb);
  for (let i = 0; i < sb.inodeSize; i++) bytes[inodeOff + i] = 0;

  // 2. Allocate data blocks + build extent list
  let extents = [];
  if (data.length > 0) {
    const neededBlocks = Math.ceil(data.length / blockSize);
    const dataBlocks = allocateBlocks(bytes, sb, neededBlocks).slice().sort((a, b) => a - b);
    const runs = [];
    for (const blk of dataBlocks) {
      const last = runs[runs.length - 1];
      if (last && last.physical + last.len === blk) last.len++;
      else runs.push({ physical: blk, len: 1 });
    }
    let cursor = 0;
    extents = runs.map((r) => { const e = { logical: cursor, physical: r.physical, len: r.len }; cursor += r.len; return e; });
  }

  // 3. Write content into data blocks
  let written = 0;
  for (const e of extents) {
    for (let b = 0; b < e.len; b++) {
      const dst = (e.physical + b) * blockSize;
      if (written < data.length) {
        const chunk = data.subarray(written, Math.min(written + blockSize, data.length));
        bytes.set(chunk, dst);
        for (let i = chunk.length; i < blockSize; i++) bytes[dst + i] = 0;
        written += chunk.length;
      } else {
        for (let i = 0; i < blockSize; i++) bytes[dst + i] = 0;
      }
    }
  }

  // 4. Build the file's extent tree
  buildExtentTree(bytes, { offset: inodeOff, blockOff: inodeOff + 0x28 }, sb, extents);

  // 5. Initialize inode metadata
  wU16(bytes, inodeOff + 0x00, 0x81A4); // mode: regular file 0644
  wU32(bytes, inodeOff + 0x04, data.length & 0xffffffff);
  wU32(bytes, inodeOff + 0x6C, Math.floor(data.length / 0x100000000) & 0xffffffff);
  wU16(bytes, inodeOff + 0x1A, 1); // links_count
  wU32(bytes, inodeOff + 0x20, 0x80000); // flags: EXT4_EXTENTS_FL
  const totalBlocks = extents.reduce((m, e) => Math.max(m, e.logical + e.len), 0);
  wU32(bytes, inodeOff + 0x1C, (totalBlocks * (blockSize / 512)) & 0xffffffff);
  const now = Math.floor(Date.now() / 1000);
  wU32(bytes, inodeOff + 0x08, now); // atime
  wU32(bytes, inodeOff + 0x0C, now); // ctime
  wU32(bytes, inodeOff + 0x10, now); // mtime

  // 6. Add the directory entry in the parent
  addDirent(bytes, parentInode, sb, name, newInodeNum);

  return { inode: newInodeNum, name, size: data.length, blocks: totalBlocks };
}