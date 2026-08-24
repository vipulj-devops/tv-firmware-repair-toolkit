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
