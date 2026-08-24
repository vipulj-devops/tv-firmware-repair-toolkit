import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasGpt, autoMapPartitions } from '../src/lib/emmc.js';
import { analyzeUserArea } from '../src/lib/userAreaParser.js';
import { analyzeFirmware, firmwarePartitionsToParts } from '../src/lib/firmwareParser.js';
import { selectDumpParts } from '../src/lib/userArea/selectDumpParts.js';
import { isExt4 } from '../src/lib/ext4.js';
import { createRangeReader } from '../src/lib/rangeReader.js';
import { parseSuperblockRange, listFilesRange } from '../src/lib/ext4Range.js';
import { usesMemoryEditor, loadExplorePartition, EXT4_EDIT_MEMORY_LIMIT } from '../src/lib/exploreSession.js';

const REALTEK_GPT = 'G:\\EMMC_8GTF4R_USER_00000000_00E8FFFF_20260206_215325.bin';
const SONY = 'G:\\sony\\EMMC_HAG2e_USER_00000000_01D5BFFF_20250924_000711_nw.bin';
const MSTAR1 = 'G:\\5800-a9k53g-op10\\userarea.bin';
const HEAD = 128 * 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

function readHead(path) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(Math.min(HEAD, size));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  return { bytes: buf, size, name: path.split('\\').pop() };
}

function partsFor(path) {
  const head = readHead(path);
  const ua = analyzeUserArea(head.bytes, head.size);
  const fw = analyzeFirmware(head.bytes, head.name, head.size, null);
  const parts = selectDumpParts({
    hasGpt: hasGpt(head.bytes),
    gptParts: autoMapPartitions(head.bytes, head.size),
    userAreaAnalysis: ua,
    firmwareParts: firmwarePartitionsToParts(fw, head.size),
  });
  return { ...head, parts };
}

function fdRangeReader(path, startByte, size) {
  const fd = openSync(path, 'r');
  const reader = createRangeReader({
    startByte,
    size,
    maxRead: 256 * 1024,
    readAbsolute: async (absStart, absEnd) => {
      const len = absEnd - absStart;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, absStart);
      return new Uint8Array(buf);
    },
  });
  reader._fd = fd;
  return reader;
}

async function exploreLargestExt4(path, minSize) {
  const { parts } = partsFor(path);
  const fd = openSync(path, 'r');
  const probe = Buffer.alloc(2048);
  const ext4Parts = [];
  try {
    for (const p of parts) {
      if (p.size < 2048) continue;
      readSync(fd, probe, 0, 2048, p.startByte);
      if (isExt4(probe)) ext4Parts.push(p);
    }
  } finally {
    closeSync(fd);
  }
  const large = ext4Parts.filter((p) => p.size > minSize).sort((a, b) => b.size - a.size);
  assert.ok(large.length, `no ext4 partitions > ${minSize} in ${path}`);
  const p = large[0];
  const reader = fdRangeReader(path, p.startByte, p.size);
  try {
    const sb = await parseSuperblockRange(reader);
    assert.ok(sb, `superblock failed for ${p.name}`);
    const files = await listFilesRange(reader, sb);
    assert.equal(reader.stats.fullPartitionSlices, 0);
    assert.equal(reader.stats.maxSliceLength <= reader.maxRead, true);
    assert.equal(reader.stats.totalSliceBytes < p.size, true);
    assert.ok(files.length > 0, `${p.name} listed 0 files`);
    assert.equal(usesMemoryEditor(p.size), false, `${p.name} should be range-backed`);
    return { part: p, files, stats: reader.stats };
  } finally {
    closeSync(reader._fd);
  }
}

const SMALL_EDIT_PROBE = 32 * 1024 * 1024;

function listExt4Parts(path) {
  const { parts } = partsFor(path);
  const fd = openSync(path, 'r');
  const probe = Buffer.alloc(2048);
  const ext4Parts = [];
  try {
    for (const p of parts) {
      if (p.size < 2048) continue;
      readSync(fd, probe, 0, 2048, p.startByte);
      if (isExt4(probe)) ext4Parts.push(p);
    }
  } finally {
    closeSync(fd);
  }
  return ext4Parts;
}

function nodeDumpFile(path) {
  return {
    slice(start, end) {
      return {
        async arrayBuffer() {
          const fd = openSync(path, 'r');
          try {
            const len = end - start;
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, start);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          } finally {
            closeSync(fd);
          }
        },
      };
    },
  };
}

describe('live dump ranged ext4 explore (optional)', () => {
  it('Realtek GPT vendor/system/data can be listed without a 1 GiB gate', {
    skip: !existsSync(REALTEK_GPT),
  }, async () => {
    const r = await exploreLargestExt4(REALTEK_GPT, GiB);
    assert.equal(r.part.size > GiB, true);
  });

  it('Sony userdata can be listed without loading the partition', {
    skip: !existsSync(SONY),
  }, async () => {
    const r = await exploreLargestExt4(SONY, GiB);
    assert.equal(r.part.size > GiB, true);
  });

  it('MStar userdata can be listed without loading the partition', {
    skip: !existsSync(MSTAR1),
  }, async () => {
    const r = await exploreLargestExt4(MSTAR1, GiB);
    assert.equal(r.part.size > GiB, true);
  });

  it('selects memory vs range by size without loading multi-GB partitions', {
    skip: ![REALTEK_GPT, SONY, MSTAR1].some((p) => existsSync(p)),
  }, async () => {
    const path = [REALTEK_GPT, SONY, MSTAR1].find((p) => existsSync(p));
    const ext4Parts = listExt4Parts(path);
    const large = ext4Parts.find((p) => p.size > EXT4_EDIT_MEMORY_LIMIT);
    const small = ext4Parts.filter((p) => p.size <= EXT4_EDIT_MEMORY_LIMIT).sort((a, b) => a.size - b.size)[0];
    if (large) assert.equal(usesMemoryEditor(large.size), false);
    if (small) assert.equal(usesMemoryEditor(small.size), true);
    if (small && small.size <= SMALL_EDIT_PROBE) {
      const session = await loadExplorePartition({
        file: nodeDumpFile(path),
        startByte: small.startByte,
        size: small.size,
        name: small.name,
      });
      assert.equal(session.mode, 'memory');
      assert.equal(session.bytes instanceof Uint8Array, true);
      assert.equal(session.bytes.length, small.size);
    }
  });
});
