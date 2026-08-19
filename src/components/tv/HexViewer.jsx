import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Copy, Check, Save, Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { bytesToAscii } from '@/lib/binaryUtils';
import { toHex } from '@/lib/crc32';

const ROW_BYTES = 16;
const ROW_HEIGHT = 22; // px

export default function HexViewer({ bytes, onEditByte, highlight, onSave }) {
  const [copied, setCopied] = useState(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [matchIdx, setMatchIdx] = useState(-1);
  const [needleLen, setNeedleLen] = useState(0);

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1200);
    }).catch(() => {});
  };

  const copyHex = () => {
    const hex = Array.from(bytes, (b) => toHex(b, 2)).join(' ');
    copyToClipboard(hex, 'hex');
  };

  const copyAscii = () => {
    const ascii = Array.from(bytes, (b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    copyToClipboard(ascii, 'ascii');
  };
  const [editing, setEditing] = useState(null);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef(null);
  const [viewportH, setViewportH] = useState(420);

  const totalRows = Math.ceil(bytes.length / ROW_BYTES);
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

  useEffect(() => { setEditing(null); setScrollTop(0); setQuery(''); }, [bytes]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setMatches([]); setMatchIdx(-1); setNeedleLen(0); return; }
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
    }
  }, [matchIdx, matches, viewportH]);

  const matchRange = matchIdx >= 0 && matches[matchIdx] != null
    ? { start: matches[matchIdx], end: matches[matchIdx] + needleLen }
    : null;

  const commitEdit = () => {
    if (!editing) return;
    const clean = editing.value.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 2) onEditByte(editing.index, parseInt(clean, 16));
    setEditing(null);
  };

  const visibleRows = useMemo(
    () => Array.from({ length: endRow - startRow }, (_, i) => startRow + i),
    [startRow, endRow]
  );

  return (
    <div className="font-mono text-xs leading-relaxed overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border">
        <button onClick={copyHex} className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1 transition-colors">
          {copied === 'hex' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} Copy hex
        </button>
        <button onClick={copyAscii} className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1 transition-colors">
          {copied === 'ascii' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} Copy ASCII
        </button>
        {onSave && (
          <button onClick={onSave} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 font-medium transition-colors ml-auto">
            <Save className="w-3 h-3" /> Save
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3 h-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search hex or text…"
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
        <span className="text-[11px] text-muted-foreground shrink-0 w-16 text-right">
          {query ? (matches.length ? `${matchIdx + 1}/${matches.length}` : '0/0') : ''}
        </span>
      </div>
      <div className="grid grid-cols-[80px_1fr_120px] gap-3 px-3 py-2 text-muted-foreground border-b border-border">
        <span>OFFSET</span>
        <span>BYTES</span>
        <span>ASCII</span>
      </div>
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
              const isHi = highlight != null && base <= highlight && highlight < base + ROW_BYTES;
              return (
                <div
                  key={r}
                  className={`grid grid-cols-[80px_1fr_120px] gap-3 px-3 ${isHi ? 'bg-emerald-500/10' : ''}`}
                  style={{ height: ROW_HEIGHT }}
                >
                  <span className="text-muted-foreground">{toHex(base, 8)}</span>
                  <span className="tracking-wider break-all">
                    {Array.from({ length: ROW_BYTES }).map((__, c) => {
                      const idx = base + c;
                      if (idx >= bytes.length) return null;
                      const isTarget = highlight === idx;
                      if (editing && editing.index === idx) {
                        return (
                          <input
                            key={idx}
                            autoFocus
                            value={editing.value}
                            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                            onBlur={commitEdit}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(null); }}
                            className="w-6 bg-emerald-500/20 text-foreground outline-none rounded px-0.5 mx-0.5"
                          />
                        );
                      }
                      const inMatch = matchRange && idx >= matchRange.start && idx < matchRange.end;
                      return (
                        <span
                          key={idx}
                          onClick={() => setEditing({ index: idx, value: toHex(bytes[idx], 2) })}
                          className={`inline-block w-[1.6em] cursor-pointer rounded px-0.5 hover:bg-accent ${isTarget ? 'bg-emerald-500 text-white' : ''} ${inMatch ? 'bg-amber-400 text-black' : ''}`}
                        >
                          {toHex(bytes[idx], 2)}
                        </span>
                      );
                    })}
                  </span>
                  <span className="text-muted-foreground">
                    {Array.from({ length: Math.min(ROW_BYTES, bytes.length - base) }).map((__, c) => {
                      const idx = base + c;
                      const ch = bytes[idx] >= 32 && bytes[idx] <= 126 ? String.fromCharCode(bytes[idx]) : '.';
                      const inMatch = matchRange && idx >= matchRange.start && idx < matchRange.end;
                      return <span key={idx} className={inMatch ? 'bg-amber-400 text-black rounded px-0.5' : ''}>{ch}</span>;
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border">
        {bytes.length.toLocaleString()} bytes · {totalRows.toLocaleString()} rows · showing {startRow.toLocaleString()}–{endRow.toLocaleString()}
      </p>
    </div>
  );
}