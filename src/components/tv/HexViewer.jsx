import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Copy, Check, Save, Search, ChevronUp, ChevronDown, X, Undo, Redo } from 'lucide-react';
import { toHex } from '@/lib/crc32';
import {
  clampIndex,
  getSelectionRange,
  isIndexSelected,
  navigateKey,
  createEditHistory,
  isEditableFormControl,
  parseOffsetInput,
  clampGotoOffset,
} from '@/lib/hexEditorCore';

const ROW_BYTES = 16;
const ROW_HEIGHT = 22; // px

export default function HexViewer({ bytes = new Uint8Array(0), onEditByte, highlight, onSave }) {
  const [copied, setCopied] = useState(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [matchIdx, setMatchIdx] = useState(-1);
  const [needleLen, setNeedleLen] = useState(0);

  // Go To Offset
  const [gotoInput, setGotoInput] = useState('');
  const [gotoError, setGotoError] = useState(null);

  // Shared cursor & selection state
  const [cursorIndex, setCursorIndex] = useState(0);
  const [anchorIndex, setAnchorIndex] = useState(0);
  const [activePane, setActivePane] = useState('hex'); // 'hex' | 'ascii'
  const [hexNibble, setHexNibble] = useState('');

  // Undo / Redo history & baseline snapshot
  const origBytesRef = useRef(null);
  const historyRef = useRef(createEditHistory());
  const [historyTick, setHistoryTick] = useState(0);

  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef(null);
  const containerRef = useRef(null);
  const [viewportH, setViewportH] = useState(420);

  // Initialize/reset baseline original bytes when bytes buffer changes
  useEffect(() => {
    if (!bytes) {
      origBytesRef.current = null;
      return;
    }
    if (!origBytesRef.current || origBytesRef.current.length !== bytes.length) {
      origBytesRef.current = new Uint8Array(bytes);
      historyRef.current.clear();
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
  useEffect(() => {
    const q = query.trim();
    if (!q || !bytes || !bytes.length) { setMatches([]); setMatchIdx(-1); setNeedleLen(0); return; }
    const hexClean = q.replace(/[^0-9a-fA-F]/g, '');
    let needle;
    if (/^[0-9a-fA-F\s]+$/.test(q) && hexClean.length >= 2 && hexClean.length % 2 === 0) {
      needle = new Uint8Array(hexClean.length / 2);
      for (let i = 0; i < needle.length; i++) needle[i] = parseInt(hexClean.substr(i * 2, 2), 16);
    } else {
      needle = new Uint8Array(q.length);
      for (let i = 0; i < q.length; i++) needle[i] = q.charCodeAt(i) & 0xff;
    }
    const found = [];
    for (let i = 0; i + needle.length <= bytes.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) { if (bytes[i + j] !== needle[j]) { ok = false; break; } }
      if (ok) found.push(i);
    }
    setMatches(found);
    setNeedleLen(needle.length);
    setMatchIdx(found.length ? 0 : -1);
  }, [query, bytes]);

  useEffect(() => {
    if (matchIdx >= 0 && matches[matchIdx] != null && scrollRef.current) {
      const row = Math.floor(matches[matchIdx] / ROW_BYTES);
      scrollRef.current.scrollTop = Math.max(0, row * ROW_HEIGHT - viewportH / 2);
      setCursorIndex(matches[matchIdx]);
      setAnchorIndex(matches[matchIdx]);
    }
  }, [matchIdx, matches, viewportH]);

  const matchRange = matchIdx >= 0 && matches[matchIdx] != null
    ? { start: matches[matchIdx], end: matches[matchIdx] + needleLen }
    : null;

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

  // Edit execution & Undo / Redo
  const commitEdit = (index, newValue) => {
    if (!bytes || index < 0 || index >= bytes.length) return;
    const before = bytes[index];
    if (before === newValue) return;
    const pushed = historyRef.current.pushEdit({ index, before, after: newValue });
    if (pushed) {
      onEditByte?.(index, newValue);
      setHistoryTick((t) => t + 1);
    }
  };

  const handleUndo = () => {
    const item = historyRef.current.undo();
    if (item) {
      onEditByte?.(item.index, item.value);
      setCursorIndex(item.index);
      setAnchorIndex(item.index);
      setHistoryTick((t) => t + 1);
    }
  };

  const handleRedo = () => {
    const item = historyRef.current.redo();
    if (item) {
      onEditByte?.(item.index, item.value);
      setCursorIndex(item.index);
      setAnchorIndex(item.index);
      setHistoryTick((t) => t + 1);
    }
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
    const clamped = clampGotoOffset(parsed.value, bytes.length);
    if (!clamped.ok) {
      setGotoError(clamped.error);
      return;
    }
    const target = clamped.value;
    setCursorIndex(target);
    setAnchorIndex(target);
    setHexNibble('');
    setGotoInput('');
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search hex (e.g. 4E 50) or ASCII text…"
            className="w-full rounded-md border border-input bg-background pl-7 pr-6 py-1 text-xs outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <button
          onClick={() => setMatchIdx((i) => (matches.length ? (i - 1 + matches.length) % matches.length : -1))}
          disabled={!matches.length}
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-2 py-1"
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          onClick={() => setMatchIdx((i) => (matches.length ? (i + 1) % matches.length : -1))}
          disabled={!matches.length}
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-2 py-1"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
        <span className="text-[11px] text-muted-foreground shrink-0 w-16 text-right font-mono">
          {query ? (matches.length ? `${matchIdx + 1}/${matches.length}` : '0/0') : ''}
        </span>
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
        <button
          onClick={handleGotoOffset}
          className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1 transition-colors"
        >
          Go
        </button>
        {gotoError && (
          <span className="text-[10px] text-rose-500 max-w-48 truncate" title={gotoError}>
            {gotoError}
          </span>
        )}
      </div>

      {/* Table Headers */}
      <div className="grid grid-cols-[80px_1fr_140px] gap-3 px-3 py-2 text-muted-foreground border-b border-border bg-muted/30 font-semibold text-[11px]">
        <span>OFFSET</span>
        <span>BYTES (HEX)</span>
        <span>ASCII</span>
      </div>

      {/* Virtualized Rows */}
      <div
        ref={scrollRef}
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
                  <span className="text-muted-foreground font-mono select-none">{toHex(base, 8)}</span>

                  {/* Hex Bytes Column */}
                  <span className="tracking-wider break-all font-mono select-none">
                    {Array.from({ length: ROW_BYTES }).map((__, c) => {
                      const idx = base + c;
                      if (!bytes || idx >= bytes.length) return null;
                      const isSelected = isIndexSelected(idx, anchorIndex, cursorIndex);
                      const isCursor = idx === cursorIndex;
                      const isModified = origBytesRef.current && bytes[idx] !== origBytesRef.current[idx];
                      const inMatch = matchRange && idx >= matchRange.start && idx < matchRange.end;
                      const isCrcHighlight = highlight === idx;

                      const valHex = isCursor && hexNibble ? (hexNibble + '_') : toHex(bytes[idx], 2);

                      return (
                        <span
                          key={idx}
                          onClick={(e) => handleCellClick(idx, 'hex', e)}
                          title={`Offset: 0x${toHex(idx, 8)} (${idx})\nHex: 0x${toHex(bytes[idx], 2)}\nASCII: ${bytes[idx] >= 32 && bytes[idx] <= 126 ? String.fromCharCode(bytes[idx]) : '.'}${isModified ? '\n[MODIFIED]' : ''}`}
                          className={`inline-block w-[1.7em] text-center cursor-pointer rounded px-0.5 mx-[1px] transition-colors ${
                            isSelected
                              ? 'bg-emerald-600 text-white font-medium'
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
                      const inMatch = matchRange && idx >= matchRange.start && idx < matchRange.end;
                      const ch = bytes[idx] >= 32 && bytes[idx] <= 126 ? String.fromCharCode(bytes[idx]) : '.';

                      return (
                        <span
                          key={idx}
                          onClick={(e) => handleCellClick(idx, 'ascii', e)}
                          title={`Offset: 0x${toHex(idx, 8)} (${idx})\nASCII: '${ch}' (0x${toHex(bytes[idx], 2)})${isModified ? '\n[MODIFIED]' : ''}`}
                          className={`inline-block w-[1.1em] text-center cursor-pointer rounded transition-colors ${
                            isSelected
                              ? 'bg-emerald-600 text-white font-medium'
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
          </div>
        </div>
      </div>

      {/* Footer Info Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border bg-card">
        <span>
          {(bytes ? bytes.length : 0).toLocaleString()} bytes · {totalRows.toLocaleString()} rows
        </span>
        <span>
          Cursor: <strong className="font-mono text-foreground">0x{toHex(cursorIndex, 8)}</strong> ({cursorIndex})
          {selectionCount > 1 && (
            <span className="ml-2 text-emerald-600 font-medium">
              Selection: 0x{toHex(selectionStart, 8)}–0x{toHex(selectionEnd, 8)} ({selectionCount} B)
            </span>
          )}
        </span>
        <span className="uppercase text-[9px] px-1.5 py-0.5 rounded border border-border bg-muted/40 font-semibold">
          Pane: {activePane}
        </span>
      </div>
    </div>
  );
}
