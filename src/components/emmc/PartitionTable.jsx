import React, { useEffect, useMemo, useState } from 'react';
import { Save, Upload, FolderOpen, Search, X } from 'lucide-react';
import { formatBytes } from '@/lib/binaryUtils';

const TYPE_STYLES = {
  'gpt': 'bg-emerald-500/10 text-emerald-600',
  'mbr': 'bg-amber-500/10 text-amber-600',
  'emmc-boot': 'bg-sky-500/10 text-sky-600',
  'emmc-rpmb': 'bg-rose-500/10 text-rose-600',
  'emmc-gp': 'bg-indigo-500/10 text-indigo-600',
  'emmc-hw': 'bg-purple-500/10 text-purple-600',
  'vendor': 'bg-teal-500/10 text-teal-600',
  'mtdparts_emmc': 'bg-cyan-500/10 text-cyan-700',
  'blkdevparts_mmc': 'bg-teal-500/10 text-teal-700',
  'realtek_partinfo': 'bg-sky-500/10 text-sky-700',
  'inferred_fs': 'bg-amber-500/10 text-amber-700 border border-amber-500/20',
};

const FS_COLORS = {
  ext4: 'text-emerald-600',
  f2fs: 'text-sky-600',
  android_boot: 'text-amber-600',
  squashfs: 'text-purple-600',
  android_sparse: 'text-orange-600',
  ubifs: 'text-rose-600',
  jffs2: 'text-pink-600',
  raw: 'text-muted-foreground',
};

const controlClass = 'h-8 text-xs rounded-md border border-border bg-transparent px-2 text-foreground';

function typeLabel(p) {
  if (p.ptType === 'gpt') return 'GPT';
  if (p.ptType === 'mbr') return `MBR·${p.typeName}`;
  if (p.ptType === 'emmc-boot') return 'BOOT';
  if (p.ptType === 'emmc-rpmb') return 'RPMB';
  if (p.ptType === 'emmc-gp') return 'GP';
  if (p.ptType === 'vendor') return 'VENDOR';
  if (p.ptType === 'emmc_1630_5840') return 'eMMC 0x1630/0x5840 Map';
  if (p.ptType === 'aml_mpt') return 'Amlogic MPT';
  if (p.ptType === 'realtek_partinfo') return 'PART.INFO';
  if (p.ptType === 'blkdevparts_mmc') return 'blkdevparts';
  if (p.ptType === 'mtdparts_emmc') return 'mtdparts';
  if (p.ptType === 'inferred_fs') return 'Inferred FS';
  if (p.ptType === 'emmc-hw') return 'HW';
  return 'HW';
}

function filesystemLabel(p, ext4Map) {
  if (ext4Map[p.name]) return 'ext4';
  return p.fsType || 'raw';
}

