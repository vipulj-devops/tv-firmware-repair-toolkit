import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOffsetMap,
  createContiguousOffsetMap,
  isOffsetMap,
} from '../src/lib/offsetMap.js';
import { buildExt4FileOffsetMap } from '../src/lib/ext4OffsetMap.js';

describe('OffsetMap: contiguous mapping', () => {
  it('1. maps logical to contiguous physical region', () => {
    const map = createContiguousOffsetMap({
      physicalStartByte: 0x10000000,
      lengthBytes: 0x1000,
    });
    const r = map.toPhysical(0);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.physicalOffset, 0x10000000);
    assert.equal(r.region.logicalStartByte, 0);
    assert.equal(r.region.physicalStartByte, 0x10000000);
    assert.equal(r.region.lengthBytes, 0x1000);
  });

  it('2. maps intermediate offset in contiguous region', () => {
    const map = createContiguousOffsetMap({
      physicalStartByte: 0x10000000,
      lengthBytes: 0x1000,
    });
    const r = map.toPhysical(0x100);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.physicalOffset, 0x10000100);
  });

  it('3. contiguous offset equals baseOffset + logical', () => {
    const baseOffset = 0x10000000;
    const map = createContiguousOffsetMap({
      physicalStartByte: baseOffset,
      lengthBytes: 0x1000,
    });
    const r = map.toPhysical(0x100);
    assert.equal(r.physicalOffset, baseOffset + 0x100);
  });
});

describe('OffsetMap: fragmented mapping', () => {
  it('4. maps fragmented regions', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x0000, physicalStartByte: 0xA000, lengthBytes: 0x1000 },
        { logicalStartByte: 0x1000, physicalStartByte: 0xB000, lengthBytes: 0x1000 },
      ],
      logicalSize: 0x2000,
    });
    const r1 = map.toPhysical(0x500);
    assert.equal(r1.reason, 'mapped');
    assert.equal(r1.physicalOffset, 0xA500);

    const r2 = map.toPhysical(0x1500);
    assert.equal(r2.reason, 'mapped');
    assert.equal(r2.physicalOffset, 0xB500);
  });

  it('5. sparse gap in fragmented mapping reports sparse', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x0000, physicalStartByte: 0xA000, lengthBytes: 0x1000 },
        { logicalStartByte: 0x2000, physicalStartByte: 0xC000, lengthBytes: 0x1000 },
      ],
      logicalSize: 0x3000,
    });
    const r = map.toPhysical(0x1500);
    assert.equal(r.reason, 'sparse');
    assert.equal(r.physicalOffset, null);
  });
});

describe('OffsetMap: reverse mapping (toLogical)', () => {
  it('6. reverse maps physical to logical for contiguous region', () => {
    const map = createContiguousOffsetMap({
      physicalStartByte: 0x10000000,
      lengthBytes: 0x1000,
    });
    const r = map.toLogical(0x10000100);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.logicalOffset, 0x100);
    assert.equal(r.region.logicalStartByte, 0);
  });

  it('7. reverse maps physical to logical for fragmented region', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x0000, physicalStartByte: 0xA000, lengthBytes: 0x1000 },
        { logicalStartByte: 0x1000, physicalStartByte: 0xB000, lengthBytes: 0x1000 },
      ],
    });
    const r = map.toLogical(0xB500);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.logicalOffset, 0x1500);
  });

  it('8. reverse maps unmapped physical region', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x0000, physicalStartByte: 0xA000, lengthBytes: 0x1000 },
      ],
    });
    const r = map.toLogical(0x5000);
    assert.equal(r.reason, 'unmapped');
    assert.equal(r.logicalOffset, null);
  });
});

