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
