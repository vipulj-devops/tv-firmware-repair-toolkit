import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZip, generateCollisionFreeNames } from '../src/lib/zipWriter.js';
import { crc32, crc16Ccitt, crc32Init, crc32Update, crc32Final } from '../src/lib/crc32.js';

describe('Feature 1: Partition Export & ZIP Generation', () => {
  it('generateCollisionFreeNames: unique partition names get name.bin', () => {
    const partitions = [
      { name: 'system', ptType: 'gpt' },
      { name: 'vendor', ptType: 'gpt' },
      { name: 'userdata', ptType: 'gpt' },
    ];
    const named = generateCollisionFreeNames(partitions);
    assert.equal(named.length, 3);
    assert.equal(named[0].fileName, 'system.bin');
    assert.equal(named[1].fileName, 'vendor.bin');
    assert.equal(named[2].fileName, 'userdata.bin');
  });

  it('generateCollisionFreeNames: duplicate partition names receive disambiguated filenames', () => {
    const partitions = [
      { name: 'frp', ptType: 'gpt', vendorSource: 'gpt' },
      { name: 'frp', ptType: 'vendor', vendorSource: 'bootparams' },
      { name: 'misc', ptType: 'gpt' },
      { name: 'misc', ptType: 'vendor', vendorSource: 'bootparams' },
    ];
    const named = generateCollisionFreeNames(partitions);
    assert.equal(named.length, 4);
    assert.equal(named[0].fileName, 'frp_gpt.bin');
    assert.equal(named[1].fileName, 'frp_bootparams.bin');
    assert.equal(named[2].fileName, 'misc_gpt.bin');
    assert.equal(named[3].fileName, 'misc_bootparams.bin');
    assert.equal(new Set(named.map((n) => n.fileName)).size, 4);
  });

  it('createZip: creates a valid ZIP Blob containing all selected partition files', async () => {
    const files = [
      { name: 'boot.bin', data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: 'recovery.bin', data: new Uint8Array([10, 20, 30, 40]) },
    ];
    const zipBlob = await createZip(files);
    assert.ok(zipBlob);
    assert.equal(zipBlob.type, 'application/zip');
    assert.ok(zipBlob.size > 30);
  });
});

describe('Feature 2: Real CRC Progress Computation', () => {
  it('chunked CRC32 IEEE computation matches direct CRC32 byte-for-byte', () => {
    const buf = new Uint8Array(200000);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 17 + 5) & 0xff;
    const dataEnd = 180000;

    const direct = crc32(buf, { start: 0, end: dataEnd });

    const chunkSize = 32 * 1024;
    let crc = crc32Init(0xFFFFFFFF);
    let processed = 0;
    const progressLog = [];

    for (let off = 0; off < dataEnd; off += chunkSize) {
      const end = Math.min(off + chunkSize, dataEnd);
      crc = crc32Update(crc, buf.subarray(off, end));
      processed = end;
      progressLog.push(Math.round((processed / dataEnd) * 100));
    }
    const finalCrc = crc32Final(crc, 0xFFFFFFFF);

    assert.equal(finalCrc, direct);
    assert.equal(progressLog[progressLog.length - 1], 100);
    assert.ok(progressLog.length > 1);
  });

  it('chunked CRC32 POSIX computation matches direct CRC32 POSIX', () => {
    const buf = new Uint8Array(150000);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 23 + 11) & 0xff;
    const dataEnd = 120000;

    const direct = crc32(buf, { start: 0, end: dataEnd, init: 0, finalXor: 0xffffffff });

    const chunkSize = 32 * 1024;
    let crc = crc32Init(0);
    for (let off = 0; off < dataEnd; off += chunkSize) {
      const end = Math.min(off + chunkSize, dataEnd);
      crc = crc32Update(crc, buf.subarray(off, end));
    }
    const finalCrc = crc32Final(crc, 0xffffffff);

    assert.equal(finalCrc, direct);
  });

  it('chunked CRC16 CCITT computation matches direct CRC16 CCITT', () => {
    const buf = new Uint8Array(100000);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) & 0xff;
    const dataEnd = 80000;

    const direct = crc16Ccitt(buf, { start: 0, end: dataEnd });

    const chunkSize = 16 * 1024;
    let crc16Val = 0xffff;
    for (let off = 0; off < dataEnd; off += chunkSize) {
      const end = Math.min(off + chunkSize, dataEnd);
      crc16Val = crc16Ccitt(buf, { init: crc16Val, start: off, end });
    }

    assert.equal(crc16Val & 0xffff, direct);
  });
});
