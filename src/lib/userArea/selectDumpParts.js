import { userAreaToParts } from '../userAreaParser.js';

export const STRICT_USER_AREA_TYPES = [
  'emmc_1630_5840',
  'aml_mpt',
  'realtek_partinfo',
  'blkdevparts_mmc',
  'mtdparts_emmc',
];

const STRICT = new Set(STRICT_USER_AREA_TYPES);

function dumpFirmwareParts(firmwareParts, hasGpt = false) {
  const parts = (firmwareParts || []).filter(
    (p) => p && p.vendorSource !== 'descriptor' && p.source !== 'descriptor'
  );
  if (!hasGpt) return parts;
  return parts.filter((p) => {
    if (p.vendorSource !== 'bootparams') return true;
    const n = p.name.toLowerCase();
    return n.startsWith('fw_') || n === 'frp' || n === 'misc' || n === 'res';
  });
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

function isMetadataPartition(p) {
  return (
    p.ptType === 'metadata' ||
    p.isMetadata ||
    [
      'mbr 0', 'GPT0', 'GPTp0', 'GPTp1', 'MBR',
      'GPT Header', 'GPT Array',
      'backup GPT header', 'backup GPT array',
      'GPT Backup Header', 'GPT Backup Array',
      'Part_Map',
    ].includes(p.name)
  );
}

// Classifies every discovered partition into a deterministic category:
// ⚪ Metadata > 🔴 Blocked/Overlap > 🟠 Nested > 🟡 Read-only/Informational > 🟢 Editable
export function classifyDumpParts(rawParts, fileSize = 0) {
  if (!Array.isArray(rawParts) || !rawParts.length) return [];

  // Sort by startByte
  const sorted = [...rawParts].sort((a, b) => a.startByte - b.startByte);

  return sorted.map((p, idx) => {
    const start = p.startByte;
    const declaredSize = p.declaredSize ?? p.size;
    const size = declaredSize;
    const end = start + size;

    if (isMetadataPartition(p)) {
      return {
        ...p,
        index: idx,
        status: 'metadata',
        statusReason: 'Metadata — partition/storage metadata',
        editable: false,
      };
    }

    if (p.unavailable) {
      return {
        ...p,
        index: idx,
        status: 'readonly',
        statusReason: 'Read-only — beyond physical dump EOF',
        editable: false,
      };
    }

    if (p.name === 'bootcode' || (p.ro && p.fsType === 'squashfs')) {
      return {
        ...p,
        index: idx,
        status: 'readonly',
        statusReason:
          p.name === 'bootcode'
            ? 'Read-only / informational bootloader region'
            : 'Read-only — SquashFS filesystem',
        editable: false,
      };
    }

    // Check containment and overlap with all other non-metadata partitions
    let containingParent = null;
    let overlappingParent = null;
    let overlappingSource = null;

    for (const o of sorted) {
      if (o === p) continue;
      const oSize = o.declaredSize ?? o.size;
      const oEnd = o.startByte + oSize;
      if (isMetadataPartition(o)) continue;

      // Strict containment check: p is inside o and o is strictly larger
      if (start >= o.startByte && end <= oEnd && oSize > size) {
        containingParent = o.name;
        break;
      }

      // Skip exact duplicates (same ptType, name, start, size) — true duplicates
      // that are identical in every field.
      const isExactDuplicate =
        p.ptType === o.ptType &&
        p.name.toLowerCase() === o.name.toLowerCase() &&
        start === o.startByte &&
        size === oSize;
      if (isExactDuplicate) continue;

      // Overlap check: regions share bytes
      if (start < oEnd && end > o.startByte) {
        // When two regions have the exact same start+size but different ptType,
        // prefer the primary source (gpt > vendor > inferred_fs) as the authoritative
        // partition, and mark the other as blocked.
        if (start === o.startByte && size === oSize) {
          const priority = { gpt: 0, aml_mpt: 1, realtek_partinfo: 1, blkdevparts_mmc: 1, mtdparts_emmc: 1, emmc_1630_5840: 1, mbr: 1, vendor: 2, inferred_fs: 3 };
          const pPri = priority[p.ptType] ?? 9;
          const oPri = priority[o.ptType] ?? 9;
          // Only mark as blocked if the other partition has higher priority
          if (oPri <= pPri) {
            overlappingParent = o.name;
            overlappingSource = o.ptType;
          }
        } else {
          overlappingParent = o.name;
          overlappingSource = o.ptType;
        }
      }
    }

    if (containingParent) {
      return {
        ...p,
        index: idx,
        status: 'nested',
        statusReason: `Nested region — contained within ${containingParent}`,
        parentRegion: containingParent,
        editable: false,
      };
    }

    if (overlappingParent) {
      return {
        ...p,
        index: idx,
        status: 'blocked',
        statusReason: `Blocked — overlaps ${overlappingParent} (${overlappingSource})`,
        parentRegion: overlappingParent,
        editable: false,
      };
    }

    return {
      ...p,
      index: idx,
      status: 'editable',
      statusReason: 'Editable — independent non-overlapping region',
      editable: true,
    };
  });
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
  bytes = null,
}) {
  const gpt = gptParts || [];
  const ua = userAreaToParts(userAreaAnalysis);
  const firmware = dumpFirmwareParts(firmwareParts, hasGpt);

  let raw = [];

  if (hasGpt) {
    raw = [...gpt];
    // Include ALL vendor firmware partitions — even ones that overlap GPT entries.
    // classifyDumpParts will mark overlapping ones as blocked/nested so they stay visible.
    raw.push(...firmware);
    // Add GPT/MBR metadata regions (primary and backup)
    raw.push(...gptMetadataParts(bytes, gptParts, fileSize));
  } else if (userAreaAnalysis && STRICT.has(userAreaAnalysis.tableType) && ua.length >= 1) {
    raw = [...ua];
    if (userAreaAnalysis.tableType === 'emmc_1630_5840') {
      raw.push(...emmc1630MetadataParts(ua, fileSize));
    }
    raw.push(...firmware);
  } else if (gpt.length >= 1) {
    raw = [...gpt];
  } else if (ua.length >= 1) {
    raw = [...ua];
    if (userAreaAnalysis && userAreaAnalysis.tableType === 'emmc_1630_5840') {
      raw.push(...emmc1630MetadataParts(ua, fileSize));
    }
  } else if (firmware.length >= 1) {
    raw = [...firmware];
  } else if (Array.isArray(filesystemHits) && filesystemHits.length >= 1) {
    raw = inferredFsToParts(filesystemHits, fileSize);
  }

  return classifyDumpParts(raw, fileSize);
}

