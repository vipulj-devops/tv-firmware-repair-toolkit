import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUserArea,
  detectSocUserArea,
  isHisiEmmcMap,
  userAreaToParts,
} from '../src/lib/userAreaParser.js';
import { autoMapPartitions, findGptOffset, hasGpt, parseMbr } from '../src/lib/emmc.js';

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hisi-partmap-header.bin'),
);

function copy(src = fixture) {
  return new Uint8Array(src);
}

function w32(buf, off, val) {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

function w16(buf, off, val) {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
}

describe('HiSilicon eMMC Part_Map (0x1630/0x5840)', () => {
  it('detects a valid map from the truncated reference fixture', () => {
    const det = detectSocUserArea(fixture);
    assert.equal(det.tableType, 'hisi_emmc_map');
    assert.equal(det.soc, 'hisilicon');
    assert.equal(isHisiEmmcMap(fixture), true);
  });

  it('decodes MBOOT, MPOOL, and vbmeta_a with LBA*512 conversion', () => {
    const analysis = analyzeUserArea(fixture, 0x3a3e00000);
    assert.equal(analysis.tableType, 'hisi_emmc_map');
    const byName = Object.fromEntries(analysis.partitions.map((p) => [p.name, p]));

    assert.equal(byName.MBOOT.offset, 0x1000 * 512);
    assert.equal(byName.MBOOT.size, 0x2800 * 512);
    assert.equal(byName.MBOOT.offset, 0x200000);
    assert.equal(byName.MBOOT.size, 0x500000);

    assert.equal(byName.MPOOL.offset, 0x3800 * 512);
    assert.equal(byName.MPOOL.size, 0x10000 * 512);
    assert.equal(byName.MPOOL.offset, 0x700000);
    assert.equal(byName.MPOOL.size, 0x2000000);

    assert.equal(byName.vbmeta_a.offset, 0x13800 * 512);
    assert.equal(byName.vbmeta_a.size, 0x800 * 512);
    assert.equal(byName.vbmeta_a.offset, 0x2700000);
    assert.equal(byName.vbmeta_a.size, 0x100000);

    const parts = userAreaToParts(analysis);
    assert.ok(parts.length >= 3);
    assert.equal(parts[0].name, 'MBOOT');
    assert.equal(parts[0].ptType, 'hisi_emmc_map');
    assert.equal(parts[0].startByte, 0x200000);
    assert.equal(parts[0].size, 0x500000);
    assert.ok(!parts.some((p) => p.name === 'Part_Map'));
  });

  it('rejects a malformed header (wrong magic or non-zero reserved fields)', () => {
    const badMagic = copy();
    w32(badMagic, 0, 0x9999);
    assert.equal(isHisiEmmcMap(badMagic), false);
    assert.equal(detectSocUserArea(badMagic).tableType, 'none');

    const badReserved = copy();
    w32(badReserved, 4, 1);
    assert.equal(isHisiEmmcMap(badReserved), false);
    assert.equal(detectSocUserArea(badReserved).tableType, 'none');
  });

  it('rejects a wrong first-entry magic', () => {
    const buf = copy();
    w32(buf, 0x200, 0x1111);
    assert.equal(isHisiEmmcMap(buf), false);
    assert.equal(detectSocUserArea(buf).tableType, 'none');
  });

  it('rejects a non-printable / invalid first partition name', () => {
    const emptyName = copy();
    emptyName[0x210] = 0;
    assert.equal(isHisiEmmcMap(emptyName), false);

    const binaryName = copy();
    binaryName[0x210] = 0x01;
    binaryName[0x211] = 0x02;
    binaryName[0x212] = 0x03;
    binaryName[0x213] = 0x04;
    assert.equal(isHisiEmmcMap(binaryName), false);
    assert.equal(detectSocUserArea(binaryName).tableType, 'none');
  });
});

describe('existing GPT detection is unchanged', () => {
  function gptBuffer() {
    const bytes = new Uint8Array(512 * 4);
    const gptOff = 512;
    bytes.set(Buffer.from('EFI PART', 'ascii'), gptOff);
    w32(bytes, gptOff + 0x0c, 92);
    w32(bytes, gptOff + 0x18, 1); // myLba low
    w32(bytes, gptOff + 0x48, 2); // part entry LBA
    w32(bytes, gptOff + 0x50, 1); // num entries
    w32(bytes, gptOff + 0x54, 128); // entry size
    bytes[0x1FE] = 0x55;
    bytes[0x1FF] = 0xaa;
    bytes[0x1BE + 4] = 0xee;
    return bytes;
  }

  it('still recognizes EFI PART as GPT in the user-area detector', () => {
    const bytes = gptBuffer();
    const det = detectSocUserArea(bytes);
    assert.equal(det.tableType, 'gpt');
    assert.notEqual(det.tableType, 'hisi_emmc_map');
  });

  it('still finds a GPT header via emmc.js', () => {
    const bytes = gptBuffer();
    assert.equal(hasGpt(bytes), true);
    assert.equal(findGptOffset(bytes), 512);
    assert.equal(hasGpt(fixture), false);
    assert.equal(findGptOffset(fixture), -1);
    assert.equal(autoMapPartitions(fixture, fixture.length).length, 0);
  });
});

describe('existing MBR detection is unchanged', () => {
  function mbrBuffer() {
    const bytes = new Uint8Array(512);
    bytes[0x1BE + 4] = 0x83;
    w32(bytes, 0x1BE + 8, 0x800);
    w32(bytes, 0x1BE + 12, 0x1000);
    w16(bytes, 0x1FE, 0xaa55);
    return bytes;
  }

  it('still recognizes MBR in the user-area detector', () => {
    const bytes = mbrBuffer();
    const det = detectSocUserArea(bytes);
    assert.equal(det.tableType, 'mbr');
    assert.notEqual(det.tableType, 'hisi_emmc_map');
  });

  it('still parses MBR via emmc.js and ignores the Part_Map fixture', () => {
    const bytes = mbrBuffer();
    const parts = parseMbr(bytes, 0);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].ptType, 'mbr');
    assert.equal(parts[0].startByte, 0x800 * 512);
    assert.equal(parts[0].size, 0x1000 * 512);
    assert.equal(parseMbr(fixture, 0).length, 0);
    assert.equal(u16le(fixture, 0x1FE), 0);
  });
});

function u16le(bytes, o) {
  return bytes[o] | (bytes[o + 1] << 8);
}
