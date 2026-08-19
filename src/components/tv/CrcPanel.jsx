import React, { useEffect, useState } from 'react';
import { crc32, crc16Ccitt, toHex } from '@/lib/crc32';

export default function CrcPanel({ bytes, onApply, config, onConfigChange }) {
  const [currentStored, setCurrentStored] = useState(null);
  const [computed, setComputed] = useState(null);

  const crcWidth = config.variant === 'crc16_ccitt' ? 2 : 4;

  useEffect(() => {
    let fieldOffset;
    if (config.offsetMode === 'tail') fieldOffset = bytes.length - crcWidth;
    else if (config.offsetMode === 'start') fieldOffset = 0;
    else fieldOffset = Number(config.offset) || 0;

    if (fieldOffset < 0 || fieldOffset + crcWidth > bytes.length) {
      setCurrentStored(null); setComputed(null); return;
    }

    let stored = 0;
    if (config.endianness === 'le') {
      for (let i = 0; i < crcWidth; i++) stored |= bytes[fieldOffset + i] << (i * 8);
    } else {
      for (let i = 0; i < crcWidth; i++) stored = (stored << 8) | bytes[fieldOffset + i];
    }
    setCurrentStored({ offset: fieldOffset, value: stored >>> 0 });

    const dataEnd = fieldOffset;
    let val;
    if (config.variant === 'crc32_ieee') val = crc32(bytes, { start: 0, end: dataEnd });
    else if (config.variant === 'crc16_ccitt') val = crc16Ccitt(bytes, { start: 0, end: dataEnd });
    else val = crc32(bytes, { start: 0, end: dataEnd, init: 0 });
    setComputed(val >>> 0);
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

      <button onClick={apply} disabled={!currentStored || !mismatch}
        className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 transition-colors">
        {mismatch ? 'Repair checksum' : 'Checksum already valid'}
      </button>
      <p className="text-[11px] text-muted-foreground">Checksum is repaired automatically when you rebuild &amp; download.</p>
    </div>
  );
}