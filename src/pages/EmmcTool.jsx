import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Download, RotateCcw, HardDrive, FolderArchive, FolderInput, ArrowLeft, Save, Upload, ShieldCheck } from 'lucide-react';
import ToolNav from '@/components/ToolNav';
import FileDropzone from '@/components/tv/FileDropzone';
import Ext4Browser from '@/components/tv/Ext4Browser';
import LogPanel from '@/components/emmc/LogPanel';
import PartitionTable from '@/components/emmc/PartitionTable';
import CrcPanelEmmc from '@/components/emmc/CrcPanelEmmc';
import FirmwareHeaderPanel from '@/components/firmware/FirmwareHeaderPanel';
import { autoMapPartitions, hasGpt } from '@/lib/emmc';
import { analyzeFirmware, firmwarePartitionsToParts } from '@/lib/firmwareParser';
import { analyzeUserArea } from '@/lib/userAreaParser';
import { selectDumpParts } from '@/lib/userArea/selectDumpParts';
import UserAreaAnalysis from '@/components/emmc/UserAreaAnalysis';
import FilesystemDetections from '@/components/emmc/FilesystemDetections';
import { formatBytes } from '@/lib/binaryUtils';
import { isExt4 } from '@/lib/ext4';
import { loadExplorePartition } from '@/lib/exploreSession';
import { composeDumpBlob, getPartitionBlob as composePartitionBlob } from '@/lib/dumpCompose';
import { scanFilesystems, scanFilesystemsAsync } from '@/lib/detectFilesystems';
import { crc32Init, crc32Update, crc32Final } from '@/lib/crc32';
import { toast } from '@/components/ui/use-toast';
import { Progress } from '@/components/ui/progress';

const GPT_CHUNK = 128 * 1024 * 1024; // initial read for GPT parsing + hw partition detection
const TAIL_CHUNK = 4 * 1024 * 1024; // tail read for ZIP central directory / EOCD

