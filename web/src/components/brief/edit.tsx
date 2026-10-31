import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

export function EText({ label, value, onChange, disabled, long, serif, help }: {
  label: string; value: string | null | undefined; onChange: (v: string) => void; disabled?: boolean; long?: boolean; serif?: boolean; help?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-semibold text-ink-soft mb-1">{label}</span>
      {long ? (
        <textarea className={`field-input ${serif ? 'source-text' : ''}`} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="field-input" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
      {help && <span className="block text-[12px] text-ink-faint mt-1">{help}</span>}
    </label>
  );
}

export function EList({ label, value, onChange, disabled, help }: {
  label: string; value: string[] | undefined; onChange: (v: string[]) => void; disabled?: boolean; help?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-semibold text-ink-soft mb-1">{label}</span>
      <textarea className="field-input" disabled={disabled} value={(value ?? []).join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n'))}
        onBlur={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} />
      <span className="block text-[12px] text-ink-faint mt-1">{help ?? 'One per line.'}</span>
    </label>
  );
}

/** Editable list of objects: each item rendered by `render`, with add/remove. */
export function ObjList<T>({ items, onChange, disabled, render, blank, addLabel }: {
  items: T[]; onChange: (v: T[]) => void; disabled?: boolean; blank: T; addLabel: string;
  render: (item: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
}) {
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="relative border border-line rounded-md p-4 bg-surface">
          {!disabled && (
            <button className="absolute top-2 right-2 p-1 text-ink-faint hover:text-blocked" aria-label="Remove item"
              onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          )}
          {render(item, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}
        </div>
      ))}
      {!disabled && (
        <button className="btn btn-quiet btn-sm" onClick={() => onChange([...items, structuredClone(blank)])}>
          <Plus size={14} aria-hidden /> {addLabel}
        </button>
      )}
    </div>
  );
}

export function RefChips({ refs, states, active, onPick }: {
  refs: string[]; states: Record<string, string>; active: string | null; onPick: (ref: string) => void;
}) {
  if (!refs?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {refs.map((r) => (
        <button key={r} type="button" className="tally" data-state={states[r] ?? 'unverified'} data-active={active === r}
          onClick={() => onPick(r)} aria-label={`Show evidence ${r}`}>{r}</button>
      ))}
    </span>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h2 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h2>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}