export default function PartitionTable({ parts, ext4Map, selected, onToggle, onToggleAll, onSave, onReplace, onExplore }) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [fsFilter, setFsFilter] = useState('');

  useEffect(() => {
    setQuery('');
    setTypeFilter('');
    setFsFilter('');
  }, [parts]);

  const typeOptions = useMemo(() => {
    const set = new Set();
    for (const p of parts) set.add(typeLabel(p));
    return [...set].sort();
  }, [parts]);

  const fsOptions = useMemo(() => {
    const set = new Set();
    for (const p of parts) set.add(filesystemLabel(p, ext4Map));
    return [...set].sort();
  }, [parts, ext4Map]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return parts.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (typeFilter && typeLabel(p) !== typeFilter) return false;
      if (fsFilter && filesystemLabel(p, ext4Map) !== fsFilter) return false;
      return true;
    });
  }, [parts, query, typeFilter, fsFilter, ext4Map]);

  const filtersActive = query.trim() !== '' || typeFilter !== '' || fsFilter !== '';
  const clearFilters = () => {
    setQuery('');
    setTypeFilter('');
    setFsFilter('');
  };

  if (!parts.length) return <p className="text-sm text-muted-foreground p-4">No partitions found in this dump.</p>;

  const selectableVisible = visible.filter((p) => !p.unavailable);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((p) => selected.has(p.name));

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2 shrink-0">
        <label className="relative flex-1 min-w-[10rem]">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name"
            aria-label="Search partitions by name"
            className={`${controlClass} w-full pl-7`}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Type
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Filter by partition type"
            className={`${controlClass} min-w-[7rem]`}
          >
            <option value="">All</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Filesystem
          <select
            value={fsFilter}
            onChange={(e) => setFsFilter(e.target.value)}
            aria-label="Filter by filesystem"
            className={`${controlClass} min-w-[7rem]`}
          >
            <option value="">All</option>
            {fsOptions.map((fs) => (
              <option key={fs} value={fs}>{fs}</option>
            ))}
          </select>
        </label>
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2 h-8 transition-colors shrink-0"
          >
            <X className="w-3 h-3" /> Clear filters
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            <p>No matching partitions</p>
            <button type="button" onClick={clearFilters} className="mt-2 text-xs rounded-md border border-border hover:bg-accent px-2.5 py-1.5 transition-colors">
              Clear filters
            </button>
          </div>
        ) : (
          <table className="w-full text-sm min-w-[40rem]">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="py-2 px-2 font-medium w-8 bg-card">
                  <input type="checkbox" checked={allVisibleSelected} onChange={() => onToggleAll(visible)} className="rounded" />
                </th>
                <th className="py-2 px-2 font-medium bg-card">#</th>
                <th className="py-2 px-2 font-medium bg-card">Name</th>
                <th className="py-2 px-2 font-medium bg-card">Type</th>
                <th className="py-2 px-2 font-medium bg-card">Start</th>
                <th className="py-2 px-2 font-medium bg-card">Size</th>
                <th className="py-2 px-2 font-medium bg-card">Filesystem</th>
                <th className="py-2 px-2 font-medium text-right bg-card">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const ext4 = ext4Map[p.name];
                const fs = filesystemLabel(p, ext4Map);
                const isSel = selected.has(p.name);
                const declaredSize = p.declaredSize ?? p.size;
                const availableSize = p.availableSize ?? p.size;
                const isTruncated = !!p.truncated;
                const isUnavailable = !!p.unavailable;
                const sizeTitle = isTruncated
                  ? `Declared: ${formatBytes(declaredSize)} · Available in dump: ${formatBytes(availableSize)}`
                  : isUnavailable
                  ? `Declared: ${formatBytes(declaredSize)} · Unavailable (0 B in dump)`
                  : undefined;
                return (
                  <tr key={`${p.ptType}-${p.index}`} className={`border-b border-border/50 ${isUnavailable ? 'opacity-60 bg-muted/10' : 'hover:bg-accent/30'} ${isSel ? 'bg-emerald-500/5' : ''}`}>
                    <td className="py-2 px-2">
                      <input type="checkbox" checked={isSel} disabled={isUnavailable} onChange={() => onToggle(p)} className="rounded disabled:opacity-40 disabled:cursor-not-allowed" />
                    </td>
                    <td className="py-2 px-2 text-muted-foreground">{p.index}</td>
                    <td className="py-2 px-2 font-mono whitespace-nowrap">{p.name}</td>
                    <td className="py-2 px-2 text-xs">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className={`rounded px-1.5 py-0.5 font-medium ${TYPE_STYLES[p.ptType] || 'bg-muted text-muted-foreground'}`}>{typeLabel(p)}</span>
                        {isTruncated && (
                          <span className="rounded px-1.5 py-0.5 font-medium text-[10px] bg-amber-500/10 text-amber-600 border border-amber-500/20" title={`Available in dump: ${formatBytes(availableSize)}`}>
                            Partial
                          </span>
                        )}
                        {isUnavailable && (
                          <span className="rounded px-1.5 py-0.5 font-medium text-[10px] bg-muted/80 text-muted-foreground border border-border" title="Partition is beyond physical dump EOF">
                            Unavailable
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-2 font-mono text-xs text-muted-foreground whitespace-nowrap">0x{p.startByte.toString(16).toUpperCase()}</td>
                    <td className="py-2 px-2 font-mono text-xs whitespace-nowrap" title={sizeTitle}>{formatBytes(declaredSize)}</td>
                    <td className={`py-2 px-2 font-mono text-xs whitespace-nowrap ${FS_COLORS[fs] || 'text-muted-foreground'}`}>{fs}</td>
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5 justify-end flex-wrap">
                        <button type="button" onClick={() => onSave(p)} disabled={isUnavailable} title={isUnavailable ? 'Unavailable partition cannot be saved' : undefined} className={`flex items-center gap-1 text-xs rounded-md border border-border px-2 py-1 transition-colors ${isUnavailable ? 'opacity-40 cursor-not-allowed' : 'hover:bg-accent'}`}>
                          <Save className="w-3 h-3" /> Save
                        </button>
                        <button type="button" onClick={() => onReplace(p)} disabled={isUnavailable} title={isUnavailable ? 'Unavailable partition cannot be replaced' : undefined} className={`flex items-center gap-1 text-xs rounded-md border border-border px-2 py-1 transition-colors ${isUnavailable ? 'opacity-40 cursor-not-allowed' : 'hover:bg-accent'}`}>
                          <Upload className="w-3 h-3" /> Replace
                        </button>
                        {ext4 && (
                          <button type="button" onClick={() => onExplore(p)} disabled={isUnavailable} title={isUnavailable ? 'Unavailable partition cannot be explored' : undefined} className={`flex items-center gap-1 text-xs rounded-md bg-sky-600 text-white px-2 py-1 transition-colors ${isUnavailable ? 'opacity-40 cursor-not-allowed' : 'hover:bg-sky-500'}`}>
                            <FolderOpen className="w-3 h-3" /> Explore
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
