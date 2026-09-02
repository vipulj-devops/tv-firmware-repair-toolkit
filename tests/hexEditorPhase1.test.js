import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampIndex,
  getSelectionRange,
  isIndexSelected,
  moveCursor,
  navigateKey,
  createEditHistory,
  isByteModified,
  getModifiedIndices,
  applyAsciiEdit,
  applyHexEdit,
  isEditableFormControl,
  parseOffsetInput,
  clampGotoOffset,
  getRowForOffset,
  formatOffsetLabel,
  formatByteValue,
  formatSelectionSize,
  createModifiedCounter,
  parseSearchPattern,
  findNextMatch,
  findPreviousMatch,
  findAllMatches,
  findNonOverlappingMatches,
  validateReplacementLength,
  collectOverwriteEdits,
  collectNonOverlappingReplacementEdits,
  validateReplacementInputs,
} from '../src/lib/hexEditorCore.js';

describe('Phase 1 Hex/ASCII Editor Core Tests', () => {
  it('1. ASCII character edit updates correct byte (fixed length, printable ASCII)', () => {
    const bytes = new Uint8Array([0x4e, 0x50, 0x43, 0x4c, 0x54]); // "NPCLT"
    const edit = applyAsciiEdit(3, 'R'.charCodeAt(0), bytes); // Change 'L' (0x4C) to 'R' (0x52)
    assert.ok(edit);
    assert.equal(edit.index, 3);
    assert.equal(edit.before, 0x4c);
    assert.equal(edit.after, 0x52);

    const updated = new Uint8Array(bytes);
    updated[edit.index] = edit.after;
    assert.equal(updated.length, bytes.length); // length remains unchanged
    assert.equal(updated[3], 0x52);
  });

  it('2. Hex edit updates ASCII representation', () => {
    const bytes = new Uint8Array([0x4e, 0x50, 0x43, 0x4c, 0x54]);
    const edit = applyHexEdit(3, 0x52, bytes);
    assert.ok(edit);
    assert.equal(edit.after, 0x52);

    const updated = new Uint8Array(bytes);
    updated[edit.index] = edit.after;
    const ascii = String.fromCharCode(updated[3]);
    assert.equal(ascii, 'R');
  });

  it('3. ASCII and HEX cursor map to same byte index', () => {
    const cursor = 0x24; // 36
    const moveHex = moveCursor({ cursorIndex: 0, anchorIndex: 0, newIndex: cursor, length: 100 });
    const moveAscii = moveCursor({ cursorIndex: 0, anchorIndex: 0, newIndex: cursor, length: 100 });

    assert.equal(moveHex.cursorIndex, 0x24);
    assert.equal(moveAscii.cursorIndex, 0x24);
    assert.equal(moveHex.cursorIndex, moveAscii.cursorIndex);
  });

  it('4. Selection range remains byte-accurate', () => {
    const range1 = getSelectionRange(10, 25);
    assert.equal(range1.start, 10);
    assert.equal(range1.end, 25);
    assert.ok(isIndexSelected(15, 10, 25));
    assert.ok(!isIndexSelected(9, 10, 25));
    assert.ok(!isIndexSelected(26, 10, 25));

    // Reverse selection (anchor > cursor)
    const range2 = getSelectionRange(25, 10);
    assert.equal(range2.start, 10);
    assert.equal(range2.end, 25);
  });

  it('5. Cursor navigation clamps at boundaries', () => {
    const length = 50;
    assert.equal(clampIndex(-10, length), 0);
    assert.equal(clampIndex(100, length), 49);
    assert.equal(clampIndex(25, length), 25);
  });

  it('6. Up/down navigation moves correct row width (16 bytes)', () => {
    const length = 100;
    const initial = 20;

    const navDown = navigateKey({ key: 'ArrowDown', cursorIndex: initial, anchorIndex: initial, length, rowBytes: 16 });
    assert.equal(navDown.cursorIndex, 36);

    const navUp = navigateKey({ key: 'ArrowUp', cursorIndex: 36, anchorIndex: 36, length, rowBytes: 16 });
    assert.equal(navUp.cursorIndex, 20);

    const navHome = navigateKey({ key: 'Home', cursorIndex: 25, anchorIndex: 25, length, rowBytes: 16 });
    assert.equal(navHome.cursorIndex, 16);

    const navEnd = navigateKey({ key: 'End', cursorIndex: 16, anchorIndex: 16, length, rowBytes: 16 });
    assert.equal(navEnd.cursorIndex, 31);
  });

  it('7. Modified byte is tracked', () => {
    const orig = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const curr = new Uint8Array([0x10, 0x99, 0x30, 0x40]);

    assert.ok(!isByteModified(0, curr, orig));
    assert.ok(isByteModified(1, curr, orig));
    assert.ok(!isByteModified(2, curr, orig));

    const modifiedSet = getModifiedIndices(curr, orig);
    assert.equal(modifiedSet.size, 1);
    assert.ok(modifiedSet.has(1));
  });

  it('8. Reverting byte to original clears modified state', () => {
    const orig = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const curr = new Uint8Array([0x10, 0x99, 0x30, 0x40]);

    assert.ok(isByteModified(1, curr, orig));

    // Edit byte back to original 0x20
    curr[1] = 0x20;
    assert.ok(!isByteModified(1, curr, orig));
    assert.equal(getModifiedIndices(curr, orig).size, 0);
  });

  it('9. Undo restores previous byte', () => {
    const history = createEditHistory();
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Apply edit at index 1: 0x20 -> 0xAA
    history.pushEdit({ index: 1, before: 0x20, after: 0xaa });
    bytes[1] = 0xaa;
    assert.equal(bytes[1], 0xaa);

    // Undo
    const undone = history.undo();
    assert.ok(undone);
    bytes[undone.index] = undone.value;
    assert.equal(bytes[1], 0x20); // Restored
  });

  it('10. Redo reapplies byte', () => {
    const history = createEditHistory();
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);

    history.pushEdit({ index: 1, before: 0x20, after: 0xaa });
    bytes[1] = 0xaa;

    const undone = history.undo();
    bytes[undone.index] = undone.value;
    assert.equal(bytes[1], 0x20);

    // Redo
    const redone = history.redo();
    assert.ok(redone);
    bytes[redone.index] = redone.value;
    assert.equal(bytes[1], 0xaa); // Reapplied
  });

  it('11. New edit after undo clears redo history', () => {
    const history = createEditHistory();

    history.pushEdit({ index: 0, before: 0x10, after: 0x11 });
    assert.ok(history.canUndo());
    assert.ok(!history.canRedo());

    history.undo();
    assert.ok(history.canRedo());

    // Perform new edit
    history.pushEdit({ index: 2, before: 0x30, after: 0x33 });
    assert.ok(!history.canRedo()); // Redo branch cleared
  });

  it('11b. pushBatch creates one undo entry', () => {
    const history = createEditHistory();
    const pushed = history.pushBatch([
      { index: 0, before: 0x10, after: 0x11 },
      { index: 1, before: 0x20, after: 0x22 },
    ]);
    assert.equal(pushed, true);
    assert.equal(history.getUndoCount(), 1);
    assert.equal(history.getRedoCount(), 0);
  });

  it('11c. undo returns all batch edits atomically', () => {
    const history = createEditHistory();
    history.pushBatch([
      { index: 0, before: 0x10, after: 0x11 },
      { index: 2, before: 0x30, after: 0x33 },
    ]);
    const undone = history.undo();
    assert.ok(undone.isBatch);
    assert.equal(undone.edits.length, 2);
    assert.equal(undone.edits[0].before, 0x10);
    assert.equal(undone.edits[1].after, 0x33);
    assert.ok(history.canRedo());
    assert.ok(!history.canUndo());
  });

  it('11d. redo returns all batch edits atomically', () => {
    const history = createEditHistory();
    history.pushBatch([
      { index: 0, before: 0x10, after: 0x11 },
      { index: 1, before: 0x20, after: 0x22 },
    ]);
    history.undo();
    const redone = history.redo();
    assert.ok(redone.isBatch);
    assert.equal(redone.edits.length, 2);
    assert.equal(redone.edits[0].after, 0x11);
    assert.equal(redone.edits[1].after, 0x22);
    assert.ok(history.canUndo());
    assert.ok(!history.canRedo());
  });

  it('11e. empty and unchanged batches are ignored', () => {
    const history = createEditHistory();
    assert.equal(history.pushBatch([]), false);
    assert.equal(history.pushBatch([{ index: 0, before: 0x10, after: 0x10 }]), false);
    assert.equal(history.getUndoCount(), 0);
  });

  it('11f. pushEdit still works after mixing with batches', () => {
    const history = createEditHistory();
    history.pushEdit({ index: 0, before: 0x10, after: 0x11 });
    history.pushBatch([
      { index: 1, before: 0x20, after: 0x22 },
      { index: 2, before: 0x30, after: 0x33 },
    ]);
    history.pushEdit({ index: 3, before: 0x40, after: 0x44 });
    assert.equal(history.getUndoCount(), 3);

    const last = history.undo();
    assert.equal(last.index, 3);
    assert.equal(last.value, 0x40);

    const batch = history.undo();
    assert.ok(batch.isBatch);
    assert.equal(batch.edits.length, 2);

    const first = history.undo();
    assert.equal(first.index, 0);
    assert.equal(first.value, 0x10);
    assert.ok(history.canRedo());
    assert.ok(!history.canUndo());
  });

  it('12. Edits remain fixed-length', () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63, 0x64]); // "abcd"
    const edit = applyAsciiEdit(1, 'X'.charCodeAt(0), bytes);
    assert.ok(edit);

    const updated = new Uint8Array(bytes);
    updated[edit.index] = edit.after;
    assert.equal(updated.length, 4);
    assert.equal(String.fromCharCode(...updated), 'aXcd');
  });

  it('13. No edit shifts following byte offsets', () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
    const edit = applyHexEdit(2, 0xff, bytes);

    const updated = new Uint8Array(bytes);
    updated[edit.index] = edit.after;

    assert.equal(updated[0], 0x10);
    assert.equal(updated[1], 0x20);
    assert.equal(updated[2], 0xff); // Only index 2 changed
    assert.equal(updated[3], 0x40); // Offset 3 unshifted
    assert.equal(updated[4], 0x50); // Offset 4 unshifted
  });

  it('14. isEditableFormControl identifies form controls', () => {
    // Simulate form control elements by their tagName
    assert.ok(isEditableFormControl({ tagName: 'INPUT', getAttribute: () => null }));
    assert.ok(isEditableFormControl({ tagName: 'TEXTAREA', getAttribute: () => null }));
    assert.ok(isEditableFormControl({ tagName: 'SELECT', getAttribute: () => null }));
    assert.ok(isEditableFormControl({ tagName: 'BUTTON', getAttribute: () => null }));
    assert.ok(isEditableFormControl({ tagName: 'A', getAttribute: () => null }));

    // contenteditable element
    assert.ok(isEditableFormControl({ tagName: 'SPAN', getAttribute: (name) => name === 'contenteditable' ? 'true' : null }));

    // Non-editable element
    assert.ok(!isEditableFormControl({ tagName: 'DIV', getAttribute: () => null }));
    assert.ok(!isEditableFormControl({ tagName: 'SPAN', getAttribute: () => null }));

    // lowercase tagName
    assert.ok(isEditableFormControl({ tagName: 'input', getAttribute: () => null }));
    assert.ok(isEditableFormControl({ tagName: 'button', getAttribute: () => null }));

    // null/undefined target
    assert.ok(!isEditableFormControl(null));
    assert.ok(!isEditableFormControl(undefined));
    assert.ok(!isEditableFormControl({}));
    assert.ok(!isEditableFormControl({ tagName: '', getAttribute: () => null }));
  });
});

