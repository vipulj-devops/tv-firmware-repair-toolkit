import React, { useEffect, useRef } from 'react';

export default function LogPanel({ entries }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [entries]);
  return (
    <div ref={ref} className="h-40 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs space-y-0.5">
      {!entries.length && <p className="text-muted-foreground">Operation log will appear here…</p>}
      {entries.map((e, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-muted-foreground shrink-0">{e.time}</span>
          <span className="break-all">{e.msg}</span>
        </div>
      ))}
    </div>
  );
}