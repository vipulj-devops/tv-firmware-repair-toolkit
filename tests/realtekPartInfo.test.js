// Test for Realtek PART.INFO binary partition table format
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRealtekPartInfo,
  isRealtekPartInfo,
  parseRealtekPartInfo,
  realtekPartInfoFormat,
} from '../src/lib/userArea/formats/realtekPartInfo.js';

// Helper to create a buffer with a valid PART.INFO header and entries
function createValidPartInfoBuffer() {
  const headerSize = 80;
  const entrySize = 96;
  const maxParts = 64;
  const buffer = Buffer.alloc(headerSize + maxParts * entrySize);

  // Header
  buffer.writeUInt32LE(0x20120716, 0); // magic
  buffer.writeUInt32LE(0, 4); // reserved
  buffer.writeUInt32LE(0, 8); // reserved
  buffer.writeUInt32LE(maxParts, 0x0C); // max_partitions
  buffer.write('h13_emmc\0', 0x10, 'ascii'); // target device
  buffer.writeBigUInt64LE(BigInt(0x100000000), 0x30); // total_disk_size = 4GB (example)
  // Remaining header bytes are zero by default

  // Entries
  let entryOff = headerSize;
  for (let i = 0; i < maxParts; i++) {
    // Name: "partinfo" for entry 1 (i===1), otherwise "part0", "part1", ... null-terminated and padded
    const name = i === 1 ? 'partinfo' : `part${i}`;
    buffer.write(name, entryOff, name.length, 'ascii');
    // Offset: i * 0x100000 (1MB each)
    buffer.writeBigUInt64LE(BigInt(i * 0x100000), entryOff + 0x20);
    // Size: 0x100000 (1MB) for all except last
    const size = i === maxParts - 1 ? 0x50000 : 0x100000; // last entry smaller
    buffer.writeBigUInt64LE(BigInt(size), entryOff + 0x28);
    // Image name: "img0.bin", etc.
    const imgName = `img${i}.bin\0`;
    buffer.write(imgName, entryOff + 0x30, imgName.length, 'ascii');
    // Image size: half of declared size
    buffer.writeUInt32LE(Math.floor(size / 2), entryOff + 0x48);
    // Image CRC: 0
    buffer.writeUInt32LE(0, entryOff + 0x4C);
    // Flags: 0
    buffer.writeUInt32LE(0, entryOff + 0x50);
    // Type ID: 0
    buffer.writeUInt32LE(0, entryOff + 0x54);
    // Padding: already zero
    entryOff += entrySize;
  }

  return buffer;
}

