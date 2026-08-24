import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Test for Issue #1: rangeRev should NOT increment on in-place edits

describe('Ext4Browser Issue #1: rangeRev only for structural changes', () => {
  it('does not increment rangeRev for text save operations', async () => {
    // This is verified by inspecting the source code - setRangeRev removed from save()
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify save() function doesn't have setRangeRev after patchExistingFileIo
    const saveFunc = src.match(/const save = async \(\) => \{[\s\S]*?\n  \};/);
    assert.ok(saveFunc, 'save function should exist');
    
    // Check that the range-backed path calls onOverlayPatched but NOT setRangeRev
    const rangeBackedSave = saveFunc[0].match(/await patchExistingFileIo[\s\S]*?toast\(/);
    assert.ok(rangeBackedSave, 'range-backed save path should exist');
    assert.ok(rangeBackedSave[0].includes('onOverlayPatched'), 'should call onOverlayPatched');
    assert.ok(!rangeBackedSave[0].includes('setRangeRev'), 'should NOT call setRangeRev for in-place edits');
  });

  it('does not increment rangeRev for hex/binary edit operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify editByteInFile() doesn't have setRangeRev after patchExistingFileIo
    const editFunc = src.match(/const editByteInFile = async \(index, value\) => \{[\s\S]*?\n  \};/);
    assert.ok(editFunc, 'editByteInFile function should exist');
    
    const rangeBackedEdit = editFunc[0].match(/await patchExistingFileIo[\s\S]*?setImgDirty/);
    assert.ok(rangeBackedEdit, 'range-backed edit path should exist');
    assert.ok(rangeBackedEdit[0].includes('onOverlayPatched'), 'should call onOverlayPatched');
    assert.ok(!rangeBackedEdit[0].includes('setRangeRev'), 'should NOT call setRangeRev for in-place edits');
  });

  it('does not increment rangeRev for replace operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify replaceFile() doesn't have setRangeRev after patchExistingFileIo
    const replaceFunc = src.match(/const replaceFile = \(file\) => \{[\s\S]*?\n  \};/);
    assert.ok(replaceFunc, 'replaceFile function should exist');
    
    const rangeBackedReplace = replaceFunc[0].match(/await patchExistingFileIo[\s\S]*?toast\(/);
    assert.ok(rangeBackedReplace, 'range-backed replace path should exist');
    assert.ok(rangeBackedReplace[0].includes('onOverlayPatched'), 'should call onOverlayPatched');
    assert.ok(!rangeBackedReplace[0].includes('setRangeRev'), 'should NOT call setRangeRev for in-place edits');
  });

  it('does not increment rangeRev for bulk replace operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify replaceFromFolder() doesn't have setRangeRev after calling onOverlayPatched
    const bulkFunc = src.match(/const replaceFromFolder = async \(fileList\) => \{[\s\S]*?\n  \};/);
    assert.ok(bulkFunc, 'replaceFromFolder function should exist');
    
    const rangeBackedBulk = bulkFunc[0].match(/if \(replaced > 0\) \{[\s\S]*?\}/);
    assert.ok(rangeBackedBulk, 'range-backed bulk replace result handling should exist');
    assert.ok(rangeBackedBulk[0].includes('onOverlayPatched'), 'should call onOverlayPatched');
    assert.ok(!rangeBackedBulk[0].includes('setRangeRev'), 'should NOT call setRangeRev for in-place edits');
  });

  it('has rangeRev comment explaining it is only for structural changes', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify rangeRev state declaration has explanatory comment
    assert.ok(src.includes('rangeRev, setRangeRev] = useState(0); // Only for structural changes'), 
      'rangeRev should have comment explaining it is only for structural changes');
  });

  it('still has rangeRev state available for future structural operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify rangeRev state still exists (not removed)
    assert.ok(src.includes('const [rangeRev, setRangeRev] = useState(0)'), 
      'rangeRev state should still exist for future use');
    
    // Verify rangeRev is in useEffect dependency array
    const metaEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?parseSuperblockRange[\s\S]*?\}, \[reader, bytes, rangeRev\]\);/);
    assert.ok(metaEffect, 'rangeRev should still be in metadata loading effect dependencies');
  });

  it('preserves existing in-place edit and overlay behavior', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify onOverlayPatched is still called for in-place edits
    assert.ok(src.includes('onOverlayPatched?.()'), 
      'should still call onOverlayPatched for overlay updates');
    
    // Verify patchExistingFileIo is still used for range-backed edits
    assert.ok(src.includes('patchExistingFileIo'), 
      'should still use patchExistingFileIo for range-backed edits');
  });
});

describe('Ext4Browser preserves existing text and image modified state', () => {
  it('preserves dirtyFile for text file tracking', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify dirtyFile computed state still exists
    assert.ok(src.includes('const dirtyFile = content !== origContent'), 
      'dirtyFile should still exist for text file tracking');
  });

  it('preserves imgDirty for image replacements', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify imgDirty state still exists
    assert.ok(src.includes('const [imgDirty, setImgDirty] = useState(false)'), 
      'imgDirty state should still exist for image replacements');
    
    // Verify replaceFile still sets imgDirty
    const replaceFunc = src.match(/const replaceFile = \(file\) => \{[\s\S]*?\n  \};/);
    assert.ok(replaceFunc[0].includes('setImgDirty(true)'), 
      'replaceFile should still set imgDirty');
  });

  it('does not have Issue #2 binary modified state tracking', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');
    
    // Verify Issue #2 artifacts are removed
    assert.ok(!src.includes('origRawBytes'), 
      'should not have origRawBytes state (Issue #2 reverted)');
    assert.ok(!src.includes('binaryDirty'), 
      'should not have binaryDirty computed state (Issue #2 reverted)');
  });
});
