import { isExt4 } from './ext4.js';
import { createFileRangeReader } from './rangeReader.js';
import { createBlockOverlay, wrapReader, OVERLAY_DIRTY_LIMIT } from './blockOverlay.js';

export const EXT4_EDIT_MEMORY_LIMIT = 1024 * 1024 * 1024;
export { OVERLAY_DIRTY_LIMIT };

export const LARGE_PARTITION_INPLACE_NOTE =
  'Large-partition editing stores only modified filesystem blocks in memory; the original dump is not modified directly.';

export const EXT4_BEST_EFFORT_NOTE =
  'Ext4 modifications are best-effort and do not update journal/metadata checksums.';

export const INPLACE_TOO_LARGE_MESSAGE =
  "Replacement is larger than the file's allocated space and cannot be expanded in hex byte edit mode.";

export const MEMORY_LOAD_FAILED_REASON =
  'This partition could not be loaded into memory as a full copy. In-place editing of existing files still works via ranged reads.';

export const LARGE_PARTITION_READONLY_REASON =
  'This partition is larger than 1 GiB and is explored via ranged reads. File editing, file replacement, file growth, and adding new files are available; delete is not.';

export function usesMemoryEditor(partitionSize, hasReplacementBytes = false) {
  if (hasReplacementBytes) return true;
  return partitionSize <= EXT4_EDIT_MEMORY_LIMIT;
}

function assertExt4(bytes, name) {
  const head = bytes.length > 2048 ? bytes.subarray(0, 2048) : bytes;
  if (!isExt4(head)) {
    throw new Error(`"${name || 'partition'}" does not look like ext4.`);
  }
}

function wrapRange(file, startByte, size, existingOverlay) {
  const base = createFileRangeReader(file, startByte, size);
  const overlay = existingOverlay || createBlockOverlay({ maxDirtyBytes: OVERLAY_DIRTY_LIMIT });
  const reader = wrapReader(base, overlay);
  return { overlay, reader };
}

export async function loadExplorePartition({
  file,
  startByte,
  size,
  name = '',
  replacementBytes = null,
  existingOverlay = null,
}) {
  if (replacementBytes) {
    assertExt4(replacementBytes, name);
    return { mode: 'memory', bytes: replacementBytes, reader: null, overlay: null, readOnlyReason: null };
  }

  if (size <= EXT4_EDIT_MEMORY_LIMIT) {
    try {
      const buf = await file.slice(startByte, startByte + size).arrayBuffer();
      const bytes = new Uint8Array(buf);
      assertExt4(bytes, name);
      return { mode: 'memory', bytes, reader: null, overlay: null, readOnlyReason: null };
    } catch (err) {
      if (err && /does not look like ext4/i.test(err.message)) throw err;
      const { overlay, reader } = wrapRange(file, startByte, size, existingOverlay);
      const head = await reader.read(0, Math.min(2048, size));
      assertExt4(head, name);
      return {
        mode: 'range',
        bytes: null,
        reader,
        overlay,
        inPlaceOnly: true,
        readOnlyReason: MEMORY_LOAD_FAILED_REASON,
        memoryError: err,
      };
    }
  }

  const { overlay, reader } = wrapRange(file, startByte, size, existingOverlay);
  const head = await reader.read(0, Math.min(2048, size));
  assertExt4(head, name);
  return {
    mode: 'range',
    bytes: null,
    reader,
    overlay,
    inPlaceOnly: true,
    readOnlyReason: LARGE_PARTITION_READONLY_REASON,
  };
}
