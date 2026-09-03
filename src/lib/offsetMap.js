// Generic, filesystem-agnostic logical-to-physical (and reverse) byte offset mapper.
// Operates ONLY on byte units. No filesystem knowledge is expected here.
//
// Regions: { logicalStartByte, physicalStartByte, lengthBytes }
// Map:     { regions: Region[], logicalSize: number|null }
//
// The mapper supports:
//   - contiguous mappings
//   - fragmented mappings
//   - sparse/unmapped logical regions
//   - reverse mapping (physical -> logical)
//   - out-of-range / invalid offset detection
//   - physical overlap -> ambiguous reverse mapping
//   - logical overlap -> rejected (throw)

const OFFSET_MAP_BRAND = Symbol.for('offsetMap');

function assertSafeInt(n, label) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeRegions(regions, logicalSize) {
  if (!Array.isArray(regions)) {
    throw new Error('regions must be an array');
  }

  const cleaned = [];
  for (const r of regions) {
    if (!isPlainObject(r)) {
      throw new Error('each region must be a plain object');
    }
    const lsb = r.logicalStartByte;
    const psb = r.physicalStartByte;
    const lb = r.lengthBytes;

    // Validate safe integers (non-negative)
    assertSafeInt(lsb, 'logicalStartByte');
    assertSafeInt(psb, 'physicalStartByte');
    assertSafeInt(lb, 'lengthBytes');

    if (lsb < 0 || psb < 0 || lb < 0) {
      throw new Error('logicalStartByte, physicalStartByte, and lengthBytes must be non-negative');
    }

    // Ignore zero-length regions
    if (lb === 0) continue;

    // Validate end calculations fit within safe integer range
    const logicalEnd = lsb + lb;
    const physicalEnd = psb + lb;
    if (!Number.isSafeInteger(logicalEnd)) {
      throw new Error('logical end exceeds safe integer range');
    }
    if (!Number.isSafeInteger(physicalEnd)) {
      throw new Error('physical end exceeds safe integer range');
    }

    // Clamp to logicalSize
    let effectiveLen = lb;
    let startByte = lsb;
    if (logicalSize != null) {
      assertSafeInt(logicalSize, 'logicalSize');
      if (lsb >= logicalSize) continue; // entirely beyond file size
      const maxEnd = Math.min(logicalEnd, logicalSize);
      effectiveLen = maxEnd - startByte;
      if (effectiveLen <= 0) continue;
    }

    cleaned.push({
      logicalStartByte: startByte,
      physicalStartByte: psb,
      lengthBytes: effectiveLen,
    });
  }

  // Sort by logicalStartByte
  cleaned.sort((a, b) => a.logicalStartByte - b.logicalStartByte);

  // Reject logical overlap
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1];
    const curr = cleaned[i];
    if (curr.logicalStartByte < prev.logicalStartByte + prev.lengthBytes) {
      throw new Error(
        `Logical overlap detected at logical byte 0x${curr.logicalStartByte.toString(16)} ` +
        `(previous region ends at 0x${(prev.logicalStartByte + prev.lengthBytes).toString(16)})`
      );
    }
  }

  // Merge adjacent regions in BOTH logical and physical space
  const merged = [];
  for (const r of cleaned) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.logicalStartByte + last.lengthBytes === r.logicalStartByte &&
      last.physicalStartByte + last.lengthBytes === r.physicalStartByte
    ) {
      last.lengthBytes += r.lengthBytes;
    } else {
      merged.push({ ...r });
    }
  }

  return merged;
}

// Binary search for the region containing a logical offset.
function findRegionByLogical(regions, logicalOffset) {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = regions[mid];
    if (logicalOffset < r.logicalStartByte) {
      hi = mid - 1;
    } else if (logicalOffset >= r.logicalStartByte + r.lengthBytes) {
      lo = mid + 1;
    } else {
      return r;
    }
  }
  return null;
}

// Create an OffsetMap from normalized regions.
export function createOffsetMap({ regions, logicalSize = null } = {}) {
  const normRegions = normalizeRegions(regions, logicalSize);
  const map = {
    [OFFSET_MAP_BRAND]: true,
    regions: normRegions,
    logicalSize: logicalSize == null ? null : Math.floor(logicalSize),
    toPhysical(logicalOffset) {
      assertSafeInt(logicalOffset, 'logicalOffset');
      if (logicalOffset < 0) {
        return { reason: 'out-of-range', physicalOffset: null };
      }
      if (this.logicalSize != null && logicalOffset >= this.logicalSize) {
        return { reason: 'out-of-range', physicalOffset: null };
      }
      const region = findRegionByLogical(this.regions, logicalOffset);
      if (!region) {
        return { reason: 'sparse', physicalOffset: null };
      }
      const physicalOffset = region.physicalStartByte + (logicalOffset - region.logicalStartByte);
      return { reason: 'mapped', physicalOffset, region };
    },
    toLogical(physicalOffset) {
      assertSafeInt(physicalOffset, 'physicalOffset');
      if (physicalOffset < 0) {
        return { reason: 'invalid', logicalOffset: null };
      }
      const candidates = this.regions.filter((r) => {
        return (
          physicalOffset >= r.physicalStartByte &&
          physicalOffset < r.physicalStartByte + r.lengthBytes
        );
      });
      if (candidates.length === 0) {
        return { reason: 'unmapped', logicalOffset: null, regions: [] };
      }
      if (candidates.length > 1) {
        return {
          reason: 'ambiguous',
          logicalOffset: null,
          regions: candidates,
        };
      }
      const r = candidates[0];
      const logicalOffset = r.logicalStartByte + (physicalOffset - r.physicalStartByte);
      return { reason: 'mapped', logicalOffset, region: r };
    },
  };
  return Object.freeze(map);
}

// Convenience: a single contiguous region (no logical size bound).
export function createContiguousOffsetMap({ physicalStartByte, lengthBytes } = {}) {
  assertSafeInt(physicalStartByte, 'physicalStartByte');
  assertSafeInt(lengthBytes, 'lengthBytes');
  if (physicalStartByte < 0 || lengthBytes < 0) {
    throw new Error('physicalStartByte and lengthBytes must be non-negative');
  }
  if (lengthBytes === 0) {
    // No data: empty map
    return createOffsetMap({ regions: [], logicalSize: 0 });
  }
  return createOffsetMap({
    regions: [
      {
        logicalStartByte: 0,
        physicalStartByte: physicalStartByte,
        lengthBytes: lengthBytes,
      },
    ],
    logicalSize: lengthBytes,
  });
}

export function isOffsetMap(value) {
  return isPlainObject(value) && value[OFFSET_MAP_BRAND] === true;
}
