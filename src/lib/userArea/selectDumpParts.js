import { userAreaToParts } from '../userAreaParser.js';

export const STRICT_USER_AREA_TYPES = [
  'emmc_1630_5840',
  'aml_mpt',
  'realtek_partinfo',
  'blkdevparts_mmc',
  'mtdparts_emmc',
];

const STRICT = new Set(STRICT_USER_AREA_TYPES);

function dumpFirmwareParts(firmwareParts) {
  return (firmwareParts || []).filter(
    (p) => p && p.vendorSource !== 'descriptor' && p.source !== 'descriptor'
  );
}

// Converts validated filesystem scan hits into Inferred Partition objects
// when no formal partition table exists.
export function inferredFsToParts(filesystemHits, fileSize = 0) {
  if (!Array.isArray(filesystemHits) || !filesystemHits.length) return [];
  const out = [];
  let idx = 0;

  for (const h of filesystemHits) {
    const offset = h.offset;
    const size = h.size || 0;
    if (size <= 0) continue;

    const declaredSize = size;
    const availableSize =
      fileSize > 0
        ? Math.max(0, Math.min(declaredSize, fileSize - offset))
        : declaredSize;
    const truncated =
      fileSize > 0 && offset < fileSize && offset + declaredSize > fileSize;
    const unavailable = fileSize > 0 && offset >= fileSize;

    let name;
    if (h.type === 'ext4') {
      if (h.volName && h.volName !== '<unnamed>') {
        name = h.volName;
      } else {
        name = 'ext4_partition';
      }
    } else if (h.type === 'squashfs') {
      name = 'squashfs_partition';
    } else {
      name = `${h.type}_partition`;
    }

    out.push({
      index: idx++,
      name,
      ptType: 'inferred_fs',
      startByte: offset,
      size: declaredSize,
      declaredSize,
      availableSize,
      truncated,
      unavailable,
      fsType: h.type,
      vendorSource: 'filesystem_scan',
      source: 'filesystem_scan',
      inferred: true,
      ro: h.type === 'squashfs',
    });
  }

  return out;
}

// PartitionTable source: valid GPT, then a non-empty strict registry map,
// then usable primary MBR (gptParts from autoMapPartitions when !hasGpt),
// then heuristic user-area parts, then structured firmware-package fallback.
// Fallback: If no declared partition table is present, promote validated filesystem scan hits into inferred partitions.
export function selectDumpParts({
  hasGpt,
  gptParts,
  userAreaAnalysis,
  firmwareParts,
  filesystemHits,
  fileSize = 0,
}) {
  const gpt = gptParts || [];
  const ua = userAreaToParts(userAreaAnalysis);
  const firmware = dumpFirmwareParts(firmwareParts);

  if (hasGpt) return gpt;
  if (userAreaAnalysis && STRICT.has(userAreaAnalysis.tableType) && ua.length >= 1)
    return ua;
  if (gpt.length >= 1) return gpt;
  if (ua.length >= 1) return ua;
  if (firmware.length >= 1) return firmware;

  // Fallback when no declared partition table exists: convert validated filesystem hits into inferred partitions
  if (Array.isArray(filesystemHits) && filesystemHits.length >= 1) {
    return inferredFsToParts(filesystemHits, fileSize);
  }

  return [];
}
