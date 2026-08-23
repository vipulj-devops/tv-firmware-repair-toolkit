import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize } from '../src/lib/formatFileSize.js';
import { formatBytes } from '../src/lib/binaryUtils.js';

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe('formatFileSize', () => {
  it('formats 0 bytes as 0 B', () => {
    assert.equal(formatFileSize(0), '0 B');
  });

  it('keeps sub-KB and sub-MB units below 1 MB', () => {
    assert.equal(formatFileSize(512), '512 B');
    assert.equal(formatFileSize(1536), '1.5 KB');
  });

  it('formats a small megabyte value with two decimals', () => {
    assert.equal(formatFileSize(512 * MB), '512.00 MB');
  });

  it('formats 1023 MB in MB, not GB', () => {
    assert.equal(formatFileSize(1023 * MB), '1023.00 MB');
  });

  it('formats exactly 1 GB as 1.00 GB', () => {
    assert.equal(formatFileSize(GB), '1.00 GB');
    assert.equal(formatFileSize(1024 * MB), '1.00 GB');
  });

  it('formats 2 GB as 2.00 GB', () => {
    assert.equal(formatFileSize(2 * GB), '2.00 GB');
    assert.equal(formatFileSize(2048 * MB), '2.00 GB');
  });

  it('formats the 7.28 GB range', () => {
    assert.equal(formatFileSize(7456 * MB), '7.28 GB');
  });

  it('formats a large multi-GB dump', () => {
    assert.equal(formatFileSize(15032 * MB), '14.68 GB');
  });

  it('treats null, undefined, and invalid input as 0 B', () => {
    assert.equal(formatFileSize(null), '0 B');
    assert.equal(formatFileSize(undefined), '0 B');
    assert.equal(formatFileSize(NaN), '0 B');
    assert.equal(formatFileSize(''), '0 B');
    assert.equal(formatFileSize('not-a-size'), '0 B');
    assert.equal(formatFileSize(-1), '0 B');
  });

  it('is the same function used by formatBytes', () => {
    assert.equal(formatBytes(GB), '1.00 GB');
    assert.equal(formatBytes(1023 * MB), '1023.00 MB');
  });
});