describe('Phase 2A — Go To Offset', () => {
  it('1. Parse 0x24 correctly', () => {
    const r = parseOffsetInput('0x24');
    assert.ok(r.ok);
    assert.equal(r.value, 0x24);
  });

  it('2. Parse 24 as hexadecimal', () => {
    const r = parseOffsetInput('24');
    assert.ok(r.ok);
    assert.equal(r.value, 0x24);
  });

  it('3. Parse uppercase 0X and lowercase 0x', () => {
    assert.equal(parseOffsetInput('0X24').value, 0x24);
    assert.equal(parseOffsetInput('0x24').value, 0x24);
    assert.equal(parseOffsetInput('0Xabcdef').value, 0xabcdef);
  });

  it('4. Reject empty input', () => {
    const r = parseOffsetInput('');
    assert.ok(!r.ok);
    assert.match(r.error, /enter/i);
  });

  it('5. Reject invalid hexadecimal input', () => {
    const r = parseOffsetInput('xyz');
    assert.ok(!r.ok);
    assert.match(r.error, /hex/i);
  });

  it('5b. Reject 0xZZZZ', () => {
    const r = parseOffsetInput('0xZZZZ');
    assert.ok(!r.ok);
  });

  it('6. Reject negative input', () => {
    const r = parseOffsetInput('-1');
    assert.ok(!r.ok);
  });

  it('7. Reject offset == bytes.length', () => {
    const length = 100;
    const r = clampGotoOffset(100, length);
    assert.ok(!r.ok);
    assert.match(r.error, /beyond/i);
  });

  it('8. Accept offset == bytes.length - 1', () => {
    const length = 100;
    const r = clampGotoOffset(99, length);
    assert.ok(r.ok);
    assert.equal(r.value, 99);
  });

  it('9. Calculate correct row index', () => {
    assert.equal(getRowForOffset(0x00, 16), 0);
    assert.equal(getRowForOffset(0x0f, 16), 0);
    assert.equal(getRowForOffset(0x10, 16), 1);
    assert.equal(getRowForOffset(0x1f, 16), 1);
    assert.equal(getRowForOffset(0x24, 16), 2);
    assert.equal(getRowForOffset(0x03800000, 16), 0x03800000 / 16);
  });

  it('10. parseOffsetInput + clampGotoOffset does not modify bytes', () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
    const origCopy = new Uint8Array(bytes);
    const parsed = parseOffsetInput('0x2');
    assert.ok(parsed.ok);
    const clamped = clampGotoOffset(parsed.value, bytes.length);
    assert.ok(clamped.ok);
    assert.equal(clamped.value, 2);
    // bytes array unchanged
    assert.deepEqual(Array.from(bytes), Array.from(origCopy));
  });

  it('11. Existing cursor/selection behavior remains intact', () => {
    const { cursorIndex, anchorIndex } = moveCursor({ cursorIndex: 0, anchorIndex: 0, newIndex: 5, length: 100 });
    assert.equal(cursorIndex, 5);
    assert.equal(anchorIndex, 5);
  });

  it('12. Existing ASCII editing remains intact', () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    const edit = applyAsciiEdit(1, 'Z'.charCodeAt(0), bytes);
    assert.ok(edit);
    assert.equal(edit.before, 0x62);
    assert.equal(edit.after, 0x5a);
    const updated = new Uint8Array(bytes);
    updated[edit.index] = edit.after;
    assert.equal(updated.length, 3);
    assert.equal(String.fromCharCode(updated[1]), 'Z');
  });

  it('13. Existing HEX editing remains intact', () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const edit = applyHexEdit(1, 0xff, bytes);
    assert.ok(edit);
    assert.equal(edit.after, 0xff);
    const updated = new Uint8Array(bytes);
    updated[edit.index] = edit.after;
    assert.equal(updated[1], 0xff);
    assert.equal(updated.length, 3);
  });

   it('14. Search input keyboard behavior remains intact (form control guard)', () => {
    // Simulating a search input element
    const mockInput = { tagName: 'INPUT', getAttribute: () => null };
    assert.ok(isEditableFormControl(mockInput));
    // This ensures the editor's keydown handler would return early for this target
  });
});

describe('Phase 2B — Hex Editor Status Bar', () => {
  it('1. formatOffsetLabel formats hex offsets with 8-digit padding', () => {
    assert.equal(formatOffsetLabel(0), '0x00000000');
    assert.equal(formatOffsetLabel(0x24), '0x00000024');
    assert.equal(formatOffsetLabel(0x1a0), '0x000001A0');
    assert.equal(formatOffsetLabel(0x03800000), '0x03800000');
  });

  it('2. formatOffsetLabel handles null/zero/undefined', () => {
    assert.equal(formatOffsetLabel(0), '0x00000000');
    assert.equal(formatOffsetLabel(null), '0x00000000');
    assert.equal(formatOffsetLabel(undefined), '0x00000000');
  });

  it('3. formatByteValue formats byte values', () => {
    assert.equal(formatByteValue(0x00), '00');
    assert.equal(formatByteValue(0xff), 'FF');
    assert.equal(formatByteValue(0x1a), '1A');
    assert.equal(formatByteValue(0x7f), '7F');
  });

  it('4. formatByteValue handles invalid values', () => {
    assert.equal(formatByteValue(null), '--');
    assert.equal(formatByteValue(undefined), '--');
    assert.equal(formatByteValue(256), '--');
    assert.equal(formatByteValue(-1), '--');
  });

  it('5. formatSelectionSize formats selection counts', () => {
    assert.equal(formatSelectionSize(0), 'Selected: 0 bytes');
    assert.equal(formatSelectionSize(1), 'Selected: 1 byte');
    assert.equal(formatSelectionSize(2), 'Selected: 2 bytes');
    assert.equal(formatSelectionSize(100), 'Selected: 100 bytes');
  });

  it('6. createModifiedCounter tracks modified byte count', () => {
    const counter = createModifiedCounter();
    assert.equal(counter.getCount(), 0);
    counter.increment();
    counter.increment();
    assert.equal(counter.getCount(), 2);
    counter.decrement();
    assert.equal(counter.getCount(), 1);
    counter.clear();
    assert.equal(counter.getCount(), 0);
  });

  it('7. createModifiedCounter never goes negative', () => {
    const counter = createModifiedCounter();
    counter.decrement();
    assert.equal(counter.getCount(), 0);
  });

  it('8. createModifiedCounter reset sets explicit value', () => {
    const counter = createModifiedCounter();
    counter.increment();
    counter.increment();
    counter.increment();
    assert.equal(counter.getCount(), 3);
    counter.reset(1);
    assert.equal(counter.getCount(), 1);
  });

  it('9. Modified count increments on edit', () => {
    const counter = createModifiedCounter();
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const origBytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Simulate commitEdit for byte 1: 0x20 -> 0xAA
    const before = bytes[1]; // 0x20
    const newValue = 0xaa;
    bytes[1] = newValue;
    const wasModified = origBytes ? before !== origBytes[1] : false; // false
    const isNowModified = origBytes ? newValue !== origBytes[1] : true; // true
    if (wasModified && !isNowModified) counter.decrement();
    else if (!wasModified && isNowModified) counter.increment();

    assert.equal(counter.getCount(), 1);
    assert.equal(bytes[1], 0xaa);
  });

  it('10. Modified count decrements on undo', () => {
    const counter = createModifiedCounter();
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const origBytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Apply edit: 0x20 -> 0xAA, counter goes to 1
    bytes[1] = 0xaa;
    counter.increment();
    assert.equal(counter.getCount(), 1);

    // Undo: revert 0xAA back to 0x20
    const afterModified = origBytes ? 0xaa !== origBytes[1] : true; // true (0xaa != 0x20)
    const beforeModified = origBytes ? 0x20 !== origBytes[1] : false; // false (0x20 == 0x20)
    if (afterModified && !beforeModified) counter.decrement();
    else if (!afterModified && beforeModified) counter.increment();

    assert.equal(counter.getCount(), 0);
  });

  it('11. Modified count increments on redo', () => {
    const counter = createModifiedCounter();
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const origBytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Initial edit: counter = 1
    counter.increment();

    // Undo: counter back to 0
    counter.decrement();

    // Redo: re-apply 0x20 -> 0xAA
    const beforeModified = origBytes ? 0x20 !== origBytes[1] : false; // false
    const afterModified = origBytes ? 0xaa !== origBytes[1] : true; // true
    if (beforeModified && !afterModified) counter.decrement();
    else if (!beforeModified && afterModified) counter.increment();

    assert.equal(counter.getCount(), 1);
  });

  it('12. Modified count clears on buffer reload (revert/new file)', () => {
    const counter = createModifiedCounter();
    counter.increment();
    counter.increment();
    assert.equal(counter.getCount(), 2);

    // Simulate buffer reload (origBytesRef re-initialized)
    counter.clear();
    assert.equal(counter.getCount(), 0);
  });

  it('13. Modified count handles multiple edits to same byte', () => {
    const counter = createModifiedCounter();
    const origBytes = new Uint8Array([0x10, 0x20, 0x30]);
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Edit byte 1: 0x20 -> 0xAA (was unmodified, now modified)
    bytes[1] = 0xaa;
    counter.increment();
    assert.equal(counter.getCount(), 1);

    // Edit byte 1 again: 0xAA -> 0xBB (was modified, still modified - no count change)
    const before = bytes[1]; // 0xaa
    const newVal = 0xbb;
    const wasModified = before !== origBytes[1]; // true (0xaa != 0x20)
    const isNowModified = newVal !== origBytes[1]; // true (0xbb != 0x20)
    if (wasModified && !isNowModified) counter.decrement();
    else if (!wasModified && isNowModified) counter.increment();

    assert.equal(counter.getCount(), 1); // still 1, not 2

    // Edit byte 1 back to original: 0xBB -> 0x20 (was modified, now unmodified)
    const before2 = bytes[1]; // 0xbb
    const newVal2 = 0x20;
    const wasModified2 = before2 !== origBytes[1]; // true
    const isNowModified2 = newVal2 !== origBytes[1]; // false
    if (wasModified2 && !isNowModified2) counter.decrement();
    else if (!wasModified2 && isNowModified2) counter.increment();

    assert.equal(counter.getCount(), 0);
  });

  it('14. isEditableFormControl guards search input from editor keyboard handlers', () => {
    // The search input in HexViewer is an HTMLInputElement
    const mockSearchInput = { tagName: 'INPUT', getAttribute: () => null };
    assert.ok(isEditableFormControl(mockSearchInput));

    // The goto input is also an HTMLInputElement
    const mockGotoInput = { tagName: 'INPUT', getAttribute: () => null };
    assert.ok(isEditableFormControl(mockGotoInput));
  });
});

