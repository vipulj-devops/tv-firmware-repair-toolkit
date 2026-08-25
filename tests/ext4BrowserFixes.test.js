import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Tests for Ext4Browser rangeRev and range-backed mutation contracts

describe('Ext4Browser Issue #1: rangeRev only for structural changes', () => {
  it('does not increment rangeRev for in-place text save operations within allocation', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const saveFunc = src.match(/const save = async \(\) => \{[\s\S]*?\n  \};/);
    assert.ok(saveFunc, 'save function should exist');

    const inPlaceSave = saveFunc[0].match(/await patchExistingFileIo[\s\S]*?toast\(/);
    assert.ok(inPlaceSave, 'in-place save path with patchExistingFileIo should exist');
    assert.ok(saveFunc[0].includes('if (res.grown) setRangeRev'), 'setRangeRev should be conditional on res.grown in save');
  });

  it('does not increment rangeRev for hex/binary edit operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const editFunc = src.match(/const editByteInFile = async \(index, value\) => \{[\s\S]*?\n  \};/);
    assert.ok(editFunc, 'editByteInFile function should exist');

    const rangeBackedEdit = editFunc[0].match(/await patchExistingFileIo[\s\S]*?setImgDirty/);
    assert.ok(rangeBackedEdit, 'range-backed edit path should exist');
    assert.ok(rangeBackedEdit[0].includes('onOverlayPatched'), 'should call onOverlayPatched');
    assert.ok(!rangeBackedEdit[0].includes('setRangeRev'), 'should NOT call setRangeRev for in-place byte edits');
  });

  it('does not increment rangeRev for in-place replace operations, but increments when growing', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const replaceFunc = src.match(/const replaceFile = \(file\) => \{[\s\S]*?\n  \};/);
    assert.ok(replaceFunc, 'replaceFile function should exist');

    assert.ok(replaceFunc[0].includes('growAndPatchFileIo'), 'should support range growth via growAndPatchFileIo');
    assert.ok(replaceFunc[0].includes('patchExistingFileIo'), 'should support in-place replace via patchExistingFileIo');
    assert.ok(replaceFunc[0].includes('if (res.grown) setRangeRev'), 'setRangeRev should be conditional on res.grown in replaceFile');
  });

  it('does not increment rangeRev for in-place bulk replace, but increments when any file grows', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const bulkFunc = src.match(/const replaceFromFolder = async \(fileList\) => \{[\s\S]*?\n  \};/);
    assert.ok(bulkFunc, 'replaceFromFolder function should exist');

    assert.ok(bulkFunc[0].includes('if (anyGrown) setRangeRev'), 'setRangeRev should be conditional on anyGrown in replaceFromFolder');
  });

  it('has rangeRev comment explaining it is only for structural changes', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    assert.ok(src.includes('rangeRev, setRangeRev] = useState(0); // Only for structural changes'),
      'rangeRev should have comment explaining it is only for structural changes');
  });

  it('still has rangeRev state available for structural operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    assert.ok(src.includes('const [rangeRev, setRangeRev] = useState(0)'),
      'rangeRev state should exist');

    const metaEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?parseSuperblockRange[\s\S]*?\}, \[reader, bytes, rangeRev\]\);/);
    assert.ok(metaEffect, 'rangeRev should be in metadata loading effect dependencies');
  });

  it('preserves existing in-place edit and overlay behavior', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    assert.ok(src.includes('onOverlayPatched?.()'),
      'should call onOverlayPatched for overlay updates');

    assert.ok(src.includes('patchExistingFileIo'),
      'should use patchExistingFileIo for range-backed edits');
  });

  it('increments rangeRev for structural growth, add, and delete operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const addFunc = src.match(/const addFile = \(file\) => \{[\s\S]*?\n  \};/);
    assert.ok(addFunc, 'addFile function should exist');
    assert.ok(addFunc[0].includes('createFileIo'), 'addFile should call createFileIo for range');
    assert.ok(addFunc[0].includes('setRangeRev'), 'addFile should increment rangeRev');

    const delFunc = src.match(/const deleteSelected = async \(\) => \{[\s\S]*?\n  \};/);
    assert.ok(delFunc, 'deleteSelected function should exist');
    assert.ok(delFunc[0].includes('deleteFileIo'), 'deleteSelected should call deleteFileIo for range');
    assert.ok(delFunc[0].includes('setRangeRev'), 'deleteSelected should increment rangeRev');
  });
});

describe('Ext4Browser preserves existing text and image modified state', () => {
  it('preserves dirtyFile for text file tracking', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    assert.ok(src.includes('const dirtyFile = content !== origContent'),
      'dirtyFile should still exist for text file tracking');
  });

  it('preserves imgDirty for image replacements', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    assert.ok(src.includes('const [imgDirty, setImgDirty] = useState(false)'),
      'imgDirty state should still exist for image replacements');

    const replaceFunc = src.match(/const replaceFile = \(file\) => \{[\s\S]*?\n  \};/);
    assert.ok(replaceFunc[0].includes('setImgDirty(true)'),
      'replaceFile should still set imgDirty');
  });

  it('does not have Issue #2 binary modified state tracking', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    assert.ok(!src.includes('origRawBytes'),
      'should not have origRawBytes state (Issue #2 reverted)');
    assert.ok(!src.includes('binaryDirty'),
      'should not have binaryDirty computed state (Issue #2 reverted)');
  });
});

describe('Stage E1: Range-backed delete UI source contract', () => {
  it('deleteSelected uses deleteFileIo in range mode and preserves memory deleteFile', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const delFunc = src.match(/const deleteSelected = async \(\) => \{[\s\S]*?\n  \};/);
    assert.ok(delFunc, 'deleteSelected function should exist');

    assert.ok(delFunc[0].includes('deleteFile(next, selected.inode, sb, selected.path)'),
      'memory mode should still call in-memory deleteFile');
    assert.ok(delFunc[0].includes('await deleteFileIo(reader, sb, selected.path)'),
      'range mode should call range-backed deleteFileIo');
    assert.ok(delFunc[0].includes('onOverlayPatched?.()'),
      'range delete should notify container via onOverlayPatched');
    assert.ok(delFunc[0].includes('setRangeRev((r) => r + 1)'),
      'range delete should increment rangeRev');
  });

  it('Delete button is controlled by inPlaceWritable and is disabled in read-only mode', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const reqDel = src.match(/const requireDelete = \(\) => \{[\s\S]*?\n  \};/);
    assert.ok(reqDel, 'requireDelete function should exist');
    assert.ok(reqDel[0].includes('inPlaceWritable'), 'requireDelete should check inPlaceWritable');

    assert.ok(src.includes('disabled={!inPlaceWritable}'), 'Delete button should be disabled when inPlaceWritable is false');
    assert.ok(src.includes('title={inPlaceWritable ? \'Delete file\' : \'Delete is unavailable in read-only mode\'}'),
      'Delete button should explain read-only restriction when disabled');
  });
});
