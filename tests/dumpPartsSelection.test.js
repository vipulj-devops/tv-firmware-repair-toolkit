import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFirmware, firmwarePartitionsToParts } from '../src/lib/firmwareParser.js';
import { analyzeUserArea } from '../src/lib/userAreaParser.js';
import { hasGpt, autoMapPartitions } from '../src/lib/emmc.js';
import { selectDumpParts } from '../src/lib/userArea/selectDumpParts.js';

const SUSPECT = 'G:\\EMMC_LG32SWE-F64-P639\\EMMC_8GTF4R_USER_00000000_00E8FFFF_20251219_124500.bin';
const REALTEK_GPT = 'G:\\EMMC_8GTF4R_USER_00000000_00E8FFFF_20260206_215325-ip.bin';
const MTK = 'G:\\hisi\\EMMC_4FTE4R_USER_00000000_00747FFF_20260628_150943.bin';
const MSTAR1 = 'G:\\5800-a9k53g-op10\\userarea.bin';
const MSTAR2 = 'G:\\mstar368\\ROM1_000000000000_0000E9000000.bin';
const SONY = 'G:\\sony\\EMMC_HAG2e_USER_00000000_01D5BFFF_20250924_000711_nw.bin';
const GPT_CHUNK = 128 * 1024 * 1024;

function readHead(path, n = GPT_CHUNK) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(Math.min(n, size));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  return { bytes: buf, size, name: path.split('\\').pop() };
}

function selectFromHead({ bytes, size, name }) {
  const ua = analyzeUserArea(bytes, size);
  const fw = analyzeFirmware(bytes, name, size, null);
  return {
    ua,
    fw,
    parts: selectDumpParts({
      hasGpt: hasGpt(bytes),
      gptParts: autoMapPartitions(bytes, size),
      userAreaAnalysis: ua,
      firmwareParts: firmwarePartitionsToParts(fw, size),
      bytes,
    }),
  };
}

function descriptorBait() {
  const fileSize = 7818182656;
  const bytes = Buffer.alloc(0x20400, 0xff);
  bytes.set(Buffer.from('rtd284x\0realtek\0', 'ascii'), 0x100);
  bytes.set(Buffer.from(
    '77ffffff7777ff77bbddeeffffffff00ffffff0000ffffcccccc33cccccc3333cccccc',
    'hex',
  ), 0x20034);
  return { bytes, size: fileSize, name: 'EMMC_8GTF4R_USER.bin' };
}

describe('generic descriptors are not a dump partition table', () => {
  it('does not promote erased/pattern descriptor bait into dump parts', () => {
    const bait = descriptorBait();
    const fw = analyzeFirmware(bait.bytes, bait.name, bait.size, null);
    assert.equal(fw.family, 'Realtek');
    assert.match(fw.marker, /RTD284X/i);
    assert.ok(fw.partitions.some((p) => p.source === 'descriptor'));
    const firmwareParts = firmwarePartitionsToParts(fw, bait.size);
    assert.equal(firmwareParts.length, 0);
    assert.equal(firmwareParts.some((p) => p.ptType === 'vendor'), false);

    const ua = analyzeUserArea(bait.bytes, bait.size);
    assert.equal(ua.tableType, 'none');
    const selected = selectDumpParts({
      hasGpt: hasGpt(bait.bytes),
      gptParts: autoMapPartitions(bait.bytes, bait.size),
      userAreaAnalysis: ua,
      firmwareParts,
    });
    assert.equal(selected.length, 0);
    assert.equal(selected.some((p) => p.ptType === 'vendor'), false);
  });

  it('ignores leftover descriptor firmwareParts in selectDumpParts', () => {
    const selected = selectDumpParts({
      hasGpt: false,
      gptParts: [],
      userAreaAnalysis: { tableType: 'none', soc: 'unknown', partitions: [] },
      firmwareParts: [{
        name: 'w...ww.w.......',
        ptType: 'vendor',
        startByte: 0xc333ccc,
        size: 859032780,
        vendorSource: 'descriptor',
      }],
    });
    assert.equal(selected.length, 0);
  });

  it('still allows structured firmware sources as a last-resort dump table', () => {
    const selected = selectDumpParts({
      hasGpt: false,
      gptParts: [],
      userAreaAnalysis: { tableType: 'none', soc: 'unknown', partitions: [] },
      firmwareParts: [{
        name: 'boot',
        ptType: 'vendor',
        startByte: 0,
        size: 0x100000,
        vendorSource: 'MTK scatter',
      }],
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].name, 'boot');
  });
});

