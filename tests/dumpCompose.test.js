import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeDumpBlob } from '../src/lib/dumpCompose.js';
import { createBlockOverlay } from '../src/lib/blockOverlay.js';

const MiB = 1024 * 1024;

function fillBytes(len, fn) {
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) u8[i] = fn(i) & 0xff;
  return u8;
}

function mockFile(bytes) {
  const slices = [];
  return {
    size: bytes.length,
    slices,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    slice(start, end = bytes.length) {
      const s = Math.max(0, start);
      const e = Math.min(bytes.length, end);
      slices.push([s, e, e - s]);
      return bytes.subarray(s, e);
    },
  };
}

describe('composeDumpBlob', () => {
  it('complete partition overlay keeps dump size and patches only overlay bytes', async () => {
    const backing = fillBytes(64, (i) => 0xa0 + (i & 0x0f));
    const original = Uint8Array.from(backing);
    const file = mockFile(backing);
    const overlay = createBlockOverlay();
    overlay.write(10, new Uint8Array([1, 2, 3]));
    const parts = [{
      name: 'system',
      startByte: 0,
      size: 64,
      declaredSize: 64,
      availableSize: 64,
      truncated: false,
      unavailable: false,
    }];
    const blob = composeDumpBlob({ file, parts, overlays: { system: overlay } });
    const out = new Uint8Array(await blob.arrayBuffer());
    assert.equal(out.length, 64);
    assert.deepEqual([...out.subarray(10, 13)], [1, 2, 3]);
    assert.equal(out[9], original[9]);
    assert.equal(out[13], original[13]);
    assert.deepEqual(backing, original);
  });

  it('truncated partition overlay keeps dump size and never expands to declaredSize', async () => {
    const fileSize = 9 * MiB;
    const startByte = 8 * MiB;
    const declaredSize = 2 * MiB;
    const availableSize = 1 * MiB;
    const backing = fillBytes(fileSize, (i) => i & 0xff);
    const file = mockFile(backing);
    const overlay = createBlockOverlay();
    overlay.write(4, new Uint8Array([9, 8, 7]));
    const parts = [{
      name: 'userdata',
      startByte,
      size: declaredSize,
      declaredSize,
      availableSize,
      truncated: true,
      unavailable: false,
    }];
    const blob = composeDumpBlob({ file, parts, overlays: { userdata: overlay } });
    const out = new Uint8Array(await blob.arrayBuffer());
    assert.equal(out.length, fileSize);
    assert.equal(out.length < startByte + declaredSize, true);
    assert.deepEqual([...out.subarray(startByte + 4, startByte + 7)], [9, 8, 7]);
    assert.equal(out[startByte + 3], backing[startByte + 3]);
    assert.ok(file.slices.every((s) => s[1] <= fileSize));
  });

  it('unavailable partition does not expand the dump even if marked changed', async () => {
    const fileSize = 8 * MiB;
    const backing = fillBytes(fileSize, (i) => (i * 3) & 0xff);
    const original = Uint8Array.from(backing);
    const file = mockFile(backing);
    const overlay = createBlockOverlay();
    overlay.write(0, new Uint8Array([1, 2]));
    const parts = [{
      name: 'cache',
      startByte: 10 * MiB,
      size: 2 * MiB,
      declaredSize: 2 * MiB,
      availableSize: 0,
      truncated: false,
      unavailable: true,
    }];
    const blob = composeDumpBlob({ file, parts, overlays: { cache: overlay } });
    const out = new Uint8Array(await blob.arrayBuffer());
    assert.equal(out.length, fileSize);
    assert.deepEqual(out, original);
  });

  it('multiple changed partitions with one truncated do not skip or duplicate physical bytes', async () => {
    const fileSize = 12 * 1024;
    const backing = fillBytes(fileSize, (i) => i & 0xff);
    const file = mockFile(backing);
    const bootOverlay = createBlockOverlay();
    bootOverlay.write(2, new Uint8Array([0xaa]));
    const userOverlay = createBlockOverlay();
    userOverlay.write(1, new Uint8Array([0xbb]));
    const parts = [
      {
        name: 'boot',
        startByte: 0,
        size: 4096,
        declaredSize: 4096,
        availableSize: 4096,
        truncated: false,
        unavailable: false,
      },
      {
        name: 'userdata',
        startByte: 8192,
        size: 8192,
        declaredSize: 8192,
        availableSize: 4096,
        truncated: true,
        unavailable: false,
      },
    ];
    const blob = composeDumpBlob({
      file,
      parts,
      overlays: { boot: bootOverlay, userdata: userOverlay },
    });
    const out = new Uint8Array(await blob.arrayBuffer());
    assert.equal(out.length, fileSize);
    assert.equal(out[2], 0xaa);
    assert.equal(out[8193], 0xbb);
    assert.equal(out[4096], backing[4096]);
    assert.equal(out[8191], backing[8191]);
    assert.ok(file.slices.every((s) => s[1] <= fileSize));
  });

  it('unchanged dump is returned as the original file', () => {
    const backing = fillBytes(32, (i) => i);
    const file = mockFile(backing);
    const parts = [{ name: 'a', startByte: 0, size: 32, availableSize: 32 }];
    const blob = composeDumpBlob({ file, parts, overlays: {} });
    assert.equal(blob, file);
  });
});