describe('OffsetMap: boundary conditions', () => {
  it('9. maps first byte of logical extent', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x1000, physicalStartByte: 0xA000, lengthBytes: 0x200 },
      ],
      logicalSize: 0x2000,
    });
    const r = map.toPhysical(0x1000);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.physicalOffset, 0xA000);
  });

  it('10. maps last byte of logical extent', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x1000, physicalStartByte: 0xA000, lengthBytes: 0x200 },
      ],
      logicalSize: 0x2000,
    });
    const r = map.toPhysical(0x11FF);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.physicalOffset, 0xA1FF);
  });

  it('11. byte just past region end is sparse', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x1000, physicalStartByte: 0xA000, lengthBytes: 0x200 },
      ],
      logicalSize: 0x2000,
    });
    const r = map.toPhysical(0x1200);
    assert.equal(r.reason, 'sparse');
  });
});

describe('OffsetMap: out-of-range offsets', () => {
  it('12. out-of-range logical offset', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 },
      ],
      logicalSize: 0x100,
    });
    const r = map.toPhysical(0x200);
    assert.equal(r.reason, 'out-of-range');
    assert.equal(r.physicalOffset, null);
  });

  it('13. invalid negative logical offset', () => {
    const map = createOffsetMap({
      regions: [{ logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 }],
      logicalSize: 0x100,
    });
    const r = map.toPhysical(-1);
    assert.equal(r.reason, 'out-of-range');
    assert.equal(r.physicalOffset, null);
  });

  it('14. out-of-range with no logicalSize allows sparse for gaps', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 },
      ],
    });
    // Without logicalSize, offsets beyond the region are still 'sparse' (not out-of-range)
    const r = map.toPhysical(0x1000);
    assert.equal(r.reason, 'sparse');
  });
});

describe('OffsetMap: zero-length regions', () => {
  it('15. zero-length region is ignored', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0 },
        { logicalStartByte: 0x100, physicalStartByte: 0x2000, lengthBytes: 0x100 },
      ],
    });
    assert.equal(map.regions.length, 1);
    const r = map.toPhysical(0x150);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.physicalOffset, 0x2050);
  });
});

describe('OffsetMap: safe integer validation', () => {
  it('16. rejects non-safe-integer logicalStartByte', () => {
    assert.throws(() => {
      createOffsetMap({
        regions: [
          { logicalStartByte: Number.MAX_SAFE_INTEGER + 1, physicalStartByte: 0, lengthBytes: 1 },
        ],
      });
    }, /safe integer/);
  });

  it('17. rejects non-integer length', () => {
    assert.throws(() => {
      createOffsetMap({
        regions: [{ logicalStartByte: 0, physicalStartByte: 0, lengthBytes: 1.5 }],
      });
    }, /safe integer/);
  });

  it('18. rejects negative start byte', () => {
    assert.throws(() => {
      createOffsetMap({
        regions: [{ logicalStartByte: -1, physicalStartByte: 0, lengthBytes: 1 }],
      });
    }, /non-negative/);
  });

  it('19. rejects physical end overflow beyond safe integer', () => {
    assert.throws(() => {
      createOffsetMap({
        regions: [{
          logicalStartByte: 0,
          physicalStartByte: Number.MAX_SAFE_INTEGER - 10,
          lengthBytes: 100,
        }],
      });
    }, /safe integer/);
  });
});

describe('OffsetMap: adjacent-region merging', () => {
  it('20. merges adjacent-in-both regions', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 },
        { logicalStartByte: 0x100, physicalStartByte: 0x1100, lengthBytes: 0x100 },
      ],
    });
    assert.equal(map.regions.length, 1);
    assert.equal(map.regions[0].lengthBytes, 0x200);
    assert.equal(map.regions[0].physicalStartByte, 0x1000);
  });

  it('21. does not merge adjacent logical but non-contiguous physical', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 },
        { logicalStartByte: 0x100, physicalStartByte: 0x5000, lengthBytes: 0x100 },
      ],
    });
    assert.equal(map.regions.length, 2);
  });

  it('22. does not merge non-adjacent logical regions', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 },
        { logicalStartByte: 0x200, physicalStartByte: 0x1100, lengthBytes: 0x100 },
      ],
    });
    assert.equal(map.regions.length, 2);
  });
});

