import React from 'react';
import { Cpu } from 'lucide-react';
import { formatBytes } from '@/lib/binaryUtils';

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

const VENDOR_TABLES = ['aml_mbr', 'mstar', 'nvtk', 'fastboot', 'uboot_env', 'hisi_emmc_map'];

function hex(n) { return '0x' + n.toString(16).toUpperCase(); }

function Cell({ label, value }) {
  return (
    <div className="rounded-md bg-muted/30 px-2.5 py-1.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xs font-medium truncate">{value}</p>
    </div>
  );
}

export default function UserAreaAnalysis({ analysis }) {
  if (!analysis) return null;
  const { soc, tableType, marker, partitions } = analysis;
  const vendorParsed = VENDOR_TABLES.includes(tableType);

  let note = 'No vendor-specific partition header detected in the user area.';
  if (tableType === 'gpt') note = 'Standard GPT layout — partitions listed in the table below.';
  else if (tableType === 'mbr') note = 'Standard MBR layout — partitions listed in the table below.';
  else if (tableType === 'none') note = 'No partition table signature found in the first 4 KB.';

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Cpu className="w-4 h-4 text-sky-600" /> User Area Analysis
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
        <Cell label="SoC / vendor" value={soc} />
        <Cell label="Partition table" value={tableType} />
        <Cell label="Detection marker" value={marker} />
      </div>
      {vendorParsed && partitions.length > 0 ? (
        <div className="border border-border rounded-md overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-2 py-1.5">#</th>
                <th className="text-left font-medium px-2 py-1.5">Name</th>
                <th className="text-left font-medium px-2 py-1.5">Offset</th>
                <th className="text-left font-medium px-2 py-1.5">Size</th>
                <th className="text-left font-medium px-2 py-1.5">Filesystem</th>
              </tr>
            </thead>
            <tbody>
              {partitions.map((p, i) => (
                <React.Fragment key={i}>
                  <tr className="border-t border-border">
                    <td className="px-2 py-1.5 text-muted-foreground">{i}</td>
                    <td className="px-2 py-1.5 font-mono">{p.name}</td>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">{hex(p.offset)}</td>
                    <td className="px-2 py-1.5 font-mono">{formatBytes(p.size)}</td>
                    <td className={`px-2 py-1.5 font-mono ${FS_COLORS[p.fsType] || 'text-muted-foreground'}`}>{p.fsType}</td>
                  </tr>
                  {p.bootInfo && (
                    <tr className="bg-muted/20">
                      <td></td>
                      <td className="px-2 py-1 text-[11px] text-muted-foreground" colSpan={4}>
                        boot v{p.bootInfo.headerVersion} · "{p.bootInfo.name}" · kernel {formatBytes(p.bootInfo.kernelSize)} · ramdisk {formatBytes(p.bootInfo.ramdiskSize)}{p.bootInfo.secondSize ? ` · 2nd ${formatBytes(p.bootInfo.secondSize)}` : ''} · page {p.bootInfo.pageSize}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{note}</p>
      )}
    </div>
  );
}