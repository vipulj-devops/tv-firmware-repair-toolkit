import React, { useRef, useState } from 'react';
import { UploadCloud, FileDigit } from 'lucide-react';
import { formatBytes } from '@/lib/binaryUtils';

export default function FileDropzone({ onFile, file, onClear }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleFiles = (files) => {
    if (files && files[0]) onFile(files[0]);
    if (inputRef.current) inputRef.current.value = '';
  };

  if (file) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <FileDigit className="w-5 h-5 text-emerald-500 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{file.name}</p>
            <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
          </div>
        </div>
        <button
          onClick={onClear}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-accent transition-colors"
        >
          Replace
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
        dragging ? 'border-emerald-500 bg-emerald-500/5' : 'border-border hover:border-emerald-500/60 hover:bg-accent/40'
      }`}
    >
      <UploadCloud className="w-8 h-8 mx-auto mb-3 text-muted-foreground" />
      <p className="text-sm font-medium">Drop firmware / dump here</p>
      <p className="text-xs text-muted-foreground mt-1">Accepts all firmware files — Amlogic, MediaTek, MStar, HiSilicon, Realtek, LG, Samsung, Novatek & EMMC dumps</p>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}