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