describe('OffsetMap: logical overlap rejection', () => {
  it('23. rejects overlapping logical regions', () => {
    assert.throws(() => {
      createOffsetMap({
        regions: [
          { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x200 },
          { logicalStartByte: 0x100, physicalStartByte: 0x5000, lengthBytes: 0x200 },
        ],
      });
    }, /overlap/);
  });
});

describe('OffsetMap: physical overlap / ambiguity', () => {
  it('24. physical overlap produces ambiguous reverse mapping', () => {
    // Two logical regions mapping to overlapping physical space
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x0000, physicalStartByte: 0x1000, lengthBytes: 0x200 },
        { logicalStartByte: 0x0200, physicalStartByte: 0x1100, lengthBytes: 0x200 },
      ],
    });
    // Physical 0x1100 belongs to both regions
    const r = map.toLogical(0x1100);
    assert.equal(r.reason, 'ambiguous');
    assert.equal(r.logicalOffset, null);
    assert.ok(r.regions.length >= 2);
  });

  it('25. physical overlap still maps logical to physical correctly', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0x0000, physicalStartByte: 0x1000, lengthBytes: 0x200 },
        { logicalStartByte: 0x0200, physicalStartByte: 0x1100, lengthBytes: 0x200 },
      ],
    });
    // Logical 0x00 maps to physical 0x1000 (region 1)
    const r1 = map.toPhysical(0x00);
    assert.equal(r1.reason, 'mapped');
    assert.equal(r1.physicalOffset, 0x1000);

    // Logical 0x0200 maps to physical 0x1100 (region 2)
    const r2 = map.toPhysical(0x200);
    assert.equal(r2.reason, 'mapped');
    assert.equal(r2.physicalOffset, 0x1100);
  });
});

describe('OffsetMap: physical gaps', () => {
  it('26. physical gap is unmapped in reverse', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 },
        { logicalStartByte: 0x100, physicalStartByte: 0x5000, lengthBytes: 0x100 },
      ],
    });
    const r = map.toLogical(0x3000);
    assert.equal(r.reason, 'unmapped');
    assert.equal(r.logicalOffset, null);
  });
});

describe('OffsetMap: isOffsetMap', () => {
  it('27. identifies OffsetMap instances', () => {
    const map = createContiguousOffsetMap({ physicalStartByte: 0, lengthBytes: 100 });
    assert.ok(isOffsetMap(map));
  });

  it('28. rejects non-OffsetMap values', () => {
    assert.ok(!isOffsetMap(null));
    assert.ok(!isOffsetMap({}));
    assert.ok(!isOffsetMap('string'));
    assert.ok(!isOffsetMap(42));
    assert.ok(!isOffsetMap([]));
  });

  it('29. OffsetMap is frozen (immutable)', () => {
    const map = createContiguousOffsetMap({ physicalStartByte: 0, lengthBytes: 100 });
    assert.ok(Object.isFrozen(map));
  });
});

describe('OffsetMap: logicalSize clamping', () => {
  it('30. clamps region exceeding logicalSize', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x200 },
      ],
      logicalSize: 0x100,
    });
    const r = map.toPhysical(0x100);
    assert.equal(r.reason, 'out-of-range');
  });

  it('31. region past logicalSize is ignored', () => {
    const map = createOffsetMap({
      regions: [
        { logicalStartByte: 0, physicalStartByte: 0x1000, lengthBytes: 0x100 },
        { logicalStartByte: 0x200, physicalStartByte: 0x5000, lengthBytes: 0x100 },
      ],
      logicalSize: 0x180,
    });
    // The second region is entirely past logicalSize and should be ignored
    assert.equal(map.regions.length, 1);
    // 0x150 is within logicalSize (0x180) but past the first region (ends at 0x100)
    // so it's sparse, not out-of-range
    const r = map.toPhysical(0x150);
    assert.equal(r.reason, 'sparse');
    // 0x180 is at logicalSize, so it's out-of-range
    const r2 = map.toPhysical(0x180);
    assert.equal(r2.reason, 'out-of-range');
  });
});

