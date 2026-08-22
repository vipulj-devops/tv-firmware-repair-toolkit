import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUserArea,
  detectSocUserArea,
  isAmlMpt,
  isBlkdevpartsMmc,
  isHisiEmmcMap,
  userAreaToParts,
} from '../src/lib/userAreaParser.js';
import { autoMapPartitions, findGptOffset, hasGpt, parseMbr } from '../src/lib/emmc.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(dir, 'fixtures', 'blkdevparts-mmc-env.bin'));
const hisiFixture = readFileSync(join(dir, 'fixtures', 'hisi-partmap-header.bin'));
const mptFixture = readFileSync(join(dir, 'fixtures', 'aml-mpt-header.bin'));

const FILE_SIZE = 0xe9000000;

function specBuf(body) {
  return Buffer.from(`pad blkdevparts=mmcblk0:${body} more`, 'latin1');
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

describe('blkdevparts_mmc (U-Boot env / mmcblk0 cmdline)', () => {
  it('detects a valid 25-partition spec from the truncated env fixture', () => {
    const det = detectSocUserArea(fixture, FILE_SIZE);
    assert.equal(det.tableType, 'blkdevparts_mmc');
    assert.equal(isBlkdevpartsMmc(fixture, FILE_SIZE), true);
    const analysis = analyzeUserArea(fixture, FILE_SIZE);
    assert.equal(analysis.partitions.length, 25);
  });

  it('decodes known offsets/sizes and keeps ro off the name', () => {
    const analysis = analyzeUserArea(fixture, FILE_SIZE);
    const byName = Object.fromEntries(analysis.partitions.map((p) => [p.name, p]));

    assert.equal(byName.fastboot.offset, 0);
    assert.equal(byName.fastboot.size, 0x100000);
    assert.equal(byName.bootargs.offset, 0x100000);
    assert.equal(byName.bootargs.size, 0x100000);
    assert.equal(byName.recovery.offset, 0x500000);
    assert.equal(byName.recovery.size, 0x2800000);

    assert.equal(byName.system.size, 1376 * 1024 * 1024);
    assert.equal(byName.system.ro, true);
    assert.equal(byName.vendor.size, 300 * 1024 * 1024);
    assert.equal(byName.vendor.ro, true);
    assert.ok(!analysis.partitions.some((p) => /ro/i.test(p.name)));

    assert.equal(byName.userdata.offset, 0x86400000);
    assert.equal(byName.userdata.offset + byName.userdata.size, FILE_SIZE);
    assert.equal(byName.userdata.size, FILE_SIZE - byName.userdata.offset);

    const last = analysis.partitions[analysis.partitions.length - 1];
    assert.equal(last.name, 'userdata');
    assert.equal(last.offset + last.size, FILE_SIZE);

    const parts = userAreaToParts(analysis);
    assert.equal(parts.length, 25);
    assert.equal(parts[0].name, 'fastboot');
    assert.equal(parts[0].ptType, 'blkdevparts_mmc');
    assert.equal(parts[0].startByte, 0);
    assert.equal(parts[19].name, 'system');
    assert.equal(parts[19].ro, true);
    assert.equal(parts[20].name, 'vendor');
    assert.equal(parts[20].ro, true);
  });

  it('rejects a truncated blkdevparts specification', () => {
    const buf = specBuf('1M(fastboot),1M(bootargs');
    assert.equal(isBlkdevpartsMmc(buf, FILE_SIZE), false);
    assert.equal(detectSocUserArea(buf, FILE_SIZE).tableType, 'none');
  });

  it('rejects invalid size syntax', () => {
    const buf = specBuf('XM(fastboot),-(userdata)');
    assert.equal(isBlkdevpartsMmc(buf, FILE_SIZE), false);
  });

  it('rejects an empty or invalid partition name', () => {
    assert.equal(isBlkdevpartsMmc(specBuf('1M(),-(userdata)'), FILE_SIZE), false);
    assert.equal(isBlkdevpartsMmc(specBuf('1M(***),-(userdata)'), FILE_SIZE), false);
  });

  it('rejects a malformed remainder entry', () => {
    assert.equal(isBlkdevpartsMmc(specBuf('1M(fastboot),-userdata'), FILE_SIZE), false);
    assert.equal(isBlkdevpartsMmc(specBuf('-(userdata),1M(fastboot)'), FILE_SIZE), false);
    assert.equal(isBlkdevpartsMmc(specBuf('1M(fastboot),-()'), FILE_SIZE), false);
  });

  it('does not treat a lone prefix as a valid table', () => {
    const buf = Buffer.from('blkdevparts=mmcblk0:', 'latin1');
    assert.equal(isBlkdevpartsMmc(buf, FILE_SIZE), false);
    assert.equal(detectSocUserArea(buf, FILE_SIZE).tableType, 'none');
  });
});

describe('existing GPT detection is unchanged with blkdevparts later', () => {
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
    const det = detectSocUserArea(bytes, FILE_SIZE);
    assert.equal(det.tableType, 'gpt');
    assert.notEqual(det.tableType, 'blkdevparts_mmc');
    assert.equal(hasGpt(bytes), true);
    assert.equal(findGptOffset(bytes), 512);
    assert.equal(autoMapPartitions(fixture, fixture.length).length, 0);
  });
});

describe('existing MBR detection is unchanged', () => {
  it('still recognizes MBR in the user-area detector', () => {
    const bytes = new Uint8Array(512);
    bytes[0x1BE + 4] = 0x83;
    w32(bytes, 0x1BE + 8, 0x800);
    w32(bytes, 0x1BE + 12, 0x1000);
    w16(bytes, 0x1FE, 0xaa55);
    const det = detectSocUserArea(bytes, FILE_SIZE);
    assert.equal(det.tableType, 'mbr');
    assert.notEqual(det.tableType, 'blkdevparts_mmc');
    assert.equal(parseMbr(bytes, 0).length, 1);
  });
});

describe('existing HiSilicon Part_Map and Amlogic MPT are unchanged', () => {
  it('still classifies the HiSilicon fixture as hisi_emmc_map', () => {
    assert.equal(isHisiEmmcMap(hisiFixture), true);
    const det = detectSocUserArea(hisiFixture, 0x3a3e00000);
    assert.equal(det.tableType, 'hisi_emmc_map');
    assert.notEqual(det.tableType, 'blkdevparts_mmc');
    assert.equal(isBlkdevpartsMmc(hisiFixture, 0x3a3e00000), false);
  });

  it('still classifies the Amlogic MPT fixture as aml_mpt', () => {
    assert.equal(isAmlMpt(mptFixture, 0x1d2000000), true);
    const det = detectSocUserArea(mptFixture, 0x1d2000000);
    assert.equal(det.tableType, 'aml_mpt');
    assert.notEqual(det.tableType, 'blkdevparts_mmc');
  });
});