export default function EmmcTool() {
  const [file1, setFile1] = useState(null);
  const [gptBytes, setGptBytes] = useState(null);
  const [tailBytes, setTailBytes] = useState(null);
  const [replacements, setReplacements] = useState({}); // { partitionName: Uint8Array }
  const [overlays, setOverlays] = useState({}); // { partitionName: overlay }
  const [overlayTick, setOverlayTick] = useState(0);
  const [asyncFsHits, setAsyncFsHits] = useState([]);
  const [ext4Map, setExt4Map] = useState({});
  const [log, setLog] = useState([]);
  const [explorePart, setExplorePart] = useState(null);
  const [exploreBytes, setExploreBytes] = useState(null);
  const [exploreReader, setExploreReader] = useState(null);
  const [exploreReadOnlyReason, setExploreReadOnlyReason] = useState(null);
  const [exploreInPlaceOnly, setExploreInPlaceOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { label, percent } | null
  const [selected, setSelected] = useState(new Set());
  const replaceInputRef = useRef(null);
  const replaceTarget = useRef(null);
  const folderInputRef = useRef(null);
  const replaceSelectedInputRef = useRef(null);

  const gptParts = useMemo(() => (gptBytes && file1 ? autoMapPartitions(gptBytes, file1.size) : []), [gptBytes, file1]);
  const firmwareAnalysis = useMemo(() => (gptBytes && file1 ? analyzeFirmware(gptBytes, file1.name, file1.size, tailBytes) : null), [gptBytes, file1, tailBytes]);
  // When no GPT/MBR table is found, fall back to vendor-firmware parsed partitions
  // so Amlogic/MTK/LG/etc. images still show an actionable partition table.
  const userAreaAnalysis = useMemo(() => (gptBytes && file1 ? analyzeUserArea(gptBytes, file1.size) : null), [gptBytes, file1]);
  const gptFound = gptBytes ? hasGpt(gptBytes) : false;
  const filesystemHits = useMemo(
    () => (gptBytes ? scanFilesystems(gptBytes, file1?.size || gptBytes.length) : []),
    [gptBytes, file1],
  );
  const effectiveFsHits = useMemo(
    () => (asyncFsHits.length > 0 ? asyncFsHits : filesystemHits),
    [asyncFsHits, filesystemHits],
  );
  const parts = useMemo(() => selectDumpParts({
    hasGpt: gptFound,
    gptParts,
    userAreaAnalysis,
    firmwareParts: firmwareAnalysis ? firmwarePartitionsToParts(firmwareAnalysis, file1?.size || 0) : [],
    filesystemHits: effectiveFsHits,
    fileSize: file1?.size || 0,
    bytes: gptBytes,
  }), [gptFound, gptParts, userAreaAnalysis, firmwareAnalysis, effectiveFsHits, file1]);
  const overlayDirty = Object.values(overlays).some((o) => o && o.hasWrites());
  const dirty = overlayTick >= 0 && (Object.keys(replacements).length > 0 || overlayDirty);

  const addLog = (msg) => setLog((l) => [...l, { time: new Date().toLocaleTimeString(), msg }]);

  // Detect ext4 per partition: from the GPT chunk for nearby partitions, async reads for the rest.
  useEffect(() => {
    if (!file1 || !parts.length) { setExt4Map({}); return; }
    const map = {};
    const asyncChecks = [];
    for (const p of parts) {
      if (p.size === 0) continue;
      if (p.startByte + 2048 <= (gptBytes?.length || 0)) {
        map[p.name] = isExt4(gptBytes.subarray(p.startByte, p.startByte + 2048));
      } else {
        asyncChecks.push(
          file1.slice(p.startByte, p.startByte + 2048).arrayBuffer()
            .then((buf) => [p.name, isExt4(new Uint8Array(buf))])
            .catch(() => [p.name, false])
        );
      }
    }
    setExt4Map(map);
    Promise.all(asyncChecks).then((results) => {
      setExt4Map((prev) => {
        const next = { ...prev };
        for (const [name, val] of results) next[name] = val;
        return next;
      });
    });
  }, [file1, parts, gptBytes]);

  const loadMain = async (f) => {
    setFile1(f);
    setReplacements({});
    setOverlays({});
    setOverlayTick(0);
    setAsyncFsHits([]);
    setExplorePart(null);
    setExploreBytes(null);
    setExploreReader(null);
    setExploreReadOnlyReason(null);
    setExploreInPlaceOnly(false);
    setBusy(true);
    setProgress({ label: `Analyzing ${f.name}…`, percent: 0 });
    try {
      const headLen = Math.min(f.size, GPT_CHUNK);
      const head = new Uint8Array(headLen);
      const READ = 16 * 1024 * 1024;
      for (let off = 0; off < headLen; off += READ) {
        const end = Math.min(off + READ, headLen);
        const chunk = new Uint8Array(await f.slice(off, end).arrayBuffer());
        head.set(chunk, off);
        const headPercent = Math.round((end / headLen) * 5);
        setProgress({ label: `Analyzing ${f.name}… ${headPercent}%`, percent: headPercent });
      }
      setGptBytes(head);
      // read the tail too — ZIP central directories live at the end of the file
      const tailStart = Math.max(0, f.size - TAIL_CHUNK);
      const tail = new Uint8Array(await f.slice(tailStart, f.size).arrayBuffer());
      setTailBytes(tail);

      // Async scan for filesystems across full file if no GPT or strict user-area PT
      const hasGptHeader = hasGpt(head);
      const ua = analyzeUserArea(head, f.size);

      addLog(`Loaded ${f.name} (${formatBytes(f.size)})`);

      if (!hasGptHeader && (!ua || !ua.partitions || ua.partitions.length === 0)) {
        setBusy(false); // Make UI interactive immediately

        scanFilesystemsAsync(
          f,
          64 * 1024 * 1024,
          ({ percent }) => {
            const unifiedPercent = Math.min(100, 5 + Math.round((percent / 100) * 95));
            setProgress({ label: `Analyzing ${f.name}… ${unifiedPercent}%`, percent: unifiedPercent });
          },
          (hits) => {
            if (hits && hits.length > 0) {
              setAsyncFsHits(hits);
            }
          }
        )
          .then(() => {
            setProgress({ label: `Analyzing ${f.name}… 100%`, percent: 100 });
            setTimeout(() => setProgress(null), 300);
          })
          .catch(() => {
            setProgress(null);
          });
      } else {
        setProgress({ label: `Analyzing ${f.name}… 100%`, percent: 100 });
        await new Promise((r) => setTimeout(r, 200));
        setBusy(false);
        setProgress(null);
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Load failed', description: e.message });
      setBusy(false);
      setProgress(null);
    }
  };

  const resetToStart = () => {
    setFile1(null);
    setGptBytes(null);
    setTailBytes(null);
    setAsyncFsHits([]);
    setReplacements({});
    setOverlays({});
    setOverlayTick(0);
    setExt4Map({});
    setLog([]);
    setExplorePart(null);
    setExploreBytes(null);
    setExploreReader(null);
    setExploreReadOnlyReason(null);
    setExploreInPlaceOnly(false);
    setBusy(false);
    setProgress(null);
    setSelected(new Set());
  };

  const revert = () => {
    setReplacements({});
    setOverlays({});
    setOverlayTick(0);
    setExplorePart(null);
    setExploreBytes(null);
    setExploreReader(null);
    setExploreReadOnlyReason(null);
    setExploreInPlaceOnly(false);
    addLog('Reverted all changes');
  };

  const toggleSelect = (p) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(p.name)) next.delete(p.name); else next.add(p.name);
    return next;
  });
  const toggleAll = (rowList = parts) => setSelected((prev) => {
    const selectable = rowList.filter((p) => !p.unavailable);
    const names = selectable.map((p) => p.name);
    const allOn = names.length > 0 && names.every((n) => prev.has(n));
    const next = new Set(prev);
    if (allOn) names.forEach((n) => next.delete(n));
    else names.forEach((n) => next.add(n));
    return next;
  });

  const saveSelected = async () => {
    const toSave = parts.filter((p) => selected.has(p.name));
    if (!toSave.length) { toast({ variant: 'destructive', title: 'No partitions selected' }); return; }
    setBusy(true);
    try {
      for (const p of toSave) {
        const blob = getPartitionBlob(p);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tvconfig_emmc/${p.name}.bin`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        await new Promise((r) => setTimeout(r, 120));
      }
      addLog(`Saved ${toSave.length} selected partitions`);
      toast({ title: 'Saved', description: `${toSave.length} partitions saved to tvconfig_emmc/` });
    } finally { setBusy(false); }
  };

  const replaceSelectedFiles = async (fileList) => {
    const toReplace = parts.filter((p) => selected.has(p.name));
    if (!toReplace.length) return;
    setBusy(true);
    const next = { ...replacements };
    let replaced = 0;
    const failed = [];
    try {
      for (const file of fileList) {
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const match = toReplace.find((p) => p.name === baseName);
        if (!match) continue;
        const buf = await file.arrayBuffer();
        const data = new Uint8Array(buf);
        if (data.length > match.size) { failed.push(`${baseName} (${data.length} > ${match.size})`); continue; }
        next[match.name] = data;
        replaced++;
      }
      setReplacements(next);
      addLog(`Replaced ${replaced} selected partitions${failed.length ? `, ${failed.length} failed` : ''}`);
      toast({ title: replaced ? 'Replace done' : 'No matches', description: `${replaced} replaced${failed.length ? `, ${failed.length} failed` : ''}`, variant: failed.length && !replaced ? 'destructive' : 'default' });
    } finally { setBusy(false); }
  };

  const buildOutputBlob = () => composeDumpBlob({ file: file1, parts, replacements, overlays });

  const downloadDump = async (crcConfig) => {
    let blob = buildOutputBlob();
    if (crcConfig?.enabled) {
      setBusy(true);
      setProgress({ label: 'Computing CRC checksum…', percent: 0 });
      try {
        const width = crcConfig.width || 4;
        const size = blob.size;
        let crcOffset;
        if (crcConfig.offsetMode === 'tail') crcOffset = size - width;
        else if (crcConfig.offsetMode === 'start') crcOffset = 0;
        else { const v = String(crcConfig.offset).trim(); crcOffset = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10) || 0; }
        if (crcOffset >= 0 && crcOffset + width <= size) {
          const init = crcConfig.variant === 'crc32_posix' ? 0 : 0xFFFFFFFF;
          let crc = crc32Init(init);
          const chunkSize = 4 * 1024 * 1024;
          for (let off = 0; off < crcOffset; off += chunkSize) {
            const end = Math.min(off + chunkSize, crcOffset);
            const buf = new Uint8Array(await blob.slice(off, end).arrayBuffer());
            crc = crc32Update(crc, buf);
            setProgress({ label: 'Computing CRC checksum…', percent: Math.round((end / crcOffset) * 90) });
          }
          const val = crc32Final(crc);
          const crcBytes = new Uint8Array(width);
          if (crcConfig.endianness === 'le') { for (let i = 0; i < width; i++) crcBytes[i] = (val >>> (i * 8)) & 0xff; }
          else { for (let i = 0; i < width; i++) crcBytes[width - 1 - i] = (val >>> (i * 8)) & 0xff; }
          blob = new Blob([blob.slice(0, crcOffset), crcBytes, blob.slice(crcOffset + width)], { type: 'application/octet-stream' });
          addLog(`CRC repaired at 0x${crcOffset.toString(16).toUpperCase()}: 0x${val.toString(16).toUpperCase().padStart(width * 2, '0')}`);
        }
        setProgress({ label: 'Saving dump…', percent: 100 });
        await new Promise((r) => setTimeout(r, 250));
      } finally { setBusy(false); setProgress(null); }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (dirty || crcConfig?.enabled) ? file1.name.replace(/(\.[^.]+)?$/, '_repaired$1') : file1.name;
    a.click();
    URL.revokeObjectURL(url);
    addLog(`Downloaded dump (${formatBytes(file1.size)})${dirty ? ` · ${Object.keys(replacements).length} partitions replaced` : ''}${crcConfig?.enabled ? ' · CRC repaired' : ''}`);
  };

  const getPartitionBlob = (p) => composePartitionBlob({ file: file1, partition: p, replacements, overlays });

  const unpackAll = async () => {
    if (!parts.length) { toast({ variant: 'destructive', title: 'No partitions', description: 'No partitions found to unpack.' }); return; }
    setBusy(true);
    setProgress({ label: 'Unpacking partitions…', percent: 0 });
    let count = 0;
    try {
      for (const p of parts) {
        if (p.unavailable || (p.availableSize != null && p.availableSize <= 0)) continue;
        const blob = getPartitionBlob(p);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tvconfig_emmc/${p.name}.bin`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        count++;
        setProgress({ label: `Unpacking ${p.name}…`, percent: Math.round((count / parts.length) * 100) });
        await new Promise((r) => setTimeout(r, 120));
      }
      addLog(`Unpacked ${count} partitions to tvconfig_emmc/ folder`);
      toast({ title: 'Unpack complete', description: `${count} partitions saved to tvconfig_emmc/ folder` });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Unpack failed', description: e.message });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const repack = async (fileList) => {
    setBusy(true);
    const next = { ...replacements };
    let replaced = 0;
    const failed = [];
    try {
      for (const file of fileList) {
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const match = parts.find((p) => p.name === baseName);
        if (!match) continue;
        const buf = await file.arrayBuffer();
        const data = new Uint8Array(buf);
        if (data.length > match.size) { failed.push(`${baseName} (${data.length} > ${match.size})`); continue; }
        next[match.name] = data;
        replaced++;
      }
      setReplacements(next);
      addLog(`Repacked: ${replaced} partitions replaced${failed.length ? `, ${failed.length} failed` : ''}`);
      toast({ title: replaced ? 'Repack done' : 'No matches', description: `${replaced} replaced${failed.length ? `, ${failed.length} failed` : ''}`, variant: failed.length && !replaced ? 'destructive' : 'default' });
    } finally {
      setBusy(false);
    }
  };

  const savePartition = (p) => {
    const readSize = p.availableSize ?? p.size;
    if (p.unavailable || readSize <= 0) {
      toast({ variant: 'destructive', title: 'Save failed', description: `Partition "${p.name}" is beyond physical dump EOF and cannot be saved.` });
      return;
    }
    const blob = getPartitionBlob(p);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.name}.bin`;
    a.click();
    URL.revokeObjectURL(url);
    addLog(`Saved partition "${p.name}" (${formatBytes(readSize)})${p.truncated ? ' (partial)' : ''}`);
  };

  const replacePartitionFile = (p, file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = new Uint8Array(reader.result);
      if (data.length > p.size) {
        toast({ variant: 'destructive', title: 'Replace failed', description: `File (${formatBytes(data.length)}) exceeds partition size (${formatBytes(p.size)})` });
        return;
      }
      setReplacements((prev) => ({ ...prev, [p.name]: data }));
      addLog(`Replaced partition "${p.name}" with ${file.name} (${formatBytes(data.length)})`);
      toast({ title: 'Partition replaced', description: `"${p.name}" updated (${formatBytes(data.length)})` });
    };
    reader.readAsArrayBuffer(file);
  };

  const explore = async (p) => {
    setBusy(true);
    try {
      const session = await loadExplorePartition({
        file: file1,
        startByte: p.startByte,
        size: p.size,
        availableSize: p.availableSize ?? p.size,
        unavailable: !!p.unavailable,
        name: p.name,
        replacementBytes: replacements[p.name] || null,
        existingOverlay: overlays[p.name] || null,
      });
      setExploreBytes(session.bytes);
      setExploreReader(session.reader);
      setExploreReadOnlyReason(session.readOnlyReason);
      setExploreInPlaceOnly(!!session.inPlaceOnly);
      setExplorePart(p);
      if (session.overlay) {
        setOverlays((prev) => ({ ...prev, [p.name]: session.overlay }));
      }
      if (session.mode === 'memory') {
        addLog(`Exploring partition "${p.name}" (${formatBytes(p.availableSize ?? p.size)})`);
      } else {
        addLog(`Exploring partition "${p.name}" (${formatBytes(p.availableSize ?? p.size)}) via ranged reads`);
        if (session.memoryError) {
          toast({
            title: 'Large-partition explore',
            description: session.readOnlyReason,
          });
        }
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Explore failed', description: e.message });
    } finally {
      setBusy(false);
    }
  };

  // Explore mode: show Ext4Browser for the selected partition
  if (explorePart && (exploreBytes || exploreReader)) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => { setExplorePart(null); setExploreBytes(null); setExploreReader(null); setExploreReadOnlyReason(null); setExploreInPlaceOnly(false); }} className="text-muted-foreground hover:text-foreground" aria-label="Back to partition table"><ArrowLeft className="w-4 h-4" /></button>
              <div className="w-9 h-9 rounded-lg bg-sky-600 flex items-center justify-center"><HardDrive className="w-5 h-5 text-white" /></div>
              <div>
                <h1 className="text-base font-semibold tracking-tight">Explore: {explorePart.name}</h1>
                <p className="text-xs text-muted-foreground">{formatBytes(explorePart.size)} · ext4 partition</p>
              </div>
              <ToolNav current="emmc" />
            </div>
            <div className="flex items-center gap-2">
              <button onClick={revert} className="flex items-center gap-1.5 text-xs rounded-md border border-border px-3 py-1.5 hover:bg-accent transition-colors"><RotateCcw className="w-3.5 h-3.5" /> Revert</button>
              <button onClick={downloadDump} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 font-medium transition-colors"><Download className="w-3.5 h-3.5" /> {dirty ? 'Rebuild & Download' : 'Download'}</button>
            </div>
          </div>
        </header>
        <main className="max-w-6xl mx-auto px-5 py-6">
          <div className="rounded-xl border border-border bg-card p-3">
            <Ext4Browser
              bytes={exploreBytes}
              reader={exploreReader}
              readOnlyReason={exploreReadOnlyReason}
              inPlaceOnly={exploreInPlaceOnly}
              dirty={dirty}
              onPatched={(patched) => {
                setReplacements((prev) => ({ ...prev, [explorePart.name]: patched }));
                setExploreBytes(patched);
                setExploreReader(null);
                setExploreReadOnlyReason(null);
                setExploreInPlaceOnly(false);
                addLog(`Patched ext4 in "${explorePart.name}"`);
              }}
              onOverlayPatched={() => {
                setOverlayTick((n) => n + 1);
                addLog(`In-place edit in "${explorePart.name}"`);
              }}
              onDownload={downloadDump}
              onReset={revert}
            />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {file1 && (
              <button
                type="button"
                onClick={resetToStart}
                className="flex items-center gap-1.5 text-xs rounded-md border border-border px-3 py-1.5 hover:bg-accent transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
            )}
            <div className="w-9 h-9 rounded-lg bg-sky-600 flex items-center justify-center"><HardDrive className="w-5 h-5 text-white" /></div>
            <div>
              <h1 className="text-base font-semibold tracking-tight">EMMC Dump Tool</h1>
              <p className="text-xs text-muted-foreground">Analyze · Unpack · Repack · Partition</p>
            </div>
            <ToolNav current="emmc" />
          </div>
          {file1 && (
            <div className="flex items-center gap-2">
              {dirty && <button onClick={revert} className="flex items-center gap-1.5 text-xs rounded-md border border-border px-3 py-1.5 hover:bg-accent transition-colors"><RotateCcw className="w-3.5 h-3.5" /> Revert</button>}
              <button onClick={downloadDump} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 font-medium transition-colors"><Download className="w-3.5 h-3.5" /> {dirty ? 'Rebuild & Download' : 'Download'}</button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 space-y-6">
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">EMMC Dump</p>
          <FileDropzone onFile={loadMain} file={file1} onClear={resetToStart} />
        </div>

        {progress && (
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">{progress.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{progress.percent}%</span>
            </div>
            <Progress value={progress.percent} className="h-2" />
          </div>
        )}
        {busy && !progress && <div className="flex items-center justify-center py-4"><div className="w-6 h-6 border-2 border-sky-200 border-t-sky-600 rounded-full animate-spin" /></div>}

        {file1 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Dump size" value={formatBytes(file1.size)} />
              <Stat label="PT type" value={ptTypeLabel(gptFound, userAreaAnalysis, parts)} accent={parts.length > 0} />
              <Stat label="Partitions" value={String(parts.length)} />
              <Stat label="Status" value={dirty ? `Modified (${Object.keys(replacements).length})` : 'Original'} accent={dirty} />
            </div>

            <FirmwareHeaderPanel analysis={firmwareAnalysis} />

            <div className="flex flex-wrap items-center gap-2">
              <button onClick={unpackAll} disabled={busy} className="flex items-center gap-1.5 text-xs rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white px-3 py-2 font-medium transition-colors"><FolderArchive className="w-3.5 h-3.5" /> {busy ? 'Working…' : 'Unpack all'}</button>
              <button onClick={() => folderInputRef.current?.click()} disabled={busy} className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-3 py-2 font-medium transition-colors"><FolderInput className="w-3.5 h-3.5" /> Repack from folder</button>
              {selected.size > 0 && (
                <>
                  <button onClick={saveSelected} disabled={busy} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-3 py-2 font-medium transition-colors"><Save className="w-3.5 h-3.5" /> Save selected ({selected.size})</button>
                  <button onClick={() => replaceSelectedInputRef.current?.click()} disabled={busy} className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-3 py-2 font-medium transition-colors"><Upload className="w-3.5 h-3.5" /> Replace selected</button>
                </>
              )}
            </div>
            <input ref={folderInputRef} type="file" className="hidden" webkitdirectory="" directory="" multiple onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) repack(fs); e.target.value = ''; }} />
            <input ref={replaceInputRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && replaceTarget.current) replacePartitionFile(replaceTarget.current, f); e.target.value = ''; replaceTarget.current = null; }} />
            <input ref={replaceSelectedInputRef} type="file" className="hidden" multiple onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) replaceSelectedFiles(fs); e.target.value = ''; }} />

            <UserAreaAnalysis analysis={userAreaAnalysis} />

            <FilesystemDetections hits={filesystemHits} scannedBytes={gptBytes?.length || 0} />

            <div className="grid lg:grid-cols-3 gap-6 lg:items-start">
              <div className="lg:col-span-2 rounded-xl border border-border bg-card overflow-hidden flex flex-col min-h-0 max-h-[min(36rem,70vh)]">
                <div className="px-3 py-2 border-b border-border text-sm font-semibold flex items-center gap-2 shrink-0"><HardDrive className="w-4 h-4 text-sky-600" /> Partition Table</div>
                <div className="p-2 flex-1 min-h-0 flex flex-col">
                  <PartitionTable parts={parts} ext4Map={ext4Map} selected={selected} onToggle={toggleSelect} onToggleAll={toggleAll} onSave={savePartition} onReplace={(p) => { replaceTarget.current = p; replaceInputRef.current?.click(); }} onExplore={explore} />
                </div>
              </div>
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="text-sm font-semibold mb-3 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-600" /> CRC Checksum Repair</div>
                  <CrcPanelEmmc getOutputBlob={buildOutputBlob} onDownload={downloadDump} disabled={!file1} />
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="text-sm font-semibold mb-2">Operation Log</div>
                  <LogPanel entries={log} />
                </div>
              </div>
            </div>
          </>
        )}

        {!file1 && (
          <div className="text-center py-10 text-sm text-muted-foreground max-w-md mx-auto">
            Load an EMMC dump (full dump or user area, any size) or a vendor firmware file
            (Amlogic, MediaTek, MStar, HiSilicon, Realtek, LG webOS, Samsung, Novatek, or ZIP/PKG container).
            Only the partition table is read into memory — partitions are streamed on demand, so even
            multi-GB dumps work. Unpack, repack, and explore ext4 partitions — all offline.
          </div>
        )}
      </main>
    </div>
  );
}

function ptTypeLabel(gptFound, userAreaAnalysis, parts) {
  if (gptFound) return 'GPT';
  const selectedType = Array.isArray(parts) ? parts[0]?.ptType : null;
  const t = selectedType || userAreaAnalysis?.tableType;
  if (t === 'emmc_1630_5840') return 'eMMC 0x1630/0x5840 Map';
  if (t === 'aml_mpt') return 'Amlogic MPT';
  if (t === 'blkdevparts_mmc') return 'blkdevparts';
  if (t === 'mtdparts_emmc') return 'mtdparts';
  if (t === 'mbr') return 'MBR';
  if (t && t !== 'none') return t;
  const n = Array.isArray(parts) ? parts.length : parts;
  if (n) return 'MBR';
  return 'None';
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold mt-0.5 break-words ${accent ? 'text-sky-600' : ''}`}>{value}</p>
    </div>
  );
}