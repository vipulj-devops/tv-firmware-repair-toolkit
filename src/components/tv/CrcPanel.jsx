import React, { useEffect, useState } from 'react';
import { crc32, crc16Ccitt, crc32Init, crc32Update, crc32Final, toHex } from '@/lib/crc32';
import { formatBytes } from '@/lib/binaryUtils';

export default function CrcPanel({ bytes, onApply, config, onConfigChange }) {
  const [currentStored, setCurrentStored] = useState(null);
  const [computed, setComputed] = useState(null);
  const [computing, setComputing] = useState(false);
  const [progressState, setProgressState] = useState(null);

  const crcWidth = config.variant === 'crc16_ccitt' ? 2 : 4;

  useEffect(() => {
    let cancelled = false;
    let fieldOffset;
    if (config.offsetMode === 'tail') fieldOffset = bytes.length - crcWidth;
    else if (config.offsetMode === 'start') fieldOffset = 0;
    else fieldOffset = Number(config.offset) || 0;

    if (fieldOffset < 0 || fieldOffset + crcWidth > bytes.length) {
      setCurrentStored(null); setComputed(null); setProgressState(null); return;
    }

    let stored = 0;
    if (config.endianness === 'le') {
      for (let i = 0; i < crcWidth; i++) stored |= bytes[fieldOffset + i] << (i * 8);
    } else {
      for (let i = 0; i < crcWidth; i++) stored = (stored << 8) | bytes[fieldOffset + i];
    }
    setCurrentStored({ offset: fieldOffset, value: stored >>> 0 });

    const dataEnd = fieldOffset;
    setComputing(true);
    setProgressState({ percent: 0, processedBytes: 0, totalBytes: dataEnd });

    const calculateCrcAsync = async () => {
      if (dataEnd === 0) {
        let val = 0;
        if (config.variant === 'crc32_ieee') val = crc32(bytes, { start: 0, end: 0 });
        else if (config.variant === 'crc16_ccitt') val = crc16Ccitt(bytes, { start: 0, end: 0 });
        else val = crc32(bytes, { start: 0, end: 0, init: 0 });
        if (!cancelled) {
          setComputed(val >>> 0);
          setComputing(false);
          setProgressState({ percent: 100, processedBytes: 0, totalBytes: 0 });
        }
        return;
      }

      const chunkSize = 64 * 1024; // 64 KB chunks
      let crc = config.variant === 'crc32_posix' ? crc32Init(0) : crc32Init(0xFFFFFFFF);
      let crc16Val = 0xFFFF;

      for (let off = 0; off < dataEnd; off += chunkSize) {
        if (cancelled) return;
        const end = Math.min(off + chunkSize, dataEnd);
        const chunk = bytes.subarray(off, end);

        if (config.variant === 'crc16_ccitt') {
          crc16Val = crc16Ccitt(bytes, { init: crc16Val, start: off, end });
        } else {
          crc = crc32Update(crc, chunk);
        }

        const percent = Math.round((end / dataEnd) * 100);
        if (!cancelled) {
          setProgressState({ percent, processedBytes: end, totalBytes: dataEnd });
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      if (cancelled) return;

      let finalVal;
      if (config.variant === 'crc16_ccitt') {
        finalVal = crc16Val & 0xFFFF;
      } else {
        finalVal = crc32Final(crc, 0xFFFFFFFF);
      }

      setComputed(finalVal >>> 0);
      setComputing(false);
      setProgressState({ percent: 100, processedBytes: dataEnd, totalBytes: dataEnd });
    };

    calculateCrcAsync();
    return () => { cancelled = true; };
  }, [bytes, config, crcWidth]);

  const mismatch = currentStored && computed && currentStored.value !== computed;
  const set = (patch) => onConfigChange({ ...config, ...patch });

  const apply = () => onApply({ offset: currentStored.offset, value: computed, width: crcWidth, endianness: config.endianness });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Algorithm</label>
          <select value={config.variant} onChange={(e) => set({ variant: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40">
            <option value="crc32_ieee">CRC-32 (IEEE)</option>
            <option value="crc32_posix">CRC-32 (POSIX)</option>
            <option value="crc16_ccitt">CRC-16 (CCITT)</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Endianness</label>
          <select value={config.endianness} onChange={(e) => set({ endianness: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40">
            <option value="le">Little-endian</option>
            <option value="be">Big-endian</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">CRC location</label>
          <select value={config.offsetMode} onChange={(e) => set({ offsetMode: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40">
            <option value="tail">Tail of file (last {crcWidth} bytes)</option>
            <option value="start">Start of file (offset 0)</option>
            <option value="custom">Custom offset…</option>
          </select>
        </div>
        {config.offsetMode === 'custom' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Offset (hex or dec)</label>
            <input value={config.offset} onChange={(e) => set({ offset: e.target.value })} placeholder="0x0000"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-emerald-500/40" />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground mb-1">Stored in file</p>
          <p className="font-mono text-lg">{currentStored ? `0x${toHex(currentStored.value, crcWidth * 2)}` : '—'}</p>
          {currentStored && <p className="text-[10px] text-muted-foreground mt-1">at offset 0x{toHex(currentStored.offset, 4)}</p>}
        </div>
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground mb-1">Computed (correct)</p>
          <p className="font-mono text-lg text-emerald-600">{computed != null ? `0x${toHex(computed, crcWidth * 2)}` : '—'}</p>
          <p className={`text-[10px] mt-1 ${mismatch ? 'text-rose-500' : 'text-emerald-600'}`}>{mismatch ? '✗ checksum mismatch' : '✓ checksum valid'}</p>
        </div>
      </div>

      {progressState != null && (
        <div className="space-y-1 rounded-lg border border-border bg-muted/20 p-2.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{computing ? 'Calculating CRC…' : 'CRC calculation complete'}</span>
            <span className="font-mono">{progressState.percent}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-emerald-600 transition-all duration-150" style={{ width: `${progressState.percent}%` }} />
          </div>
          <p className="text-[10px] text-muted-foreground text-right font-mono">
            Processed {formatBytes(progressState.processedBytes)} / {formatBytes(progressState.totalBytes)}
          </p>
        </div>
      )}

      <button onClick={apply} disabled={!currentStored || !mismatch || computing}
        className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 transition-colors">
        {mismatch ? 'Repair checksum' : 'Checksum already valid'}
      </button>
      <p className="text-[11px] text-muted-foreground">Checksum is repaired automatically when you rebuild &amp; download.</p>
    </div>
  );
}