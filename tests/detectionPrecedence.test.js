import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUserArea,
  detectSocUserArea,
  userAreaToParts,
} from '../src/lib/userAreaParser.js';
import { selectDumpParts } from '../src/lib/userArea/selectDumpParts.js';
import { autoMapPartitions, hasGpt, parseMbr } from '../src/lib/emmc.js';

const dir = dirname(fileURLToPath(import.meta.url));
const hisiFixture = readFileSync(join(dir, 'fixtures', 'hisi-partmap-header.bin'));
const mptFixture = readFileSync(join(dir, 'fixtures', 'aml-mpt-header.bin'));
const blkFixture = readFileSync(join(dir, 'fixtures', 'blkdevparts-mmc-env.bin'));

const ROM1_SIZE = 0x1d2000000;
const BLK_SIZE = 0xe9000000;
const HISI_SIZE = 0x3a3e00000;

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

function writeUsableMbr(bytes) {
  bytes[0x1BE + 4] = 0x83;
  w32(bytes, 0x1BE + 8, 0x800);
  w32(bytes, 0x1BE + 12, 0x1000);
  w16(bytes, 0x1FE, 0xaa55);
}

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

function placeAfterMbr(fixture) {
  const bytes = new Uint8Array(512 + fixture.length);
  writeUsableMbr(bytes);
  bytes.set(fixture, 512);
  return bytes;
}

describe('detection precedence: existing strict fixtures', () => {
  it('still detects the Amlogic MPT fixture as aml_mpt', () => {
    assert.equal(detectSocUserArea(mptFixture, ROM1_SIZE).tableType, 'aml_mpt');
    assert.equal(analyzeUserArea(mptFixture, ROM1_SIZE).partitions.length, 21);
  });

  it('still detects the eMMC 0x1630/0x5840 map fixture as emmc_1630_5840', () => {
    assert.equal(detectSocUserArea(hisiFixture, HISI_SIZE).tableType, 'emmc_1630_5840');
  });

  it('still detects the blkdevparts fixture as blkdevparts_mmc', () => {
    assert.equal(detectSocUserArea(blkFixture, BLK_SIZE).tableType, 'blkdevparts_mmc');
    assert.equal(analyzeUserArea(blkFixture, BLK_SIZE).partitions.length, 25);
  });
});

describe('detection precedence: GPT and MBR', () => {
  it('still detects a valid GPT signature as gpt', () => {
    const bytes = gptBuffer();
    assert.equal(detectSocUserArea(bytes).tableType, 'gpt');
    assert.equal(hasGpt(bytes), true);
  });

  it('still detects a usable primary MBR as mbr', () => {
    const bytes = new Uint8Array(512);
    writeUsableMbr(bytes);
    assert.equal(detectSocUserArea(bytes, 0x100000).tableType, 'mbr');
    assert.equal(parseMbr(bytes, 0).length, 1);
  });

  it('does not classify a lone 0xAA55 as mbr', () => {
    const bytes = new Uint8Array(512);
    w16(bytes, 0x1FE, 0xaa55);
    assert.equal(parseMbr(bytes, 0).length, 0);
    assert.equal(detectSocUserArea(bytes, 0x100000).tableType, 'none');
  });

  it('does not let a lone 0xAA55 block a strict registry format', () => {
    const bytes = placeAfterMbr(mptFixture);
    bytes[0x1BE + 4] = 0;
    w32(bytes, 0x1BE + 8, 0);
    w32(bytes, 0x1BE + 12, 0);
    w16(bytes, 0x1FE, 0xaa55);
    assert.equal(parseMbr(bytes, 0).length, 0);
    assert.equal(detectSocUserArea(bytes, ROM1_SIZE).tableType, 'aml_mpt');
  });
});

describe('detection precedence: strict registry beats usable MBR', () => {
  it('prefers blkdevparts_mmc over a usable primary MBR', () => {
    const bytes = placeAfterMbr(blkFixture);
    assert.equal(parseMbr(bytes, 0).length, 1);
    assert.equal(detectSocUserArea(bytes, BLK_SIZE).tableType, 'blkdevparts_mmc');
    const ua = analyzeUserArea(bytes, BLK_SIZE);
    const selected = selectDumpParts({
      hasGpt: false,
      gptParts: autoMapPartitions(bytes, BLK_SIZE),
      userAreaAnalysis: ua,
      firmwareParts: [],
      bytes,
    });
    assert.equal(selected[0].ptType, 'blkdevparts_mmc');
    assert.equal(selected.length, 25);
  });

  it('prefers aml_mpt over a usable primary MBR', () => {
    const bytes = placeAfterMbr(mptFixture);
    assert.equal(parseMbr(bytes, 0).length, 1);
    assert.equal(detectSocUserArea(bytes, ROM1_SIZE).tableType, 'aml_mpt');
    const ua = analyzeUserArea(bytes, ROM1_SIZE);
    const selected = selectDumpParts({
      hasGpt: false,
      gptParts: autoMapPartitions(bytes, ROM1_SIZE),
      userAreaAnalysis: ua,
      firmwareParts: [],
      bytes,
    });
    assert.equal(selected[0].ptType, 'aml_mpt');
    assert.equal(userAreaToParts(ua).length, 21);
  });

  it('prefers emmc_1630_5840 over a usable primary MBR in the same first sector', () => {
    const bytes = Uint8Array.from(hisiFixture);
    writeUsableMbr(bytes);
    assert.equal(parseMbr(bytes, 0).length, 1);
    assert.equal(detectSocUserArea(bytes, HISI_SIZE).tableType, 'emmc_1630_5840');
  });
});