describe('known dumps: descriptor fallback does not steal structured maps', () => {
  it('suspect Realtek dump: family Realtek, parses Realtek PART.INFO table', {
    skip: !existsSync(SUSPECT),
  }, () => {
    const head = readHead(SUSPECT);
    const { ua, fw, parts } = selectFromHead(head);
    assert.equal(fw.family, 'Realtek');
    assert.match(fw.marker, /RTD284X/i);
    assert.equal(hasGpt(head.bytes), false);
    assert.equal(ua.tableType, 'realtek_partinfo');
    assert.equal(parts.length, 62);
    assert.equal(parts.some((p) => p.ptType === 'vendor'), false);
  });

  it('known-good Realtek dump stays GPT with all firmware parts preserved', {
    skip: !existsSync(REALTEK_GPT),
  }, () => {
    const head = readHead(REALTEK_GPT);
    const { fw, parts } = selectFromHead(head);
    assert.equal(fw.family, 'Realtek');
    assert.equal(hasGpt(head.bytes), true);
    // 13 GPT partitions + 15 firmware parts (8 bootparams + 7 Realtek layout) + 5 metadata entries = 33
    assert.equal(parts.length, 33);
    const gptParts = parts.filter((p) => p.ptType === 'gpt');
    const fwParts = parts.filter((p) => p.ptType === 'vendor');
    const metaParts = parts.filter((p) => p.ptType === 'metadata');
    assert.equal(gptParts.length, 13);
    assert.equal(fwParts.length, 15);
    assert.equal(metaParts.length, 5);
    // Verify backup GPT metadata entries
    assert.ok(metaParts.some((p) => p.name === 'backup GPT header'));
    assert.ok(metaParts.some((p) => p.name === 'backup GPT array'));
    // Verify VERONA fw table and Realtek system regions
    assert.ok(fwParts.some((p) => p.name === 'fw table'));
    assert.ok(fwParts.some((p) => p.name === 'bootcode'));
    assert.ok(fwParts.some((p) => p.name === 'factory_ro'));
    assert.ok(fwParts.some((p) => p.name === 'eeprom'));
    assert.ok(fwParts.some((p) => p.name === 'factory'));
    assert.ok(fwParts.some((p) => p.name === 'secure store'));
    assert.ok(fwParts.some((p) => p.name === 'reserved'));
    // Verify overlapping factory and secure store both remain visible
    const factory = parts.find((p) => p.name === 'factory');
    const secureStore = parts.find((p) => p.name === 'secure store');
    assert.ok(factory);
    assert.ok(secureStore);
    assert.equal(factory.status, 'blocked');
    assert.equal(secureStore.status, 'blocked');
    // Verify overlapping firmware parts are retained as blocked
    const blocked = parts.filter((p) => p.status === 'blocked');
    assert.ok(blocked.some((p) => p.name === 'frp'));
    assert.ok(blocked.some((p) => p.name === 'misc'));
    assert.ok(blocked.some((p) => p.name === 'res'));
  });

  it('MediaTek dump stays blkdevparts with 25 partitions', {
    skip: !existsSync(MTK),
  }, () => {
    const head = readHead(MTK);
    const { ua, fw, parts } = selectFromHead(head);
    assert.ok(fw.family === 'MediaTek' || fw.family === 'HiSilicon');
    assert.equal(ua.tableType, 'blkdevparts_mmc');
    assert.equal(parts.length, 25);
    assert.ok(parts.every((p) => p.ptType === 'blkdevparts_mmc'));
  });

  it('MStar userarea.bin stays eMMC 0x1630/0x5840', {
    skip: !existsSync(MSTAR1),
  }, () => {
    const head = readHead(MSTAR1, 0x10000);
    const { ua, fw, parts } = selectFromHead(head);
    assert.equal(fw.family, 'MStar');
    assert.equal(ua.tableType, 'emmc_1630_5840');
    assert.equal(parts.length, 38);
    assert.ok(parts.every((p) => p.ptType === 'emmc_1630_5840' || p.ptType === 'metadata'));
    assert.ok(parts.some((p) => p.name === 'Part_Map' && p.status === 'metadata'));
  });

  it('MStar ROM1 stays eMMC 0x1630/0x5840', {
    skip: !existsSync(MSTAR2),
  }, () => {
    const head = readHead(MSTAR2, 0x10000);
    const { ua, fw, parts } = selectFromHead(head);
    assert.equal(fw.family, 'MStar');
    assert.equal(ua.tableType, 'emmc_1630_5840');
    assert.equal(parts.length, 26);
    assert.ok(parts.every((p) => p.ptType === 'emmc_1630_5840' || p.ptType === 'metadata'));
    assert.ok(parts.some((p) => p.name === 'Part_Map' && p.status === 'metadata'));
  });

  it('Sony dump stays mtdparts with 63 partitions and boot/recovery offsets', {
    skip: !existsSync(SONY),
  }, () => {
    const head = readHead(SONY);
    const { ua, parts } = selectFromHead(head);
    assert.equal(ua.tableType, 'mtdparts_emmc');
    assert.equal(parts.length, 63);
    const boot = parts.find((p) => p.name === 'boot');
    const recovery = parts.find((p) => p.name === 'recovery');
    assert.equal(boot.startByte, 0xd00000);
    assert.equal(recovery.startByte, 0xef900000);
    assert.ok(parts.every((p) => p.ptType === 'mtdparts_emmc'));
  });
});

