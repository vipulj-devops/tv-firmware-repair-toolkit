import React from 'react';
import { Save, Upload, FolderOpen } from 'lucide-react';
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

function typeLabel(p) {
  if (p.ptType === 'gpt') return 'GPT';
  if (p.ptType === 'mbr') return `MBR·${p.typeName}`;
  if (p.ptType === 'emmc-boot') return 'BOOT';
  if (p.ptType === 'emmc-rpmb') return 'RPMB';
  if (p.ptType === 'emmc-gp') return 'GP';
  if (p.ptType === 'vendor') return 'VENDOR';
  return 'HW';
}

export default function PartitionTable({ parts, ext4Map, selected, onToggle, onToggleAll, onSave, onReplace, onExplore }) {
  if (!parts.length) return <p className="text-sm text-muted-foreground p-4">No partitions found in this dump.</p>;
  const allSelected = parts.every((p) => selected.has(p.name));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b border-border">
            <th className="py-2 px-2 font-medium w-8">
              <input type="checkbox" checked={allSelected} onChange={onToggleAll} className="rounded" />
            </th>
            <th className="py-2 px-2 font-medium">#</th>
            <th className="py-2 px-2 font-medium">Name</th>
            <th className="py-2 px-2 font-medium">Type</th>
            <th className="py-2 px-2 font-medium">Start</th>
            <th className="py-2 px-2 font-medium">Size</th>
            <th className="py-2 px-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => {
            const ext4 = ext4Map[p.name];
            const isSel = selected.has(p.name);
            return (
              <tr key={`${p.ptType}-${p.index}`} className={`border-b border-border/50 hover:bg-accent/30 ${isSel ? 'bg-emerald-500/5' : ''}`}>
                <td className="py-2 px-2">
                  <input type="checkbox" checked={isSel} onChange={() => onToggle(p)} className="rounded" />
                </td>
                <td className="py-2 px-2 text-muted-foreground">{p.index}</td>
                <td className="py-2 px-2 font-mono">
                  {p.name}
                  {ext4 && <span className="text-[10px] text-sky-500 ml-1.5 align-middle">ext4</span>}
                </td>
                <td className="py-2 px-2 text-xs">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${TYPE_STYLES[p.ptType] || 'bg-muted text-muted-foreground'}`}>{typeLabel(p)}</span>
                </td>
                <td className="py-2 px-2 font-mono text-xs text-muted-foreground">0x{p.startByte.toString(16).toUpperCase()}</td>
                <td className="py-2 px-2 font-mono text-xs">{formatBytes(p.size)}</td>
                <td className="py-2 px-2">
                  <div className="flex items-center gap-1.5 justify-end">
                    <button onClick={() => onSave(p)} className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2 py-1 transition-colors">
                      <Save className="w-3 h-3" /> Save
                    </button>
                    <button onClick={() => onReplace(p)} className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2 py-1 transition-colors">
                      <Upload className="w-3 h-3" /> Replace
                    </button>
                    {ext4 && (
                      <button onClick={() => onExplore(p)} className="flex items-center gap-1 text-xs rounded-md bg-sky-600 hover:bg-sky-500 text-white px-2 py-1 transition-colors">
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
    </div>
  );
}