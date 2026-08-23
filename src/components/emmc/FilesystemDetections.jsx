import React from 'react';
import { Layers } from 'lucide-react';
import { formatBytes } from '@/lib/binaryUtils';

function metaLine(hit) {
  if (hit.type === 'squashfs') {
    const bits = [
      hit.version ? `v${hit.version}` : null,
      hit.size ? `~${formatBytes(hit.size)}` : null,
      hit.blockSize ? `${formatBytes(hit.blockSize)} blocks` : null,
    ].filter(Boolean);
    return bits.join(' · ');
  }
  if (hit.type === 'ext4') {
    const bits = [
      hit.size ? `~${formatBytes(hit.size)}` : 'validated filesystem',
      hit.blockSize ? `${hit.blockSize / 1024}K blocks` : null,
    ].filter(Boolean);
    return bits.join(' · ');
  }
  return hit.size ? `~${formatBytes(hit.size)}` : '';
}

function typeLabel(type) {
  if (type === 'squashfs') return 'SquashFS';
  if (type === 'ext4') return 'ext4';
  return type;
}

export default function FilesystemDetections({ hits, scannedBytes }) {
  if (!hits || !hits.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-sm font-semibold mb-1 flex items-center gap-2">
        <Layers className="w-4 h-4 text-sky-600" /> Detected Filesystems / Containers
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">
        Signature-based finds in the scanned prefix
        {scannedBytes ? ` (${formatBytes(scannedBytes)})` : ''}. These are not partition-table entries.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1.5 pr-3 font-medium">Type</th>
              <th className="py-1.5 pr-3 font-medium">Offset</th>
              <th className="py-1.5 font-medium">Size / metadata</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={`${h.type}-${h.offset}`} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-3 font-medium">{typeLabel(h.type)}</td>
                <td className="py-1.5 pr-3 font-mono">0x{h.offset.toString(16).toUpperCase()}</td>
                <td className="py-1.5 text-muted-foreground">{metaLine(h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
