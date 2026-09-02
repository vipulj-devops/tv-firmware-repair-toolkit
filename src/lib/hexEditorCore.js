// Pure core logic for hex/ASCII editing, navigation, selection, and undo/redo.

export function clampIndex(index, length) {
  if (length <= 0) return 0;
  const i = Math.floor(index);
  if (i < 0) return 0;
  if (i >= length) return length - 1;
  return i;
}

export function getSelectionRange(anchorIndex, cursorIndex) {
  const a = Math.floor(anchorIndex || 0);
  const c = Math.floor(cursorIndex || 0);
  return {
    start: Math.min(a, c),
    end: Math.max(a, c),
  };
}

export function isIndexSelected(index, anchorIndex, cursorIndex) {
  const { start, end } = getSelectionRange(anchorIndex, cursorIndex);
  return index >= start && index <= end;
}

export function moveCursor({ cursorIndex, anchorIndex, newIndex, length, extendSelection = false }) {
  const clamped = clampIndex(newIndex, length);
  return {
    cursorIndex: clamped,
    anchorIndex: extendSelection ? (anchorIndex ?? clamped) : clamped,
  };
}

export function navigateKey({ key, shiftKey = false, cursorIndex = 0, anchorIndex = 0, length = 0, rowBytes = 16, viewportRows = 16 }) {
  if (length <= 0) return { cursorIndex: 0, anchorIndex: 0 };
  let target = cursorIndex;

  switch (key) {
    case 'ArrowLeft':
      target = cursorIndex - 1;
      break;
    case 'ArrowRight':
      target = cursorIndex + 1;
      break;
    case 'ArrowUp':
      target = cursorIndex - rowBytes;
      break;
    case 'ArrowDown':
      target = cursorIndex + rowBytes;
      break;
    case 'Home':
      target = cursorIndex - (cursorIndex % rowBytes);
      break;
    case 'End': {
      const rowStart = cursorIndex - (cursorIndex % rowBytes);
      target = Math.min(length - 1, rowStart + rowBytes - 1);
      break;
    }
    case 'PageUp':
      target = cursorIndex - rowBytes * viewportRows;
      break;
    case 'PageDown':
      target = cursorIndex + rowBytes * viewportRows;
      break;
    default:
      return { cursorIndex, anchorIndex };
  }

  return moveCursor({
    cursorIndex,
    anchorIndex,
    newIndex: target,
    length,
    extendSelection: shiftKey,
  });
}

export function isByteModified(index, currentBytes, origBytes) {
  if (!currentBytes || !origBytes || index < 0 || index >= currentBytes.length) return false;
  return currentBytes[index] !== origBytes[index];
}

export function getModifiedIndices(currentBytes, origBytes) {
  if (!currentBytes || !origBytes) return new Set();
  const len = Math.min(currentBytes.length, origBytes.length);
  const modified = new Set();
  for (let i = 0; i < len; i++) {
    if (currentBytes[i] !== origBytes[i]) {
      modified.add(i);
    }
  }
  return modified;
}

export function createEditHistory() {
  let undoStack = [];
  let redoStack = [];

  return {
    pushEdit({ index, before, after }) {
      if (before === after) return false;
      undoStack.push({ index, before, after });
      redoStack = [];
      return true;
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    undo() {
      if (undoStack.length === 0) return null;
      const entry = undoStack.pop();
      redoStack.push(entry);
      return { index: entry.index, value: entry.before, entry };
    },
    redo() {
      if (redoStack.length === 0) return null;
      const entry = redoStack.pop();
      undoStack.push(entry);
      return { index: entry.index, value: entry.after, entry };
    },
    clear() {
      undoStack = [];
      redoStack = [];
    },
    getUndoCount() { return undoStack.length; },
    getRedoCount() { return redoStack.length; },
  };
}

export function applyAsciiEdit(index, charCode, currentBytes) {
  if (index < 0 || index >= currentBytes.length) return null;
  const code = charCode & 0xff;
  if (code < 32 || code > 126) return null; // printable ASCII only
  const before = currentBytes[index];
  if (before === code) return null;
  return { index, before, after: code };
}

export function applyHexEdit(index, hexValue, currentBytes) {
  if (index < 0 || index >= currentBytes.length) return null;
  const val = typeof hexValue === 'number' ? (hexValue & 0xff) : parseInt(String(hexValue).replace(/[^0-9a-fA-F]/g, ''), 16);
  if (Number.isNaN(val) || val < 0 || val > 255) return null;
  const before = currentBytes[index];
  if (before === val) return null;
  return { index, before, after: val };
}

export function isEditableFormControl(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName ? String(target.tagName).toUpperCase() : '';
  if (tag === 'INPUT') return true;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'SELECT') return true;
  if (tag === 'BUTTON') return true;
  if (tag === 'A') return true;
  if (target.getAttribute && target.getAttribute('contenteditable') === 'true') return true;
  return false;
}