describe('EXT4 adapter: block-to-byte conversion', () => {
  it('32. converts single contiguous extent to byte region', () => {
    const blockSize = 4096;
    const partitionStartByte = 0x10000000;
    const { map, skipped } = buildExt4FileOffsetMap({
      extents: [{ logical: 0, physical: 100, len: 1 }],
      blockSize,
      partitionStartByte,
      fileSize: blockSize,
    });
    assert.equal(skipped, 0);
    assert.equal(map.regions.length, 1);
    const r = map.toPhysical(0);
    assert.equal(r.reason, 'mapped');
    assert.equal(r.physicalOffset, partitionStartByte + 100 * blockSize);
  });

  it('33. converts multiple fragmented extents', () => {
    const blockSize = 4096;
    const partitionStartByte = 0x10000000;
    const { map, skipped } = buildExt4FileOffsetMap({
      extents: [
        { logical: 0, physical: 100, len: 2 },
        { logical: 2, physical: 200, len: 1 },
      ],
      blockSize,
      partitionStartByte,
      fileSize: 3 * blockSize,
    });
    assert.equal(skipped, 0);
    assert.equal(map.regions.length, 2);

    const r1 = map.toPhysical(0);
    assert.equal(r1.reason, 'mapped');
    assert.equal(r1.physicalOffset, partitionStartByte + 100 * blockSize);

    const r2 = map.toPhysical(2 * blockSize);
    assert.equal(r2.reason, 'mapped');
    assert.equal(r2.physicalOffset, partitionStartByte + 200 * blockSize);
  });

  it('34. handles partitionStartByte correctly', () => {
    const blockSize = 1024;
    const partitionStartByte = 0x2000000;
    const { map } = buildExt4FileOffsetMap({
      extents: [{ logical: 0, physical: 50, len: 4 }],
      blockSize,
      partitionStartByte,
      fileSize: 4 * blockSize,
    });
    const r = map.toPhysical(0);
    assert.equal(r.physicalOffset, partitionStartByte + 50 * blockSize);
  });
});

describe('EXT4 adapter: fileSize clamping', () => {
  it('35. clamps to fileSize (partial last block)', () => {
    const blockSize = 4096;
    const { map } = buildExt4FileOffsetMap({
      extents: [{ logical: 0, physical: 0, len: 1 }],
      blockSize,
      partitionStartByte: 0,
      fileSize: 100, // less than one block
    });
    assert.equal(map.logicalSize, 100);
    const r = map.toPhysical(99);
    assert.equal(r.reason, 'mapped');
    const r2 = map.toPhysical(100);
    assert.equal(r2.reason, 'out-of-range');
  });
});

describe('EXT4 adapter: fragmented EXT4 mapping', () => {
  it('36. fragmented file with sparse hole produces correct mapping', () => {
    const blockSize = 4096;
    const partitionStartByte = 0x1000;
    const { map } = buildExt4FileOffsetMap({
      extents: [
        { logical: 0, physical: 10, len: 1 },
        { logical: 3, physical: 20, len: 1 },
      ],
      blockSize,
      partitionStartByte,
      fileSize: 4 * blockSize,
    });
    // Logical blocks 0-1 are mapped, 1-2 are sparse, 3 is mapped
    const r0 = map.toPhysical(0);
    assert.equal(r0.reason, 'mapped');

    const r1 = map.toPhysical(blockSize);
    assert.equal(r1.reason, 'sparse');

    const r3 = map.toPhysical(3 * blockSize);
    assert.equal(r3.reason, 'mapped');
    assert.equal(r3.physicalOffset, partitionStartByte + 20 * blockSize);
  });
});

