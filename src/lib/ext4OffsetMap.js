// EXT4-specific adapter: converts EXT4 extent objects (block units) into
// byte-based regions for the generic OffsetMap.
//
// This is the ONLY module that understands EXT4 extent units.
// HexViewer must never import or use this file directly.
//
// EXT4 extent: { logical, physical, len }  (all in BLOCK units)
//
// Conversion:
//   logicalStartByte  = e.logical * blockSize
//   physicalStartByte = partitionStartByte + e.physical * blockSize
//   lengthBytes       = e.len * blockSize

import { createOffsetMap } from './offsetMap.js';

function assertSafeInt(n, label) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

function isExtentSafe(extent) {
  return (
    extent != null &&
    typeof extent === 'object' &&
    Number.isSafeInteger(extent.logical) &&
    Number.isSafeInteger(extent.physical) &&
    Number.isSafeInteger(extent.len) &&
    extent.logical >= 0 &&
    extent.physical >= 0 &&
    extent.len > 0
  );
}

function buildRegions(extents, blockSize, partitionStartByte) {
  const regions = [];
  let skipped = 0;

  for (const e of extents) {
    if (!isExtentSafe(e)) {
      skipped++;
      continue;
    }

    // Calculate byte-based values
    const logicalStartByte = e.logical * blockSize;
    const physicalStartByte = partitionStartByte + e.physical * blockSize;
    const lengthBytes = e.len * blockSize;

    // Validate that resulting byte values are safe integers
    if (
      !Number.isSafeInteger(logicalStartByte) ||
      !Number.isSafeInteger(physicalStartByte) ||
      !Number.isSafeInteger(lengthBytes)
    ) {
      skipped++;
      continue;
    }

    regions.push({
      logicalStartByte,
      physicalStartByte,
      lengthBytes,
    });
  }

  return { regions, skipped };
}

export function buildExt4FileOffsetMap({
  extents,
  blockSize,
  partitionStartByte = 0,
  fileSize = null,
}) {
  // Validate inputs
  assertSafeInt(blockSize, 'blockSize');
  if (blockSize <= 0) throw new Error('blockSize must be a positive safe integer');
  assertSafeInt(partitionStartByte, 'partitionStartByte');
  if (partitionStartByte < 0) throw new Error('partitionStartByte must be non-negative');

  if (fileSize != null) {
    assertSafeInt(fileSize, 'fileSize');
    if (fileSize < 0) throw new Error('fileSize must be non-negative');
  }

  if (!Array.isArray(extents)) {
    throw new Error('extents must be an array');
  }

  // Sort extents by logical block to ensure consistent processing order.
  // The generic mapper will reject genuine logical overlap.
  const sortedExtents = extents
    .slice()
    .sort((a, b) => (a.logical || 0) - (b.logical || 0));

  const { regions, skipped } = buildRegions(sortedExtents, blockSize, partitionStartByte);

  const map = createOffsetMap({
    regions,
    logicalSize: fileSize,
  });

  return { map, skipped };
}
