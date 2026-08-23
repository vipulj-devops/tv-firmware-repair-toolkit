import { existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeUserArea,
  detectSocUserArea,
  isMtdpartsEmmc,
  userAreaToParts,
} from '../src/lib/userAreaParser.js';
import { parseMtdpartsEmmc } from '../src/lib/userArea/formats/mtdpartsEmmc.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(dir, 'fixtures', 'mtdparts-emmc-env.bin'));
const SONY_SIZE = 15762194432;
const SONY_DUMP = 'G:\\sony\\EMMC_HAG2e_USER_00000000_01D5BFFF_20250924_000711_nw.bin';
const MiB = 1024 * 1024;

function specBuf(body, device = 'vendor-emmc') {
  return Buffer.from(`pad mtdparts=${device}:${body} more`, 'latin1');
}

describe('mtdparts_emmc (U-Boot mtdparts on eMMC)', () => {
  it('parses sequential K/M/G entries from offset 0', () => {
    const bytes = specBuf('2M(uboot),512K(env),1G(data)');
    const fileSize = (2 + 1 + 1024) * MiB;
    assert.equal(isMtdpartsEmmc(bytes, fileSize), true);
    const parts = parseMtdpartsEmmc(bytes, fileSize);
    assert.equal(parts.length, 3);
    assert.equal(parts[0].name, 'uboot');
    assert.equal(parts[0].offset, 0);
    assert.equal(parts[0].size, 2 * MiB);
    assert.equal(parts[1].offset, 2 * MiB);
    assert.equal(parts[1].size, 512 * 1024);
    assert.equal(parts[2].offset, 2 * MiB + 512 * 1024);
    assert.equal(parts[2].size, 1024 * MiB);
    assert.equal(parts[2].ro, false);
  });

  it('supports remainder - only as the final entry', () => {
    const fileSize = 8 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('1M(boot),-(data)'), fileSize);
    assert.equal(parts.length, 2);
    assert.equal(parts[1].name, 'data');
    assert.equal(parts[1].offset, MiB);
    assert.equal(parts[1].size, 7 * MiB);
    assert.equal(isMtdpartsEmmc(specBuf('-(data),1M(boot)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(boot),-(data),1M(extra)'), fileSize), false);
  });

  it('supports (name)ro and exposes ro=true', () => {
    const parts = parseMtdpartsEmmc(specBuf('1M(system)ro,1M(data)'), 8 * MiB);
    assert.equal(parts[0].name, 'system');
    assert.equal(parts[0].ro, true);
    assert.equal(parts[1].ro, false);
    const mapped = userAreaToParts(analyzeUserArea(specBuf('1M(system)ro,1M(data)'), 8 * MiB));
    assert.equal(mapped[0].ro, true);
    assert.ok(!mapped.some((p) => /ro/i.test(p.name)));
  });

  it('accepts @offset when it equals the sequential cursor', () => {
    const parts = parseMtdpartsEmmc(specBuf('1M(a),1M@0x100000(b)'), 8 * MiB);
    assert.equal(parts[1].offset, 0x100000);
    assert.equal(parts[1].name, 'b');
  });

  it('rejects @offset holes and overlaps', () => {
    assert.equal(isMtdpartsEmmc(specBuf('1M(a),1M@0x200000(b)'), 8 * MiB), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(a),1M@0x0(b)'), 8 * MiB), false);
  });

  it('allows unused tail space when there is no remainder entry', () => {
    const fileSize = 8 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('1M(a),1M(b)'), fileSize);
    assert.equal(parts.length, 2);
    assert.equal(parts[1].offset + parts[1].size, 2 * MiB);
    assert.ok(parts[1].offset + parts[1].size < fileSize);
  });

  it('rejects malformed and truncated specifications', () => {
    const fileSize = 8 * MiB;
    assert.equal(isMtdpartsEmmc(specBuf('1M(boot'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(boot),'), fileSize), false);
    assert.equal(isMtdpartsEmmc(Buffer.from('mtdparts=vendor-emmc:', 'latin1'), fileSize), false);
    assert.equal(isMtdpartsEmmc(Buffer.from('mtdparts=', 'latin1'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1Mboot)'), fileSize), false);
  });

  it('rejects invalid names and duplicate names', () => {
    const fileSize = 8 * MiB;
    assert.equal(isMtdpartsEmmc(specBuf('1M()'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(***)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(a),1M(a)'), fileSize), false);
  });

  it('rejects zero and overflowing sizes', () => {
    const fileSize = 8 * MiB;
    assert.equal(isMtdpartsEmmc(specBuf('0M(boot),-(data)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('99999999999G(boot)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('16M(boot)'), fileSize), false);
  });

  it('rejects NAND/SPI/NOR/OneNAND device targets', () => {
    const fileSize = 8 * MiB;
    const body = '1M(boot),-(data)';
    assert.equal(isMtdpartsEmmc(specBuf(body, 'nand0'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf(body, 'spi0.0'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf(body, 'nor0'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf(body, 'onenand0'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf(body, 'vendor-emmc'), fileSize), true);
  });

  it('does not require Realtek/Sony/MediaTek identity strings', () => {
    const bytes = specBuf('1M(boot),1M(env)', 'board-emmc');
    assert.equal(bytes.toString('latin1').toUpperCase().includes('RTK'), false);
    assert.equal(bytes.toString('latin1').toUpperCase().includes('SONY'), false);
    assert.equal(bytes.toString('latin1').toUpperCase().includes('MEDIATEK'), false);
    const det = detectSocUserArea(bytes, 8 * MiB);
    assert.equal(det.tableType, 'mtdparts_emmc');
    assert.equal(det.soc, 'linux');
  });

  it('parses the Sony env fixture: 63 partitions, boot at 13 MiB, unused 132 MiB tail', () => {
    const det = detectSocUserArea(fixture, SONY_SIZE);
    assert.equal(det.tableType, 'mtdparts_emmc');
    assert.notEqual(det.tableType, 'mbr');
    const analysis = analyzeUserArea(fixture, SONY_SIZE);
    assert.equal(analysis.partitions.length, 63);
    const byName = Object.fromEntries(analysis.partitions.map((p) => [p.name, p]));
    assert.equal(byName.uboot.offset, 0);
    assert.equal(byName.uboot.size, 2 * MiB);
    assert.equal(byName.uboot_env.offset, 0x200000);
    assert.equal(byName.boot.offset, 0xd00000);
    assert.equal(byName.boot.offset, 13 * MiB);
    assert.equal(byName.boot.size, 20 * MiB);
    assert.equal(byName.recovery.offset, 0xef900000);
    assert.equal(byName.recovery.size, 20 * MiB);
    const last = analysis.partitions[analysis.partitions.length - 1];
    assert.equal(last.name, 'reserved11');
    assert.equal(last.offset + last.size, 14900 * MiB);
    assert.equal(SONY_SIZE - (last.offset + last.size), 132 * MiB);
    const mapped = userAreaToParts(analysis);
    assert.equal(mapped.length, 63);
    assert.equal(mapped[4].name, 'boot');
    assert.equal(mapped[4].startByte, 0xd00000);
    assert.equal(mapped[4].ptType, 'mtdparts_emmc');
  });
});

describe('mtdparts_emmc live Sony dump (optional)', () => {
  it('detects the same map and ANDROID! at boot/recovery if the dump is present', () => {
    if (!existsSync(SONY_DUMP)) {
      return;
    }
    const fd = openSync(SONY_DUMP, 'r');
    try {
      const env = Buffer.alloc(8192);
      readSync(fd, env, 0, 8192, 0x200000);
      const analysis = analyzeUserArea(env, SONY_SIZE);
      assert.equal(analysis.tableType, 'mtdparts_emmc');
      assert.equal(analysis.partitions.length, 63);
      const boot = Buffer.alloc(8);
      readSync(fd, boot, 0, 8, 0xd00000);
      assert.equal(boot.toString('latin1'), 'ANDROID!');
      const recovery = Buffer.alloc(8);
      readSync(fd, recovery, 0, 8, 0xef900000);
      assert.equal(recovery.toString('latin1'), 'ANDROID!');
    } finally {
      closeSync(fd);
    }
  });
});
