import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Folder, FolderOpen, FileText, Save, AlertTriangle, ArrowLeft, ChevronRight, ChevronDown, Download, RotateCcw, HardDrive, Image as ImageIcon, Upload, Archive, FolderInput, Trash2, Plus, FilePlus } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';

const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;
const isImage = (path) => IMG_EXT.test(path);
const mimeFromPath = (path) => {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'webp') return 'image/webp';
  return 'application/octet-stream';
};
const detectImageType = (raw) => {
  if (raw.length < 4) return null;
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'jpeg';
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) return 'png';
  if (raw[0] === 0x42 && raw[1] === 0x4d) return 'bmp';
  if (raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46) return 'gif';
  if (raw.length >= 12 && raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46 && raw[8] === 0x57 && raw[9] === 0x45 && raw[10] === 0x42 && raw[11] === 0x50) return 'webp';
  return null;
};
import { isExt4, parseSuperblock, listFiles, readFileBytes, patchFile, getAllocatedSpace, getFreeSpace, growAndPatchFile, deleteFile, createFile } from '@/lib/ext4';
import { parseSuperblockRange, listFilesRange, readFileBytesRange, getFreeSpaceRange } from '@/lib/ext4Range';
import { createZip } from '@/lib/zipWriter';
import { formatBytes } from '@/lib/binaryUtils';
import HexViewer from '@/components/tv/HexViewer';
import { Progress } from '@/components/ui/progress';

const isBinaryFile = (path, raw) => {
  if (/\.(bin|img|dat|fw|rom|dump)$/i.test(path)) return true;
  const sample = raw.subarray(0, Math.min(raw.length, 1024));
  if (!sample.length) return false;
  let nonPrint = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32) || b > 126) nonPrint++;
  }
  return nonPrint / sample.length > 0.1;
};

function buildTree(files) {
  const root = { name: '', path: '', children: {}, isDir: true };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc += '/' + part;
      const isLast = i === parts.length - 1;
      const isDir = isLast ? f.isDir : true;
      if (!node.children[part]) {
        node.children[part] = { name: part, path: acc, children: {}, isDir, file: isLast ? f : null };
      }
      node = node.children[part];
    }
  }
  // convert children maps to sorted arrays
  const fix = (n) => {
    n.items = Object.values(n.children).sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    n.items.forEach(fix);
  };
  fix(root);
  return root;
}