describe('Realtek layout and backup GPT discovery', () => {
  it('detects VERONA__ signature and extracts fw table and layout regions', () => {
    const bytes = Buffer.alloc(0x3810000, 0);
    bytes.set(Buffer.from('REALTEK\0RTD284X_DEMO\0', 'latin1'), 0x100);
    bytes.set(Buffer.from('VERONA__', 'latin1'), 0x3800000);
    const fw = analyzeFirmware(bytes, 'realtek_test.bin', bytes.length, null);
    assert.equal(fw.family, 'Realtek');
    const fwTable = fw.partitions.find((p) => p.name === 'fw table');
    assert.ok(fwTable);
    assert.equal(fwTable.start, '0x3800000');
    assert.equal(fwTable.size, '0x8000');
    assert.equal(fwTable.source, 'VERONA');
    const bootcode = fw.partitions.find((p) => p.name === 'bootcode');
    assert.ok(bootcode);
    assert.equal(bootcode.start, '0x2000');
  });

  it('does not add Realtek system layout regions when VERONA__ is absent', () => {
    const bytes = Buffer.alloc(0x4000000, 0);
    bytes.set(Buffer.from('REALTEK\0RTD284X_DEMO\0', 'latin1'), 0x100);
    const fw = analyzeFirmware(bytes, 'realtek_test.bin', bytes.length, null);
    assert.equal(fw.family, 'Realtek');
    assert.equal(fw.partitions.some((p) => p.name === 'fw table'), false);
    assert.equal(fw.partitions.some((p) => p.name === 'bootcode'), false);
  });

  it('generates primary and backup GPT metadata entries matching expected GPT geometry', () => {
    const fileSize = 0x100000;
    const gptParts = [
      { name: 'system', ptType: 'gpt', startByte: 0x4000, size: 0x10000, baseOffset: 0 },
    ];
    const bytes = Buffer.alloc(0x100000, 0);
    bytes.set(Buffer.from('EFI PART', 'ascii'), 0x200);
    // uint64 at +0x18 = 1, +0x20 = (fileSize/512 - 1) = 2047, +0x30 = 2014
    bytes.writeUInt32LE(1, 0x200 + 0x18);
    bytes.writeUInt32LE(2047, 0x200 + 0x20);
    bytes.writeUInt32LE(2014, 0x200 + 0x30);
    bytes.writeUInt32LE(1, 0x200 + 0x50);
    bytes.writeUInt32LE(128, 0x200 + 0x54);

    const selected = selectDumpParts({
      hasGpt: true,
      gptParts,
      userAreaAnalysis: null,
      firmwareParts: [],
      fileSize,
      bytes,
    });

    const meta = selected.filter((p) => p.ptType === 'metadata');
    assert.equal(meta.length, 5);
    assert.ok(meta.some((p) => p.name === 'mbr 0'));
    assert.ok(meta.some((p) => p.name === 'GPT Header'));
    assert.ok(meta.some((p) => p.name === 'GPT Array'));
    const backupArray = meta.find((p) => p.name === 'backup GPT array');
    const backupHeader = meta.find((p) => p.name === 'backup GPT header');
    assert.ok(backupArray);
    assert.ok(backupHeader);
    assert.equal(backupArray.startByte, (2014 + 1) * 512);
    assert.equal(backupHeader.startByte, 2047 * 512);
  });
});