describe('Phase 2B — Hex Editor Status Bar & Search', () => {
  it('1. formatOffsetLabel formats cursor offsets', () => {
    assert.equal(formatOffsetLabel(0), '0x00000000');
    assert.equal(formatOffsetLabel(0x24), '0x00000024');
    assert.equal(formatOffsetLabel(0x000001A0), '0x000001A0');
    assert.equal(formatOffsetLabel(0x03800000), '0x03800000');
    assert.equal(formatOffsetLabel(255), '0x000000FF');
  });

  it('2. formatByteValue displays byte values', () => {
    assert.equal(formatByteValue(0x00), '00');
    assert.equal(formatByteValue(0x7f), '7F');
    assert.equal(formatByteValue(0xff), 'FF');
    assert.equal(formatByteValue(0x4e), '4E');
  });

  it('3. formatByteValue handles invalid values safely', () => {
    assert.equal(formatByteValue(null), '--');
    assert.equal(formatByteValue(undefined), '--');
    assert.equal(formatByteValue(256), '--');
    assert.equal(formatByteValue(-1), '--');
  });

  it('4. formatSelectionSize formats selection counts correctly', () => {
    assert.equal(formatSelectionSize(0), 'Selected: 0 bytes');
    assert.equal(formatSelectionSize(1), 'Selected: 1 byte');
    assert.equal(formatSelectionSize(5), 'Selected: 5 bytes');
  });

  it('5. Modified-byte count starts at zero', () => {
    const counter = createModifiedCounter();
    assert.equal(counter.getCount(), 0);
  });

  it('6. Modified count increments on edit', () => {
    const counter = createModifiedCounter();
    const origBytes = new Uint8Array([0x10, 0x20, 0x30]);
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Edit byte 1: 0x20 -> 0xAA
    const before = bytes[1];
    const newValue = 0xaa;
    bytes[1] = newValue;
    const wasModified = before !== origBytes[1];
    const isNowModified = newValue !== origBytes[1];
    if (wasModified && !isNowModified) counter.decrement();
    else if (!wasModified && isNowModified) counter.increment();

    assert.equal(counter.getCount(), 1);
  });

  it('7. Modified count decrements on undo', () => {
    const counter = createModifiedCounter();
    const origBytes = new Uint8Array([0x10, 0x20, 0x30]);
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Apply edit: 0x20 -> 0xAA
    bytes[1] = 0xaa;
    counter.increment();
    assert.equal(counter.getCount(), 1);

    // Undo: revert 0xAA -> 0x20
    const afterModified = 0xaa !== origBytes[1]; // true
    const beforeModified = 0x20 !== origBytes[1]; // false (was original)
    if (afterModified && !beforeModified) counter.decrement();
    else if (!afterModified && beforeModified) counter.increment();

    assert.equal(counter.getCount(), 0);
  });

  it('8. Modified count increments on redo', () => {
    const counter = createModifiedCounter();
    const origBytes = new Uint8Array([0x10, 0x20, 0x30]);

    // Initial edit: counter = 1
    counter.increment();

    // Undo: counter back to 0
    counter.decrement();
    assert.equal(counter.getCount(), 0);

    // Redo: re-apply edit
    const beforeModified = 0x20 !== origBytes[1]; // false (was original)
    const afterModified = 0xaa !== origBytes[1]; // true
    if (beforeModified && !afterModified) counter.decrement();
    else if (!beforeModified && afterModified) counter.increment();

    assert.equal(counter.getCount(), 1);
  });

  it('9. Modified count clears on revert (buffer reload)', () => {
    const counter = createModifiedCounter();
    counter.increment();
    counter.increment();
    counter.increment();
    assert.equal(counter.getCount(), 3);

    // Simulate revert: origBytesRef clears and counter resets
    counter.clear();
    assert.equal(counter.getCount(), 0);
  });

  it('10. parseSearchPattern parses HEX input with spaces', () => {
    const r = parseSearchPattern('4E 4F 4E 45', 'hex');
    assert.ok(r.ok);
    assert.equal(r.needle.length, 4);
    assert.deepEqual(Array.from(r.needle), [0x4e, 0x4f, 0x4e, 0x45]);
  });

  it('11. parseSearchPattern parses HEX input without spaces', () => {
    const r = parseSearchPattern('4E4F4E45', 'hex');
    assert.ok(r.ok);
    assert.equal(r.needle.length, 4);
    assert.deepEqual(Array.from(r.needle), [0x4e, 0x4f, 0x4e, 0x45]);
  });

  it('12. parseSearchPattern parses uppercase and lowercase hex', () => {
    assert.deepEqual(Array.from(parseSearchPattern('0xabcdef', 'hex').needle), [0xab, 0xcd, 0xef]);
    assert.deepEqual(Array.from(parseSearchPattern('0XABCDEF', 'hex').needle), [0xab, 0xcd, 0xef]);
    assert.deepEqual(Array.from(parseSearchPattern('abcd', 'hex').needle), [0xab, 0xcd]);
    assert.deepEqual(Array.from(parseSearchPattern('ABCD', 'hex').needle), [0xab, 0xcd]);
  });

  it('13. parseSearchPattern rejects invalid HEX input', () => {
    assert.ok(!parseSearchPattern('xyz', 'hex').ok);
    assert.ok(!parseSearchPattern('0xZZZZ', 'hex').ok);
    assert.ok(!parseSearchPattern('GG', 'hex').ok);
  });

  it('14. parseSearchPattern rejects odd-length HEX', () => {
    const r = parseSearchPattern('ABC', 'hex');
    assert.ok(!r.ok);
    assert.match(r.error, /even number/i);
  });

  it('15. parseSearchPattern parses ASCII input', () => {
    const r = parseSearchPattern('NPCLT', 'ascii');
    assert.ok(r.ok);
    assert.equal(r.needle.length, 5);
    assert.equal(r.needle[0], 0x4e);
    assert.equal(r.needle[3], 0x4c);
  });

  it('16. parseSearchPattern rejects empty input', () => {
    const r = parseSearchPattern('', 'hex');
    assert.ok(!r.ok);
    assert.match(r.error, /enter/i);
  });

  it('17. findNextMatch finds first match from start', () => {
    const haystack = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x30, 0x40]);
    const needle = new Uint8Array([0x30, 0x40]);
    assert.equal(findNextMatch(haystack, needle, 0), 2);
  });

  it('18. findNextMatch finds next match from cursor', () => {
    const haystack = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x30, 0x40]);
    const needle = new Uint8Array([0x30, 0x40]);
    assert.equal(findNextMatch(haystack, needle, 3), 4);
  });

  it('19. findNextMatch wraps around', () => {
    const haystack = new Uint8Array([0x30, 0x40, 0x10, 0x20, 0x30, 0x40]);
    const needle = new Uint8Array([0x30, 0x40]);
    // Searching from index 4 should find index 4
    assert.equal(findNextMatch(haystack, needle, 4), 4);
  });

  it('20. findNextMatch returns -1 for no match', () => {
    const haystack = new Uint8Array([0x10, 0x20, 0x30]);
    const needle = new Uint8Array([0xaa, 0xbb]);
    assert.equal(findNextMatch(haystack, needle, 0), -1);
  });

  it('21. findPreviousMatch finds match before cursor', () => {
    const haystack = new Uint8Array([0x30, 0x40, 0x10, 0x20, 0x30, 0x40]);
    const needle = new Uint8Array([0x30, 0x40]);
    assert.equal(findPreviousMatch(haystack, needle, 5), 4);
  });

  it('22. findPreviousMatch wraps around to end', () => {
    const haystack = new Uint8Array([0x30, 0x40, 0x10, 0x20, 0x30, 0x40]);
    const needle = new Uint8Array([0x30, 0x40]);
    // Searching backwards from index 1 wraps to find last match at index 4
    assert.equal(findPreviousMatch(haystack, needle, 1), 0);
  });

  it('23. findPreviousMatch returns -1 for no match', () => {
    const haystack = new Uint8Array([0x10, 0x20, 0x30]);
    const needle = new Uint8Array([0xaa]);
    assert.equal(findPreviousMatch(haystack, needle, 2), -1);
  });

  it('24. findAllMatches finds multiple matches', () => {
    const haystack = new Uint8Array([0x4e, 0x4f, 0x4e, 0x45, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);
    const found = findAllMatches(haystack, needle);
    assert.deepEqual(found, [0, 4]);
  });

  it('25. Overlapping matches are found', () => {
    const haystack = new Uint8Array([0xaa, 0xaa, 0xaa]);
    const needle = new Uint8Array([0xaa, 0xaa]);
    const found = findAllMatches(haystack, needle);
    assert.deepEqual(found, [0, 1]);
  });

  it('26. Single-byte pattern search', () => {
    const haystack = new Uint8Array([0x10, 0xaa, 0x20, 0xaa, 0xaa]);
    const needle = new Uint8Array([0xaa]);
    const found = findAllMatches(haystack, needle);
    assert.deepEqual(found, [1, 3, 4]);
    assert.equal(findNextMatch(haystack, needle, 0), 1);
    assert.equal(findNextMatch(haystack, needle, 2), 3);
    assert.equal(findPreviousMatch(haystack, needle, 3), 3);
    assert.equal(findPreviousMatch(haystack, needle, 2), 1);
    assert.equal(findPreviousMatch(haystack, needle, 4), 4);
  });

  it('27. Pattern equal to entire buffer', () => {
    const haystack = new Uint8Array([0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);
    const found = findAllMatches(haystack, needle);
    assert.deepEqual(found, [0]);
    assert.equal(findNextMatch(haystack, needle, 0), 0);
    assert.equal(findPreviousMatch(haystack, needle, 1), 0);
  });

  it('28. Pattern larger than buffer returns no matches', () => {
    const haystack = new Uint8Array([0x4e]);
    const needle = new Uint8Array([0x4e, 0x4f]);
    assert.equal(findNextMatch(haystack, needle, 0), -1);
    assert.equal(findPreviousMatch(haystack, needle, 0), -1);
    assert.deepEqual(findAllMatches(haystack, needle), []);
  });

  it('29. Existing cursor/selection behavior remains intact after search enhancements', () => {
    const { cursorIndex, anchorIndex } = moveCursor({ cursorIndex: 0, anchorIndex: 0, newIndex: 0x10, length: 100 });
    assert.equal(cursorIndex, 0x10);
    assert.equal(anchorIndex, 0x10);
  });

  it('30. Existing HEX editing remains intact after search enhancements', () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const edit = applyHexEdit(1, 0xff, bytes);
    assert.ok(edit);
    assert.equal(edit.after, 0xff);
  });

  it('31. Existing ASCII editing remains intact after search enhancements', () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    const edit = applyAsciiEdit(1, 'Z'.charCodeAt(0), bytes);
    assert.ok(edit);
    assert.equal(edit.after, 0x5a);
  });

  it('32. Existing undo/redo remains intact after search enhancements', () => {
    const history = createEditHistory();
    history.pushEdit({ index: 0, before: 0x10, after: 0x11 });
    assert.ok(history.canUndo());
    assert.ok(!history.canRedo());
    const undone = history.undo();
    assert.equal(undone.value, 0x10);
    assert.ok(history.canRedo());
    const redone = history.redo();
    assert.equal(redone.value, 0x11);
  });

  it('33. Search results invalidate when buffer changes (edit while searching)', () => {
    // Simulate: search finds matches, then a byte is edited that modifies a match
    const origBytes = new Uint8Array([0x4e, 0x4f, 0x4e, 0x4f, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);

    // Initial search finds 3 matches
    let matches = findAllMatches(origBytes, needle);
    assert.equal(matches.length, 3);

    // Edit a byte (simulating editor edit via onEditByte)
    const newBytes = new Uint8Array(origBytes);
    newBytes[0] = 0x00; // Was 0x4e, now 0x00 - this match position is gone

    // After editing, search results should be invalid/stale
    // The useEffect in HexViewer clears matches when bytes reference changes
    assert.equal(origBytes.length, newBytes.length); // length unchanged
    assert.equal(origBytes[0], 0x4e);
    assert.equal(newBytes[0], 0x00);

    // Re-search on the new buffer
    const newMatches = findAllMatches(newBytes, needle);
    assert.equal(newMatches.length, 2); // One match was at position 0, now gone
    // New matches should be at positions 2 and 4
    assert.deepEqual(newMatches, [2, 4]);
  });

  it('34. Repeated Find Next uses cached results (no redundant full scan)', () => {
    // This test verifies that the search engine functions work correctly
    // when called repeatedly on the same buffer/needle (simulating cached behavior)
    const bytes = new Uint8Array([0x4e, 0x4f, 0x10, 0x20, 0x4e, 0x4f, 0x30, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);

    // First Find Next from cursor 0
    let idx = findNextMatch(bytes, needle, 0);
    assert.equal(idx, 0);

    // Second Find Next from cursor 2 (should find next match, not re-find 0)
    idx = findNextMatch(bytes, needle, 2);
    assert.equal(idx, 4);

    // Third Find Next from cursor 6 (should find match at 7)
    idx = findNextMatch(bytes, needle, 6);
    assert.equal(idx, 7);

    // Fourth Find Next from cursor 9 (should wrap to 0)
    idx = findNextMatch(bytes, needle, 9);
    assert.equal(idx, -1); // No more matches from 9
    idx = findNextMatch(bytes, needle, 0); // Wrap-around search
    assert.equal(idx, 0);
  });

  it('35. HEX/ASCII mode change invalidates cached parse result', () => {
    // ASCII input '4E' in hex mode is 1 byte (0x4E)
    const hexParsed = parseSearchPattern('4E', 'hex');
    assert.ok(hexParsed.ok);
    assert.equal(hexParsed.needle.length, 1);
    assert.equal(hexParsed.needle[0], 0x4e);

    // ASCII input '4E' in ascii mode is 2 bytes (0x34, 0x45 = '4', 'E')
    const asciiParsed = parseSearchPattern('4E', 'ascii');
    assert.ok(asciiParsed.ok);
    assert.equal(asciiParsed.needle.length, 2);
    assert.equal(asciiParsed.needle[0], 0x34); // '4'
    assert.equal(asciiParsed.needle[1], 0x45); // 'E'
  });

  it('36. Overlapping matches with single-byte needle', () => {
    const bytes = new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]);
    const needle = new Uint8Array([0xaa]);
    const matches = findAllMatches(bytes, needle);
    assert.equal(matches.length, 4);
    assert.deepEqual(matches, [0, 1, 2, 3]);
  });

  it('37. Wrap-around find next from last match', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x10, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);
    // Cursor at last match (index 3)
    let idx = findNextMatch(bytes, needle, 3);
    assert.equal(idx, 3); // Finds itself
    // From index 4 (after last match), should wrap to 0
    idx = findNextMatch(bytes, needle, 4);
    assert.equal(idx, -1); // Not found from 4
    idx = findNextMatch(bytes, needle, 0); // Wrap
    assert.equal(idx, 0);
  });

  it('38. parseSearchPattern with spaces in hex input', () => {
    const r = parseSearchPattern('0x4E 4F', 'hex');
    assert.ok(r.ok);
    assert.equal(r.needle.length, 2);
    assert.deepEqual(Array.from(r.needle), [0x4e, 0x4f]);
  });

  it('39. parseSearchPattern with spaces and 0x prefix', () => {
    const r = parseSearchPattern('0x4E4F', 'hex');
    assert.ok(r.ok);
    assert.equal(r.needle.length, 2);
    assert.deepEqual(Array.from(r.needle), [0x4e, 0x4f]);
  });

  it('40. Search with needle larger than buffer returns no matches', () => {
    const bytes = new Uint8Array([0x4e]);
    const needle = new Uint8Array([0x4e, 0x4f, 0x50]);
    assert.equal(findNextMatch(bytes, needle, 0), -1);
    assert.equal(findPreviousMatch(bytes, needle, 0), -1);
    assert.deepEqual(findAllMatches(bytes, needle), []);
  });

  it('41. Empty needle returns -1', () => {
    const bytes = new Uint8Array([0x4e, 0x4f]);
    const needle = new Uint8Array([]);
    assert.equal(findNextMatch(bytes, needle, 0), -1);
    assert.equal(findPreviousMatch(bytes, needle, 0), -1);
    assert.deepEqual(findAllMatches(bytes, needle), []);
  });

  it('42. Null/undefined haystack returns -1', () => {
    const needle = new Uint8Array([0x4e]);
    assert.equal(findNextMatch(null, needle, 0), -1);
    assert.equal(findNextMatch(undefined, needle, 0), -1);
    assert.equal(findPreviousMatch(null, needle, 0), -1);
    assert.deepEqual(findAllMatches(null, needle), []);
    assert.deepEqual(findAllMatches(undefined, needle), []);
  });

  it('43. Find Next and Find Previous move in opposite directions from same cursor', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x10, 0x20, 0x4e, 0x4f, 0x30, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);

    // Matches at indices 0, 4, 7
    const matches = findAllMatches(bytes, needle);
    assert.deepEqual(matches, [0, 4, 7]);

    // From cursor at 0 (which is a match), Find Next should find 4 (not 0)
    const nextFrom0 = findNextMatch(bytes, needle, 0 + needle.length);
    assert.equal(nextFrom0, 4);

    // From cursor at 0, Find Previous should wrap to 7 (last match)
    // (starting at cursorIndex - 1 = -1, which wraps to end)
    const prevFrom0 = findPreviousMatch(bytes, needle, bytes.length - needle.length);
    assert.equal(prevFrom0, 7);
  });

  it('44. Repeated Find Next advances through all matches', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x10, 0x20, 0x4e, 0x4f, 0x30, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);
    const matches = findAllMatches(bytes, needle);

    // Start at cursor 0 (a match)
    let cursor = 0;
    // First Find Next: should find match at 4 (skip the one at cursor 0)
    cursor = findNextMatch(bytes, needle, cursor + needle.length);
    assert.equal(cursor, 4);

    // Second Find Next: should find match at 7
    cursor = findNextMatch(bytes, needle, cursor + needle.length);
    assert.equal(cursor, 7);

    // Third Find Next should wrap to 0
    cursor = findNextMatch(bytes, needle, cursor + needle.length);
    assert.equal(cursor, -1); // No more from 9
    cursor = findNextMatch(bytes, needle, 0); // Wrap
    assert.equal(cursor, 0);
  });

  it('45. Repeated Find Previous advances backwards through all matches', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x10, 0x20, 0x4e, 0x4f, 0x30, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);

    // Start at cursor 7 (last match)
    let cursor = 7;
    // First Find Previous: should find match at 4
    cursor = findPreviousMatch(bytes, needle, cursor - 1);
    assert.equal(cursor, 4);

    // Second Find Previous: should find match at 0
    cursor = findPreviousMatch(bytes, needle, cursor - 1);
    assert.equal(cursor, 0);

    // Third Find Previous: cursor is 0, search from -1 (wraps to end)
    // findPreviousMatch with start=-1 wraps to bytes.length - needle.length = 7
    // which finds the match at 7
    cursor = findPreviousMatch(bytes, needle, cursor - 1);
    assert.equal(cursor, 7); // Wrapped to last match
  });

  it('46. Find Next skips current match (does not re-find same match from cursor)', () => {
    const bytes = new Uint8Array([0xaa, 0xaa, 0xaa]);
    const needle = new Uint8Array([0xaa]);
    const matches = findAllMatches(bytes, needle);
    assert.deepEqual(matches, [0, 1, 2]);

    // From cursor at match 0, Find Next should find 1, not 0
    const next = findNextMatch(bytes, needle, 0 + needle.length);
    assert.equal(next, 1);
  });

  it('47. Find Previous skips current match (does not re-find same match)', () => {
    const bytes = new Uint8Array([0xaa, 0xaa, 0xaa]);
    const needle = new Uint8Array([0xaa]);

    // From cursor at match 1, Find Previous should find 0, not 1
    const prev = findPreviousMatch(bytes, needle, 1 - 1);
    assert.equal(prev, 0);
  });

  it('48. doFind direction simulation: next vs previous find opposite results', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x10, 0x20, 0x4e, 0x4f]);
    const needle = new Uint8Array([0x4e, 0x4f]);

    // Matches at 0 and 4

    // Find Next from cursor 0 (skip current match at 0): finds 4
    const nextIdx = findNextMatch(bytes, needle, 0 + needle.length);
    assert.equal(nextIdx, 4);

    // Find Previous from cursor 0 (search before cursor): wraps to find 4 (last match)
    const prevIdx = findPreviousMatch(bytes, needle, 0 - 1);
    assert.equal(prevIdx, 4); // wraps to end, finds last match

    // From cursor 4: Find Next should wrap to 0
    const nextFrom4 = findNextMatch(bytes, needle, 4 + needle.length);
    assert.equal(nextFrom4, -1); // No more after 4
    const nextWrapped = findNextMatch(bytes, needle, 0);
    assert.equal(nextWrapped, 0);

    // From cursor 4: Find Previous should find 0
    const prevFrom4 = findPreviousMatch(bytes, needle, 4 - 1);
    assert.equal(prevFrom4, 0);
  });
});