// Add eMMC 0x1630/0x5840 Part_Map metadata region (non-editable).
// Derives size strictly from the first valid partition's startByte.
function emmc1630MetadataParts(uaParts, fileSize = 0) {
  if (!Array.isArray(uaParts) || !uaParts.length) return [];
  const sorted = [...uaParts].sort((a, b) => a.startByte - b.startByte);
  const first = sorted.find((p) => p.startByte > 0);
  if (!first || first.startByte <= 0) return [];
  const size = first.startByte;
  const availableSize = fileSize > 0 ? Math.min(size, fileSize) : size;
  return [{
    index: 0,
    name: 'Part_Map',
    ptType: 'metadata',
    startByte: 0,
    size,
    declaredSize: size,
    availableSize,
    fsType: 'raw',
    vendorSource: 'emmc_1630_5840',
    source: 'emmc_1630_5840',
    isMetadata: true,
  }];
}

// Add MBR/GPT metadata regions as visible metadata entries (non-editable).
// Returns GPT Header, GPT Partition Array, protective MBR, Backup GPT Array, and Backup GPT Header metadata entries
// when a valid GPT table is present.
function gptMetadataParts(bytes, gptParts, fileSize = 0) {
  if (!gptParts || gptParts.length === 0) return [];
  const hasGptParts = gptParts.some((p) => p.ptType === 'gpt');
  if (!hasGptParts) return [];
  if (!bytes || bytes.length < 0x200) return [];

  // Find GPT header offset from a partition's baseOffset, or scan for "EFI PART"
  const gptPart = gptParts.find((p) => p.ptType === 'gpt');
  let gptHeaderOff = 0x200;
  if (gptPart && gptPart.baseOffset !== undefined) {
    // baseOffset + myLba * 512; myLba is typically 1
    gptHeaderOff = gptPart.baseOffset + 512;
  } else {
    // Fallback: scan for EFI PART signature in first 128 MB
    const EFI_PART = [0x45, 0x46, 0x49, 0x20, 0x50, 0x41, 0x52, 0x54];
    const maxScan = Math.min(bytes.length, 128 * 1024 * 1024);
    for (let off = 0; off < maxScan; off += 512) {
      let match = true;
      for (let i = 0; i < 8; i++) { if (bytes[off + i] !== EFI_PART[i]) { match = false; break; } }
      if (match) { gptHeaderOff = off; break; }
    }
  }

  // Read GPT header fields
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;

  const myLba = gptHeaderOff + 0x18 + 8 <= bytes.length ? u64(bytes, gptHeaderOff + 0x18) : 1;
  const altLba = gptHeaderOff + 0x20 + 8 <= bytes.length ? u64(bytes, gptHeaderOff + 0x20) : 0;
  const lastUsableLba = gptHeaderOff + 0x30 + 8 <= bytes.length ? u64(bytes, gptHeaderOff + 0x30) : 0;

  const baseOffset = gptHeaderOff - myLba * 512;
  const numEntries = gptHeaderOff + 0x50 + 4 <= bytes.length ? u32(bytes, gptHeaderOff + 0x50) : 0;
  const entrySize = gptHeaderOff + 0x54 + 4 <= bytes.length ? u32(bytes, gptHeaderOff + 0x54) : 128;
  const headerSize = 92;
  const arraySize = numEntries * entrySize;
  const arrayOff = baseOffset + (gptHeaderOff + 0x48 + 8 <= bytes.length ? u64(bytes, gptHeaderOff + 0x48) : 2) * 512;

  const meta = [];
  meta.push({
    index: 0,
    name: 'mbr 0',
    ptType: 'metadata',
    startByte: 0,
    size: 512,
    declaredSize: 512,
    availableSize: 512,
    fsType: 'raw',
    vendorSource: 'gpt_metadata',
    source: 'gpt_metadata',
    isMetadata: true,
  });
  meta.push({
    index: 1,
    name: 'GPT Header',
    ptType: 'metadata',
    startByte: gptHeaderOff,
    size: headerSize,
    declaredSize: headerSize,
    availableSize: headerSize,
    fsType: 'raw',
    vendorSource: 'gpt_metadata',
    source: 'gpt_metadata',
    isMetadata: true,
  });
  meta.push({
    index: 2,
    name: 'GPT Array',
    ptType: 'metadata',
    startByte: arrayOff,
    size: arraySize,
    declaredSize: arraySize,
    availableSize: arraySize,
    fsType: 'raw',
    vendorSource: 'gpt_metadata',
    source: 'gpt_metadata',
    isMetadata: true,
  });

  // Calculate backup GPT offsets dynamically from geometry
  const totalSize = fileSize || (altLba > 0 ? (altLba + 1) * 512 : bytes.length);
  if (totalSize > 512) {
    const backupHeaderOff = altLba > 0 ? baseOffset + altLba * 512 : totalSize - 512;
    const backupArrayOff = lastUsableLba > 0 ? baseOffset + (lastUsableLba + 1) * 512 : backupHeaderOff - 32 * 512;
    const backupArraySize = 32 * 512; // 0x4000 (16384 bytes, physical backup array region)

    meta.push({
      index: 3,
      name: 'backup GPT array',
      ptType: 'metadata',
      startByte: backupArrayOff,
      size: backupArraySize,
      declaredSize: backupArraySize,
      availableSize: backupArraySize,
      fsType: 'raw',
      vendorSource: 'gpt_metadata',
      source: 'gpt_metadata',
      isMetadata: true,
    });

    meta.push({
      index: 4,
      name: 'backup GPT header',
      ptType: 'metadata',
      startByte: backupHeaderOff,
      size: 512,
      declaredSize: 512,
      availableSize: 512,
      fsType: 'raw',
      vendorSource: 'gpt_metadata',
      source: 'gpt_metadata',
      isMetadata: true,
    });
  }

  return meta;
}
