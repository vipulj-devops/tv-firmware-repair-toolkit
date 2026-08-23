import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { scanFilesystems } from '../src/lib/detectFilesystems.js';
import { analyzeFirmware, firmwarePartitionsToParts } from '../src/lib/firmwareParser.js';
import { analyzeUserArea } from '../src/lib/userAreaParser.js';
import { hasGpt, autoMapPartitions } from '../src/lib/emmc.js';
import { selectDumpParts } from '../src/lib/userArea/selectDumpParts.js';

function squashHeader({ inodes = 10, blockLog = 17, major = 4, minor = 0, bytesUsed = 4096 } = {}) {
  const buf = Buffer.alloc(96, 0);
  buf.write('hsqs', 0, 4, 'ascii');
  buf.writeUInt32LE(inodes, 4);
  buf.writeUInt32LE(1 << blockLog, 12);
  buf.writeUInt16LE(1, 20); // gzip
  buf.writeUInt16LE(blockLog, 22);
  buf.writeUInt16LE(major, 28);
  buf.writeUInt16LE(minor, 30);
  buf.writeBigUInt64LE(BigInt(bytesUsed), 40);
  return buf;
}

function ext4Image({ blocks = 256, logBlockSize = 2, blocksPerGroup = 256, inodesPerGroup = 32, inodeSize = 256 } = {}) {
  const buf = Buffer.alloc(2048, 0);
  const sb = 1024;
  buf.writeUInt32LE(blocks, sb + 0x04);
  buf.writeUInt32LE(0, sb + 0x14); // first data block
  buf.writeUInt32LE(logBlockSize, sb + 0x18);
  buf.writeUInt32LE(blocksPerGroup, sb + 0x20);
  buf.writeUInt32LE(inodesPerGroup, sb + 0x28);
  buf.writeUInt32LE(1, sb + 0x4c); // rev 1
  buf.writeUInt16LE(0xef53, sb + 0x38);
  buf.writeUInt16LE(inodeSize, sb + 0x58);
  return buf;
}

describe('scanFilesystems (independent of partition tables)', () => {
  it('detects a valid SquashFS header', () => {
    const bytes = Buffer.alloc(0x2000, 0xff);
    bytes.set(squashHeader({ bytesUsed: 0x1234, major: 4, minor: 0 }), 0x100);
    const hits = scanFilesystems(bytes, bytes.length);
    const sq = hits.filter((h) => h.type === 'squashfs');
    assert.equal(sq.length, 1);
    assert.equal(sq[0].offset, 0x100);
    assert.equal(sq[0].size, 0x1234);
    assert.equal(sq[0].version, '4.0');
  });

  it('detects a valid ext4 superblock at fs+0x438', () => {
    const bytes = ext4Image();
    const hits = scanFilesystems(bytes, 256 * 4096);
    const ext = hits.filter((h) => h.type === 'ext4');
    assert.equal(ext.length, 1);
    assert.equal(ext[0].offset, 0);
    assert.equal(ext[0].blockSize, 4096);
    assert.equal(ext[0].size, 256 * 4096);
  });

  it('does not treat a stray EF53 as ext4', () => {
    const bytes = Buffer.alloc(4096, 0);
    bytes[200] = 0x53;
    bytes[201] = 0xef;
    bytes.writeUInt16LE(0xef53, 1080 + 17); // unaligned-ish junk
    const hits = scanFilesystems(bytes, bytes.length);
    assert.equal(hits.filter((h) => h.type === 'ext4').length, 0);
  });

  it('rejects SquashFS with impossible header fields', () => {
    const bytes = squashHeader({ blockLog: 17, bytesUsed: 96 });
    bytes.writeUInt32LE(999, 12); // block_size != 1<<block_log
    assert.equal(scanFilesystems(bytes, 1024).length, 0);
  });

  it('does not feed filesystem hits into selectDumpParts', () => {
    const bytes = Buffer.alloc(0x2000, 0);
    bytes.set(squashHeader({ bytesUsed: 0x800 }), 0x100);
    const hits = scanFilesystems(bytes, 0x100000);
    assert.ok(hits.some((h) => h.type === 'squashfs'));
    const selected = selectDumpParts({
      hasGpt: false,
      gptParts: [],
      userAreaAnalysis: { tableType: 'none', soc: 'unknown', partitions: [] },
      firmwareParts: [],
    });
    assert.equal(selected.length, 0);
  });
});

const SUSPECT = 'G:\\EMMC_LG32SWE-F64-P639\\EMMC_8GTF4R_USER_00000000_00E8FFFF_20251219_124500.bin';

describe('LG/Realtek dump: filesystems independent of empty PT', () => {
  it('stays Realtek / PT none / 0 parts and can still report squashfs+ext4', {
    skip: !existsSync(SUSPECT),
  }, () => {
    const size = statSync(SUSPECT).size;
    const fd = openSync(SUSPECT, 'r');
    const buf = Buffer.alloc(Math.min(128 * 1024 * 1024, size));
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);

    const fw = analyzeFirmware(buf, 'dump.bin', size, null);
    const ua = analyzeUserArea(buf, size);
    const parts = selectDumpParts({
      hasGpt: hasGpt(buf),
      gptParts: autoMapPartitions(buf, size),
      userAreaAnalysis: ua,
      firmwareParts: firmwarePartitionsToParts(fw, size),
    });
    assert.equal(fw.family, 'Realtek');
    assert.equal(hasGpt(buf), false);
    assert.equal(ua.tableType, 'none');
    assert.equal(parts.length, 0);

    const hits = scanFilesystems(buf, size);
    const types = hits.map((h) => `${h.type}@0x${h.offset.toString(16)}`);
    assert.ok(hits.some((h) => h.type === 'squashfs' && h.offset === 0x980000), types.join(','));
    assert.ok(hits.some((h) => h.type === 'ext4' && h.offset === 0x3400000), types.join(','));
    assert.ok(hits.some((h) => h.type === 'squashfs' && h.offset === 0x7a80000), types.join(','));
  });
});
