// Unit tests for Inferred Filesystem Partition capability
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanFilesystems, scanFilesystemsAsync, filterBackupSuperblocks } from '../src/lib/detectFilesystems.js';
import { selectDumpParts, inferredFsToParts } from '../src/lib/userArea/selectDumpParts.js';

// Helper to construct a buffer with an EXT4 superblock at a given offset
function createBufferWithExt4(offset, blocksCount = 2048, blockSize = 4096, volName = '') {
  const minLen = offset + 1024 + 1024;
  const buf = Buffer.alloc(minLen);

  const sb = offset + 1024;
  // Magic 0xEF53 at sb + 0x38
  buf.writeUInt16LE(0xef53, sb + 0x38);
  // Log block size (0 = 1024, 1 = 2048, 2 = 4096)
  const logBlockSize = blockSize === 4096 ? 2 : blockSize === 2048 ? 1 : 0;
  buf.writeUInt32LE(logBlockSize, sb + 0x18);
  // Blocks count lo
  buf.writeUInt32LE(blocksCount, sb + 0x04);
  // Inodes count lo
  buf.writeUInt32LE(128, sb + 0x00);
  // Blocks per group
  buf.writeUInt32LE(8192, sb + 0x20);
  // Inodes per group
  buf.writeUInt32LE(128, sb + 0x28);
  // First data block
  buf.writeUInt32LE(blockSize === 1024 ? 1 : 0, sb + 0x14);
  // Revision level
  buf.writeUInt32LE(1, sb + 0x4c);
  // Inode size
  buf.writeUInt16LE(256, sb + 0x58);

  if (volName) {
    buf.write(volName, sb + 120, Math.min(volName.length, 16), 'ascii');
  }

  return buf;
}