describe('Realtek PART.INFO (binary partition table)', () => {
  it('detects a valid PART.INFO table at offset 0', () => {
    const buf = createValidPartInfoBuffer();
    const det = isRealtekPartInfo(buf, buf.length);
    assert.strictEqual(det, true);
    assert.strictEqual(findRealtekPartInfo(buf, buf.length), 0);
  });

  it('detects PART.INFO table placed at non-zero offset 0x100000 (1 MB)', () => {
    const tableBuf = createValidPartInfoBuffer();
    const targetOff = 0x100000; // 1 MB
    const largeBuf = Buffer.alloc(targetOff + tableBuf.length, 0xff); // erased bytes before 1 MB
    tableBuf.copy(largeBuf, targetOff);

    // Verify offset finder
    const foundOff = findRealtekPartInfo(largeBuf, 0x100000000);
    assert.strictEqual(foundOff, targetOff);

    // Verify detector
    assert.strictEqual(isRealtekPartInfo(largeBuf, 0x100000000), true);

    // Verify format detection marker contains 0x100000
    const hit = realtekPartInfoFormat.detect(largeBuf, 0x100000000);
    assert.ok(hit);
    assert.strictEqual(hit.marker, 'Realtek PART.INFO @0x100000');

    // Verify parsing from 1 MB offset
    const parts = parseRealtekPartInfo(largeBuf, 0x100000000);
    assert.strictEqual(parts.length, 64);
    assert.strictEqual(parts[0].name, 'part0');
    assert.strictEqual(parts[0].offset, 0);
    assert.strictEqual(parts[1].name, 'partinfo');
    assert.strictEqual(parts[1].offset, 0x100000);
  });

  it('rejects invalid magic', () => {
    const buf = createValidPartInfoBuffer();
    buf.writeUInt32LE(0xdeadbeef, 0); // corrupt magic
    const det = isRealtekPartInfo(buf, buf.length);
    assert.strictEqual(det, false);
  });

  it('rejects invalid target device string', () => {
    const buf = createValidPartInfoBuffer();
    buf.write('no_target_device\0', 0x10, 'ascii');
    const det = isRealtekPartInfo(buf, buf.length);
    assert.strictEqual(det, false);
  });

  it('rejects max_partitions out of range', () => {
    const buf = createValidPartInfoBuffer();
    buf.writeUInt32LE(0, 0x0c); // zero max parts
    const det = isRealtekPartInfo(buf, buf.length);
    assert.strictEqual(det, false);
    buf.writeUInt32LE(100, 0x0c); // too many
    const det2 = isRealtekPartInfo(buf, buf.length);
    assert.strictEqual(det2, false);
  });

  it('rejects zero total disk size', () => {
    const buf = createValidPartInfoBuffer();
    buf.writeBigUInt64LE(0n, 0x30);
    const det = isRealtekPartInfo(buf, buf.length);
    assert.strictEqual(det, false);
  });

  it('parses entries correctly', () => {
    const buf = createValidPartInfoBuffer();
    const parts = parseRealtekPartInfo(buf, 0x100000000);
    assert.strictEqual(parts.length, 64);
    // Check first entry
    assert.strictEqual(parts[0].name, 'part0');
    assert.strictEqual(parts[0].offset, 0);
    assert.strictEqual(parts[0].size, 0x100000);
    assert.strictEqual(parts[0].declaredSize, 0x100000);
    assert.strictEqual(parts[0].availableSize, 0x100000);
    assert.strictEqual(parts[0].truncated, false);
    assert.strictEqual(parts[0].unavailable, false);
    // Check last entry (size 0x50000)
    const last = parts[63];
    assert.strictEqual(last.name, 'part63');
    assert.strictEqual(last.offset, 63 * 0x100000);
    assert.strictEqual(last.size, 0x50000);
    assert.strictEqual(last.declaredSize, 0x50000);
    assert.strictEqual(last.availableSize, 0x50000);
  });

  it('handles truncated final partition (extends beyond fileSize)', () => {
    const buf = createValidPartInfoBuffer();
    const fileSize = 50 * 0x100000; // 50MB, so only first 50 entries fully available
    const parts = parseRealtekPartInfo(buf, fileSize);
    // First 50 entries should be fully available
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(parts[i].unavailable, false);
      assert.strictEqual(parts[i].truncated, false);
      assert.strictEqual(parts[i].availableSize, parts[i].declaredSize);
    }
    // Entry 50 starts at 50 * 0x100000 = fileSize exactly -> unavailable = true (since offset >= fileSize)
    assert.strictEqual(parts[50].offset, fileSize);
    assert.strictEqual(parts[50].unavailable, true);
    assert.strictEqual(parts[50].availableSize, 0);
    assert.strictEqual(parts[50].truncated, false);
    // Entries beyond 50 have offset > fileSize -> unavailable = true
    for (let i = 51; i < parts.length; i++) {
      assert.strictEqual(parts[i].unavailable, true);
      assert.strictEqual(parts[i].availableSize, 0);
      assert.strictEqual(parts[i].truncated, false);
    }
  });

  it('handles partition that begins before EOF but extends beyond (truncated)', () => {
    const buf = createValidPartInfoBuffer();
    const fileSize = 50 * 0x100000 + 0x80000;
    const parts = parseRealtekPartInfo(buf, fileSize);
    assert.strictEqual(parts[50].offset, 50 * 0x100000);
    assert.strictEqual(parts[50].size, 0x100000);
    assert.strictEqual(parts[50].declaredSize, 0x100000);
    assert.strictEqual(parts[50].truncated, true);
    assert.strictEqual(parts[50].unavailable, false);
    assert.strictEqual(parts[50].availableSize, 0x80000);
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(parts[i].truncated, false);
      assert.strictEqual(parts[i].unavailable, false);
      assert.strictEqual(parts[i].availableSize, parts[i].declaredSize);
    }
    for (let i = 51; i < parts.length; i++) {
      assert.strictEqual(parts[i].unavailable, true);
      assert.strictEqual(parts[i].availableSize, 0);
      assert.strictEqual(parts[i].truncated, false);
    }
  });

  it('accepts duplicate partition names', () => {
    const buf = createValidPartInfoBuffer();
    const entryOff0 = 80;
    const entryOff1 = 80 + 96;
    buf.write('partinfo\0', entryOff0, 9, 'ascii');
    buf.write('partinfo\0', entryOff1, 9, 'ascii');
    const parts = parseRealtekPartInfo(buf, buf.length);
    assert.strictEqual(parts.length, 64);
    assert.strictEqual(parts[0].name, 'partinfo');
    assert.strictEqual(parts[1].name, 'partinfo');
    assert.strictEqual(parts[0].offset, 0);
    assert.strictEqual(parts[1].offset, 0x100000);
  });
});