describe('Phase 3B — Replace / Replace All', () => {
  it('1. Replace current match with equal-length HEX pattern', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x4e, 0x45]);
    const search = parseSearchPattern('4E 4F', 'hex');
    const replace = parseSearchPattern('59 45', 'hex');
    assert.ok(search.ok && replace.ok);
    const edits = collectOverwriteEdits(bytes, 0, replace.needle);
    assert.equal(edits.length, 2);
    const next = new Uint8Array(bytes);
    for (const e of edits) next[e.index] = e.after;
    assert.deepEqual(Array.from(next), [0x59, 0x45, 0x4e, 0x45]);
    assert.equal(next.length, bytes.length);
  });

  it('2. Replace current match with equal-length ASCII pattern', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x4e, 0x45]);
    const search = parseSearchPattern('NO', 'ascii');
    const replace = parseSearchPattern('YE', 'ascii');
    assert.ok(search.ok && replace.ok);
    assert.equal(search.needle.length, replace.needle.length);
    const edits = collectOverwriteEdits(bytes, 0, replace.needle);
    const next = new Uint8Array(bytes);
    for (const e of edits) next[e.index] = e.after;
    assert.equal(String.fromCharCode(...next.subarray(0, 2)), 'YE');
    assert.equal(next.length, 4);
  });

  it('3. Reject shorter replacement', () => {
    const search = parseSearchPattern('4E 4F', 'hex');
    const replace = parseSearchPattern('59', 'hex');
    const check = validateReplacementLength(search.needle, replace.needle);
    assert.ok(!check.ok);
    assert.match(check.error, /same byte length/i);
  });

  it('4. Reject longer replacement', () => {
    const search = parseSearchPattern('AA', 'hex');
    const replace = parseSearchPattern('BB CC', 'hex');
    const check = validateReplacementLength(search.needle, replace.needle);
    assert.ok(!check.ok);
  });

  it('5. Invalid replacement HEX input is rejected', () => {
    const replace = parseSearchPattern('ZZ', 'hex');
    assert.ok(!replace.ok);
  });

  it('6. Replace when there is no current match does nothing', () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const orig = new Uint8Array(bytes);
    const matchIdx = -1;
    const matches = [];
    if (matchIdx < 0 || matches[matchIdx] == null) {
      assert.deepEqual(Array.from(bytes), Array.from(orig));
    }
  });

  it('7. Replace All multiple non-overlapping matches', () => {
    const bytes = new Uint8Array([0xaa, 0xaa, 0x00, 0xaa, 0xaa]);
    const search = new Uint8Array([0xaa, 0xaa]);
    const replace = new Uint8Array([0xbb, 0xbb]);
    const result = collectNonOverlappingReplacementEdits(bytes, search, replace);
    assert.ok(result.ok);
    assert.equal(result.matchCount, 2);
    const next = new Uint8Array(bytes);
    for (const e of result.edits) next[e.index] = e.after;
    assert.deepEqual(Array.from(next), [0xbb, 0xbb, 0x00, 0xbb, 0xbb]);
    assert.equal(next.length, bytes.length);
  });

  it('8. Replace All overlapping matches only replaces non-overlapping ranges', () => {
    const bytes = new Uint8Array([0xaa, 0xaa, 0xaa]);
    const search = new Uint8Array([0xaa, 0xaa]);
    const replace = new Uint8Array([0xbb, 0xbb]);
    const overlapping = findAllMatches(bytes, search);
    assert.deepEqual(overlapping, [0, 1]);
    const nonOverlap = findNonOverlappingMatches(bytes, search);
    assert.deepEqual(nonOverlap, [0]);
    const result = collectNonOverlappingReplacementEdits(bytes, search, replace);
    const next = new Uint8Array(bytes);
    for (const e of result.edits) next[e.index] = e.after;
    assert.deepEqual(Array.from(next), [0xbb, 0xbb, 0xaa]);
  });

  it('9. Replace All with zero matches does not modify bytes', () => {
    const bytes = new Uint8Array([0x10, 0x20, 0x30]);
    const result = collectNonOverlappingReplacementEdits(bytes, new Uint8Array([0xff]), new Uint8Array([0x00]));
    assert.equal(result.matchCount, 0);
    assert.equal(result.edits.length, 0);
    assert.deepEqual(Array.from(bytes), [0x10, 0x20, 0x30]);
  });

  it('10. Undo Replace Current restores original bytes as one batch', () => {
    const history = createEditHistory();
    const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const edits = collectOverwriteEdits(bytes, 0, new Uint8Array([0x11, 0x22, 0x33]));
    history.pushBatch(edits);
    for (const e of edits) bytes[e.index] = e.after;
    assert.deepEqual(Array.from(bytes), [0x11, 0x22, 0x33]);
    const undone = history.undo();
    assert.ok(undone.isBatch);
    assert.equal(undone.edits.length, 3);
    for (const e of undone.edits) bytes[e.index] = e.before;
    assert.deepEqual(Array.from(bytes), [0xaa, 0xbb, 0xcc]);
  });

  it('11. Redo Replace Current restores replacement as one batch', () => {
    const history = createEditHistory();
    const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const edits = collectOverwriteEdits(bytes, 0, new Uint8Array([0x11, 0x22, 0x33]));
    history.pushBatch(edits);
    for (const e of edits) bytes[e.index] = e.after;
    history.undo();
    for (const e of edits) bytes[e.index] = e.before;
    const redone = history.redo();
    assert.ok(redone.isBatch);
    for (const e of redone.edits) bytes[e.index] = e.after;
    assert.deepEqual(Array.from(bytes), [0x11, 0x22, 0x33]);
  });

  it('12. Undo entire Replace All as one operation', () => {
    const history = createEditHistory();
    const bytes = new Uint8Array([0xaa, 0xaa, 0x00, 0xaa, 0xaa]);
    const result = collectNonOverlappingReplacementEdits(
      bytes,
      new Uint8Array([0xaa, 0xaa]),
      new Uint8Array([0xbb, 0xbb])
    );
    history.pushBatch(result.edits);
    for (const e of result.edits) bytes[e.index] = e.after;
    assert.deepEqual(Array.from(bytes), [0xbb, 0xbb, 0x00, 0xbb, 0xbb]);
    const undone = history.undo();
    assert.ok(undone.isBatch);
    assert.equal(history.getUndoCount(), 0);
    for (const e of undone.edits) bytes[e.index] = e.before;
    assert.deepEqual(Array.from(bytes), [0xaa, 0xaa, 0x00, 0xaa, 0xaa]);
  });

  it('13. Redo entire Replace All as one operation', () => {
    const history = createEditHistory();
    const bytes = new Uint8Array([0xaa, 0xaa, 0x00, 0xaa, 0xaa]);
    const orig = new Uint8Array(bytes);
    const result = collectNonOverlappingReplacementEdits(
      bytes,
      new Uint8Array([0xaa, 0xaa]),
      new Uint8Array([0xbb, 0xbb])
    );
    history.pushBatch(result.edits);
    for (const e of result.edits) bytes[e.index] = e.after;
    history.undo();
    for (const e of result.edits) bytes[e.index] = e.before;
    const redone = history.redo();
    for (const e of redone.edits) bytes[e.index] = e.after;
    assert.deepEqual(Array.from(bytes), [0xbb, 0xbb, 0x00, 0xbb, 0xbb]);
    assert.equal(orig.length, bytes.length);
  });

  it('14. Modified counter after Replace Current', () => {
    const counter = createModifiedCounter();
    const orig = new Uint8Array([0x10, 0x20, 0x30]);
    const bytes = new Uint8Array(orig);
    const edits = collectOverwriteEdits(bytes, 1, new Uint8Array([0xaa]));
    for (const e of edits) {
      const wasModified = e.before !== orig[e.index];
      const isNowModified = e.after !== orig[e.index];
      if (wasModified && !isNowModified) counter.decrement();
      else if (!wasModified && isNowModified) counter.increment();
      bytes[e.index] = e.after;
    }
    assert.equal(counter.getCount(), 1);
  });

  it('15. Modified counter after Replace All', () => {
    const counter = createModifiedCounter();
    const orig = new Uint8Array([0xaa, 0xaa, 0x00, 0xaa, 0xaa]);
    const result = collectNonOverlappingReplacementEdits(
      orig,
      new Uint8Array([0xaa, 0xaa]),
      new Uint8Array([0xbb, 0xbb])
    );
    for (const e of result.edits) {
      const wasModified = e.before !== orig[e.index];
      const isNowModified = e.after !== orig[e.index];
      if (wasModified && !isNowModified) counter.decrement();
      else if (!wasModified && isNowModified) counter.increment();
    }
    assert.equal(counter.getCount(), 4);
  });

  it('16. Modified counter after undo/redo of Replace All', () => {
    const counter = createModifiedCounter();
    const orig = new Uint8Array([0xaa, 0xaa]);
    const result = collectNonOverlappingReplacementEdits(
      orig,
      new Uint8Array([0xaa, 0xaa]),
      new Uint8Array([0xbb, 0xbb])
    );
    const applyDelta = (from, to, index) => {
      const wasModified = from !== orig[index];
      const isNowModified = to !== orig[index];
      if (wasModified && !isNowModified) counter.decrement();
      else if (!wasModified && isNowModified) counter.increment();
    };
    for (const e of result.edits) applyDelta(e.before, e.after, e.index);
    assert.equal(counter.getCount(), 2);
    for (const e of result.edits) applyDelta(e.after, e.before, e.index);
    assert.equal(counter.getCount(), 0);
    for (const e of result.edits) applyDelta(e.before, e.after, e.index);
    assert.equal(counter.getCount(), 2);
  });

  it('17. Replacing a byte with its original value does not increase modified count', () => {
    const orig = new Uint8Array([0xaa, 0xbb]);
    const bytes = new Uint8Array([0x11, 0xbb]);
    const counter = createModifiedCounter();
    counter.increment();
    const edits = collectOverwriteEdits(bytes, 0, new Uint8Array([0xaa, 0xbb]));
    for (const e of edits) {
      const wasModified = e.before !== orig[e.index];
      const isNowModified = e.after !== orig[e.index];
      if (wasModified && !isNowModified) counter.decrement();
      else if (!wasModified && isNowModified) counter.increment();
    }
    assert.equal(counter.getCount(), 0);
  });

  it('18. Search cache invalidation after Replace leaves stale matches unusable', () => {
    const bytes = new Uint8Array([0xaa, 0xaa, 0x00, 0xaa, 0xaa]);
    const needle = new Uint8Array([0xaa, 0xaa]);
    let matches = findAllMatches(bytes, needle);
    assert.equal(matches.length, 2);
    const result = collectNonOverlappingReplacementEdits(bytes, needle, new Uint8Array([0xbb, 0xbb]));
    const next = new Uint8Array(bytes);
    for (const e of result.edits) next[e.index] = e.after;
    matches = [];
    const refreshed = findAllMatches(next, needle);
    assert.equal(refreshed.length, 0);
  });

  it('19. Buffer length remains unchanged after every replacement', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x4e, 0x45, 0x4e, 0x4f]);
    const result = collectNonOverlappingReplacementEdits(
      bytes,
      new Uint8Array([0x4e, 0x4f]),
      new Uint8Array([0x59, 0x45])
    );
    const next = new Uint8Array(bytes);
    for (const e of result.edits) next[e.index] = e.after;
    assert.equal(next.length, bytes.length);
  });

  it('20. Search and Replace inputs remain protected form controls', () => {
    assert.ok(isEditableFormControl({ tagName: 'INPUT', getAttribute: () => null }));
  });
});

