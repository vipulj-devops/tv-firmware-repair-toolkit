import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFirmware } from '../src/lib/firmwareParser.js';

function buf(s, fileName = 'dump.bin') {
  return analyzeFirmware(Buffer.from(s, 'latin1'), fileName, s.length, null);
}

describe('firmware family detection (independent of partition tables)', () => {
  it('does not treat incidental LGEK as LG', () => {
    const bytes = Buffer.alloc(4096, 0);
    bytes.set(Buffer.from("..DB..;k..'S.j&.LGEK.N{5.8?(", 'latin1'), 100);
    const analysis = analyzeFirmware(bytes, 'EMMC_HAG2e_USER.bin', bytes.length, null);
    assert.notEqual(analysis.family, 'LG');
    assert.notEqual(analysis.marker, 'text: LGE');
  });

  it('does not treat random EPk binary text as LG', () => {
    const bytes = Buffer.alloc(4096, 0);
    bytes.set(Buffer.from('v.U]#.u.....EPk... i.g:', 'latin1'), 200);
    const analysis = analyzeFirmware(bytes, 'dump.bin', bytes.length, null);
    assert.notEqual(analysis.family, 'LG');
    assert.notEqual(analysis.marker, 'text: EPK');
  });

  it('does not count rtdI as a normal RTD hit', () => {
    const analysis = buf('....WTrtdI...W.$U.');
    assert.notEqual(analysis.family, 'Realtek');
    assert.notEqual(analysis.marker, 'text: RTD');
  });

  it('does not treat incidental aMLK as Amlogic', () => {
    assert.notEqual(buf('noise aMLK blob').family, 'Amlogic');
  });

  it('still recognizes strong REALTEK text as Realtek', () => {
    const analysis = buf('REALTEK bootcode header');
    assert.equal(analysis.family, 'Realtek');
    assert.equal(analysis.marker, 'text: REALTEK');
  });

  it('still recognizes bounded RTD as a weak Realtek fallback', () => {
    assert.equal(buf('RTD bootrom').family, 'Realtek');
  });

  it('detects Realtek SoC identifiers past the 2 MB script window', () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 64, 0);
    bytes.set(Buffer.from('RTD284X_DEMO', 'ascii'), 2 * 1024 * 1024 + 8);
    const analysis = analyzeFirmware(bytes, 'EMMC_8GTF4R_USER.bin', bytes.length, null);
    assert.equal(analysis.family, 'Realtek');
    assert.match(analysis.marker, /RTD284X/);
  });

  it('lets strong MEDIATEK win despite HISI/SAMSUNG noise', () => {
    const analysis = buf('compatible=hisi SAMSUNG_LTA400WT MEDIATEK scatter');
    assert.equal(analysis.family, 'MediaTek');
    assert.equal(analysis.marker, 'text: MEDIATEK');
  });

  it('does not treat HISI-only DTS as HiSilicon', () => {
    const analysis = buf('compatible = "hisi,generic-soc"; bootargs=...');
    assert.notEqual(analysis.family, 'HiSilicon');
    assert.equal(analysis.family, 'Generic / unknown');
  });

  it('still recognizes MStar MBOOT / MSTAR text', () => {
    assert.equal(buf('MBOOT loader').family, 'MStar');
    assert.equal(buf('MSTAR chip init').family, 'MStar');
  });

  it('still recognizes EPK0 magic at offset 0 as LG', () => {
    const bytes = Buffer.from('EPK0........', 'latin1');
    const analysis = analyzeFirmware(bytes, 'firmware.epk', bytes.length, null);
    assert.equal(analysis.family, 'LG');
    assert.match(analysis.marker, /EPK0/);
  });

  it('still recognizes explicit LG electronics / webOS text', () => {
    assert.equal(buf('LG ELECTRONICS upgrade').family, 'LG');
    assert.equal(buf('WEBOS package header').family, 'LG');
  });

  it('keeps Sony-like incidental LGEK/EPk dumps as Generic/unknown', () => {
    const bytes = Buffer.alloc(4096, 0);
    bytes.set(Buffer.from("..DB..;k..'S.j&.LGEK.N{5.8?(", 'latin1'), 100);
    bytes.set(Buffer.from('v.U]#.u.....EPk... i.g:', 'latin1'), 200);
    const analysis = analyzeFirmware(bytes, 'EMMC_HAG2e_USER.bin', bytes.length, null);
    assert.equal(analysis.family, 'Generic / unknown');
  });

  it('does not treat a later MEDIATEK toolchain triplet as MediaTek', () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 80, 0);
    bytes.set(Buffer.from('V7A-MEDIATEK-LINUX-GNUEABI', 'ascii'), 2 * 1024 * 1024 + 8);
    const analysis = analyzeFirmware(bytes, 'EMMC_HAG2e_USER.bin', bytes.length, null);
    assert.equal(analysis.family, 'Generic / unknown');
  });
});
