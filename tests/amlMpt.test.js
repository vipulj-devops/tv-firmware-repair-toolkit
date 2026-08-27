import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUserArea,
  detectSocUserArea,
  findAmlMpt,
  isAmlMpt,
  isEmmc1630Map,
  userAreaToParts,
} from '../src/lib/userAreaParser.js';
import { autoMapPartitions, findGptOffset, hasGpt } from '../src/lib/emmc.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(dir, 'fixtures', 'aml-mpt-header.bin'));
const hisiFixture = readFileSync(join(dir, 'fixtures', 'hisi-partmap-header.bin'));

const ROM1_SIZE = 0x1d2000000;
const MPT_FILE_OFF = 0x2400000;

function copy(src = fixture) {
  return new Uint8Array(src);
}

function w32(buf, off, val) {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

function w64(buf, off, val) {
  const n = BigInt(val);
  w32(buf, off, Number(n & 0xffffffffn));
  w32(buf, off + 4, Number((n >> 32n) & 0xffffffffn));
}

describe('Amlogic MPT (MPT header, 40-byte entries)', () => {
  it('detects a valid MPT table from the truncated ROM1 fixture', () => {
    const det = detectSocUserArea(fixture, ROM1_SIZE);
    assert.equal(det.tableType, 'aml_mpt');
    assert.equal(det.soc, 'amlogic');
    assert.equal(isAmlMpt(fixture, ROM1_SIZE), true);
    assert.equal(findAmlMpt(fixture, ROM1_SIZE), 0);
  });

  it('parses 21 partitions and bootloader at absolute byte offsets', () => {
    const analysis = analyzeUserArea(fixture, ROM1_SIZE);
    assert.equal(analysis.tableType, 'aml_mpt');
    assert.equal(analysis.partitions.length, 21);

    const byName = Object.fromEntries(analysis.partitions.map((p) => [p.name, p]));
    assert.equal(byName.bootloader.offset, 0x0);
    assert.equal(byName.bootloader.size, 0x400000);
    assert.equal(byName.reserved.offset, 0x2400000);
    assert.equal(byName.reserved.size, 0x4000000);
    assert.equal(byName.cache.offset, 0x6c00000);
    assert.equal(byName.cache.size, 0x12c00000);
    assert.equal(byName.env.offset, 0x1a000000);
    assert.equal(byName.env.size, 0x800000);
    assert.equal(byName.boot.offset, 0x21800000);
    assert.equal(byName.boot.size, 0x1000000);
    assert.equal(byName.system.offset, 0x44000000);
    assert.equal(byName.system.size, 0x60000000);
    assert.equal(byName.vbmeta.offset, 0xa6000000);
    assert.equal(byName.vbmeta.size, 0x200000);
    assert.equal(byName.data.offset, 0xb8a00000);
    assert.equal(byName.data.size, 0x119600000);
    assert.equal(byName.data.offset + byName.data.size, ROM1_SIZE);

    const parts = userAreaToParts(analysis);
    assert.equal(parts.length, 21);
    assert.equal(parts[0].name, 'bootloader');
    assert.equal(parts[0].ptType, 'aml_mpt');
    assert.equal(parts[0].startByte, 0);
    assert.equal(parts[0].size, 0x400000);
    assert.ok(!parts.some((p) => p.name === 'Part_Map'));
  });

  it('finds MPT at 0x2400000 in a head-sized buffer (absolute entry offsets)', () => {
    const buf = new Uint8Array(MPT_FILE_OFF + 0x4010);
    buf.set(fixture, MPT_FILE_OFF);
    buf.set(Buffer.from('AMLSECURITY\0', 'ascii'), MPT_FILE_OFF + 0x4000);
    assert.equal(findAmlMpt(buf, ROM1_SIZE), MPT_FILE_OFF);
    const det = detectSocUserArea(buf, ROM1_SIZE);
    assert.equal(det.tableType, 'aml_mpt');
    assert.equal(analyzeUserArea(buf, ROM1_SIZE).partitions[0].offset, 0);
  });

  it('does not treat AMLSECURITY as an MPT or AMLS table', () => {
    const buf = new Uint8Array(0x5000);
    buf.set(Buffer.from('AMLSECURITY', 'ascii'), 0x4000);
    assert.equal(isAmlMpt(buf, ROM1_SIZE), false);
    assert.equal(detectSocUserArea(buf, ROM1_SIZE).tableType, 'none');
  });

  it('rejects a malformed header (wrong magic, version, or count)', () => {
    const badMagic = copy();
    badMagic[0] = 0x41;
    assert.equal(isAmlMpt(badMagic, ROM1_SIZE), false);
    assert.equal(detectSocUserArea(badMagic, ROM1_SIZE).tableType, 'none');

    const badVer = copy();
    badVer[4] = 0x58;
    assert.equal(isAmlMpt(badVer, ROM1_SIZE), false);

    const zeroCount = copy();
    w32(zeroCount, 0x10, 0);
    assert.equal(isAmlMpt(zeroCount, ROM1_SIZE), false);

    const hugeCount = copy();
    w32(hugeCount, 0x10, 99);
    assert.equal(isAmlMpt(hugeCount, ROM1_SIZE), false);
  });

  it('accepts MPT entries with size === 0 and preserves zero size and following offsets', () => {
    const zeroSize = copy();
    w64(zeroSize, 0x18 + 16, 0); // set bootloader size to 0
    assert.equal(isAmlMpt(zeroSize, ROM1_SIZE), true);
    const analysis = analyzeUserArea(zeroSize, ROM1_SIZE);
    assert.equal(analysis.tableType, 'aml_mpt');
    const bootloader = analysis.partitions.find((p) => p.name === 'bootloader');
    assert.ok(bootloader);
    assert.equal(bootloader.size, 0);
    assert.equal(bootloader.offset, 0);
    const reserved = analysis.partitions.find((p) => p.name === 'reserved');
    assert.ok(reserved);
    assert.equal(reserved.offset, 0x2400000);
  });

  it('rejects invalid entries (empty name or binary name)', () => {
    const emptyName = copy();
    emptyName[0x18] = 0;
    assert.equal(isAmlMpt(emptyName, ROM1_SIZE), false);
    assert.equal(detectSocUserArea(emptyName, ROM1_SIZE).tableType, 'none');

    const binaryName = copy();
    binaryName[0x18] = 0x01;
    binaryName[0x19] = 0x02;
    binaryName[0x1a] = 0x03;
    binaryName[0x1b] = 0x04;
    assert.equal(isAmlMpt(binaryName, ROM1_SIZE), false);
  });

  it('parses T950X4 Amlogic MPT pattern fixture (29 partitions including zero-size cache)', () => {
    const fileSize = 7818182656; // 7.281 GB
    const buf = new Uint8Array(2048);
    // Header
    buf.set(new Uint8Array([0x4d, 0x50, 0x54, 0x00, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x2e, 0x30, 0x30]), 0);
    w32(buf, 0x10, 29); // 29 count

    const partsDef = [
      ['bootloader', 0, 4 * 1024 * 1024],
      ['reserved', 0x2400000, 64 * 1024 * 1024],
      ['cache', 0x6c00000, 0], // zero size!
      ['env', 0x7400000, 8 * 1024 * 1024],
      ['frp', 0x8400000, 2 * 1024 * 1024],
      ['factory', 0x8e00000, 8 * 1024 * 1024],
      ['vendor_boot_a', 0x9e00000, 32 * 1024 * 1024],
      ['vendor_boot_b', 0xc600000, 32 * 1024 * 1024],
      ['tee', 0xee00000, 32 * 1024 * 1024],
      ['logo', 0x11600000, 8 * 1024 * 1024],
      ['misc', 0x12600000, 2 * 1024 * 1024],
      ['dtbo_a', 0x13000000, 2 * 1024 * 1024],
      ['dtbo_b', 0x13a00000, 2 * 1024 * 1024],
      ['cri_data', 0x14400000, 8 * 1024 * 1024],
      ['param', 0x15400000, 16 * 1024 * 1024],
      ['oem_a', 0x16c00000, 32 * 1024 * 1024],
      ['oem_b', 0x19400000, 32 * 1024 * 1024],
      ['boot_a', 0x1bc00000, 80 * 1024 * 1024],
      ['boot_b', 0x21400000, 80 * 1024 * 1024],
      ['rsv', 0x26c00000, 16 * 1024 * 1024],
      ['metadata', 0x28400000, 16 * 1024 * 1024],
      ['vbmeta_a', 0x29c00000, 2 * 1024 * 1024],
      ['vbmeta_b', 0x2a600000, 2 * 1024 * 1024],
      ['vbmeta_system_a', 0x2b000000, 2 * 1024 * 1024],
      ['vbmeta_system_b', 0x2ba00000, 2 * 1024 * 1024],
      ['odm_ext_a', 0x2c400000, 64 * 1024 * 1024],
      ['odm_ext_b', 0x30c00000, 64 * 1024 * 1024],
      ['super', 0x35400000, 2300 * 1024 * 1024],
      ['userdata', 0xc5800000, 4296 * 1024 * 1024],
    ];

    partsDef.forEach(([name, off, sz], idx) => {
      const e = 0x18 + idx * 40;
      buf.set(Buffer.from(name, 'ascii'), e);
      w64(buf, e + 16, sz);
      w64(buf, e + 24, off);
    });

    assert.equal(isAmlMpt(buf, fileSize), true);
    const analysis = analyzeUserArea(buf, fileSize);
    assert.equal(analysis.tableType, 'aml_mpt');
    assert.equal(analysis.partitions.length, 29);

    const cachePart = analysis.partitions.find((p) => p.name === 'cache');
    assert.ok(cachePart);
    assert.equal(cachePart.size, 0);
    assert.equal(cachePart.offset, 0x6c00000);

    const userdataPart = analysis.partitions.find((p) => p.name === 'userdata');
    assert.ok(userdataPart);
    assert.equal(userdataPart.offset, 0xc5800000);

    const mapped = userAreaToParts(analysis);
    assert.equal(mapped.length, 29);
    assert.equal(mapped[2].name, 'cache');
    assert.equal(mapped[2].size, 0);
    assert.equal(mapped[28].name, 'userdata');
    assert.equal(mapped[28].startByte, 0xc5800000);
  });

  it('rejects a lone MPT magic without a valid table', () => {
    const buf = new Uint8Array(512);
    buf[0] = 0x4d;
    buf[1] = 0x50;
    buf[2] = 0x54;
    buf[3] = 0x00;
    assert.equal(isAmlMpt(buf, ROM1_SIZE), false);
    assert.equal(detectSocUserArea(buf, ROM1_SIZE).tableType, 'none');
  });
});

describe('existing GPT detection is unchanged with MPT present later', () => {
  function gptBuffer() {
    const bytes = new Uint8Array(512 * 4);
    const gptOff = 512;
    bytes.set(Buffer.from('EFI PART', 'ascii'), gptOff);
    w32(bytes, gptOff + 0x0c, 92);
    w32(bytes, gptOff + 0x18, 1);
    w32(bytes, gptOff + 0x48, 2);
    w32(bytes, gptOff + 0x50, 1);
    w32(bytes, gptOff + 0x54, 128);
    bytes[0x1FE] = 0x55;
    bytes[0x1FF] = 0xaa;
    bytes[0x1BE + 4] = 0xee;
    return bytes;
  }

  it('still recognizes EFI PART as GPT in the user-area detector', () => {
    const bytes = gptBuffer();
    bytes.set(fixture.subarray(0, Math.min(fixture.length, bytes.length - 1024)), 1024);
    const det = detectSocUserArea(bytes, ROM1_SIZE);
    assert.equal(det.tableType, 'gpt');
    assert.notEqual(det.tableType, 'aml_mpt');
    assert.equal(hasGpt(bytes), true);
    assert.equal(findGptOffset(bytes), 512);
    assert.equal(autoMapPartitions(fixture, fixture.length).length, 0);
  });
});

describe('existing eMMC 0x1630/0x5840 map detection is unchanged', () => {
  it('still classifies the 0x1630/0x5840 fixture as emmc_1630_5840, not aml_mpt', () => {
    assert.equal(isEmmc1630Map(hisiFixture), true);
    const det = detectSocUserArea(hisiFixture, 0x3a3e00000);
    assert.equal(det.tableType, 'emmc_1630_5840');
    assert.notEqual(det.tableType, 'aml_mpt');
    assert.equal(isAmlMpt(hisiFixture, 0x3a3e00000), false);
  });
});