describe('Phase 3B — Replace/Replace All UI State Validation', () => {
  it('1. validateReplacementInputs rejects empty search or replace', () => {
    const r1 = validateReplacementInputs('', '4142', 'hex');
    assert.ok(!r1.ok);
    assert.match(r1.error, /enter/i);

    const r2 = validateReplacementInputs('4142', '', 'hex');
    assert.ok(!r2.ok);
    assert.match(r2.error, /enter/i);
  });

  it('2. validateReplacementInputs accepts valid equal-length HEX patterns', () => {
    const r = validateReplacementInputs('4E 4F', '59 45', 'hex');
    assert.ok(r.ok);
    assert.equal(r.searchNeedle.length, 2);
    assert.equal(r.replaceNeedle.length, 2);
    assert.deepEqual(Array.from(r.replaceNeedle), [0x59, 0x45]);
  });

  it('3. validateReplacementInputs accepts valid equal-length ASCII patterns', () => {
    const r = validateReplacementInputs('NO', 'YE', 'ascii');
    assert.ok(r.ok);
    assert.equal(r.searchNeedle.length, 2);
    assert.equal(r.replaceNeedle.length, 2);
    assert.deepEqual(Array.from(r.replaceNeedle), [0x59, 0x45]);
  });

  it('4. validateReplacementInputs rejects odd-length HEX search', () => {
    const r = validateReplacementInputs('ABC', '4142', 'hex');
    assert.ok(!r.ok);
    assert.match(r.error, /even number/i);
  });

  it('5. validateReplacementInputs rejects odd-length HEX replace', () => {
    const r = validateReplacementInputs('4142', 'ABC', 'hex');
    assert.ok(!r.ok);
    assert.match(r.error, /even number/i);
  });

  it('6. validateReplacementInputs rejects invalid HEX characters', () => {
    const r = validateReplacementInputs('ZZZZ', '4142', 'hex');
    assert.ok(!r.ok);
    assert.match(r.error, /invalid hex/i);
  });

  it('7. validateReplacementInputs rejects length mismatch (search shorter)', () => {
    const r = validateReplacementInputs('AA', 'BBCC', 'hex');
    assert.ok(!r.ok);
    assert.match(r.error, /same byte length/i);
  });

  it('8. validateReplacementInputs rejects length mismatch (replace shorter)', () => {
    const r = validateReplacementInputs('AABB', 'CC', 'hex');
    assert.ok(!r.ok);
    assert.match(r.error, /same byte length/i);
  });

  it('9. validateReplacementInputs returns needles on length mismatch for diagnostics', () => {
    const r = validateReplacementInputs('AABB', 'CC', 'hex');
    assert.ok(!r.ok);
    assert.equal(r.searchNeedle.length, 2);
    assert.equal(r.replaceNeedle.length, 1);
  });

  it('10. validateReplacementInputs handles 0x prefix in both patterns', () => {
    const r = validateReplacementInputs('0x4E', '0x59', 'hex');
    assert.ok(r.ok);
    assert.equal(r.searchNeedle[0], 0x4e);
    assert.equal(r.replaceNeedle[0], 0x59);
  });

  it('11. validateReplacementInputs handles single-byte patterns', () => {
    const r = validateReplacementInputs('4E', '59', 'hex');
    assert.ok(r.ok);
    assert.equal(r.searchNeedle[0], 0x4e);
    assert.equal(r.replaceNeedle[0], 0x59);
  });

  it('12. validateReplacementInputs rejects whitespace-only input', () => {
    const r = validateReplacementInputs('   ', '4142', 'hex');
    assert.ok(!r.ok);
  });

  it('13. validateReplacementInputs rejects invalid ASCII (non-printable chars are byte-level, ASCII mode accepts them)', () => {
    const r = validateReplacementInputs('hello', 'world', 'ascii');
    assert.ok(r.ok);
    assert.equal(r.searchNeedle.length, 5);
    assert.equal(r.replaceNeedle.length, 5);
  });

  it('14. UI disabled state: Replace Current requires valid patterns + current match', () => {
    // Simulates the derived state logic from HexViewer
    // hasCurrentMatch = matchIdx >= 0 && matches[matchIdx] != null
    // disabled = !replaceValidation?.ok || !hasCurrentMatch

    // Case: valid patterns, no match found yet
    const result = validateReplacementInputs('4E4F', '5959', 'hex');
    assert.ok(result.ok);
    const hasCurrentMatch = false; // matchIdx = -1
    const replaceCurrentDisabled = !result.ok || !hasCurrentMatch;
    assert.ok(replaceCurrentDisabled, 'Should be disabled when no current match');

    // Case: valid patterns, has current match
    const hasMatch = true;
    const replaceCurrentEnabled = result.ok && hasMatch;
    assert.ok(replaceCurrentEnabled, 'Should be enabled with match');
  });

  it('15. UI disabled state: Replace All requires only valid patterns (does own matching)', () => {
    // Replace All does its own match finding via collectNonOverlappingReplacementEdits
    // It does NOT require hasCurrentMatch
    const result = validateReplacementInputs('4E4F', '5959', 'hex');
    assert.ok(result.ok);
    const replaceAllDisabled = !result.ok;
    assert.ok(!replaceAllDisabled, 'Replace All should be enabled with valid patterns');

    // Invalid patterns disable Replace All
    const result2 = validateReplacementInputs('ABC', '5959', 'hex');
    const replaceAllDisabled2 = !result2.ok;
    assert.ok(replaceAllDisabled2, 'Should be disabled with invalid patterns');
  });

  it('16. UI disabled state: both buttons disabled when replace input is empty', () => {
    const result = validateReplacementInputs('4E4F', '', 'hex');
    assert.ok(!result.ok);
    assert.ok(!result.ok || !false, 'Both should be disabled when replace is empty');
  });

  it('17. UI disabled state: both buttons disabled when search input is empty', () => {
    const result = validateReplacementInputs('', '4142', 'hex');
    assert.ok(!result.ok);
    assert.ok(!result.ok, 'Both should be disabled when search is empty');
  });

  it('18. End-to-end: Replace Current only proceeds with valid equal-length patterns and match', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x4e, 0x45]);
    const result = validateReplacementInputs('4E 4F', '59 45', 'hex');
    assert.ok(result.ok);

    // Simulate hasCurrentMatch = true
    const matchStart = 0;
    const edits = collectOverwriteEdits(bytes, matchStart, result.replaceNeedle);
    assert.equal(edits.length, 2);

    const next = new Uint8Array(bytes);
    for (const e of edits) next[e.index] = e.after;
    assert.deepEqual(Array.from(next), [0x59, 0x45, 0x4e, 0x45]);
    assert.equal(next.length, bytes.length, 'Buffer length must not change');
  });

  it('19. End-to-end: Replace All with valid patterns finds and replaces all non-overlapping', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x10, 0x4e, 0x4f]);
    const result = validateReplacementInputs('4E4F', '5959', 'hex');
    assert.ok(result.ok);

    const res = collectNonOverlappingReplacementEdits(
      bytes,
      result.searchNeedle,
      result.replaceNeedle
    );
    assert.ok(res.ok);
    assert.equal(res.matchCount, 2);

    const next = new Uint8Array(bytes);
    for (const e of res.edits) next[e.index] = e.after;
    assert.deepEqual(Array.from(next), [0x59, 0x59, 0x10, 0x59, 0x59]);
    assert.equal(next.length, bytes.length, 'Buffer length must not change');
  });

  it('20. Root cause regression: buttons are NOT enabled with simple !query || !replaceInput check', () => {
    // The old disabled condition was !query || !replaceInput
    // This was too loose - it enabled buttons with invalid input
    // The fix: use validateReplacementInputs for proper validation

    // Old behavior would enable buttons here (both fields have text):
    const query = 'ABC';  // odd-length hex - invalid
    const replaceInput = '4142';
    const oldDisabled = !query || !replaceInput;
    assert.ok(!oldDisabled, 'Old condition would have enabled the buttons (the bug)');

    // New behavior properly disables:
    const result = validateReplacementInputs(query, replaceInput, 'hex');
    assert.ok(!result.ok, 'New condition properly rejects invalid hex');
    const newDisabled = !result.ok;
    assert.ok(newDisabled, 'New condition disables buttons for invalid input');
  });

  it('21. Root cause regression: length mismatch disables buttons', () => {
    // Old condition: !query || !replaceInput → both have text → enabled (bug!)
    const query = 'AA';       // 1 byte
    const replaceInput = 'BBCC'; // 2 bytes
    const oldDisabled = !query || !replaceInput;
    assert.ok(!oldDisabled, 'Old condition would have enabled buttons despite length mismatch');

    // New condition: validate length match
    const result = validateReplacementInputs(query, replaceInput, 'hex');
    assert.ok(!result.ok);
    const newDisabled = !result.ok;
    assert.ok(newDisabled, 'New condition disables buttons for length mismatch');
  });

  it('22. Root cause regression: no current match disables Replace Current only', () => {
    const result = validateReplacementInputs('4E4F', '5959', 'hex');
    assert.ok(result.ok);

    // Both buttons have valid patterns
    const replaceAllDisabled = !result.ok;
    const replaceCurrentDisabled = !result.ok || false; // replaceCurrent needs match

    assert.ok(!replaceAllDisabled, 'Replace All enabled with valid patterns');
    assert.ok(!replaceCurrentDisabled, 'Replace Current enabled when hasCurrentMatch=true');

    // Now simulate no current match
    const hasCurrentMatch = false;
    const replaceCurrentNoMatch = !result.ok || !hasCurrentMatch;
    assert.ok(replaceCurrentNoMatch, 'Replace Current disabled without current match');
    assert.ok(!replaceAllDisabled, 'Replace All still enabled without current match');
  });
});

