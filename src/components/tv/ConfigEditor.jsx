import React, { useState, useMemo } from 'react';
import { Pencil, Check, X, Search } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';

export default function ConfigEditor({ entries, bytes, onPatchString }) {
  const [filter, setFilter] = useState('');
  const [editIdx, setEditIdx] = useState(null);
  const [draft, setDraft] = useState('');
  const [section, setSection] = useState('all');

  const sections = useMemo(
    () => entries.filter((e) => e.type === 'section').map((e) => e.key),
    [entries]
  );

  // Assign each kv entry to the ini section that most recently precedes it.
  // Also compute the max writable length: the gap from the value start to the
  // next detected entry (or EOF), reserving 1 byte for a terminator.
  const kvWithSection = useMemo(() => {
    let cur = '';
    const out = [];
    for (let k = 0; k < entries.length; k++) {
      const e = entries[k];
      if (e.type === 'section') { cur = e.key; continue; }
      if (e.type !== 'kv') continue;
      const valueStart = e.offset + e.key.length + 1;
      const nextEntry = entries[k + 1];
      const boundary = nextEntry ? nextEntry.offset : bytes.length;
      const maxLen = Math.max(boundary - valueStart - 1, e.value.length);
      out.push({ ...e, section: cur || '(root)', maxLen });
    }
    return out;
  }, [entries, bytes]);

  const matched = kvWithSection.filter((e) => {
    if (section !== 'all' && e.section !== section) return false;
    const q = filter.toLowerCase();
    return !q || e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q) || e.section.toLowerCase().includes(q);
  });
  const RENDER_CAP = 800;
  const shown = matched.slice(0, RENDER_CAP);

  const startEdit = (i, val) => { setEditIdx(i); setDraft(val); };
  const save = (entry) => {
    let val = draft;
    if (val.length > entry.maxLen) {
      val = val.slice(0, entry.maxLen);
      toast({ title: 'Value trimmed', description: `Max slot is ${entry.maxLen} chars — trimmed to fit.` });
    }
    onPatchString(entry, val, entry.maxLen);
    setEditIdx(null);
  };

  if (!entries.length) {
    return <p className="text-sm text-muted-foreground p-4">No readable key=value config entries detected in this pack.</p>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search keys / values / ini sections…"
            className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
        </div>
        {sections.length > 0 && (
          <select
            value={section}
            onChange={(e) => setSection(e.target.value)}
            className="rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40"
          >
            <option value="all">All sections ({kvWithSection.length})</option>
            {sections.map((s) => (
              <option key={s} value={s}>[{s}]</option>
            ))}
          </select>
        )}
      </div>
      <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
        {shown.map((e, i) => {
          const editing = editIdx === i;
          return (
            <div key={`${e.offset}-${i}`} className="flex items-center gap-2 rounded-md hover:bg-accent/40 px-2 py-1.5">
              <span className="text-[10px] text-muted-foreground font-mono w-16 shrink-0">0x{e.offset.toString(16).toUpperCase()}</span>
              <span className="text-[10px] text-sky-500 font-mono shrink-0 max-w-[90px] truncate" title={e.section}>{e.section}</span>
              <span className="text-sm font-medium shrink-0 max-w-[120px] truncate">{e.key}</span>
              <span className="text-muted-foreground">=</span>
              {editing ? (
                <input
                  autoFocus
                  value={draft}
                  maxLength={e.maxLen}
                  onChange={(ev) => setDraft(ev.target.value)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') save(e); if (ev.key === 'Escape') setEditIdx(null); }}
                  className="flex-1 min-w-0 rounded border border-emerald-500/50 bg-background px-2 py-1 text-sm outline-none"
                />
              ) : (
                <span className="flex-1 min-w-0 truncate text-sm" title={`${e.value} (max ${e.maxLen})`}>{e.value}</span>
              )}
              {editing ? (
                <>
                  <button onClick={() => save(e)} title="Save" className="flex items-center gap-1 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-1"><Check className="w-3.5 h-3.5" /> Save</button>
                  <button onClick={() => setEditIdx(null)} title="Cancel" className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                </>
              ) : (
                <button onClick={() => startEdit(i, e.value)} title="Edit" className="flex items-center gap-1 text-xs rounded-md border border-border hover:bg-accent px-2 py-1 transition-colors"><Pencil className="w-3.5 h-3.5" /> Edit</button>
              )}
            </div>
          );
        })}
        {!shown.length && <p className="text-sm text-muted-foreground p-4">No entries match your search.</p>}
      </div>
      <p className="text-[11px] text-muted-foreground mt-3">
        {kvWithSection.length} key=value entries{sections.length ? ` across ${sections.length} ini sections` : ''}{matched.length > RENDER_CAP ? ` (showing first ${RENDER_CAP} — narrow the search)` : ''}. Values edit in-place — keep within the original byte length.
      </p>
    </div>
  );
}