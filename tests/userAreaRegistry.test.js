import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSocUserArea } from '../src/lib/userAreaParser.js';
import { USER_AREA_STRICT_FORMATS } from '../src/lib/userArea/registry.js';

const dir = dirname(fileURLToPath(import.meta.url));
const hisiFixture = readFileSync(join(dir, 'fixtures', 'hisi-partmap-header.bin'));
const mptFixture = readFileSync(join(dir, 'fixtures', 'aml-mpt-header.bin'));
const blkFixture = readFileSync(join(dir, 'fixtures', 'blkdevparts-mmc-env.bin'));

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

describe('user-area strict format registry', () => {
  it('keeps emmc_1630_5840 before aml_mpt before blkdevparts_mmc before mtdparts_emmc', () => {
    assert.deepEqual(USER_AREA_STRICT_FORMATS.map((f) => f.id), [
      'emmc_1630_5840',
      'aml_mpt',
      'blkdevparts_mmc',
      'mtdparts_emmc',
    ]);
  });

  it('still prefers GPT over registered dump formats', () => {
    const bytes = new Uint8Array(512 * 4);
    const gptOff = 512;
    bytes.set(Buffer.from('EFI PART', 'ascii'), gptOff);
    w32(bytes, gptOff + 0x0c, 92);
    w32(bytes, gptOff + 0x18, 1);
    w32(bytes, gptOff + 0x48, 2);
    w32(bytes, gptOff + 0x50, 1);
    w32(bytes, gptOff + 0x54, 128);
    bytes.set(mptFixture.subarray(0, Math.min(mptFixture.length, bytes.length - 1024)), 1024);
    const det = detectSocUserArea(bytes, 0x1d2000000);
    assert.equal(det.tableType, 'gpt');
  });

  it('still prefers MBR over registered dump formats', () => {
    const bytes = new Uint8Array(512);
    bytes[0x1BE + 4] = 0x83;
    w32(bytes, 0x1BE + 8, 0x800);
    w32(bytes, 0x1BE + 12, 0x1000);
    w16(bytes, 0x1FE, 0xaa55);
    const det = detectSocUserArea(bytes, 0xe9000000);
    assert.equal(det.tableType, 'mbr');
  });

  it('classifies existing fixtures through the same detectSocUserArea entry', () => {
    assert.equal(detectSocUserArea(hisiFixture, 0x3a3e00000).tableType, 'emmc_1630_5840');
    assert.equal(detectSocUserArea(mptFixture, 0x1d2000000).tableType, 'aml_mpt');
    assert.equal(detectSocUserArea(blkFixture, 0xe9000000).tableType, 'blkdevparts_mmc');
  });
});