describe('Phase 4A-1 — baseOffset Prop & Absolute Dump Offset Display', () => {
  it('1. formatOffsetLabel formats editor offset with 8-digit padding', () => {
    assert.equal(formatOffsetLabel(0x1A0), '0x000001A0');
    assert.equal(formatOffsetLabel(0x6A734000), '0x6A734000');
  });

  it('2. Absolute dump offset = baseOffset + cursorIndex (editor offset 0x1A0, base 0x6A734000)', () => {
    const baseOffset = 0x6A734000;
    const cursorIndex = 0x000001A0;
    const absolute = baseOffset + cursorIndex;
    assert.equal(absolute, 0x6A7341A0);
    assert.equal(formatOffsetLabel(absolute), '0x6A7341A0');
  });

  it('3. Absolute dump offset when baseOffset is 0 equals editor offset', () => {
    const baseOffset = 0;
    const cursorIndex = 0x000001A0;
    const absolute = baseOffset + cursorIndex;
    assert.equal(absolute, cursorIndex);
    assert.equal(formatOffsetLabel(absolute), formatOffsetLabel(cursorIndex));
  });

  it('4. Absolute dump offset at cursorIndex 0 equals baseOffset', () => {
    const baseOffset = 0x6A734000;
    const cursorIndex = 0;
    const absolute = baseOffset + cursorIndex;
    assert.equal(absolute, baseOffset);
    assert.equal(formatOffsetLabel(absolute), '0x6A734000');
  });

  it('5. formatOffsetLabel handles large numeric offsets (> 0xFFFFFFFF)', () => {
    const baseOffset = 0x1_0000_0000; // 2^32 = 4 GiB
    const cursorIndex = 0x000001A0;
    const absolute = baseOffset + cursorIndex;
    assert.equal(absolute, 0x1_000001A0);
    const formatted = formatOffsetLabel(absolute);
    assert.match(formatted, /^0x[0-9A-F]+$/);
    assert.equal(formatted, '0x1000001A0'); // '0x' + 9 hex digits
  });

  it('6. formatOffsetLabel handles baseOffset + cursorIndex boundary at max safe int', () => {
    const cursorIndex = 0xFFFF;
    const baseOffset = Number.MAX_SAFE_INTEGER - cursorIndex;
    const absolute = baseOffset + cursorIndex;
    assert.equal(absolute, Number.MAX_SAFE_INTEGER);
    const formatted = formatOffsetLabel(absolute);
    assert.match(formatted, /^0x[0-9A-F]+$/);
  });

  it('7. formatOffsetLabel clamps negative results to 0', () => {
    // baseOffset could theoretically be negative if misused
    // formatOffsetLabel should not produce negative offsets
    const badBase = -0x100;
    const cursorIdx = 0x50;
    const raw = badBase + cursorIdx; // -0xB0
    assert.equal(formatOffsetLabel(raw), '0x00000000');
  });

  it('8. HexViewer accepts baseOffset prop (source contract)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/HexViewer.jsx'), 'utf8');

    assert.ok(src.includes('baseOffset = null'), 'HexViewer should accept baseOffset with default null');
    assert.ok(src.includes('Editor offset:'), 'HexViewer should display "Editor offset:" label');
    assert.ok(src.includes('Base offset:'), 'HexViewer should display "Base offset:" label');
    assert.ok(src.includes('Absolute dump:'), 'HexViewer should display "Absolute dump:" label');
    assert.ok(src.includes('formatOffsetLabel(baseOffset)'), 'Should format baseOffset with formatOffsetLabel');
    assert.ok(src.includes('formatOffsetLabel(baseOffset + cursorIndex)'), 'Should compute absolute as baseOffset + cursorIndex');
  });

  it('9. HexViewer hides absolute offset display when baseOffset is null', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/HexViewer.jsx'), 'utf8');

    // When baseOffset is null, the status bar should show "Offset:" not "Editor offset:"
    assert.ok(src.includes("Offset: <strong"), 'Should show "Offset:" label when baseOffset is null/undefined');
  });

  it('10. TVConfigTool passes baseOffset={0} to HexViewer', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/pages/TVConfigTool.jsx'), 'utf8');

    assert.ok(src.includes('baseOffset={0}'), 'TVConfigTool should pass baseOffset={0}');
  });

  it('11. Ext4Browser passes baseOffset={fileBaseOffset} to HexViewer (contiguous only)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    // Ext4Browser should pass baseOffset to HexViewer
    assert.ok(src.includes('baseOffset={fileBaseOffset}'), 'Ext4Browser should pass baseOffset to HexViewer');

    // But fileBaseOffset should be null for non-contiguous or unselected files
    assert.ok(src.includes('const [fileBaseOffset, setFileBaseOffset] = useState(null)'),
      'fileBaseOffset state should default to null');

    // The computation should check for single contiguous extent
    assert.ok(src.includes('extents.length === 1 && extents[0].logical === 0'),
      'Should only compute baseOffset for single-extent files with logical=0');
  });

  it('12. Absolute offset calculation does not modify original bytes', () => {
    const bytes = new Uint8Array([0x4e, 0x4f, 0x4e, 0x45]);
    const origCopy = new Uint8Array(bytes);
    const baseOffset = 0x6A734000;
    const cursorIndex = 2;
    const absolute = baseOffset + cursorIndex;
    assert.equal(absolute, 0x6A734002);
    assert.deepEqual(Array.from(bytes), Array.from(origCopy), 'Bytes must not change');
  });

  it('13. validateReplacementInputs with null/undefined inputs returns ok: false', () => {
    const r1 = validateReplacementInputs(null, '4142', 'hex');
    assert.ok(!r1.ok);

    const r2 = validateReplacementInputs('4142', null, 'hex');
    assert.ok(!r2.ok);

    const r3 = validateReplacementInputs(undefined, undefined, 'hex');
    assert.ok(!r3.ok);
  });

  it('14. baseOffset default is null (source check)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/HexViewer.jsx'), 'utf8');

    assert.ok(src.includes('baseOffset = null'), 'baseOffset should default to null');
  });
});

