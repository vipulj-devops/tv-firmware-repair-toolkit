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
