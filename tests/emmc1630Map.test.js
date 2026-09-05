import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUserArea,
  detectSocUserArea,
  isEmmc1630Map,
  userAreaToParts,
} from '../src/lib/userAreaParser.js';
import { selectDumpParts } from '../src/lib/userArea/selectDumpParts.js';
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

describe('eMMC 0x1630/0x5840 Map', () => {
  it('detects a valid map from the truncated reference fixture', () => {
    const det = detectSocUserArea(fixture);
    assert.equal(det.tableType, 'emmc_1630_5840');
    assert.notEqual(det.soc, 'hisilicon');
    assert.equal(det.soc, 'unknown');
    assert.equal(isEmmc1630Map(fixture), true);
  });

  it('decodes MBOOT, MPOOL, and vbmeta_a with LBA*512 conversion', () => {
    const analysis = analyzeUserArea(fixture, 0x3a3e00000);
    assert.equal(analysis.tableType, 'emmc_1630_5840');
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
    assert.equal(parts[0].ptType, 'emmc_1630_5840');
    assert.equal(parts[0].startByte, 0x200000);
    assert.equal(parts[0].size, 0x500000);
    assert.ok(!parts.some((p) => p.name === 'Part_Map'));
  });

  it('decodes Videocon MStar variant with non-zero entry metadata at +0x02..+0x07', () => {
    const buf = new Uint8Array(512 * 4);
    // Sector 0 Header
    w16(buf, 0, 0x1630);
    w32(buf, 16, 0x003f2000); // 4,136,960 LBA sectors

    // Sector 1: MBOOT entry with non-zero metadata at +0x02..+0x07
    w16(buf, 0x200, 0x5840);
    w16(buf, 0x202, 0x5cb1);
    w32(buf, 0x204, 0x54fd5797);
    w32(buf, 0x208, 4096); // startLba (0x200000)
    w32(buf, 0x20c, 6144); // sizeLba (0x300000)
    buf.set(Buffer.from('MBOOT', 'ascii'), 0x210);

    // Sector 2: system entry with non-zero metadata at +0x02..+0x07
    w16(buf, 0x400, 0x5840);
    w16(buf, 0x402, 0x2d2e);
    w32(buf, 0x404, 0x2e1dc250);
    w32(buf, 0x408, 44544); // startLba (0x15c0000)
    w32(buf, 0x40c, 1638400); // sizeLba (0x32000000)
    buf.set(Buffer.from('system', 'ascii'), 0x410);

    assert.equal(isEmmc1630Map(buf), true);
    const det = detectSocUserArea(buf, 0x100000000);
    assert.equal(det.tableType, 'emmc_1630_5840');

    const analysis = analyzeUserArea(buf, 0x100000000);
    assert.equal(analysis.partitions.length, 2);

    const mboot = analysis.partitions[0];
    assert.equal(mboot.name, 'MBOOT');
    assert.equal(mboot.offset, 0x200000);
    assert.equal(mboot.size, 0x300000);

    const system = analysis.partitions[1];
    assert.equal(system.name, 'system');
    assert.equal(system.offset, 0x15c0000);
    assert.equal(system.size, 0x32000000);

    const parts = userAreaToParts(analysis);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].name, 'MBOOT');
    assert.equal(parts[1].name, 'system');
    assert.ok(!parts.some((p) => p.name === 'Part_Map'));

    // selectDumpParts incorporates Part_Map as a metadata entry derived from first valid partition's startByte
    const selected = selectDumpParts({ userAreaAnalysis: analysis, fileSize: 0x100000000, bytes: buf });
    assert.equal(selected.length, 3);
    assert.equal(selected[0].name, 'Part_Map');
    assert.equal(selected[0].status, 'metadata');
    assert.equal(selected[0].editable, false);
    assert.equal(selected[0].startByte, 0);
    assert.equal(selected[0].size, 0x200000);
    assert.equal(selected[1].name, 'MBOOT');
    assert.equal(selected[1].status, 'editable');
    assert.equal(selected[2].name, 'system');
    assert.equal(selected[2].status, 'editable');
  });

  it('safely omits Part_Map metadata if first partition has startByte 0', () => {
    const buf = new Uint8Array(512 * 4);
    w16(buf, 0, 0x1630);
    w16(buf, 0x200, 0x5840);
    w32(buf, 0x208, 0); // startLba 0
    w32(buf, 0x20c, 100);
    buf.set(Buffer.from('MBOOT', 'ascii'), 0x210);

    const analysis = analyzeUserArea(buf, 0x100000);
    const selected = selectDumpParts({ userAreaAnalysis: analysis, fileSize: 0x100000, bytes: buf });
    assert.ok(!selected.some((p) => p.name === 'Part_Map'));
  });

  it('rejects a malformed header (wrong magic or non-zero reserved fields)', () => {
    const badMagic = copy();
    w32(badMagic, 0, 0x9999);
    assert.equal(isEmmc1630Map(badMagic), false);
    assert.equal(detectSocUserArea(badMagic).tableType, 'none');

    const badReserved = copy();
    w32(badReserved, 4, 1);
    assert.equal(isEmmc1630Map(badReserved), false);
    assert.equal(detectSocUserArea(badReserved).tableType, 'none');
  });

  it('rejects a wrong first-entry magic', () => {
    const buf = copy();
    w32(buf, 0x200, 0x1111);
    assert.equal(isEmmc1630Map(buf), false);
    assert.equal(detectSocUserArea(buf).tableType, 'none');
  });

  it('rejects a non-printable / invalid first partition name', () => {
    const emptyName = copy();
    emptyName[0x210] = 0;
    assert.equal(isEmmc1630Map(emptyName), false);

    const binaryName = copy();
    binaryName[0x210] = 0x01;
    binaryName[0x211] = 0x02;
    binaryName[0x212] = 0x03;
    binaryName[0x213] = 0x04;
    assert.equal(isEmmc1630Map(binaryName), false);
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
    assert.notEqual(det.tableType, 'emmc_1630_5840');
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
    assert.notEqual(det.tableType, 'emmc_1630_5840');
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

function readHead(path, n) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(Math.min(n, size));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  return { bytes: new Uint8Array(buf), size };
}

const LOCAL_MSTAR1 = 'G:\\5800-a9k53g-op10\\userarea.bin';
const LOCAL_MSTAR2 = 'G:\\mstar368\\ROM1_000000000000_0000E9000000.bin';

const MSTAR1_NAMES = [
  'MBOOT', 'MPOOL', 'vbmeta', 'tvcertificate', 'eeprom_a', 'tvconfig', 'swconfig',
  'misc', 'recovery', 'boot', 'optee', 'armfw', 'RTPM', 'dtbo', 'metadata', 'frc',
  'linux_rootfs_a', 'basic_a', '3rd_a', '3rd_rw', 'vbmeta_a', 'ciplus', 'OLED_data',
  'dvbsdb_a', 'cha', 'chb', 'upgrade', 'schedpvr', 'demura', 'MBOOTBAK', 'oem',
  'super', 'cache', 'tvservice', 'factory_a', 'vbmeta_system', 'userdata',
];

const MSTAR2_NAMES = [
  'MBOOT', 'MPOOL', 'tvcertificate', 'eeprom_a', 'tvconfig', 'misc', 'recovery',
  'boot', 'optee', 'armfw', 'RTPM', 'dtb', 'frc', 'linux_rootfs_a', '3rd_a',
  '3rd_rw', 'vbmeta_a', 'cha', 'chb', 'system', 'cache', 'vendor', 'tvservice',
  'factory_a', 'userdata',
];

describe('local 0x1630/0x5840 dumps (skipped if absent)', () => {
  it('still parses G:\\\\5800-a9k53g-op10\\\\userarea.bin', { skip: !existsSync(LOCAL_MSTAR1) }, () => {
    const { bytes, size } = readHead(LOCAL_MSTAR1, 0x10000);
    const analysis = analyzeUserArea(bytes, size);
    assert.equal(isEmmc1630Map(bytes), true);
    assert.equal(analysis.tableType, 'emmc_1630_5840');
    assert.notEqual(analysis.soc, 'hisilicon');
    assert.equal(analysis.partitions.length, 37);
    assert.deepEqual(analysis.partitions.map((p) => p.name), MSTAR1_NAMES);
    assert.equal(analysis.partitions[0].offset, 0x200000);
    assert.equal(analysis.partitions[0].size, 0x500000);
    assert.equal(analysis.partitions[36].name, 'userdata');
    assert.equal(analysis.partitions[36].offset, 0xc2400400);
    assert.equal(analysis.partitions[36].size, 0x10fbfec00);
  });

  it('still parses G:\\\\mstar368\\\\ROM1 dump', { skip: !existsSync(LOCAL_MSTAR2) }, () => {
    const { bytes, size } = readHead(LOCAL_MSTAR2, 0x10000);
    const analysis = analyzeUserArea(bytes, size);
    assert.equal(isEmmc1630Map(bytes), true);
    assert.equal(analysis.tableType, 'emmc_1630_5840');
    assert.notEqual(analysis.soc, 'hisilicon');
    assert.equal(analysis.partitions.length, 25);
    assert.deepEqual(analysis.partitions.map((p) => p.name), MSTAR2_NAMES);
    assert.equal(analysis.partitions[0].offset, 0x200000);
    assert.equal(analysis.partitions[0].size, 0x500000);
    assert.equal(analysis.partitions[24].name, 'userdata');
    assert.equal(analysis.partitions[24].offset, 0x6b3d0000);
    assert.equal(analysis.partitions[24].size, 0x7dc2f000);
  });
});