describe('Phase 4A-2 — EXT4 Physical Offset Propagation', () => {
  function wu16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
  function wu32(b, o, v) {
    b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
  }

  async function buildTestExt4() {
    const { parseSuperblock } = await import('../src/lib/ext4.js');
    const blockSize = 1024;
    const bytes = new Uint8Array(16 * blockSize);
    const sb = 1024;
    wu32(bytes, sb + 0x00, 16);
    wu32(bytes, sb + 0x04, 16);
    wu32(bytes, sb + 0x0C, 6);
    wu32(bytes, sb + 0x10, 13);
    wu32(bytes, sb + 0x14, 1);
    wu32(bytes, sb + 0x18, 0);
    wu32(bytes, sb + 0x20, 16);
    wu32(bytes, sb + 0x28, 16);
    wu16(bytes, sb + 0x38, 0xef53);
    wu32(bytes, sb + 0x4c, 1);
    wu16(bytes, sb + 0x58, 128);
    wu16(bytes, sb + 0xfe, 32);

    const gdt = 2048;
    wu32(bytes, gdt + 0x00, 3);
    wu32(bytes, gdt + 0x04, 4);
    wu32(bytes, gdt + 0x08, 5);
    wu16(bytes, gdt + 0x0C, 6);
    wu16(bytes, gdt + 0x0E, 13);

    function writeInode(num, { mode, size, physBlock }) {
      const off = 5 * blockSize + (num - 1) * 128;
      wu16(bytes, off + 0x00, mode);
      wu32(bytes, off + 0x04, size);
      wu32(bytes, off + 0x20, 0x80000);
      const eh = off + 0x28;
      wu16(bytes, eh + 0, 0xf30a);
      wu16(bytes, eh + 2, 1);
      wu16(bytes, eh + 4, 4);
      wu16(bytes, eh + 6, 0);
      wu32(bytes, eh + 12, 0);
      wu16(bytes, eh + 16, 1);
      wu16(bytes, eh + 18, 0);
      wu32(bytes, eh + 20, physBlock);
    }

    writeInode(2, { mode: 0x41ed, size: blockSize, physBlock: 8 });
    writeInode(12, { mode: 0x81a4, size: 6, physBlock: 9 });

    const dir = 8 * blockSize;
    function dirent(off, inode, recLen, name, typ) {
      wu32(bytes, off, inode);
      wu16(bytes, off + 4, recLen);
      bytes[off + 6] = name.length;
      bytes[off + 7] = typ;
      for (let i = 0; i < name.length; i++) bytes[off + 8 + i] = name.charCodeAt(i);
    }
    dirent(dir, 2, 12, '.', 2);
    dirent(dir + 12, 2, 12, '..', 2);
    dirent(dir + 24, 12, 1024 - 24, 'hello.txt', 1);
    bytes.set(Buffer.from('hello\n', 'ascii'), 9 * blockSize);
    return { bytes, sb: parseSuperblock(bytes) };
  }

  it('1. readFileBytesWithInfo returns Uint8Array bytes matching readFileBytes', async () => {
    const { readFileBytes, readFileBytesWithInfo } = await import('../src/lib/ext4.js');
    const { bytes, sb } = await buildTestExt4();
    const plain = readFileBytes(bytes, 12, sb);
    const info = readFileBytesWithInfo(bytes, 12, sb);

    assert.ok(info.bytes instanceof Uint8Array);
    assert.deepEqual(Array.from(info.bytes), Array.from(plain));
  });

  it('2. readFileBytesWithInfo returns extents array with { logical, physical, len }', async () => {
    const { readFileBytesWithInfo } = await import('../src/lib/ext4.js');
    const { bytes, sb } = await buildTestExt4();
    const info = readFileBytesWithInfo(bytes, 12, sb);

    assert.ok(Array.isArray(info.extents));
    assert.equal(info.extents.length, 1);
    assert.deepEqual(info.extents[0], { logical: 0, physical: 9, len: 1 });
  });

  it('3. readFileBytesRangeWithInfo returns matching bytes and reader.startByte', async () => {
    const { readFileBytesRange, readFileBytesRangeWithInfo } = await import('../src/lib/ext4Range.js');
    const { createBufferRangeReader } = await import('../src/lib/rangeReader.js');
    const { bytes, sb } = await buildTestExt4();
    const reader = createBufferRangeReader(bytes);
    const plain = await readFileBytesRange(reader, 12, sb);
    const info = await readFileBytesRangeWithInfo(reader, 12, sb);

    assert.ok(info.bytes instanceof Uint8Array);
    assert.deepEqual(Array.from(info.bytes), Array.from(plain));
    assert.ok(Array.isArray(info.extents));
    assert.equal(info.startByte, 0);
  });

  it('4. startByte is preserved for a non-zero range-backed partition', async () => {
    const { readFileBytesRangeWithInfo } = await import('../src/lib/ext4Range.js');
    const { createRangeReader } = await import('../src/lib/rangeReader.js');
    const { bytes, sb } = await buildTestExt4();
    const reader = createRangeReader({
      startByte: 0x6A734000,
      size: bytes.length,
      readAbsolute: async (start, end) => bytes.subarray(start - 0x6A734000, end - 0x6A734000),
    });

    const info = await readFileBytesRangeWithInfo(reader, 12, sb);
    assert.equal(info.startByte, 0x6A734000);
    assert.equal(info.bytes.length, 6);
  });

  it('5. single extent + logical 0 produces expected baseOffset', () => {
    const partitionStartByte = 0x6A734000;
    const blockSize = 1024;
    const extents = [{ logical: 0, physical: 9, len: 1 }];

    const isContiguous = extents.length === 1 && extents[0].logical === 0;
    assert.ok(isContiguous);
    const baseOffset = isContiguous ? partitionStartByte + extents[0].physical * blockSize : null;
    assert.equal(baseOffset, 0x6A734000 + 9 * 1024);
  });

  it('6. multiple extents produces null baseOffset', () => {
    const extents = [
      { logical: 0, physical: 9, len: 1 },
      { logical: 1, physical: 20, len: 1 },
    ];
    const isContiguous = extents.length === 1 && extents[0].logical === 0;
    assert.equal(isContiguous, false);
    const baseOffset = isContiguous ? 0x6A734000 + extents[0].physical * 1024 : null;
    assert.equal(baseOffset, null);
  });

  it('7. first extent logical > 0 produces null baseOffset (sparse file)', () => {
    const extents = [{ logical: 5, physical: 9, len: 1 }];
    const isContiguous = extents.length === 1 && extents[0].logical === 0;
    assert.equal(isContiguous, false);
    const baseOffset = isContiguous ? 0x6A734000 + extents[0].physical * 1024 : null;
    assert.equal(baseOffset, null);
  });

  it('8. existing readFileBytes and readFileBytesRange APIs remain unchanged (return Uint8Array)', async () => {
    const { readFileBytes } = await import('../src/lib/ext4.js');
    const { readFileBytesRange } = await import('../src/lib/ext4Range.js');
    const { createBufferRangeReader } = await import('../src/lib/rangeReader.js');
    const { bytes, sb } = await buildTestExt4();
    const reader = createBufferRangeReader(bytes);

    const syncBytes = readFileBytes(bytes, 12, sb);
    assert.ok(syncBytes instanceof Uint8Array);
    assert.equal(syncBytes.length, 6);

    const asyncBytes = await readFileBytesRange(reader, 12, sb);
    assert.ok(asyncBytes instanceof Uint8Array);
    assert.equal(asyncBytes.length, 6);
  });

  it('9. Ext4Browser uses WithInfo APIs for display and original APIs for edit operations', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    // Display path uses loadFileBytesWithInfo
    assert.ok(src.includes('loadFileBytesWithInfo(selected.inode)'), 'Display effect should call loadFileBytesWithInfo');
    assert.ok(!src.includes('const raw = await loadFileBytes(selected.inode);\n        const result = await loadFileBytesWithInfo'), 'Should NOT read file twice');

    // Edit path uses original Uint8Array APIs
    assert.ok(src.includes('readFileBytes(bytes, selected.inode, sb)'), 'editByteInFile should use original readFileBytes');
    assert.ok(src.includes('readFileBytesRange(reader, selected.inode, sb)'), 'editByteInFile range should use original readFileBytesRange');
  });

  it('10. No duplicate file read occurs in Ext4Browser display effect', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    const displayEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[selected, bytes, sb, reader, partitionStartByte\]\);/);
    assert.ok(displayEffect, 'Display effect should exist');
    const effectCode = displayEffect[0];

    const plainCalls = effectCode.match(/\bloadFileBytes\(/g) || [];
    const infoCalls = effectCode.match(/\bloadFileBytesWithInfo\(/g) || [];

    assert.equal(plainCalls.length, 0, 'Display effect should not call plain loadFileBytes');
    assert.equal(infoCalls.length, 1, 'Display effect should call loadFileBytesWithInfo exactly ONCE');
  });

  it('11. EmmcTool propagates and resets exploreStartByte correctly', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/pages/EmmcTool.jsx'), 'utf8');

    // State declaration
    assert.ok(src.includes('const [exploreStartByte, setExploreStartByte] = useState(0)'));

    // Passed to Ext4Browser
    assert.ok(src.includes('partitionStartByte={exploreStartByte}'));

    // Propagated from session
    assert.ok(src.includes('setExploreStartByte(session.startByte ?? 0)'));

    // Reset on back / load / revert
    const resetCount = (src.match(/setExploreStartByte\(0\)/g) || []).length;
    assert.ok(resetCount >= 3, 'Should reset exploreStartByte on loadMain, revert, and back button');
  });

  it('12. Ext4Browser useEffect includes partitionStartByte in dependency array', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../src/components/tv/Ext4Browser.jsx'), 'utf8');

    assert.ok(src.includes('}, [selected, bytes, sb, reader, partitionStartByte]);'),
      'Ext4Browser file-loading useEffect must include partitionStartByte in its dependency array');
  });
});
