import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { crc32Init, crc32Update, crc32Final, toHex } from '@/lib/crc32';

// CRC repair panel for multi-GB EMMC dumps. Reads the output blob in 4 MB chunks
// to compute the checksum incrementally — never loads the full dump into memory.
export default function CrcPanelEmmc({ getOutputBlob, onDownload, disabled }) {
  const [config, setConfig] = useState({ variant: 'crc32_ieee', offsetMode: 'tail', offset: '0', endianness: 'le' });
  const [stored, setStored] = useState(null);
  const [computed, setComputed] = useState(null);
  const [computing, setComputing] = useState(false);
  const [progress, setProgress] = useState(0);
  const width = config.variant === 'crc16_ccitt' ? 2 : 4;
  const set = (patch) => setConfig((c) => ({ ...c, ...patch }));

  const getCrcOffset = (size) => {
    if (config.offsetMode === 'tail') return size - width;
    if (config.offsetMode === 'start') return 0;
    const v = String(config.offset).trim();
    return v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10) || 0;
  };

  const verify = async () => {
    const blob = getOutputBlob();
    if (!blob) return;
    setComputing(true);
    setProgress(0);
    setStored(null);
    setComputed(null);
    try {
      const crcOffset = getCrcOffset(blob.size);
      if (crcOffset < 0 || crcOffset + width > blob.size) return;
      const storedBuf = new Uint8Array(await blob.slice(crcOffset, crcOffset + width).arrayBuffer());
      let s = 0;
      if (config.endianness === 'le') { for (let i = 0; i < width; i++) s |= storedBuf[i] << (i * 8); }
      else { for (let i = 0; i < width; i++) s = (s << 8) | storedBuf[i]; }
      setStored(s >>> 0);
      const chunkSize = 4 * 1024 * 1024;
      const init = config.variant === 'crc32_posix' ? 0 : 0xFFFFFFFF;
      let crc = crc32Init(init);
      for (let off = 0; off < crcOffset; off += chunkSize) {
        const end = Math.min(off + chunkSize, crcOffset);
        const buf = new Uint8Array(await blob.slice(off, end).arrayBuffer());
        crc = crc32Update(crc, buf);
        setProgress(Math.round((off / crcOffset) * 100));
      }
      setComputed(crc32Final(crc));
      setProgress(100);
    } finally {
      setComputing(false);
    }
  };

  const mismatch = stored != null && computed != null && stored !== computed;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <select value={config.variant} onChange={(e) => set({ variant: e.target.value })} className="rounded-md border border-input bg-background px-2 py-1.5 text-xs">
          <option value="crc32_ieee">CRC-32 (IEEE)</option>
          <option value="crc32_posix">CRC-32 (POSIX)</option>
        </select>
        <select value={config.endianness} onChange={(e) => set({ endianness: e.target.value })} className="rounded-md border border-input bg-background px-2 py-1.5 text-xs">
          <option value="le">Little-endian</option>
          <option value="be">Big-endian</option>
        </select>
        <select value={config.offsetMode} onChange={(e) => set({ offsetMode: e.target.value })} className="rounded-md border border-input bg-background px-2 py-1.5 text-xs">
          <option value="tail">Tail (last {width} bytes)</option>
          <option value="start">Start (offset 0)</option>
          <option value="custom">Custom offset…</option>
        </select>
        {config.offsetMode === 'custom' && (
          <input value={config.offset} onChange={(e) => set({ offset: e.target.value })} placeholder="0x0000" className="rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono" />
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border bg-muted/30 p-2">
          <p className="text-[10px] text-muted-foreground">Stored in dump</p>
          <p className="font-mono text-sm">{stored != null ? `0x${toHex(stored, width * 2)}` : '—'}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 p-2">
          <p className="text-[10px] text-muted-foreground">Computed (correct)</p>
          <p className={`font-mono text-sm ${mismatch ? 'text-rose-500' : 'text-emerald-600'}`}>{computed != null ? `0x${toHex(computed, width * 2)}` : '—'}</p>
        </div>
      </div>
      {computing && (
        <div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-emerald-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">Computing CRC… {progress}%</p>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={verify} disabled={computing || disabled} className="flex-1 rounded-md border border-border hover:bg-accent disabled:opacity-40 text-xs font-medium py-2 transition-colors">
          {computing ? 'Computing…' : 'Verify CRC'}
        </button>
        <button onClick={() => onDownload({ ...config, width, enabled: true })} disabled={disabled || computing} className="flex-1 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium py-2 transition-colors">
          Repair &amp; Download
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">CRC computed over [0, offset) in 4 MB chunks — handles multi-GB dumps without loading into memory.</p>
    </div>
  );
}