describe('EXT4 adapter: adjacent extents merging', () => {
  it('37. physically contiguous extents merge into single region', () => {
    const blockSize = 4096;
    const partitionStartByte = 0;
    const { map, skipped } = buildExt4FileOffsetMap({
      extents: [
        { logical: 0, physical: 10, len: 1 },
        { logical: 1, physical: 11, len: 1 },
      ],
      blockSize,
      partitionStartByte,
      fileSize: 2 * blockSize,
    });
    assert.equal(skipped, 0);
    // Physical 10 + 1 = 11, contiguous and adjacent in both logical and physical
    assert.equal(map.regions.length, 1);
    assert.equal(map.regions[0].lengthBytes, 2 * blockSize);
  });

  it('38. logically adjacent but physically non-contiguous stays separate', () => {
    const blockSize = 4096;
    const { map } = buildExt4FileOffsetMap({
      extents: [
        { logical: 0, physical: 10, len: 1 },
        { logical: 1, physical: 50, len: 1 },
      ],
      blockSize,
      partitionStartByte: 0,
      fileSize: 2 * blockSize,
    });
    assert.equal(map.regions.length, 2);
  });
});

describe('EXT4 adapter: invalid/unsafe extents', () => {
  it('39. skips invalid extents and returns skipped count', () => {
    const blockSize = 4096;
    const { map, skipped } = buildExt4FileOffsetMap({
      extents: [
        { logical: 0, physical: 10, len: 1 },
        { logical: 'abc', physical: -1, len: 0 }, // invalid
        { logical: 1, physical: 11, len: 1 },
      ],
      blockSize,
      partitionStartByte: 0,
      fileSize: 3 * blockSize,
    });
    assert.equal(skipped, 1);
    assert.equal(map.regions.length, 1); // the two valid adjacent extents merge
  });

  it('40. throws on invalid blockSize', () => {
    assert.throws(() => {
      buildExt4FileOffsetMap({
        extents: [],
        blockSize: 0,
        partitionStartByte: 0,
      });
    }, /positive safe integer/);
  });

  it('41. throws on negative partitionStartByte', () => {
    assert.throws(() => {
      buildExt4FileOffsetMap({
        extents: [],
        blockSize: 4096,
        partitionStartByte: -1,
      });
    }, /non-negative/);
  });
});

describe('EXT4 adapter: logical overlap rejection', () => {
  it('42. rejects genuine logical overlap in extents', () => {
    const blockSize = 4096;
    assert.throws(() => {
      buildExt4FileOffsetMap({
        extents: [
          { logical: 0, physical: 10, len: 4 },
          { logical: 2, physical: 20, len: 4 },
        ],
        blockSize,
        partitionStartByte: 0,
        fileSize: 8 * blockSize,
      });
    }, /overlap/);
  });

  it('43. accepts extents sorted out of order (re-sorts by logical)', () => {
    const blockSize = 4096;
    const partitionStartByte = 0;
    const { map, skipped } = buildExt4FileOffsetMap({
      extents: [
        { logical: 1, physical: 20, len: 1 },
        { logical: 0, physical: 10, len: 1 },
      ],
      blockSize,
      partitionStartByte,
      fileSize: 2 * blockSize,
    });
    assert.equal(skipped, 0);
    assert.equal(map.regions.length, 2);
    const r0 = map.toPhysical(0);
    assert.equal(r0.physicalOffset, partitionStartByte + 10 * blockSize);
    const r1 = map.toPhysical(blockSize);
    assert.equal(r1.physicalOffset, partitionStartByte + 20 * blockSize);
  });
});

describe('OffsetMap: reverse mapping sparse gaps', () => {
  it('44. sparse logical gap does not produce reverse mapping', () => {
    const blockSize = 4096;
    const { map } = buildExt4FileOffsetMap({
      extents: [
        { logical: 0, physical: 0, len: 1 },
        { logical: 2, physical: 100, len: 1 },
      ],
      blockSize,
      partitionStartByte: 0,
      fileSize: 3 * blockSize,
    });
    // Physical bytes between region 1 and region 2 should be unmapped
    const r = map.toLogical(50 * blockSize);
    assert.equal(r.reason, 'unmapped');
  });
});
