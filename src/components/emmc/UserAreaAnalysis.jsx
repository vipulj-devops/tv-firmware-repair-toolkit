import React from 'react';
import { Cpu } from 'lucide-react';
import { formatBytes } from '@/lib/binaryUtils';

function Cell({ label, value }) {
  return (
    <div className="rounded-md bg-muted/30 px-2.5 py-1.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xs font-medium truncate" title={value}>{value}</p>
    </div>
  );
}

function bootInfoLine(info) {
  const bits = [
    `boot v${info.headerVersion}`,
    info.name ? `"${info.name}"` : null,
    `kernel ${formatBytes(info.kernelSize)}`,
    `ramdisk ${formatBytes(info.ramdiskSize)}`,
    info.secondSize ? `2nd ${formatBytes(info.secondSize)}` : null,
    `page ${info.pageSize}`,
  ].filter(Boolean);
  return bits.join(' · ');
}

export default function UserAreaAnalysis({ analysis }) {
  if (!analysis) return null;
  const { soc, tableType, marker, partitions } = analysis;
  const bootParts = (partitions || []).filter((p) => p.bootInfo);

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Cpu className="w-4 h-4 text-sky-600" /> User Area Analysis
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Cell label="SoC / vendor" value={soc} />
        <Cell label="Partition table" value={tableType === 'hisi_emmc_map' ? 'HiSilicon eMMC Map' : tableType} />
        <Cell label="Detection marker" value={marker} />
      </div>
      {bootParts.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Android boot images</p>
          {bootParts.map((p) => (
            <p key={p.name} className="text-[11px] text-muted-foreground">
              <span className="font-mono text-foreground">{p.name}</span>
              {' · '}
              {bootInfoLine(p.bootInfo)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
