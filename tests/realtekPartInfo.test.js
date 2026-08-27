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
function createValidPartInfoBuffer(names = null) {
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

  // Entries
  let entryOff = headerSize;
  for (let i = 0; i < maxParts; i++) {
    let name;
    if (names && i < names.length) {
      name = names[i];
    } else {
      name = i === 1 ? 'partinfo' : `part${i}`;
    }
    buffer.write(name + '\0', entryOff, name.length + 1, 'ascii');
    buffer.writeBigUInt64LE(BigInt(i * 0x100000), entryOff + 0x20);
    const size = i === maxParts - 1 ? 0x50000 : 0x100000;
    buffer.writeBigUInt64LE(BigInt(size), entryOff + 0x28);
    const imgName = `img${i}.bin\0`;
    buffer.write(imgName, entryOff + 0x30, imgName.length, 'ascii');
    buffer.writeUInt32LE(Math.floor(size / 2), entryOff + 0x48);
    buffer.writeUInt32LE(0, entryOff + 0x4C);
    buffer.writeUInt32LE(0, entryOff + 0x50);
    buffer.writeUInt32LE(0, entryOff + 0x54);
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

  it('accepts a PART.INFO table where partinfo is at entry 2 (index 2) (LG WebOS pattern)', () => {
    // entry 0 = secureboot, entry 1 = boot, entry 2 = partinfo, entry 3 = mapbak
    const names = ['secureboot', 'boot', 'partinfo', 'mapbak', 'swue'];
    const tableBuf = createValidPartInfoBuffer(names);
    const targetOff = 0x500000; // 5 MB
    const largeBuf = Buffer.alloc(targetOff + tableBuf.length, 0xff);
    tableBuf.copy(largeBuf, targetOff);

    const foundOff = findRealtekPartInfo(largeBuf, 0x100000000);
    assert.strictEqual(foundOff, targetOff);
    assert.strictEqual(isRealtekPartInfo(largeBuf, 0x100000000), true);

    const hit = realtekPartInfoFormat.detect(largeBuf, 0x100000000);
    assert.ok(hit);
    assert.strictEqual(hit.marker, 'Realtek PART.INFO @0x500000');

    const parts = parseRealtekPartInfo(largeBuf, 0x100000000);
    assert.strictEqual(parts.length, 64);
    assert.strictEqual(parts[0].name, 'secureboot');
    assert.strictEqual(parts[1].name, 'boot');
    assert.strictEqual(parts[2].name, 'partinfo');
    assert.strictEqual(parts[3].name, 'mapbak');
  });

  it('rejects a PART.INFO table when none of the first 4 entries match partinfo or mapbak', () => {
    const names = ['secureboot', 'boot', 'kernel', 'rootfs', 'data'];
    const buf = createValidPartInfoBuffer(names);
    assert.strictEqual(isRealtekPartInfo(buf, buf.length), false);
    assert.strictEqual(findRealtekPartInfo(buf, buf.length), -1);
  });

  it('parses truncated reserved partition at physical EOF (LG WebOS 53-part pattern)', () => {
    const headerSize = 80;
    const entrySize = 96;
    const count = 53;
    const buf = Buffer.alloc(headerSize + count * entrySize);

    buf.writeUInt32LE(0x20120716, 0);
    buf.writeUInt32LE(count, 0x0c);
    buf.write('h13_emmc\0', 0x10, 'ascii');
    buf.writeBigUInt64LE(BigInt(0xe4800000 + 0x1b800000), 0x30); // declared disk size = 4GB

    // Entries: 0..51 normal, 52 = reserved at 0xE4800000 size 440MB (0x1B800000)
    for (let i = 0; i < count; i++) {
      const entryOff = headerSize + i * entrySize;
      let name = `part${i}`;
      if (i === 2) name = 'partinfo';
      if (i === 3) name = 'mapbak';
      if (i === 52) name = 'reserved';

      buf.write(name + '\0', entryOff, name.length + 1, 'ascii');
      if (i === 52) {
        buf.writeBigUInt64LE(BigInt(0xe4800000), entryOff + 0x20); // 0xE4800000
        buf.writeBigUInt64LE(BigInt(0x1b800000), entryOff + 0x28); // 440 MB
      } else {
        buf.writeBigUInt64LE(BigInt(i * 0x100000), entryOff + 0x20);
        buf.writeBigUInt64LE(BigInt(0x100000), entryOff + 0x28);
      }
    }

    // Physical EOF at 0xE9000000 (3,909,091,328 bytes)
    const fileSize = 0xe9000000;
    const parts = parseRealtekPartInfo(buf, fileSize);
    assert.strictEqual(parts.length, 53);

    const reserved = parts[52];
    assert.strictEqual(reserved.name, 'reserved');
    assert.strictEqual(reserved.offset, 0xe4800000);
    assert.strictEqual(reserved.declaredSize, 0x1b800000); // 440 MB
    assert.strictEqual(reserved.availableSize, 0xe9000000 - 0xe4800000); // 80 MB (0x4800000)
    assert.strictEqual(reserved.truncated, true);
    assert.strictEqual(reserved.unavailable, false);
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
