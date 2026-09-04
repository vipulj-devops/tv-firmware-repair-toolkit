import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Copy, Check, Save, Search, ChevronUp, ChevronDown, X, Undo, Redo } from 'lucide-react';
import { toHex } from '@/lib/crc32';
import { formatBytes } from '@/lib/binaryUtils';
import { createContiguousOffsetMap, isOffsetMap } from '@/lib/offsetMap';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  clampIndex,
  getSelectionRange,
  isIndexSelected,
  navigateKey,
  createEditHistory,
  isEditableFormControl,
  isDragMovement,
  parseOffsetInput,
  clampGotoOffset,
  formatOffsetLabel,
  formatByteValue,
  formatSelectionSize,
  createModifiedCounter,
  parseSearchPattern,
  findNextMatch,
  findPreviousMatch,
  findAllMatches,
  collectOverwriteEdits,
  collectNonOverlappingReplacementEdits,
  validateReplacementInputs,
} from '@/lib/hexEditorCore';

const ROW_BYTES = 16;
const ROW_HEIGHT = 22; // px

export default function HexViewer({ bytes = new Uint8Array(0), onEditByte, onEditBytes, highlight, onSave, baseOffset = null, offsetMap = null }) {
  const [copied, setCopied] = useState(null);
  const [query, setQuery] = useState('');
  const [replaceInput, setReplaceInput] = useState('');
  const [searchMode, setSearchMode] = useState('hex'); // 'hex' | 'ascii'
  const [matches, setMatches] = useState([]);
  const [matchIdx, setMatchIdx] = useState(-1);
  const [needleLen, setNeedleLen] = useState(0);
  const [searchError, setSearchError] = useState(null);
  const [lastParsedPattern, setLastParsedPattern] = useState(null);

  // Go To Offset
  const [gotoInput, setGotoInput] = useState('');
  const [gotoError, setGotoError] = useState(null);
  const [gotoMode, setGotoMode] = useState('editor'); // 'editor' | 'physical'

  // Shared cursor & selection state
  const [cursorIndex, setCursorIndex] = useState(0);
  const [anchorIndex, setAnchorIndex] = useState(0);
  const [activePane, setActivePane] = useState('hex'); // 'hex' | 'ascii'
  const [hexNibble, setHexNibble] = useState('');

  // Mouse drag selection state
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, index: 0 });
  const DRAG_THRESHOLD = 3;

  // Undo / Redo history & baseline snapshot
  const origBytesRef = useRef(null);
  const historyRef = useRef(createEditHistory());
  const modifiedCounterRef = useRef(createModifiedCounter());
  const [historyTick, setHistoryTick] = useState(0);

  const [scrollTop, setScrollTop] = useState(0);
  const [menuKey, setMenuKey] = useState(0);
  const scrollRef = useRef(null);
  const containerRef = useRef(null);
  const [viewportH, setViewportH] = useState(420);

      // Unified offset map: use offsetMap if provided, otherwise convert baseOffset
      // into a single-region contiguous map for backward compatibility.
      const resolvedOffsetMap = useMemo(() => {
        if (offsetMap && isOffsetMap(offsetMap)) return offsetMap;
        if (baseOffset != null && Number.isSafeInteger(baseOffset) && baseOffset >= 0 && bytes && bytes.length > 0) {
          return createContiguousOffsetMap({
            physicalStartByte: baseOffset,
            lengthBytes: bytes.length,
          });
        }
        return null;
      }, [offsetMap, baseOffset, bytes]);

  const cursorPhysicalResult = useMemo(() => {
    if (!resolvedOffsetMap) return { reason: 'unmapped', physicalOffset: null };
    return resolvedOffsetMap.toPhysical(cursorIndex);
  }, [resolvedOffsetMap, cursorIndex]);

  // Initialize/reset baseline original bytes when bytes buffer changes
  useEffect(() => {
    if (!bytes) {
      origBytesRef.current = null;
      modifiedCounterRef.current.clear();
      return;
    }
    if (!origBytesRef.current || origBytesRef.current.length !== bytes.length) {
      origBytesRef.current = new Uint8Array(bytes);
      historyRef.current.clear();
      modifiedCounterRef.current.clear();
      setHistoryTick((t) => t + 1);
    }
  }, [bytes]);

  useEffect(() => {
    setCursorIndex((c) => clampIndex(c, bytes ? bytes.length : 0));
    setAnchorIndex((a) => clampIndex(a, bytes ? bytes.length : 0));
    setHexNibble('');
  }, [bytes]);

  // Clipboard copy helpers
  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1200);
    }).catch(() => {});
  };

  const copyHex = () => {
    if (!bytes || !bytes.length) return;
    const { start, end } = getSelectionRange(anchorIndex, cursorIndex);
    const slice = bytes.subarray(start, end + 1);
    const hexStr = Array.from(slice, (b) => toHex(b, 2)).join(' ');
    copyToClipboard(hexStr, 'hex');
  };

  const copyAscii = () => {
    if (!bytes || !bytes.length) return;
    const { start, end } = getSelectionRange(anchorIndex, cursorIndex);
    const slice = bytes.subarray(start, end + 1);
    const asciiStr = Array.from(slice, (b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    copyToClipboard(asciiStr, 'ascii');
  };

  const copyEditorOffset = () => {
    if (!bytes || bytes.length === 0) return;
    copyToClipboard(formatOffsetLabel(cursorIndex), 'editor offset');
  };

  const copyPhysicalOffset = () => {
    if (!bytes || bytes.length === 0 || !resolvedOffsetMap) return;
    if (cursorPhysicalResult.reason !== 'mapped') return;
    copyToClipboard(formatOffsetLabel(cursorPhysicalResult.physicalOffset), 'physical offset');
  };

  const selectAll = () => {
    if (!bytes || bytes.length === 0) return;
    setAnchorIndex(0);
    setCursorIndex(bytes.length - 1);
  };

  const handleCellContextMenu = (idx, e) => {
    if (!bytes || bytes.length === 0) return;
    const clamped = clampIndex(idx, bytes.length);
    const inSelection = isIndexSelected(clamped, anchorIndex, cursorIndex);
    if (!inSelection) {
      setCursorIndex(clamped);
      setAnchorIndex(clamped);
    }
    setHexNibble('');
  };

  const totalRows = Math.max(1, Math.ceil((bytes ? bytes.length : 0) / ROW_BYTES));
  const totalHeight = totalRows * ROW_HEIGHT;

  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const endRow = Math.min(totalRows, startRow + Math.ceil(viewportH / ROW_HEIGHT) + 8);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Search logic
  // Cache the parsed needle and last-searched buffer to avoid redundant full scans.
  const lastMatchesRef = useRef([]);

  // When bytes change (edit/undo/redo/reload) or query/mode changes, invalidate cached matches
  useEffect(() => {
    lastMatchesRef.current = [];
    setMatches([]);
    setMatchIdx(-1);

    // If there's no active query, just clear and return
    const q = query.trim();
    if (!q || !bytes || !bytes.length) {
      setNeedleLen(0);
      setSearchError(null);
      setLastParsedPattern(null);
      return;
    }
    // Validate the pattern but do NOT run findAllMatches on every keystroke.
    // Full results are computed lazily when Find Next/Previous is invoked.
    const parsed = parseSearchPattern(q, searchMode);
    if (!parsed.ok) {
      setNeedleLen(0);
      setMatches([]);
      setMatchIdx(-1);
      setSearchError(parsed.error);
      setLastParsedPattern(null);
      return;
    }
    setSearchError(null);
    setNeedleLen(parsed.needle.length);
    setLastParsedPattern(parsed);
  }, [query, searchMode, bytes]);

  // When matchIdx changes (via Find Next/Previous), scroll to it
  useEffect(() => {
    if (matchIdx >= 0 && matches[matchIdx] != null && scrollRef.current) {
      const row = Math.floor(matches[matchIdx] / ROW_BYTES);
      scrollRef.current.scrollTop = Math.max(0, row * ROW_HEIGHT - viewportH / 2);
      setCursorIndex(matches[matchIdx]);
      setAnchorIndex(matches[matchIdx]);
    }
  }, [matchIdx, matches, viewportH]);

  // All match ranges (for highlighting every match, not just the current one)
  const allMatchRanges = useMemo(() => {
    if (!needleLen || !matches.length) return [];
    return matches.map((start) => ({ start, end: start + needleLen - 1 }));
  }, [matches, needleLen]);

  const matchRange = matchIdx >= 0 && matches[matchIdx] != null
    ? { start: matches[matchIdx], end: matches[matchIdx] + needleLen - 1 }
    : null;

  const hasCurrentMatch = matchIdx >= 0 && matches[matchIdx] != null;

  const replaceValidation = useMemo(() => {
    const q = query.trim();
    const r = replaceInput.trim();
    if (!q || !r) return null;
    return validateReplacementInputs(q, r, searchMode);
  }, [query, replaceInput, searchMode]);

  // Check if an index is within the current (active) match
  const isCurrentMatch = (idx) => {
    return matchRange && idx >= matchRange.start && idx <= matchRange.end;
  };

  // Check if an index is within any match (for secondary highlighting)
  const isInAnyMatch = (idx) => {
    return allMatchRanges.some((r) => idx >= r.start && idx <= r.end);
  };

  // Auto-scroll active cursor into view
  useEffect(() => {
    if (!scrollRef.current || !bytes || bytes.length === 0) return;
    const row = Math.floor(cursorIndex / ROW_BYTES);
    const targetTop = row * ROW_HEIGHT;
    const container = scrollRef.current;
    if (targetTop < container.scrollTop) {
      container.scrollTop = targetTop;
    } else if (targetTop + ROW_HEIGHT > container.scrollTop + container.clientHeight) {
      container.scrollTop = targetTop + ROW_HEIGHT - container.clientHeight;
    }
  }, [cursorIndex, bytes]);

  const applyModifiedDelta = (index, fromValue, toValue) => {
    const origBytes = origBytesRef.current;
    const wasModified = origBytes ? fromValue !== origBytes[index] : false;
    const isNowModified = origBytes ? toValue !== origBytes[index] : true;
    if (wasModified && !isNowModified) modifiedCounterRef.current.decrement();
    else if (!wasModified && isNowModified) modifiedCounterRef.current.increment();
  };

  const applyEdits = (edits) => {
    if (!edits || !edits.length) return;
    if (onEditBytes) {
      onEditBytes(edits);
      return;
    }
    for (const edit of edits) onEditByte?.(edit.index, edit.after);
  };

  // Edit execution & Undo / Redo
  const commitEdit = (index, newValue) => {
    if (!bytes || index < 0 || index >= bytes.length) return;
    const before = bytes[index];
    if (before === newValue) return;
    const pushed = historyRef.current.pushEdit({ index, before, after: newValue });
    if (pushed) {
      applyModifiedDelta(index, before, newValue);
      onEditByte?.(index, newValue);
      setHistoryTick((t) => t + 1);
    }
  };

  const handleUndo = () => {
    const item = historyRef.current.undo();
    if (!item) return;
    if (item.isBatch) {
      for (const edit of item.edits) {
        applyModifiedDelta(edit.index, edit.after, edit.before);
      }
      applyEdits(item.edits.map((edit) => ({ index: edit.index, after: edit.before })));
    } else {
      applyModifiedDelta(item.index, item.entry.after, item.entry.before);
      onEditByte?.(item.index, item.value);
      setCursorIndex(item.index);
      setAnchorIndex(item.index);
    }
    setHistoryTick((t) => t + 1);
  };

  const handleRedo = () => {
    const item = historyRef.current.redo();
    if (!item) return;
    if (item.isBatch) {
      for (const edit of item.edits) {
        applyModifiedDelta(edit.index, edit.before, edit.after);
      }
      applyEdits(item.edits);
    } else {
      applyModifiedDelta(item.index, item.entry.before, item.entry.after);
      onEditByte?.(item.index, item.value);
      setCursorIndex(item.index);
      setAnchorIndex(item.index);
    }
    setHistoryTick((t) => t + 1);
  };

  const invalidateSearchCache = () => {
    lastMatchesRef.current = [];
    setMatches([]);
    setMatchIdx(-1);
  };

  const parseReplacePatterns = () => {
    return validateReplacementInputs(query, replaceInput, searchMode);
  };

  const commitBatchEdits = (edits) => {
    if (!edits.length) return false;
    const pushed = historyRef.current.pushBatch(edits);
    if (!pushed) return false;
    for (const edit of edits) applyModifiedDelta(edit.index, edit.before, edit.after);
    applyEdits(edits);
    setHistoryTick((t) => t + 1);
    invalidateSearchCache();
    return true;
  };

  const handleGotoOffset = () => {
    setGotoError(null);
    if (!bytes || bytes.length === 0) {
      setGotoError('No data loaded.');
      return;
    }
    const parsed = parseOffsetInput(gotoInput);
    if (!parsed.ok) {
      setGotoError(parsed.error);
      return;
    }

    if (gotoMode === 'physical') {
      if (!resolvedOffsetMap) {
        setGotoError('No physical mapping available');
        return;
      }
      const phys = resolvedOffsetMap.toLogical(parsed.value);
      let target;
      if (phys.reason === 'mapped') {
        target = phys.logicalOffset;
      } else if (phys.reason === 'unmapped') {
        setGotoError('Physical offset not mapped to this file');
        return;
      } else if (phys.reason === 'ambiguous') {
        setGotoError('Ambiguous: maps to multiple editor locations');
        return;
      } else if (phys.reason === 'invalid') {
        setGotoError('Invalid physical offset');
        return;
      } else {
        setGotoError('Invalid physical offset');
        return;
      }

      const clamped = clampGotoOffset(target, bytes.length);
      if (!clamped.ok) {
        setGotoError(clamped.error);
        return;
      }
      setCursorIndex(clamped.value);
      setAnchorIndex(clamped.value);
      setHexNibble('');
      scrollToIndex(clamped.value);
      return;
    }

    // Editor (logical) mode
    const clamped = clampGotoOffset(parsed.value, bytes.length);
    if (!clamped.ok) {
      setGotoError(clamped.error);
      return;
    }
    const target = clamped.value;
    setCursorIndex(target);
    setAnchorIndex(target);
    setHexNibble('');
    // Scroll the target row into view via the existing auto-scroll effect
    if (scrollRef.current) {
      const row = Math.floor(target / ROW_BYTES);
      const targetTop = row * ROW_HEIGHT;
      const container = scrollRef.current;
      if (targetTop < container.scrollTop) {
        container.scrollTop = targetTop;
      } else if (targetTop + ROW_HEIGHT > container.scrollTop + container.clientHeight) {
        container.scrollTop = targetTop + ROW_HEIGHT - container.clientHeight;
      }
   }
  };

  const scrollToIndex = (idx) => {
    if (!scrollRef.current) return;
    const row = Math.floor(idx / ROW_BYTES);
    const targetTop = row * ROW_HEIGHT;
    const container = scrollRef.current;
    if (targetTop < container.scrollTop) {
      container.scrollTop = targetTop;
    } else if (targetTop + ROW_HEIGHT > container.scrollTop + container.clientHeight) {
      container.scrollTop = targetTop + ROW_HEIGHT - container.clientHeight;
    }
  };

  const doFind = (direction) => {
    if (!bytes || bytes.length === 0) return;
    const parsed = lastParsedPattern;
    if (!parsed || !parsed.ok) {
      const fresh = parseSearchPattern(query, searchMode);
      if (!fresh.ok) { setSearchError(fresh.error); return; }
      setSearchError(null);
      const found = findAllMatches(bytes, fresh.needle);
      setMatches(found);
      setNeedleLen(fresh.needle.length);
      if (found.length === 0) { setMatchIdx(-1); setSearchError('No matches found.'); return; }
      // For initial search, start from cursor position
      let idx = direction === 'next'
        ? findNextMatch(bytes, fresh.needle, cursorIndex)
        : findPreviousMatch(bytes, fresh.needle, cursorIndex - 1);
      if (idx === -1) {
        // Wrap around
        idx = direction === 'next'
          ? findNextMatch(bytes, fresh.needle, 0)
          : findPreviousMatch(bytes, fresh.needle, bytes.length - fresh.needle.length);
      }
      if (idx === -1) { setMatchIdx(-1); setSearchError('No matches found.'); return; }
      const newIdx = found.indexOf(idx);
      setMatchIdx(newIdx >= 0 ? newIdx : 0);
      setCursorIndex(idx);
      setAnchorIndex(idx);
      scrollToIndex(idx);
      return;
    }

    const needle = parsed.needle;
    // Calculate search start: skip past current match for 'next', start before cursor for 'previous'
    let searchStart;
    if (direction === 'next') {
      // Start search from current cursor; if cursor is at a match, start from end of match
      const currentMatchStart = matches[matchIdx];
      searchStart = (matchIdx >= 0 && currentMatchStart != null)
        ? Math.min(currentMatchStart + needle.length, cursorIndex + needle.length)
        : cursorIndex;
    } else {
      // Start search before current cursor position
      searchStart = cursorIndex - 1;
    }

    let idx = direction === 'next'
      ? findNextMatch(bytes, needle, searchStart)
      : findPreviousMatch(bytes, needle, searchStart);
    if (idx === -1) {
      // Wrap around
      idx = direction === 'next'
        ? findNextMatch(bytes, needle, 0)
        : findPreviousMatch(bytes, needle, bytes.length - needle.length);
    }
    if (idx === -1) {
      setSearchError('No matches found.');
      return;
    }
    setNeedleLen(needle.length);
    const allMatches = matches.length ? matches : findAllMatches(bytes, needle);
    setMatches(allMatches);
    const newIdx = allMatches.indexOf(idx);
    setMatchIdx(newIdx >= 0 ? newIdx : 0);
    setCursorIndex(idx);
    setAnchorIndex(idx);
    scrollToIndex(idx);
  };

  const handleFindNext = () => doFind('next');
  const handleFindPrevious = () => doFind('previous');

  const handleReplaceCurrent = () => {
    if (!bytes || bytes.length === 0) return;
    setSearchError(null);
    const parsed = parseReplacePatterns();
    if (!parsed.ok) { setSearchError(parsed.error); return; }
    if (matchIdx < 0 || matches[matchIdx] == null) {
      setSearchError('No current match to replace.');
      return;
    }
    const matchStart = matches[matchIdx];
    const edits = collectOverwriteEdits(bytes, matchStart, parsed.replaceNeedle);
    if (!edits.length) {
      setSearchError('Replace value is identical to the current match.');
      return;
    }
    commitBatchEdits(edits);
  };

  const handleReplaceAll = () => {
    if (!bytes || bytes.length === 0) return;
    setSearchError(null);
    const parsed = parseReplacePatterns();
    if (!parsed.ok) { setSearchError(parsed.error); return; }
    const result = collectNonOverlappingReplacementEdits(
      bytes,
      parsed.searchNeedle,
      parsed.replaceNeedle
    );
    if (!result.ok) { setSearchError(result.error); return; }
    if (!result.matchCount) {
      setSearchError('No matches found.');
      return;
    }
    if (!result.edits.length) {
      setSearchError('Replace value is identical to all matches.');
      return;
    }
    commitBatchEdits(result.edits);
  };

  const handleClearSearch = () => {
    setQuery('');
    setReplaceInput('');
    setMatches([]);
    setMatchIdx(-1);
    setNeedleLen(0);
    setSearchError(null);
    setLastParsedPattern(null);
    lastMatchesRef.current = [];
  };

  // Byte selection click handler
  const handleCellClick = (idx, pane, e) => {
    if (!bytes || bytes.length === 0) return;
    containerRef.current?.focus();
    setActivePane(pane);
    setHexNibble('');
    const clamped = clampIndex(idx, bytes.length);
    if (e.shiftKey) {
      setCursorIndex(clamped);
    } else {
      setAnchorIndex(clamped);
      setCursorIndex(clamped);
    }
  };

   // Mouse drag selection handlers
  const handleCellMouseDown = (idx, e) => {
    if (e.button !== 0) return;
    if (!bytes || bytes.length === 0) return;
    const clamped = clampIndex(idx, bytes.length);
    dragStart.current = { x: e.clientX, y: e.clientY, index: clamped };
    isDraggingRef.current = true;
    setIsDragging(true);
  };

  const handleMouseMove = (e) => {
    if (!isDraggingRef.current) return;
    if (!isDragMovement(dragStart.current.x, dragStart.current.y, e.clientX, e.clientY, DRAG_THRESHOLD)) return;
    const target = e.target;
    const cellIdx = target.getAttribute('data-byte-index');
    const idx = cellIdx ? parseInt(cellIdx, 10) : dragStart.current.index;
    const clamped = clampIndex(idx, bytes.length);
    setCursorIndex(clamped);
  };

  const handleMouseUp = () => {
    if (isDraggingRef.current) {
      setAnchorIndex(dragStart.current.index);
      isDraggingRef.current = false;
      setIsDragging(false);
    }
  };

  useEffect(() => {
    if (!isDragging) return;
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Keyboard Navigation and Input
  const handleKeyDown = (e) => {
    if (!bytes || bytes.length === 0) return;

    // Ignore keyboard events originating from editable form controls.
    // This lets text inputs, textareas, selects, buttons, and other controls
    // receive normal keyboard behavior without interfering with the hex editor.
    if (isEditableFormControl(e.target)) {
      return;
    }

    // Undo / Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) handleRedo();
      else handleUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      handleRedo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      if (e.shiftKey) handleFindPrevious();
      else handleFindNext();
      return;
    }

    // Copy selected bytes (Ctrl+C / Cmd+C)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      if (selectionCount > 0) {
        copyHex();
      }
      return;
    }

    // Navigation keys
    const navKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
    if (navKeys.includes(e.key)) {
      e.preventDefault();
      setHexNibble('');
      const viewportRows = Math.max(1, Math.floor(viewportH / ROW_HEIGHT));
      const next = navigateKey({
        key: e.key,
        shiftKey: e.shiftKey,
        cursorIndex,
        anchorIndex,
        length: bytes.length,
        rowBytes: ROW_BYTES,
        viewportRows,
      });
      setCursorIndex(next.cursorIndex);
      setAnchorIndex(next.anchorIndex);
      return;
    }

    // Input editing based on active pane
    if (activePane === 'hex') {
      const hexChar = e.key.toUpperCase();
      if (/^[0-9A-F]$/.test(hexChar)) {
        e.preventDefault();
        if (!hexNibble) {
          setHexNibble(hexChar);
        } else {
          const hexStr = hexNibble + hexChar;
          const val = parseInt(hexStr, 16);
          commitEdit(cursorIndex, val);
          setHexNibble('');
          const nextIdx = clampIndex(cursorIndex + 1, bytes.length);
          setCursorIndex(nextIdx);
          if (!e.shiftKey) setAnchorIndex(nextIdx);
        }
      } else if (e.key === 'Escape') {
        setHexNibble('');
      }
    } else if (activePane === 'ascii') {
      if (e.key.length === 1 && e.key.charCodeAt(0) >= 32 && e.key.charCodeAt(0) <= 126) {
        e.preventDefault();
        const charCode = e.key.charCodeAt(0);
        commitEdit(cursorIndex, charCode);
        const nextIdx = clampIndex(cursorIndex + 1, bytes.length);
        setCursorIndex(nextIdx);
        if (!e.shiftKey) setAnchorIndex(nextIdx);
      }
    }
  };

  const { start: selectionStart, end: selectionEnd } = getSelectionRange(anchorIndex, cursorIndex);
  const selectionCount = Math.max(0, selectionEnd - selectionStart + 1);

  const visibleRows = useMemo(
    () => Array.from({ length: Math.max(0, endRow - startRow) }, (_, i) => startRow + i),
    [startRow, endRow]
  );

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="font-mono text-xs leading-relaxed overflow-hidden outline-none focus:ring-1 focus:ring-emerald-500/40 rounded-lg border border-border bg-card"
    >
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border bg-card">
        <button onClick={copyHex} title="Copy selected hex bytes to clipboard" className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1 transition-colors">
          {copied === 'hex' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} Copy hex
        </button>
        <button onClick={copyAscii} title="Copy selected ASCII text to clipboard" className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1 transition-colors">
          {copied === 'ascii' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} Copy ASCII
        </button>
        <div className="h-4 w-px bg-border mx-1" />
        <button
          onClick={handleUndo}
          disabled={!historyRef.current.canUndo()}
          title="Undo byte edit (Ctrl+Z)"
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed px-2.5 py-1 transition-colors"
        >
          <Undo className="w-3 h-3" /> Undo
        </button>
        <button
          onClick={handleRedo}
          disabled={!historyRef.current.canRedo()}
          title="Redo byte edit (Ctrl+Y)"
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed px-2.5 py-1 transition-colors"
        >
          <Redo className="w-3 h-3" /> Redo
        </button>
        {onSave && (
          <button onClick={onSave} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 font-medium transition-colors ml-auto">
            <Save className="w-3 h-3" /> Save
          </button>
        )}
      </div>

      {/* Search Bar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-card">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3 h-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleFindNext(); } }}
            placeholder={searchMode === 'hex' ? "Search hex (e.g. 4E 4F 4E 45)…" : "Search ASCII text…"}
            className="w-full rounded-md border border-input bg-background pl-7 pr-6 py-1 text-xs outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 text-xs">
          <button
            onClick={() => setSearchMode('hex')}
            className={`px-2 py-1 rounded-l-md border border-border text-xs font-medium transition-colors ${searchMode === 'hex' ? 'bg-emerald-600 text-white' : 'hover:bg-accent'}`}
          >
            HEX
          </button>
          <button
            onClick={() => setSearchMode('ascii')}
            className={`px-2 py-1 rounded-r-md border border-border text-xs font-medium transition-colors ${searchMode === 'ascii' ? 'bg-emerald-600 text-white' : 'hover:bg-accent'}`}
          >
            ASCII
          </button>
        </div>
        <button
          onClick={handleFindPrevious}
          disabled={!query}
          title="Find previous (Ctrl+Shift+G)"
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-2 py-1"
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          onClick={handleFindNext}
          disabled={!query}
          title="Find next (Ctrl+G)"
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-2 py-1"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
        <span className="text-[11px] text-muted-foreground shrink-0 w-16 text-right font-mono">
          {query && !searchError ? (matches.length ? `${matchIdx + 1}/${matches.length}` : '0/0') : ''}
        </span>
        {query && (
          <button
            onClick={handleClearSearch}
            title="Clear search"
            className="flex items-center justify-center text-muted-foreground hover:text-foreground w-5 h-5 rounded hover:bg-accent"
          >
            <X className="w-3 h-3" />
          </button>
        )}
        <div className="h-4 w-px bg-border mx-1" />
        <span className="text-[11px] text-muted-foreground shrink-0">Go To:</span>
        <div className="relative">
          <input
            value={gotoInput}
            onChange={(e) => { setGotoInput(e.target.value); setGotoError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleGotoOffset(); } if (e.key === 'Escape') { setGotoInput(''); setGotoError(null); } }}
            placeholder="0x…"
            className={`w-28 rounded-md border bg-background px-2 py-1 text-xs font-mono outline-none ${gotoError ? 'border-rose-500 focus:ring-rose-500/40' : 'border-input focus:ring-emerald-500/40'} focus:ring-2`}
          />
        </div>
        <div className="relative">
          <select
            value={gotoMode}
            onChange={(e) => setGotoMode(e.target.value)}
            className="appearance-none rounded-md border border-border bg-background px-2 py-1 text-xs font-medium outline-none hover:bg-accent pr-5"
          >
            <option value="editor">Editor</option>
            <option value="physical">Physical</option>
          </select>
          <ChevronDown className="w-3 h-3 text-muted-foreground absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
        <button
          onClick={handleGotoOffset}
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1 transition-colors"
        >
          Go
        </button>
      </div>
      {gotoError && (
        <div className="px-3 py-1.5 border-b border-border bg-card">
          <span className="text-[10px] text-rose-500 max-w-48 truncate" title={gotoError}>
            {gotoError}
          </span>
        </div>
      )}
      {searchError && (
        <div className="px-3 py-1.5 border-b border-border bg-card">
          <span className="text-[10px] text-rose-500 max-w-full break-words" title={searchError}>
            {searchError}
          </span>
        </div>
      )}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-card">
        <span className="text-[11px] text-muted-foreground shrink-0">Replace:</span>
        <input
          value={replaceInput}
          onChange={(e) => { setReplaceInput(e.target.value); setSearchError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleReplaceCurrent(); } }}
          placeholder={searchMode === 'hex' ? 'hex bytes…' : 'ASCII text…'}
          className={`w-40 rounded-md border bg-background px-2 py-1 text-xs font-mono outline-none ${replaceValidation?.ok === false ? 'border-rose-500 focus:ring-rose-500/40' : replaceInput ? 'border-emerald-500/50 focus:ring-emerald-500/40' : 'border-input focus:ring-emerald-500/40'} focus:ring-2`}
        />
        <button
          onClick={handleReplaceCurrent}
          disabled={!replaceValidation?.ok || !hasCurrentMatch}
          title="Replace current match (overwrite only, identical length required)"
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-2.5 py-1 transition-colors"
        >
          Replace
        </button>
        <button
          onClick={handleReplaceAll}
          disabled={!replaceValidation?.ok}
          title="Replace all matches (overwrite only, identical length required)"
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-2.5 py-1 transition-colors"
        >
          Replace All
        </button>
      </div>
      {replaceValidation?.ok === false && replaceValidation.error && (
        <div className="px-3 py-1.5 border-b border-border bg-card">
          <span className="text-[10px] text-rose-500 max-w-full break-words" title={replaceValidation.error}>
            {replaceValidation.error}
          </span>
        </div>
      )}
      {!hasCurrentMatch && replaceValidation?.ok && query && (
        <div className="px-3 py-1.5 border-b border-border bg-card">
          <span className="text-[10px] text-muted-foreground">
            Find a match to enable Replace
          </span>
        </div>
      )}



      {/* Table Headers */}
      <div className="grid grid-cols-[80px_1fr_140px] gap-3 px-3 py-2 text-muted-foreground border-b border-border bg-muted/30 font-semibold text-[11px]">
        <span>OFFSET</span>
        <span>BYTES (HEX)</span>
        <span>ASCII</span>
      </div>

       {/* Virtualized Rows */}
      <ContextMenu
        modal={false}
        onOpenChange={(open) => {
          if (open) {
            containerRef.current?.focus();
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            onContextMenu={() => setMenuKey((k) => k + 1)}
            onScroll={(e) => setScrollTop(e.target.scrollTop)}
            className="overflow-y-auto"
            style={{ height: 420 }}
          >
            <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ position: 'absolute', top: startRow * ROW_HEIGHT, left: 0, right: 0 }}>
            {visibleRows.map((r) => {
              const base = r * ROW_BYTES;
              const isRowHi = highlight != null && base <= highlight && highlight < base + ROW_BYTES;
              return (
                <div
                  key={r}
                  className={`grid grid-cols-[80px_1fr_140px] gap-3 px-3 ${isRowHi ? 'bg-emerald-500/10' : ''}`}
                  style={{ height: ROW_HEIGHT }}
                >
                  {/* Offset Column */}
                  <span
                    onContextMenu={(e) => handleCellContextMenu(base, e)}
                    className="text-muted-foreground font-mono select-none cursor-pointer"
                  >
                    {toHex(base, 8)}
                  </span>

                  {/* Hex Bytes Column */}
                  <span className="tracking-wider break-all font-mono select-none">
                    {Array.from({ length: ROW_BYTES }).map((__, c) => {
                      const idx = base + c;
                      if (!bytes || idx >= bytes.length) return null;
                      const isSelected = isIndexSelected(idx, anchorIndex, cursorIndex);
                      const isCursor = idx === cursorIndex;
                      const isModified = origBytesRef.current && bytes[idx] !== origBytesRef.current[idx];
                      const isCurrentMatchIdx = isCurrentMatch(idx);
                      const inMatch = !isCurrentMatchIdx && isInAnyMatch(idx);
                      const isCrcHighlight = highlight === idx;

                      const valHex = isCursor && hexNibble ? (hexNibble + '_') : toHex(bytes[idx], 2);

                       const phyResult = resolvedOffsetMap ? resolvedOffsetMap.toPhysical(idx) : null;
                       const phyLabel = phyResult && phyResult.reason === 'mapped' ? formatOffsetLabel(phyResult.physicalOffset) : (phyResult && phyResult.reason === 'sparse' ? 'unmapped' : '—');
                        return (
                           <span
                             key={idx}
                             data-byte-index={idx}
                             onMouseDown={(e) => handleCellMouseDown(idx, e)}
                             onClick={(e) => handleCellClick(idx, 'hex', e)}
                             onContextMenu={(e) => handleCellContextMenu(idx, e)}
                             title={`Offset: 0x${toHex(idx, 8)} (${idx})\nPhysical: ${phyLabel}\nHex: 0x${toHex(bytes[idx], 2)}\nASCII: ${bytes[idx] >= 32 && bytes[idx] <= 126 ? String.fromCharCode(bytes[idx]) : '.'}${isModified ? '\n[MODIFIED]' : ''}`}
                             className={`inline-block w-[1.7em] text-center cursor-text rounded px-0.5 mx-[1px] transition-colors ${
                             isSelected
                               ? 'bg-emerald-600 text-white font-medium'
                               : isCurrentMatchIdx
                               ? 'bg-emerald-400 text-black'
                               : inMatch
                               ? 'bg-amber-400 text-black'
                               : isCrcHighlight
                               ? 'bg-emerald-500/20 text-emerald-600'
                               : 'hover:bg-accent'
                           } ${
                            isCursor && activePane === 'hex'
                              ? 'ring-2 ring-emerald-400 z-10 relative'
                              : isCursor
                              ? 'ring-1 ring-emerald-500/60'
                              : ''
                          } ${
                            isModified
                              ? isSelected
                                ? 'border-b-2 border-amber-300 font-bold text-amber-200'
                                : 'border-b-2 border-amber-500 font-semibold text-amber-500'
                              : ''
                          }`}
                        >
                          {valHex}
                        </span>
                      );
                    })}
                  </span>

                  {/* ASCII Column */}
                  <span className="font-mono select-none">
                    {Array.from({ length: Math.min(ROW_BYTES, bytes ? bytes.length - base : 0) }).map((__, c) => {
                      const idx = base + c;
                      const isSelected = isIndexSelected(idx, anchorIndex, cursorIndex);
                      const isCursor = idx === cursorIndex;
                      const isModified = origBytesRef.current && bytes[idx] !== origBytesRef.current[idx];
                      const isCurrentMatchIdx = isCurrentMatch(idx);
                      const inMatch = !isCurrentMatchIdx && isInAnyMatch(idx);
                      const ch = bytes[idx] >= 32 && bytes[idx] <= 126 ? String.fromCharCode(bytes[idx]) : '.';

                       const phyResultA = resolvedOffsetMap ? resolvedOffsetMap.toPhysical(idx) : null;
                       const phyLabelA = phyResultA && phyResultA.reason === 'mapped' ? formatOffsetLabel(phyResultA.physicalOffset) : (phyResultA && phyResultA.reason === 'sparse' ? 'unmapped' : '—');
                        return (
                           <span
                             key={idx}
                             data-byte-index={idx}
                             onMouseDown={(e) => handleCellMouseDown(idx, e)}
                             onClick={(e) => handleCellClick(idx, 'ascii', e)}
                             onContextMenu={(e) => handleCellContextMenu(idx, e)}
                             title={`Offset: 0x${toHex(idx, 8)} (${idx})\nPhysical: ${phyLabelA}\nASCII: '${ch}' (0x${toHex(bytes[idx], 2)})${isModified ? '\n[MODIFIED]' : ''}`}
                           className={`inline-block w-[1.1em] text-center cursor-text rounded transition-colors ${
                            isSelected
                              ? 'bg-emerald-600 text-white font-medium'
                              : isCurrentMatchIdx
                              ? 'bg-emerald-400 text-black'
                              : inMatch
                              ? 'bg-amber-400 text-black'
                              : 'hover:bg-accent text-muted-foreground'
                          } ${
                            isCursor && activePane === 'ascii'
                              ? 'ring-2 ring-emerald-400 z-10 relative'
                              : isCursor
                              ? 'ring-1 ring-emerald-500/60'
                              : ''
                          } ${
                            isModified
                              ? isSelected
                                ? 'border-b-2 border-amber-300 font-bold text-amber-200'
                                : 'border-b-2 border-amber-500 font-semibold text-amber-500'
                              : ''
                          }`}
                        >
                          {ch}
                        </span>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div> {/* position: absolute */}
           </div> {/* totalHeight wrapper */}
        </div></ContextMenuTrigger>
        <ContextMenuContent key={menuKey} className="w-56">
          <ContextMenuItem
            onSelect={handleUndo}
            disabled={!historyRef.current.canUndo()}
          >
            <Undo className="w-3 h-3 mr-2" /> Undo
            <ContextMenuShortcut>Ctrl+Z</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={handleRedo}
            disabled={!historyRef.current.canRedo()}
          >
            <Redo className="w-3 h-3 mr-2" /> Redo
            <ContextMenuShortcut>Ctrl+Y</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={copyHex}
            disabled={selectionCount === 0}
          >
            <Copy className="w-3 h-3 mr-2" /> Copy Hex
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={copyAscii}
            disabled={selectionCount === 0}
          >
            <Copy className="w-3 h-3 mr-2" /> Copy ASCII
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={copyEditorOffset}
            disabled={!bytes || bytes.length === 0}
          >
            <Copy className="w-3 h-3 mr-2" /> Copy Editor Offset
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={copyPhysicalOffset}
            disabled={
              !resolvedOffsetMap ||
              cursorPhysicalResult.reason !== 'mapped'
            }
            title={
              !resolvedOffsetMap
                ? 'No physical offset map available'
                : cursorPhysicalResult.reason === 'sparse'
                ? 'No physical mapping at this location'
                : cursorPhysicalResult.reason === 'out-of-range'
                ? 'Offset out of range'
                : 'No physical mapping available'
            }
          >
            <Copy className="w-3 h-3 mr-2" /> Copy Physical Offset
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={selectAll}
            disabled={!bytes || bytes.length === 0}
          >
            Select All
            <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Footer Info Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border bg-card">
      <span>
        {formatBytes(bytes ? bytes.length : 0)} · {totalRows.toLocaleString()} rows
      </span>
      <span className="flex items-center gap-3 font-mono">
        {resolvedOffsetMap ? (
          (() => {
            let physicalDisplay;
            if (cursorPhysicalResult.reason === 'mapped') {
              physicalDisplay = formatOffsetLabel(cursorPhysicalResult.physicalOffset);
            } else if (cursorPhysicalResult.reason === 'sparse') {
              physicalDisplay = 'unmapped (sparse)';
            } else if (cursorPhysicalResult.reason === 'out-of-range') {
              physicalDisplay = '—';
            } else {
              physicalDisplay = '—';
            }
            return (
              <>
                <span>
                  Editor offset: <strong className="text-foreground">{formatOffsetLabel(cursorIndex)}</strong>
                </span>
                <span>
                  Physical: <strong className="text-foreground">{physicalDisplay}</strong>
                </span>
                <span className={selectionCount > 0 ? 'text-emerald-600' : 'text-muted-foreground'}>
                  {formatSelectionSize(selectionCount)}
                </span>
                <span className={modifiedCounterRef.current.getCount() > 0 ? 'text-amber-500' : 'text-muted-foreground'}>
                  Modified: {modifiedCounterRef.current.getCount()}
                </span>
              </>
            );
          })()
        ) : (
          <>
            <span>
              Offset: <strong className="text-foreground">{formatOffsetLabel(cursorIndex)}</strong> ({cursorIndex})
            </span>
            <span>
              Byte: <strong className="text-foreground">{formatByteValue(bytes && cursorIndex < bytes.length ? bytes[cursorIndex] : null)}</strong>
            </span>
            <span className={selectionCount > 0 ? 'text-emerald-600' : 'text-muted-foreground'}>
              {formatSelectionSize(selectionCount)}
            </span>
            <span className={modifiedCounterRef.current.getCount() > 0 ? 'text-amber-500' : 'text-muted-foreground'}>
              Modified: {modifiedCounterRef.current.getCount()}
            </span>
          </>
        )}
      </span>
      <span className="uppercase text-[9px] px-1.5 py-0.5 rounded border border-border bg-muted/40 font-semibold">
        Pane: {activePane}
      </span>
      </div>
    </div>
  );
}
