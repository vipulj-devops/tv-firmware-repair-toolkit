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

  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.name));

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
                return (
                  <tr key={`${p.ptType}-${p.index}`} className={`border-b border-border/50 hover:bg-accent/30 ${isSel ? 'bg-emerald-500/5' : ''}`}>
                    <td className="py-2 px-2">
                      <input type="checkbox" checked={isSel} onChange={() => onToggle(p)} className="rounded" />
                    </td>
                    <td className="py-2 px-2 text-muted-foreground">{p.index}</td>
                    <td className="py-2 px-2 font-mono whitespace-nowrap">{p.name}</td>
                    <td className="py-2 px-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-medium ${TYPE_STYLES[p.ptType] || 'bg-muted text-muted-foreground'}`}>{typeLabel(p)}</span>
                    </td>
                    <td className="py-2 px-2 font-mono text-xs text-muted-foreground whitespace-nowrap">0x{p.startByte.toString(16).toUpperCase()}</td>
                    <td className="py-2 px-2 font-mono text-xs whitespace-nowrap">{formatBytes(p.size)}</td>
                    <td className={`py-2 px-2 font-mono text-xs whitespace-nowrap ${FS_COLORS[fs] || 'text-muted-foreground'}`}>{fs}</td>
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5 justify-end flex-wrap">
                        <button type="button" onClick={() => onSave(p)} className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2 py-1 transition-colors">
                          <Save className="w-3 h-3" /> Save
                        </button>
                        <button type="button" onClick={() => onReplace(p)} className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2 py-1 transition-colors">
                          <Upload className="w-3 h-3" /> Replace
                        </button>
                        {ext4 && (
                          <button type="button" onClick={() => onExplore(p)} className="flex items-center gap-1 text-xs rounded-md bg-sky-600 hover:bg-sky-500 text-white px-2 py-1 transition-colors">
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
