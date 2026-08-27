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

function assertComplete(p, declaredSize) {
  assert.equal(p.declaredSize, declaredSize);
  assert.equal(p.availableSize, declaredSize);
  assert.equal(p.truncated, false);
  assert.equal(p.unavailable, false);
}

function assertTruncated(p, declaredSize, availableSize) {
  assert.equal(p.declaredSize, declaredSize);
  assert.equal(p.availableSize, availableSize);
  assert.equal(p.truncated, true);
  assert.equal(p.unavailable, false);
}

function assertUnavailable(p, declaredSize) {
  assert.equal(p.declaredSize, declaredSize);
  assert.equal(p.availableSize, 0);
  assert.equal(p.truncated, false);
  assert.equal(p.unavailable, true);
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
    assertComplete(parts[0], 2 * MiB);
    assert.equal(parts[1].offset, 2 * MiB);
    assertComplete(parts[1], 512 * 1024);
    assert.equal(parts[2].offset, 2 * MiB + 512 * 1024);
    assertComplete(parts[2], 1024 * MiB);
    assert.equal(parts[2].ro, false);
  });

  it('supports remainder - only as the final entry', () => {
    const fileSize = 8 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('1M(boot),-(data)'), fileSize);
    assert.equal(parts.length, 2);
    assert.equal(parts[1].name, 'data');
    assert.equal(parts[1].offset, MiB);
    assertComplete(parts[1], 7 * MiB);
    assert.equal(isMtdpartsEmmc(specBuf('-(data),1M(boot)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(boot),-(data),1M(extra)'), fileSize), false);
  });

  it('supports (name)ro, (name)enc, and combined ro/enc attributes', () => {
    const spec = '1M(sysA)ro,8M(perm)enc,5M(kernA)roenc,65M(rtfsA)encro,1M(data)';
    const parts = parseMtdpartsEmmc(specBuf(spec), 100 * MiB);
    assert.equal(parts.length, 5);
    assert.equal(parts[0].name, 'sysA');
    assert.equal(parts[0].ro, true);
    assert.equal(parts[1].name, 'perm');
    assert.equal(parts[1].ro, false);
    assert.equal(parts[2].name, 'kernA');
    assert.equal(parts[2].ro, true);
    assert.equal(parts[3].name, 'rtfsA');
    assert.equal(parts[3].ro, true);
    assert.equal(parts[4].name, 'data');
    assert.equal(parts[4].ro, false);
    const mapped = userAreaToParts(analyzeUserArea(specBuf(spec), 100 * MiB));
    assert.equal(mapped[0].ro, true);
    assert.equal(mapped[2].ro, true);
    assert.equal(mapped[3].ro, true);
    assert.ok(!mapped.some((p) => /ro/i.test(p.name)));
  });

  it('accepts @offset when it equals the sequential cursor', () => {
    const parts = parseMtdpartsEmmc(specBuf('1M(a),1M@0x100000(b)'), 8 * MiB);
    assert.equal(parts[1].offset, 0x100000);
    assert.equal(parts[1].name, 'b');
    assertComplete(parts[1], MiB);
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
    assertComplete(parts[0], MiB);
    assertComplete(parts[1], MiB);
  });

  it('rejects malformed and truncated specifications', () => {
    const fileSize = 8 * MiB;
    assert.equal(isMtdpartsEmmc(specBuf('1M(boot'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(boot),'), fileSize), false);
    assert.equal(isMtdpartsEmmc(Buffer.from('mtdparts=vendor-emmc:', 'latin1'), fileSize), false);
    assert.equal(isMtdpartsEmmc(Buffer.from('mtdparts=', 'latin1'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1Mboot)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(boot)invalid!'), fileSize), false);
  });

  it('rejects invalid names', () => {
    const fileSize = 8 * MiB;
    assert.equal(isMtdpartsEmmc(specBuf('1M()'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('1M(***)'), fileSize), false);
  });

  it('allows duplicate partition names as distinct sequential entries', () => {
    const fileSize = 8 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('1M(a),1M(a)'), fileSize);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].name, 'a');
    assert.equal(parts[0].offset, 0);
    assert.equal(parts[1].name, 'a');
    assert.equal(parts[1].offset, 1 * MiB);
  });

  it('handles full partition (cursor + size <= fileSize)', () => {
    const fileSize = 10 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('5M(uboot),3M(boot),2M(kernel)'), fileSize);
    assert.equal(parts.length, 3);
    assert.equal(parts[0].name, 'uboot');
    assert.equal(parts[0].offset, 0);
    assertComplete(parts[0], 5 * MiB);
    assert.equal(parts[1].offset, 5 * MiB);
    assertComplete(parts[1], 3 * MiB);
    assert.equal(parts[2].offset, 8 * MiB);
    assertComplete(parts[2], 2 * MiB);
    assert.equal(parts[2].offset + parts[2].size, fileSize);
  });

  it('handles truncated final partition (cursor < fileSize < cursor + size)', () => {
    const fileSize = 9 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('5M(uboot),3M(boot),10M(userdata)'), fileSize);
    assert.equal(parts.length, 3);
    assert.equal(parts[0].name, 'uboot');
    assertComplete(parts[0], 5 * MiB);
    assert.equal(parts[1].offset, 5 * MiB);
    assertComplete(parts[1], 3 * MiB);
    assert.equal(parts[2].offset, 8 * MiB);
    assertTruncated(parts[2], 10 * MiB, 1 * MiB);
  });

  it('handles partition starting exactly at EOF (cursor == fileSize)', () => {
    const fileSize = 4 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('4M(a),4M(b)'), fileSize);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].name, 'a');
    assert.equal(parts[0].offset, 0);
    assertComplete(parts[0], 4 * MiB);
    assert.equal(parts[1].name, 'b');
    assert.equal(parts[1].offset, 4 * MiB);
    assertUnavailable(parts[1], 4 * MiB);
  });

  it('includes all declared partitions including those beyond EOF', () => {
    const fileSize = 7 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('2M(uboot),2M(boot),4M(userdata),2M(cache)'), fileSize);
    assert.equal(parts.length, 4);
    assert.equal(parts[0].name, 'uboot');
    assertComplete(parts[0], 2 * MiB);
    assert.equal(parts[1].name, 'boot');
    assertComplete(parts[1], 2 * MiB);
    assert.equal(parts[2].name, 'userdata');
    assertTruncated(parts[2], 4 * MiB, 3 * MiB);
    assert.equal(parts[3].name, 'cache');
    assertUnavailable(parts[3], 2 * MiB);
  });

  it('supports remainder - only as the final entry with partial dump', () => {
    const fileSize = 6 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('2M(uboot),-(data)'), fileSize);
    assert.equal(parts.length, 2);
    assert.equal(parts[1].name, 'data');
    assert.equal(parts[1].offset, 2 * MiB);
    assertComplete(parts[1], 4 * MiB);
  });

  it('accepts a lone remainder covering the whole dump', () => {
    const fileSize = 8 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('-(boot)'), fileSize);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].name, 'boot');
    assert.equal(parts[0].offset, 0);
    assertComplete(parts[0], 8 * MiB);
  });

  it('accepts a declared size larger than the dump as truncated', () => {
    const fileSize = 8 * MiB;
    const parts = parseMtdpartsEmmc(specBuf('16M(boot)'), fileSize);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].name, 'boot');
    assert.equal(parts[0].offset, 0);
    assertTruncated(parts[0], 16 * MiB, 8 * MiB);
  });

  it('parses a truncated MediaTek-style mtdparts dump with all declared partitions', () => {
    const body = '2M(uboot),2M(uboot_env),1792M(system),4578M(userdata),768M(cache),1M(reserved),75M(linux_rootfs)';
    const fileSize = (2 + 2 + 1792 + 100) * MiB;
    const det = detectSocUserArea(specBuf(body, 'mt53xx-emmc'), fileSize);
    assert.equal(det.tableType, 'mtdparts_emmc');
    const parts = parseMtdpartsEmmc(specBuf(body, 'mt53xx-emmc'), fileSize);
    assert.equal(parts.length, 7);
    assert.equal(parts[0].name, 'uboot');
    assertComplete(parts[0], 2 * MiB);
    assert.equal(parts[1].name, 'uboot_env');
    assertComplete(parts[1], 2 * MiB);
    assert.equal(parts[2].name, 'system');
    assert.equal(parts[2].offset, 4 * MiB);
    assertComplete(parts[2], 1792 * MiB);
    assert.equal(parts[3].name, 'userdata');
    assert.equal(parts[3].offset, 1796 * MiB);
    assertTruncated(parts[3], 4578 * MiB, 100 * MiB);
    assert.equal(parts[4].name, 'cache');
    assert.equal(parts[4].offset, 1796 * MiB + 4578 * MiB);
    assertUnavailable(parts[4], 768 * MiB);
    assert.equal(parts[5].name, 'reserved');
    assertUnavailable(parts[5], 1 * MiB);
    assert.equal(parts[6].name, 'linux_rootfs');
    assertUnavailable(parts[6], 75 * MiB);
  });

  it('parses full MediaTek mtdparts map from EMMC_AUTO_5252.BIN containing duplicate "reserved" names', () => {
    const body = '2M(uboot),2M(uboot_env),1M(misc),20M(recovery),20M(boot),1792M(system),4578M(userdata),768M(cache),1M(reserved),75M(linux_rootfs),1M(basic),7M(perm),20M(3rd_ro),10M(3rd_rw),1M(reserved),1M(channelA),1M(channelB),1M(pq),1M(aq),4M(logo),4M(bootlogo),1M(tzbp),3M(adsp),1M(ciplus),1M(dvbsDB),10M(upgrade),1M(part_26),1M(part_27),1M(eeprom_A),256k(sch_pvr)';
    const fileSize = 4152360960; // 3.867 GB physical dump size
    const det = detectSocUserArea(specBuf(body, 'mt53xx-emmc'), fileSize);
    assert.equal(det.tableType, 'mtdparts_emmc');
    const parts = parseMtdpartsEmmc(specBuf(body, 'mt53xx-emmc'), fileSize);
    assert.equal(parts.length, 30);
    const reservedParts = parts.filter((p) => p.name === 'reserved');
    assert.equal(reservedParts.length, 2);
    assert.notEqual(reservedParts[0].offset, reservedParts[1].offset);
    assert.equal(parts[5].name, 'system');
    assert.equal(parts[5].offset, 0x02D00000); // 47185920 B = (2+2+1+20+20)M
    assert.equal(parts[6].name, 'userdata');
    assert.equal(parts[6].offset, 0x72D00000); // 1926234112 B = (2+2+1+20+20+1792)M
    assert.equal(parts[6].truncated, true);
    assert.equal(parts[7].name, 'cache');
    assert.equal(parts[7].unavailable, true);
  });

  it('parses Sony 43-partition mtdparts map from EMMC_AUTO_2524_nw.BIN with enc attribute suffixes', () => {
    const body = '2M(uboot),2M(uboot_env),1M(part_02),1M(part_03),1M(eepromA),8M(perm)enc,1M(ci),1M(hdmi),1M(wfdp),5M(kernelA)enc,5M(kernelB)enc,65M(rootfsA)enc,65M(rootfsB)enc,1M(basic),200M(3rd_rw)enc,300M(upgrade)enc,168M(3rd_ro)enc,1M(channelA),1M(channelB),30M(pqa),30M(pqb),5M(aqa),5M(aqb),1M(panel),1M(edid),1M(svc),1M(ddb),1M(epg),1M(bechip),1M(pqeepback),6M(part_30),6M(part_31),1M(spsA),1M(spsB),1M(fdat),2M(spdA),2M(spdB),5M(spcA),5M(spcB),1M(fnvm),692M(cach),20M(reserved),128M(warm)';
    const fileSize = 1979711488; // 1.844 GB physical dump size
    const det = detectSocUserArea(specBuf(body, 'mt53xx-emmc'), fileSize);
    assert.equal(det.tableType, 'mtdparts_emmc');
    const parts = parseMtdpartsEmmc(specBuf(body, 'mt53xx-emmc'), fileSize);
    assert.equal(parts.length, 43);
    assert.equal(parts[0].name, 'uboot');
    assert.equal(parts[0].offset, 0);
    assert.equal(parts[5].name, 'perm');
    assert.equal(parts[5].offset, 7340032); // 7 MB
    assert.equal(parts[9].name, 'kernelA');
    assert.equal(parts[9].offset, 18874368); // 18 MB
    assert.equal(parts[11].name, 'rootfsA');
    assert.equal(parts[11].offset, 29360128); // 28 MB
    assert.equal(parts[42].name, 'warm');
    assert.equal(parts[42].offset, 1728053248);
    assert.ok(parts.every((p) => !p.unavailable && !p.truncated));
  });

  it('logical cursor continues by DECLARED size after a truncated partition', () => {
    const fileSize = 9 * MiB;
    const body = '5M(uboot),3M(boot),10M(userdata),4M(cache)';
    const parts = parseMtdpartsEmmc(specBuf(body), fileSize);
    assert.equal(parts.length, 4);
    assertTruncated(parts[2], 10 * MiB, 1 * MiB);
    assert.equal(parts[3].name, 'cache');
    assert.equal(parts[3].offset, 8 * MiB + 10 * MiB);
    assertUnavailable(parts[3], 4 * MiB);
  });

  it('userAreaToParts normalizes declaredSize / availableSize / truncated / unavailable', () => {
    const fileSize = 6 * MiB;
    const body = '2M(uboot),2M(boot),4M(userdata),2M(cache)';
    const analysis = analyzeUserArea(specBuf(body), fileSize);
    const mapped = userAreaToParts(analysis);
    assert.equal(mapped.length, 4);
    assertComplete(mapped[0], 2 * MiB);
    assertComplete(mapped[1], 2 * MiB);
    assertTruncated(mapped[2], 4 * MiB, 2 * MiB);
    assertUnavailable(mapped[3], 2 * MiB);
  });

  it('rejects zero and overflowing sizes', () => {
    const fileSize = 8 * MiB;
    assert.equal(isMtdpartsEmmc(specBuf('0M(boot),-(data)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('99999999999G(boot)'), fileSize), false);
    assert.equal(isMtdpartsEmmc(specBuf('-(boot),1M(data)'), fileSize), false);
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
    assertComplete(byName.uboot, 2 * MiB);
    assert.equal(byName.uboot_env.offset, 0x200000);
    assert.equal(byName.boot.offset, 0xd00000);
    assert.equal(byName.boot.offset, 13 * MiB);
    assertComplete(byName.boot, 20 * MiB);
    assert.equal(byName.recovery.offset, 0xef900000);
    assertComplete(byName.recovery, 20 * MiB);
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