function TreeNode({ node, depth, expanded, toggle, selected, onSelect, onAddFile, onSelectFolder, selectedFolder }) {
  const isExpanded = expanded[node.path];
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => { if (node.isDir) { onSelectFolder(node.path); toggle(node.path); } else onSelect(node.file); }}
        className={`group w-full flex items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent/50 ${selected === node.path ? 'bg-accent' : ''} ${selectedFolder === node.path ? 'bg-emerald-500/10 ring-1 ring-emerald-500/30' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        {node.isDir ? (
          <>
            {node.items.length ? (isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />) : <span className="w-3.5 shrink-0" />}
            {isExpanded ? <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" /> : <Folder className="w-4 h-4 text-amber-500 shrink-0" />}
            <span className="text-sm truncate flex-1">{node.name || '/'}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAddFile(node.path); }}
              title="Add file to this folder"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex items-center justify-center w-5 h-5 rounded hover:bg-emerald-500/15 text-emerald-600 shrink-0 transition-opacity"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <>
            <span className="w-3.5 shrink-0" />
            {isImage(node.name) ? <ImageIcon className="w-4 h-4 text-sky-500 shrink-0" /> : <FileText className="w-4 h-4 text-emerald-500 shrink-0" />}
            <span className="text-sm truncate flex-1">{node.name}</span>
            <span className="text-xs text-muted-foreground shrink-0">{formatBytes(node.file.size)}</span>
          </>
        )}
      </div>
      {node.isDir && isExpanded && node.items.map((c) => (
        <TreeNode key={c.path} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} selected={selected} onSelect={onSelect} onAddFile={onAddFile} onSelectFolder={onSelectFolder} selectedFolder={selectedFolder} />
      ))}
    </div>
  );
}

export default function Ext4Browser({ bytes, reader, onPatched, onDownload, onReset, dirty }) {
  const writable = !!bytes;
  const [rangeMeta, setRangeMeta] = useState(null);
  const [rangeErr, setRangeErr] = useState(null);
  const [rangeLoading, setRangeLoading] = useState(false);

  useEffect(() => {
    if (bytes || !reader) {
      setRangeMeta(null);
      setRangeErr(null);
      setRangeLoading(false);
      return undefined;
    }
    let cancelled = false;
    setRangeLoading(true);
    (async () => {
      try {
        const parsed = await parseSuperblockRange(reader);
        if (!parsed) throw new Error('This image is not an ext4 filesystem (no ext4 superblock magic found).');
        const listed = await listFilesRange(reader, parsed);
        const free = await getFreeSpaceRange(reader, parsed);
        if (!cancelled) {
          setRangeMeta({ sb: parsed, files: listed, freeSpace: free });
          setRangeErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setRangeMeta(null);
          setRangeErr(e.message || String(e));
        }
      } finally {
        if (!cancelled) setRangeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reader, bytes]);

  const memSb = useMemo(() => (bytes && isExt4(bytes) ? parseSuperblock(bytes) : null), [bytes]);
  const memFiles = useMemo(() => (bytes && memSb ? listFiles(bytes, memSb) : []), [bytes, memSb]);
  const memFree = useMemo(() => (bytes && memSb ? getFreeSpace(bytes, memSb) : 0), [bytes, memSb]);
  const sb = bytes ? memSb : rangeMeta?.sb;
  const files = bytes ? memFiles : (rangeMeta?.files || []);
  const freeSpace = bytes ? memFree : (rangeMeta?.freeSpace || 0);
  const tree = useMemo(() => buildTree(files), [files]);
  const [expanded, setExpanded] = useState({ '/': true });
  const [selected, setSelected] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [content, setContent] = useState('');
  const [origContent, setOrigContent] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [imgUrl, setImgUrl] = useState(null);
  const [imgDirty, setImgDirty] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [imgValid, setImgValid] = useState(true);
  const [rawBytes, setRawBytes] = useState(null);
  const [isBinary, setIsBinary] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const replaceInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const addFileInputRef = useRef(null);
  const addTargetFolder = useRef('');

  const loadFileBytes = async (inodeNum) => {
    if (bytes) return readFileBytes(bytes, inodeNum, sb);
    return readFileBytesRange(reader, inodeNum, sb);
  };

  useEffect(() => {
    setImgDirty(false);
    setImgError(false);
    let cancelled = false;
    const run = async () => {
      if (selected) {
        const raw = await loadFileBytes(selected.inode);
        if (cancelled) return;
        if (isImage(selected.path)) {
          const detected = detectImageType(raw);
          if (detected) {
            const mime = detected === 'jpeg' ? 'image/jpeg' : detected === 'png' ? 'image/png' : detected === 'bmp' ? 'image/bmp' : detected === 'gif' ? 'image/gif' : 'image/webp';
            const blob = new Blob([raw], { type: mime });
            setImgUrl(URL.createObjectURL(blob));
            setImgValid(true);
          } else {
            setImgValid(false);
            setImgUrl(null);
          }
          setContent('');
          setOrigContent('');
        } else {
          const bin = isBinaryFile(selected.path, raw);
          setIsBinary(bin);
          if (bin) {
            setRawBytes(raw);
            setContent(''); setOrigContent('');
          } else {
            setRawBytes(null);
            setContent(new TextDecoder('utf-8', { fatal: false }).decode(raw));
            setOrigContent(new TextDecoder('utf-8', { fatal: false }).decode(raw));
          }
        }
        setError('');
      } else {
        setContent('');
        setOrigContent('');
        setImgUrl(null);
      }
    };
    run();
    return () => {
      cancelled = true;
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    };
  }, [selected, bytes, sb, reader]);

  if (!bytes && rangeLoading) {
    return <p className="text-sm text-muted-foreground p-4">Reading ext4 metadata…</p>;
  }
  if (!bytes && rangeErr) {
    return <p className="text-sm text-rose-500 p-4">{rangeErr}</p>;
  }
  if (!sb) return <p className="text-sm text-muted-foreground p-4">This image is not an ext4 filesystem (no ext4 superblock magic found).</p>;

  const allocSpace = selected
    ? (bytes ? getAllocatedSpace(bytes, selected.inode, sb) : (selected.allocated || selected.size || 0))
    : 0;

  const requireWritable = () => {
    if (writable) return true;
    toast({
      variant: 'destructive',
      title: 'Read-only explore',
      description: 'In-place edit, replace, delete, and add are unavailable for range-backed partitions. Viewing and extract still work.',
    });
    return false;
  };

  const toggle = (p) => setExpanded((e) => ({ ...e, [p]: !e[p] }));
  const regular = files.filter((f) => !f.isDir);
  const dirCount = files.filter((f) => f.isDir).length;
  const scopedRegular = selectedFolder
    ? regular.filter((f) => { const fld = selectedFolder.replace(/\/+$/, ''); return f.path === fld || f.path.startsWith(fld + '/'); })
    : regular;

  const save = () => {
    if (!requireWritable()) return;
    setError('');
    try {
      const next = new Uint8Array(bytes);
      const res = patchFile(next, selected.inode, sb, content);
      onPatched(next);
      setOrigContent(content);
      setSelected({ ...selected, size: res.newSize });
      toast({ title: 'Saved successfully', description: `${selected.path} updated in-place (${res.newSize} B)` });
    } catch (e) { setError(e.message || String(e)); toast({ variant: 'destructive', title: 'Save failed', description: e.message || String(e) }); }
  };

  const dirtyFile = content !== origContent;

  const editByteInFile = (index, value) => {
    if (!requireWritable()) return;
    const raw = readFileBytes(bytes, selected.inode, sb);
    raw[index] = value & 0xff;
    const next = new Uint8Array(bytes);
    patchFile(next, selected.inode, sb, raw);
    onPatched(next);
    setRawBytes(raw);
    setImgDirty(true);
  };

  const exportFile = async () => {
    const raw = await loadFileBytes(selected.inode);
    const blob = new Blob([raw], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selected.path.split('/').pop() || 'export.bin';
    a.click();
    URL.revokeObjectURL(url);
  };

  const replaceFile = (file) => {
    if (!requireWritable()) return;
    setError('');
    const reader = new FileReader();
    reader.onload = () => {
      const newBytes = new Uint8Array(reader.result);
      try {
        const next = new Uint8Array(bytes);
        const res = newBytes.length > allocSpace
          ? growAndPatchFile(next, selected.inode, sb, newBytes)
          : patchFile(next, selected.inode, sb, newBytes);
        onPatched(next);
        setSelected({ ...selected, size: res.newSize });
        setImgDirty(true);
        toast({
          title: 'Replace successful',
          description: res.grown
            ? `${selected.path} grown by ${res.grown} blocks → ${res.newSize} B`
            : `${selected.path} updated (${res.newSize} B)`,
        });
      } catch (e) {
        setError(e.message || String(e));
        toast({ variant: 'destructive', title: 'Replace failed', description: e.message || String(e) });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const deleteSelected = () => {
    if (!requireWritable()) return;
    if (!window.confirm(`Delete "${selected.path}" from the ext4 partition? This reclaims its data blocks.`)) return;
    setError('');
    try {
      const next = new Uint8Array(bytes);
      deleteFile(next, selected.inode, sb, selected.path);
      onPatched(next);
      const removed = selected.path;
      setSelected(null);
      toast({ title: 'File deleted', description: `${removed} removed` });
    } catch (e) {
      setError(e.message || String(e));
      toast({ variant: 'destructive', title: 'Delete failed', description: e.message || String(e) });
    }
  };

  const handleAddFile = (folderPath) => {
    addTargetFolder.current = folderPath;
    addFileInputRef.current?.click();
  };

  const addFile = (file) => {
    if (!requireWritable()) return;
    setError('');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result);
        const next = new Uint8Array(bytes);
        const folder = addTargetFolder.current;
        const res = createFile(next, sb, folder, file.name, data);
        onPatched(next);
        setExpanded((e) => ({ ...e, [folder]: true }));
        toast({ title: 'File added', description: `${file.name} → ${folder || '/'} (${res.size} B)` });
      } catch (e) {
        setError(e.message || String(e));
        toast({ variant: 'destructive', title: 'Add failed', description: e.message || String(e) });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const extractAll = async () => {
    setExtracting(true);
    const allFiles = [];
    for (const f of scopedRegular) {
      allFiles.push({
        relPath: f.path.replace(/^\//, ''),
        data: await loadFileBytes(f.inode),
      });
    }
    if (!allFiles.length) {
      toast({ variant: 'destructive', title: 'Nothing to extract', description: selectedFolder ? `No files found under "${selectedFolder}"` : 'No files in this partition' });
      setExtracting(false);
      setExtractProgress(null);
      return;
    }
    setExtractProgress({ current: 0, total: allFiles.length, name: '' });
    const finish = () => { setExtracting(false); setTimeout(() => setExtractProgress(null), 900); };
    // Direct folder extraction via the File System Access API: one folder
    // picker, then all files (with their subfolder structure) are written
    // straight into that folder — no ZIP, no per-file Save-As prompts.
    // The picker is blocked in a cross-origin iframe (e.g. the preview
    // shell); in that case fall back to a single ZIP download (one prompt,
    // folder structure preserved inside the archive).
    const downloadZip = async () => {
      setExtractProgress({ current: 0, total: allFiles.length, name: 'Bundling into ZIP…' });
      const zipBlob = await createZip(allFiles.map((f) => ({ name: f.relPath, data: f.data })));
      setExtractProgress({ current: allFiles.length, total: allFiles.length, name: '' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'extracted_config.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };

    if (!window.showDirectoryPicker) {
      await downloadZip();
      toast({ title: 'Extract complete', description: `${allFiles.length} files bundled into extracted_config.zip. Open the app in a new tab for direct folder extraction.` });
      finish();
      return;
    }
    try {
      let rootHandle;
      try {
        rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        if (e && e.name === 'AbortError') { finish(); return; } // user cancelled
        throw e;
      }
      let saved = 0;
      for (const f of allFiles) {
        setExtractProgress({ current: saved, total: allFiles.length, name: f.relPath });
        const parts = f.relPath.split('/');
        let dir = rootHandle;
        for (let i = 0; i < parts.length - 1; i++) {
          dir = await dir.getDirectoryHandle(parts[i], { create: true });
        }
        const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(f.data);
        await writable.close();
        saved++;
      }
      setExtractProgress({ current: allFiles.length, total: allFiles.length, name: '' });
      toast({ title: 'Extract complete', description: `${saved} files saved directly into "${rootHandle.name}"` });
      finish();
    } catch (e) {
      // Picker blocked (e.g. cross-origin iframe) — fall back to a ZIP.
      await downloadZip();
      toast({ title: 'Extract complete', description: `${allFiles.length} files bundled into extracted_config.zip. Open the app in a new tab for direct folder extraction.` });
      finish();
    }
  };

  const replaceFromFolder = async (fileList) => {
    if (!requireWritable()) return;
    setBulkBusy(true);
    let next = new Uint8Array(bytes);
    let replaced = 0;
    const failed = [];
    for (const file of fileList) {
      const relPath = (file.webkitRelativePath || file.name).replace(/^\//, '');
      const match = scopedRegular.find((f) => f.path.replace(/^\//, '') === relPath);
      if (!match) continue;
      const buf = await file.arrayBuffer();
      const newBytes = new Uint8Array(buf);
      const alloc = getAllocatedSpace(next, match.inode, sb);
      try {
        if (newBytes.length > alloc) {
          growAndPatchFile(next, match.inode, sb, newBytes);
        } else {
          patchFile(next, match.inode, sb, newBytes);
        }
        replaced++;
      } catch (e) {
        failed.push(`${relPath}: ${e.message}`);
      }
    }
    if (replaced > 0) { onPatched(next); }
    toast({
      title: replaced > 0 ? 'Bulk replace done' : 'No files replaced',
      description: `${replaced} replaced${failed.length ? `, ${failed.length} failed` : ''}`,
      variant: failed.length && !replaced ? 'destructive' : 'default',
    });
    setBulkBusy(false);
  };

  // filtered flat view when searching
  const filtered = filter ? regular.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) : null;

  if (selected) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-1 pb-2 border-b border-border mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground shrink-0"><ArrowLeft className="w-4 h-4" /></button>
            {isImage(selected.path) ? <ImageIcon className="w-4 h-4 text-sky-500 shrink-0" /> : <FileText className="w-4 h-4 text-emerald-500 shrink-0" />}
            <span className="text-sm font-mono truncate">{selected.path}</span>
            <span className="text-xs text-muted-foreground shrink-0">{formatBytes(selected.size)}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={exportFile} className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent px-3 py-1.5 font-medium transition-colors">
              <Download className="w-3.5 h-3.5" /> Save
            </button>
            <button disabled={!writable} onClick={() => replaceInputRef.current?.click()} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-3 py-1.5 font-medium transition-colors">
              <Upload className="w-3.5 h-3.5" /> Replace
            </button>
            <button disabled={!writable} onClick={deleteSelected} className="flex items-center gap-1.5 text-xs rounded-md bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white px-3 py-1.5 font-medium transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            {!isImage(selected.path) && !isBinary && (
              <button onClick={save} disabled={!writable || !dirtyFile} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-3 py-1.5 font-medium transition-colors">
                <Save className="w-3.5 h-3.5" /> Save in-place
              </button>
            )}
          </div>
        </div>
        {!writable && (
          <p className="text-[11px] text-amber-600 mb-2">Read-only explore (range I/O). Extract and view work; in-place edit is disabled so the partition is not loaded into memory.</p>
        )}
        <input ref={replaceInputRef} type="file" className="hidden" accept={isImage(selected.path) ? 'image/*,.bmp' : '*/*'} onChange={(e) => { const f = e.target.files?.[0]; if (f) replaceFile(f); e.target.value = ''; }} />
        {isImage(selected.path) ? (
          <div className="flex flex-col items-center justify-center bg-muted/30 rounded-md border border-input p-4 min-h-[360px]">
            {imgUrl && !imgError ? (
              <img key={imgUrl} src={imgUrl} alt={selected.name} onError={() => setImgError(true)}
                className="max-w-full max-h-[340px] object-contain rounded" />
            ) : <p className="text-sm text-muted-foreground">{!imgValid ? 'Not a standard image format — use Save to export the raw file.' : imgError ? 'Preview unavailable — use Save to export the raw file.' : 'No preview'}</p>}
            <p className="mt-3 text-xs text-muted-foreground">Boot logo · {formatBytes(selected.size)}{imgDirty ? ' · replaced' : ''}</p>
          </div>
        ) : isBinary ? (
          <div className="rounded-md border border-input bg-background min-h-[360px] overflow-hidden">
            <HexViewer bytes={rawBytes} onEditByte={writable ? editByteInFile : () => {}} />
          </div>
        ) : (
          <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false}
            className="flex-1 w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-emerald-500/40 min-h-[360px]" />
        )}
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className={dirtyFile || imgDirty ? 'text-amber-500' : 'text-muted-foreground'}>
            {isImage(selected.path)
              ? (imgDirty ? `Replaced · ${selected.size} B` : 'Unchanged')
              : isBinary
              ? (imgDirty ? `Modified · ${selected.size} B` : 'Unchanged')
              : (dirtyFile ? `Modified · ${content.length} B (orig ${origContent.length} B)` : 'Unchanged')}
          </span>
          {content.length > allocSpace && <span className="text-rose-500 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Exceeds allocated block space — save will fail</span>}
        </div>
        {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
        <p className="mt-2 text-[11px] text-muted-foreground">{isImage(selected.path) ? (imgDirty ? 'Image replaced — rebuild & download to keep the change.' : `Allocated ${allocSpace} B · ${formatBytes(freeSpace)} free. Larger replacements auto-grow the file allocation into free space.`) : `Edits write back into the file's existing data blocks. Content can grow up to ${allocSpace} B (allocated block space).`}</p>
      </div>
    );
  }

  return (
    <div>
      {!writable && (
        <p className="text-[11px] text-amber-600 mb-2">
          Read-only explore via ranged reads — this partition is not loaded into memory.
          Extract works; replace/add/edit require an in-memory copy (for example after Replace in the partition table).
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-3 min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <HardDrive className="w-3.5 h-3.5" /> {sb.blockSize} B · {regular.length} files · {dirCount} dirs
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {selectedFolder ? (
            <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 text-emerald-600 px-2 py-1 ring-1 ring-emerald-500/30 shrink-0 max-w-[280px]">
              Scope: {selectedFolder}
              <button type="button" onClick={() => setSelectedFolder('')} className="hover:text-emerald-700 font-medium">×</button>
            </span>
          ) : (
            <span className="text-muted-foreground px-2 py-1">Scope: all files</span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1 ml-auto min-w-0">
          <button onClick={extractAll} disabled={extracting} className="flex items-center gap-1.5 text-xs rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white px-2.5 py-1.5 font-medium transition-colors">
            <Archive className="w-3.5 h-3.5" /> {extracting ? 'Extracting…' : (selectedFolder ? 'Extract selected' : 'Extract all')}
          </button>
          <button onClick={() => folderInputRef.current?.click()} disabled={!writable || bulkBusy} className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-2.5 py-1.5 font-medium transition-colors">
            <FolderInput className="w-3.5 h-3.5" /> {bulkBusy ? 'Replacing…' : (selectedFolder ? 'Replace selected' : 'Replace all')}
          </button>
          <button disabled={!writable} onClick={() => handleAddFile(selectedFolder)} className="flex items-center gap-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-2.5 py-1.5 font-medium transition-colors max-w-[260px]"><FilePlus className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Add file to {selectedFolder || '/'}</span></button>
          <button onClick={() => setExpanded({ '/': true })} className="text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1.5">Collapse all</button>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…"
            className="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-emerald-500/40 w-36 max-w-full" />
        </div>
      </div>

      {extractProgress && (
        <div className="mb-3 rounded-md border border-border bg-card px-3 py-2">
          <div className="flex items-center justify-between mb-1.5 gap-2">
            <span className="text-xs font-medium truncate">{extractProgress.current >= extractProgress.total ? 'Finishing…' : `Extracting ${extractProgress.name || '…'}`}</span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">{extractProgress.current}/{extractProgress.total}</span>
          </div>
          <Progress value={extractProgress.total ? (extractProgress.current / extractProgress.total) * 100 : 0} className="h-1.5" />
        </div>
      )}

      <input ref={folderInputRef} type="file" className="hidden" webkitdirectory="" directory="" multiple
        onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) replaceFromFolder(files); e.target.value = ''; }} />
      <input ref={addFileInputRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) addFile(f); e.target.value = ''; }} />

      {filter ? (
        <div className="max-h-[400px] overflow-y-auto pr-1 space-y-0.5">
          {filtered.map((f) => (
            <button key={f.inode} onClick={() => setSelected(f)} className="w-full flex items-center gap-2 rounded-md hover:bg-accent/50 px-2 py-1.5 text-left">
              {isImage(f.path) ? <ImageIcon className="w-4 h-4 text-sky-500 shrink-0" /> : <FileText className="w-4 h-4 text-emerald-500 shrink-0" />}
              <span className="text-sm font-mono truncate flex-1">{f.path}</span>
              <span className="text-xs text-muted-foreground shrink-0">{formatBytes(f.size)}</span>
            </button>
          ))}
          {!filtered.length && <p className="text-sm text-muted-foreground p-4">No files match.</p>}
        </div>
      ) : (
        <div className="max-h-[400px] overflow-y-auto pr-1">
          {tree.items.map((c) => (
            <TreeNode key={c.path} node={c} depth={0} expanded={expanded} toggle={toggle} selected={selected?.path} onSelect={setSelected} onAddFile={handleAddFile} onSelectFolder={setSelectedFolder} selectedFolder={selectedFolder} />
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 pt-3 border-t border-border">
        <button onClick={onDownload} disabled={!dirty} className="flex items-center gap-1.5 text-xs rounded-md bg-primary hover:bg-primary/90 disabled:opacity-40 text-primary-foreground px-3 py-2 font-medium">
          <Download className="w-3.5 h-3.5" /> Rebuild & download image
        </button>
        <button onClick={onReset} disabled={!dirty} className="flex items-center gap-1.5 text-xs rounded-md border border-border hover:bg-accent disabled:opacity-40 px-3 py-2">
          <RotateCcw className="w-3.5 h-3.5" /> Revert
        </button>
        {dirty && <span className="text-xs text-amber-500">Unsaved changes</span>}
      </div>
    </div>
  );
}