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

export function isDragMovement(startX, startY, currentX, currentY, threshold = 3) {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return Math.hypot(dx, dy) >= threshold;
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
      undoStack.push({ index, before, after, isBatch: false });
      redoStack = [];
      return true;
    },
    pushBatch(edits) {
      if (!edits || edits.length === 0) return false;
      const filtered = edits.filter((e) => e.before !== e.after);
      if (filtered.length === 0) return false;
      undoStack.push({ edits: filtered, isBatch: true });
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
      if (entry.isBatch) {
        return { isBatch: true, edits: entry.edits };
      }
      return { index: entry.index, value: entry.before, entry };
    },
    redo() {
      if (redoStack.length === 0) return null;
      const entry = redoStack.pop();
      undoStack.push(entry);
      if (entry.isBatch) {
        return { isBatch: true, edits: entry.edits };
      }
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

export function parseOffsetInput(input) {
  if (input == null) return { ok: false, error: 'No input provided.' };
  const trimmed = String(input).trim();
  if (trimmed === '') return { ok: false, error: 'Please enter an offset.' };

  const isHex = /^0[xX][0-9a-fA-F]+$/.test(trimmed);
  const isPlainHex = /^[0-9a-fA-F]+$/.test(trimmed);

  if (isHex) {
    const val = parseInt(trimmed, 16);
    if (Number.isNaN(val)) return { ok: false, error: 'Invalid hexadecimal offset.' };
    return { ok: true, value: val };
  }

  if (isPlainHex) {
    const val = parseInt(trimmed, 16);
    if (Number.isNaN(val)) return { ok: false, error: 'Invalid hexadecimal offset.' };
    return { ok: true, value: val };
  }

  return { ok: false, error: 'Please enter a valid hex offset (e.g. 0x03800000).' };
}

export function clampGotoOffset(offset, length) {
  const i = Math.floor(offset);
  if (i < 0) return { ok: false, error: 'Offset cannot be negative.' };
  if (i >= length) return { ok: false, error: `Offset 0x${i.toString(16).toUpperCase()} is beyond the end of the buffer (length 0x${length.toString(16).toUpperCase()}).` };
  return { ok: true, value: i };
}

export function getRowForOffset(offset, rowBytes = 16) {
  return Math.floor(offset / rowBytes);
}

export function formatOffsetLabel(offset) {
  const o = Math.max(0, Math.floor(offset || 0));
  let hex = o.toString(16).toUpperCase().padStart(8, '0');
  return `0x${hex}`;
}

export function formatByteValue(byteVal) {
  if (byteVal == null || byteVal < 0 || byteVal > 255) return '--';
  return byteVal.toString(16).toUpperCase().padStart(2, '0');
}

export function formatSelectionSize(count) {
  if (count <= 0) return 'Selected: 0 bytes';
  if (count === 1) return 'Selected: 1 byte';
  return `Selected: ${count} bytes`;
}

export function createModifiedCounter() {
  let count = 0;

  return {
    getCount() { return count; },
    increment() { count = Math.max(0, count + 1); },
    decrement() { count = Math.max(0, count - 1); },
    reset(value = 0) { count = Math.max(0, Math.floor(value || 0)); },
    clear() { count = 0; },
  };
}

export function parseSearchPattern(input, mode = 'hex') {
  if (input == null) return { ok: false, error: 'No input provided.', needle: null };
  const trimmed = String(input).trim();
  if (trimmed === '') return { ok: false, error: 'Please enter a search pattern.', needle: null };

  if (mode === 'hex') {
    // Strip whitespace and optional 0x/0X prefix
    let clean = trimmed.replace(/\s+/g, '');
    if (/^0[xX]/.test(clean)) clean = clean.slice(2);
    clean = clean.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 0) return { ok: false, error: 'Invalid hex pattern.', needle: null };
    if (clean.length % 2 !== 0) return { ok: false, error: 'Hex pattern must have an even number of digits.', needle: null };
    const needle = new Uint8Array(clean.length / 2);
    for (let i = 0; i < needle.length; i++) {
      needle[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return { ok: true, error: null, needle, mode: 'hex' };
  }

  // ASCII mode
  const needle = new Uint8Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i++) {
    needle[i] = trimmed.charCodeAt(i) & 0xff;
  }
  return { ok: true, error: null, needle, mode: 'ascii' };
}

export function findNextMatch(haystack, needle, start = 0) {
  if (!haystack || !needle || needle.length === 0) return -1;
  if (needle.length > haystack.length) return -1;
  const end = haystack.length - needle.length;
  for (let i = Math.max(0, start); i <= end; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

export function findPreviousMatch(haystack, needle, start = -1) {
  if (!haystack || !needle || needle.length === 0) return -1;
  if (needle.length > haystack.length) return -1;
  const end = haystack.length - needle.length;
  if (start < 0 || start > end) start = end;
  for (let i = Math.min(start, end); i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

export function findAllMatches(haystack, needle) {
  if (!haystack || !needle || needle.length === 0) return [];
  const results = [];
  let from = 0;
  while (true) {
    const idx = findNextMatch(haystack, needle, from);
    if (idx === -1) break;
    results.push(idx);
    from = idx + 1;
  }
  return results;
}

export function findNonOverlappingMatches(haystack, needle) {
  if (!haystack || !needle || needle.length === 0) return [];
  const results = [];
  let from = 0;
  while (true) {
    const idx = findNextMatch(haystack, needle, from);
    if (idx === -1) break;
    results.push(idx);
    from = idx + needle.length;
  }
  return results;
}

export function validateReplacementLength(searchNeedle, replaceNeedle) {
  if (!searchNeedle || !replaceNeedle) return { ok: false, error: 'Invalid pattern.' };
  if (searchNeedle.length !== replaceNeedle.length) {
    return {
      ok: false,
      error: `Search (${searchNeedle.length} B) and replace (${replaceNeedle.length} B) must have the same byte length.`,
    };
  }
  return { ok: true };
}

export function collectOverwriteEdits(haystack, start, replacement) {
  if (!haystack || !replacement || replacement.length === 0) return [];
  const edits = [];
  for (let i = 0; i < replacement.length; i++) {
    const index = start + i;
    if (index < 0 || index >= haystack.length) break;
    const before = haystack[index];
    const after = replacement[i];
    if (before !== after) edits.push({ index, before, after });
  }
  return edits;
}

export function collectNonOverlappingReplacementEdits(haystack, searchNeedle, replaceNeedle) {
  const lengthCheck = validateReplacementLength(searchNeedle, replaceNeedle);
  if (!lengthCheck.ok) return { ok: false, error: lengthCheck.error, edits: [] };
  const matches = findNonOverlappingMatches(haystack, searchNeedle);
  const edits = [];
  for (const start of matches) {
    edits.push(...collectOverwriteEdits(haystack, start, replaceNeedle));
  }
   return { ok: true, error: null, edits, matchCount: matches.length };
}

export function validateReplacementInputs(searchInput, replaceInput, mode) {
  const searchParsed = parseSearchPattern(searchInput, mode);
  if (!searchParsed.ok) return { ok: false, error: searchParsed.error, searchNeedle: null, replaceNeedle: null };
  const replaceParsed = parseSearchPattern(replaceInput, mode);
  if (!replaceParsed.ok) return { ok: false, error: replaceParsed.error, searchNeedle: null, replaceNeedle: null };
  const lengthCheck = validateReplacementLength(searchParsed.needle, replaceParsed.needle);
  if (!lengthCheck.ok) return { ok: false, error: lengthCheck.error, searchNeedle: searchParsed.needle, replaceNeedle: replaceParsed.needle };
  return { ok: true, error: null, searchNeedle: searchParsed.needle, replaceNeedle: replaceParsed.needle };
}