describe('detection precedence: weak strings and magics', () => {
  it('keeps emmc_1630_5840 when HISILICON ASCII is in the first 4 KB', () => {
    const bytes = Uint8Array.from(hisiFixture);
    bytes.set(Buffer.from('HISILICON', 'ascii'), 64);
    assert.equal(detectSocUserArea(bytes, HISI_SIZE).tableType, 'emmc_1630_5840');
  });

  it('keeps blkdevparts_mmc when HISILICON ASCII is in the first 4 KB', () => {
    const bytes = new Uint8Array(Math.max(0x20 + blkFixture.length, blkFixture.length));
    bytes.set(Buffer.from('HISILICON', 'ascii'), 0);
    bytes.set(blkFixture, 16);
    assert.equal(detectSocUserArea(bytes, BLK_SIZE).tableType, 'blkdevparts_mmc');
  });

  it('does not classify RTK text without mtdparts as uboot_env', () => {
    const bytes = new Uint8Array(512);
    bytes.set(Buffer.from('RTK boot loader', 'ascii'), 0);
    assert.equal(detectSocUserArea(bytes, 0x100000).tableType, 'none');
  });

  it('does not classify AMLS magic without a usable AMLS table as aml_mbr', () => {
    const bytes = new Uint8Array(256);
    bytes.set(Buffer.from('AMLS', 'ascii'), 0);
    assert.equal(detectSocUserArea(bytes, 0x100000).tableType, 'none');
  });

  it('does not classify MSTAR magic without a usable MStar table as mstar', () => {
    const bytes = new Uint8Array(0x400);
    bytes.set(Buffer.from('MSTAR', 'ascii'), 0x200);
    assert.equal(detectSocUserArea(bytes, 0x100000).tableType, 'none');
  });

  it('does not classify NVTK magic without a usable NVTK table as nvtk', () => {
    const bytes = new Uint8Array(64);
    bytes.set(Buffer.from('NVTK', 'ascii'), 0);
    assert.equal(detectSocUserArea(bytes, 0x100000).tableType, 'none');
  });
});

describe('selectDumpParts', () => {
  it('uses GPT mapping when hasGpt is true', () => {
    const gptParts = [{ name: 'system', ptType: 'gpt', startByte: 0, size: 1 }];
    const ua = analyzeUserArea(mptFixture, ROM1_SIZE);
    const selected = selectDumpParts({
      hasGpt: true,
      gptParts,
      userAreaAnalysis: ua,
      firmwareParts: [{ name: 'zip' }],
      bytes: gptBuffer(),
    });
    assert.equal(selected[0].ptType, 'gpt');
  });

  it('uses usable MBR when there is no GPT and no strict registry map', () => {
    const bytes = new Uint8Array(512);
    writeUsableMbr(bytes);
    const gptParts = autoMapPartitions(bytes, 0x100000);
    const selected = selectDumpParts({
      hasGpt: false,
      gptParts,
      userAreaAnalysis: detectSocUserArea(bytes, 0x100000).tableType === 'mbr'
        ? { ...detectSocUserArea(bytes, 0x100000), partitions: [] }
        : null,
      firmwareParts: [],
      bytes,
    });
    assert.ok(gptParts.length >= 1);
    assert.equal(selected[0].ptType, 'mbr');
  });
});

describe('detection precedence: mtdparts_emmc', () => {
  const MTD_SIZE = 8 * 1024 * 1024;
  const mtdSpec = Buffer.from('mtdparts=vendor-emmc:1M(boot),-(data)', 'latin1');

  it('still classifies GPT as gpt when mtdparts is also present', () => {
    const bytes = new Uint8Array(4096);
    bytes.set(gptBuffer(), 0);
    bytes.set(mtdSpec, 2048);
    assert.equal(detectSocUserArea(bytes, MTD_SIZE).tableType, 'gpt');
    assert.equal(hasGpt(bytes), true);
  });

  it('still classifies existing 0x1630, MPT, and blkdevparts fixtures ahead of mtdparts', () => {
    assert.equal(detectSocUserArea(hisiFixture, HISI_SIZE).tableType, 'emmc_1630_5840');
    assert.equal(detectSocUserArea(mptFixture, ROM1_SIZE).tableType, 'aml_mpt');
    assert.equal(detectSocUserArea(blkFixture, BLK_SIZE).tableType, 'blkdevparts_mmc');
  });

  it('prefers blkdevparts_mmc when both blkdevparts and mtdparts are present', () => {
    const bytes = new Uint8Array(blkFixture.length + 4 + mtdSpec.length);
    bytes.set(blkFixture, 0);
    bytes.set(mtdSpec, blkFixture.length + 1);
    assert.equal(detectSocUserArea(bytes, BLK_SIZE).tableType, 'blkdevparts_mmc');
  });

  it('prefers mtdparts_emmc over a usable primary MBR', () => {
    const bytes = placeAfterMbr(mtdSpec);
    assert.equal(parseMbr(bytes, 0).length, 1);
    assert.equal(detectSocUserArea(bytes, MTD_SIZE).tableType, 'mtdparts_emmc');
    const ua = analyzeUserArea(bytes, MTD_SIZE);
    const selected = selectDumpParts({
      hasGpt: false,
      gptParts: autoMapPartitions(bytes, MTD_SIZE),
      userAreaAnalysis: ua,
      firmwareParts: [],
    });
    assert.equal(selected[0].ptType, 'mtdparts_emmc');
    assert.equal(selected.length, 2);
  });
});
