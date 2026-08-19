import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Download, RotateCcw, ShieldCheck, Binary, FileCog, HardDrive } from 'lucide-react';
import FileDropzone from '@/components/tv/FileDropzone';
import HexViewer from '@/components/tv/HexViewer';
import ConfigEditor from '@/components/tv/ConfigEditor';
import CrcPanel from '@/components/tv/CrcPanel';
import Ext4Browser from '@/components/tv/Ext4Browser';
import { scanStrings, formatBytes, writeUint32LE, writeUint32BE } from '@/lib/binaryUtils';
import { toHex, crc32, crc16Ccitt } from '@/lib/crc32';
import { isExt4 } from '@/lib/ext4';
import FirmwareHeaderPanel from '@/components/firmware/FirmwareHeaderPanel';
import { analyzeFirmware } from '@/lib/firmwareParser';

export default function TVConfigTool() {
  const [file, setFile] = useState(null);
  const [bytes, setBytes] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('hex');
  const [crcHighlight, setCrcHighlight] = useState(null);
  const [crcConfig, setCrcConfig] = useState({ variant: 'crc32_ieee', offsetMode: 'tail', offset: 0, endianness: 'le' });
  const ext4Detected = useMemo(() => (bytes ? isExt4(bytes) : false), [bytes]);
  const firmwareAnalysis = useMemo(() => (bytes && file ? analyzeFirmware(bytes, file.name) : null), [bytes, file]);

  const loadFile = (f) => {
    const reader = new FileReader();
    reader.onload = () => {
      setBytes(new Uint8Array(reader.result));
      setFile(f);
      setDirty(false);
      setCrcHighlight(null);
    };
    reader.readAsArrayBuffer(f);
  };

  const entries = useMemo(() => (bytes ? scanStrings(bytes) : []), [bytes]);

  const editByte = (index, value) => {
    const next = new Uint8Array(bytes);
    next[index] = value & 0xff;
    setBytes(next);
    setDirty(true);
  };

  const patchString = (entry, newVal, maxLen) => {
    const next = new Uint8Array(bytes);
    // Only overwrite the value portion (after "key="), leaving the key intact.
    const valueStart = entry.offset + entry.key.length + 1;
    const origValueLen = entry.value.length;
    if (newVal.length <= origValueLen) {
      // Fits in the original slot — pad remainder with spaces.
      for (let i = 0; i < origValueLen; i++) {
        next[valueStart + i] = i < newVal.length ? (newVal.charCodeAt(i) & 0xff) : 0x20;
      }
    } else {
      // Grow into the gap after the original value, preserving a terminator.
      const writeLen = Math.min(newVal.length, maxLen || origValueLen);
      for (let i = 0; i < writeLen; i++) next[valueStart + i] = newVal.charCodeAt(i) & 0xff;
      const term = bytes[valueStart + origValueLen];
      next[valueStart + writeLen] = (term != null && term < 32) ? term : 0x00;
    }
    setBytes(next);
    setDirty(true);
  };

  const applyCrc = ({ offset, value, width, endianness }) => {
    const next = new Uint8Array(bytes);
    if (width === 4) {
      if (endianness === 'le') writeUint32LE(next, offset, value);
      else writeUint32BE(next, offset, value);
    } else {
      next[offset] = endianness === 'le' ? value & 0xff : (value >>> 8) & 0xff;
      next[offset + 1] = endianness === 'le' ? (value >>> 8) & 0xff : value & 0xff;
    }
    setBytes(next);
    setDirty(true);
    setCrcHighlight(offset);
  };

  const revert = () => {
    if (file) loadFile(file);
  };

  const autoRepairCrc = (buf) => {
    const width = crcConfig.variant === 'crc16_ccitt' ? 2 : 4;
    let fieldOffset;
    if (crcConfig.offsetMode === 'tail') fieldOffset = buf.length - width;
    else if (crcConfig.offsetMode === 'start') fieldOffset = 0;
    else fieldOffset = Number(crcConfig.offset) || 0;
    if (fieldOffset < 0 || fieldOffset + width > buf.length) return false;
    let val;
    if (crcConfig.variant === 'crc32_ieee') val = crc32(buf, { start: 0, end: fieldOffset });
    else if (crcConfig.variant === 'crc16_ccitt') val = crc16Ccitt(buf, { start: 0, end: fieldOffset });
    else val = crc32(buf, { start: 0, end: fieldOffset, init: 0 });
    val = val >>> 0;
    if (width === 4) {
      if (crcConfig.endianness === 'le') writeUint32LE(buf, fieldOffset, val);
      else writeUint32BE(buf, fieldOffset, val);
    } else {
      buf[fieldOffset] = crcConfig.endianness === 'le' ? val & 0xff : (val >>> 8) & 0xff;
      buf[fieldOffset + 1] = crcConfig.endianness === 'le' ? (val >>> 8) & 0xff : val & 0xff;
    }
    setCrcHighlight(fieldOffset);
    return true;
  };

  const download = () => {
    const buf = new Uint8Array(bytes);
    const repaired = autoRepairCrc(buf);
    setBytes(buf);
    if (repaired) setDirty(true);
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (dirty || repaired) ? file.name.replace(/(\.[^.]+)?$/, '_patched$1') : file.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-600 flex items-center justify-center">
              <FileCog className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight">TVConfig Repair Tool</h1>
              <p className="text-xs text-muted-foreground">Unpack · Modify · Rebuild · Auto CRC Repair</p>
            </div>
            <Link to="/emmc" className="ml-2 text-xs rounded-md border border-border px-2.5 py-1.5 hover:bg-accent transition-colors flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5" /> EMMC Tool
            </Link>
          </div>
          {bytes && (
            <div className="flex items-center gap-2">
              {dirty && (
                <button
                  onClick={revert}
                  className="flex items-center gap-1.5 text-xs rounded-md border border-border px-3 py-1.5 hover:bg-accent transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Revert
                </button>
              )}
              <button
                onClick={download}
                className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 font-medium transition-colors"
              >
                <Download className="w-3.5 h-3.5" /> {dirty ? 'Rebuild & Download' : 'Download'}
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 space-y-6">
        <FileDropzone onFile={loadFile} file={file} onClear={() => { setFile(null); setBytes(null); setDirty(false); }} />

        {bytes && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="File size" value={formatBytes(bytes.length)} />
              <Stat label="Config entries" value={String(entries.filter(e => e.type === 'kv').length)} />
              <Stat label="Strings found" value={String(entries.length)} />
              <Stat label="Status" value={dirty ? 'Modified' : 'Original'} accent={dirty} />
            </div>

            <FirmwareHeaderPanel analysis={firmwareAnalysis} />

            <div className="grid lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 rounded-xl border border-border bg-card overflow-hidden">
                <div className="flex border-b border-border">
                  <TabBtn active={tab === 'hex'} onClick={() => setTab('hex')} icon={<Binary className="w-4 h-4" />}>Hex Editor</TabBtn>
                  <TabBtn active={tab === 'config'} onClick={() => setTab('config')} icon={<FileCog className="w-4 h-4" />}>Config Values</TabBtn>
                  {ext4Detected && (
                    <TabBtn active={tab === 'ext4'} onClick={() => setTab('ext4')} icon={<HardDrive className="w-4 h-4" />}>ext4 Files</TabBtn>
                  )}
                </div>
                <div className="p-3">
                  {tab === 'hex' && <HexViewer bytes={bytes} onEditByte={editByte} highlight={crcHighlight} onSave={download} />}
                  {tab === 'config' && <ConfigEditor entries={entries} bytes={bytes} onPatchString={patchString} />}
                  {tab === 'ext4' && <Ext4Browser bytes={bytes} dirty={dirty} onPatched={(next) => { setBytes(next); setDirty(true); }} onDownload={download} onReset={revert} />}
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-2 mb-4">
                  <ShieldCheck className="w-5 h-5 text-emerald-600" />
                  <h2 className="text-sm font-semibold">CRC Checksum Repair</h2>
                </div>
                <CrcPanel bytes={bytes} onApply={applyCrc} config={crcConfig} onConfigChange={setCrcConfig} />
              </div>
            </div>
          </>
        )}

        {!bytes && (
          <div className="text-center py-10 text-sm text-muted-foreground max-w-md mx-auto">
            Load a TV config pack to unpack it. Edit bytes or parsed config values, recalculate the CRC
            checksum to repair it, then rebuild and download the patched file — all offline in your browser.
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold mt-0.5 ${accent ? 'text-emerald-600' : ''}`}>{value}</p>
    </div>
  );
}

function TabBtn({ active, onClick, icon, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}{children}
    </button>
  );
}