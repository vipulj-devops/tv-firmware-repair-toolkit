import React from 'react';
import { FileSearch } from 'lucide-react';

export default function FirmwareHeaderPanel({ analysis }) {
  if (!analysis) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex-1">
      <div className="flex items-center gap-2 mb-3">
        <FileSearch className="w-4 h-4 text-sky-600" />
        <h2 className="text-sm font-semibold">Firmware Header</h2>
      </div>

      <dl className="space-y-2">
        {analysis.header.map((item) => (
          <div
            key={item.label}
            className="flex justify-between gap-4 text-xs"
          >
            <dt className="text-muted-foreground shrink-0">
              {item.label}
            </dt>

            <dd className="font-mono text-right break-all">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}