describe('Inferred Filesystem Partitions', () => {
  it('converts validated filesystem scan hits into inferred partition objects', () => {
    const hits = [
      { type: 'ext4', offset: 0x00d00000, size: 8 * 1024 * 1024, volName: '<unnamed>' },
      { type: 'ext4', offset: 0x294f00000, size: 4317 * 1024 * 1024, volName: 'data' },
    ];
    const fileSize = 0x3a3e00000; // 15.63 GB
    const parts = inferredFsToParts(hits, fileSize);

    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[0].name, 'ext4_partition');
    assert.strictEqual(parts[0].startByte, 0x00d00000);
    assert.strictEqual(parts[0].size, 8 * 1024 * 1024);
    assert.strictEqual(parts[0].ptType, 'inferred_fs');
    assert.strictEqual(parts[0].inferred, true);
    assert.strictEqual(parts[0].source, 'filesystem_scan');
    assert.strictEqual(parts[0].availableSize, 8 * 1024 * 1024);
    assert.strictEqual(parts[0].truncated, false);
    assert.strictEqual(parts[0].unavailable, false);

    assert.strictEqual(parts[1].name, 'data');
    assert.strictEqual(parts[1].startByte, 0x294f00000);
    assert.strictEqual(parts[1].size, 4317 * 1024 * 1024);
    assert.strictEqual(parts[1].ptType, 'inferred_fs');
    assert.strictEqual(parts[1].inferred, true);
    assert.strictEqual(parts[1].availableSize, 4317 * 1024 * 1024);
  });

  it('preserves filesystem start at primary superblock 0x0970D400 (Candidate 3 pattern)', () => {
    // 1024 block size, 2048 blocks = 2 MB
    const offset = 0x0970d400;
    const buf = createBufferWithExt4(offset, 2048, 1024);
    const hits = scanFilesystems(buf, 0x100000000);

    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].offset, 0x0970d400); // MUST be 0x0970D400, not backup superblock at 0x09730000
    assert.strictEqual(hits[0].size, 2048 * 1024);

    const parts = inferredFsToParts(hits, 0x100000000);
    assert.strictEqual(parts[0].startByte, 0x0970d400);
    assert.strictEqual(parts[0].size, 2048 * 1024);
  });

  it('calculates size from EXT4 superblock metadata', () => {
    // Block size 4096, 65536 blocks = 256 MB
    const offset = 0x46b00000;
    const buf = createBufferWithExt4(offset, 65536, 4096);
    const hits = scanFilesystems(buf, 0x100000000);

    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].size, 65536 * 4096); // 256 MB
    assert.strictEqual(hits[0].offset, 0x46b00000);

    const parts = inferredFsToParts(hits, 0x100000000);
    assert.strictEqual(parts[0].size, 256 * 1024 * 1024);
  });

  it('filters backup superblocks inside an earlier filesystem range', () => {
    const rawHits = [
      { type: 'ext4', offset: 0x294f00000, size: 4317 * 1024 * 1024, volName: 'data' },
      { type: 'ext4', offset: 0x29ceffc00, size: 4317 * 1024 * 1024, volName: 'data' }, // backup inside range
      { type: 'ext4', offset: 0x2aceffc00, size: 4317 * 1024 * 1024, volName: 'data' }, // backup inside range
    ];

    const filtered = filterBackupSuperblocks(rawHits);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].offset, 0x294f00000);
  });

  it('handles truncated filesystem extending beyond physical EOF', () => {
    const hits = [
      { type: 'ext4', offset: 0x00e4800000, size: 440 * 1024 * 1024, volName: 'reserved' },
    ];
    const fileSize = 0x00e9000000; // 72MB available out of 440MB declared
    const parts = inferredFsToParts(hits, fileSize);

    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0].startByte, 0x00e4800000);
    assert.strictEqual(parts[0].declaredSize, 440 * 1024 * 1024);
    assert.strictEqual(parts[0].availableSize, 0x04800000); // 72 MB (fileSize - offset)
    assert.strictEqual(parts[0].truncated, true);
    assert.strictEqual(parts[0].unavailable, false);
  });

  it('declared partition tables take precedence over inferred filesystems', () => {
    const hits = [
      { type: 'ext4', offset: 0x00d00000, size: 8 * 1024 * 1024, volName: 'data' },
    ];
    const gptParts = [
      { name: 'gpt_partition', startByte: 0, size: 0x100000, ptType: 'gpt' },
    ];

    // When hasGpt is true, GPT partitions are returned, NOT inferred filesystems
    const selected = selectDumpParts({
      hasGpt: true,
      gptParts,
      userAreaAnalysis: null,
      firmwareParts: [],
      filesystemHits: hits,
      fileSize: 0x10000000,
    });

    assert.strictEqual(selected.length, 1);
    assert.strictEqual(selected[0].name, 'gpt_partition');
    assert.strictEqual(selected[0].ptType, 'gpt');
  });

  it('selects inferred partitions when no declared partition table is present', () => {
    const hits = [
      { type: 'ext4', offset: 0x00d00000, size: 8 * 1024 * 1024, volName: 'ext4_partition' },
      { type: 'ext4', offset: 0x294f00000, size: 4317 * 1024 * 1024, volName: 'data' },
    ];

    const selected = selectDumpParts({
      hasGpt: false,
      gptParts: [],
      userAreaAnalysis: { tableType: 'none', partitions: [] },
      firmwareParts: [],
      filesystemHits: hits,
      fileSize: 0x3a3e00000,
    });

    assert.strictEqual(selected.length, 2);
    assert.strictEqual(selected[0].ptType, 'inferred_fs');
    assert.strictEqual(selected[0].inferred, true);
    assert.strictEqual(selected[1].name, 'data');
    assert.strictEqual(selected[1].ptType, 'inferred_fs');
  });

  it('scanFilesystemsAsync reports accurate progress and streams discovered hits', async () => {
    const offset = 0x00100000;
    const buf = createBufferWithExt4(offset, 4096, 4096, 'testvol');
    const fileSize = buf.length;

    const mockFile = {
      size: fileSize,
      slice: (start, end) => ({
        arrayBuffer: async () => {
          const sliceBuf = buf.subarray(start, Math.min(end, buf.length));
          return sliceBuf.buffer.slice(sliceBuf.byteOffset, sliceBuf.byteOffset + sliceBuf.length);
        },
      }),
    };

    const progressUpdates = [];
    const hitUpdates = [];

    const result = await scanFilesystemsAsync(
      mockFile,
      0x100000,
      (p) => progressUpdates.push(p),
      (hits) => hitUpdates.push(hits)
    );

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].volName, 'testvol');
    assert.ok(progressUpdates.length > 0);
    assert.strictEqual(progressUpdates[progressUpdates.length - 1].percent, 100);
    assert.ok(hitUpdates.length > 0);
  });
});
