import type { ReactNode } from 'react';
import { STATUS_LABEL, type BriefStatus, type SourceStatus } from '../lib/types';

export function PageHeader({ title, lede, actions }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-5 mb-6 border-b border-line">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
        {lede && <p className="mt-1 text-ink-soft max-w-[70ch]">{lede}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Field({ label, help, children, htmlFor }: { label: string; help?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="block text-sm font-semibold mb-1">{label}</span>
      {children}
      {help && <span className="block text-[13px] text-ink-faint mt-1">{help}</span>}
    </label>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="text-sm text-blocked bg-blocked-soft border border-blocked/30 rounded-md px-3 py-2">
      {msg}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-2 text-ink-soft max-w-[60ch] mx-auto">{children}</div>}
    </div>
  );
}

const SOURCE_TONE: Record<SourceStatus, string> = {
  queued: 'bg-paper text-ink-soft border-line-strong',
  processing: 'bg-signal-soft text-ink border-signal/40',
  needs_attention: 'bg-signal-soft text-ink border-signal',
  ready: 'bg-verified-soft text-verified border-verified/30',
  failed: 'bg-blocked-soft text-blocked border-blocked/30',
};
const SOURCE_LABEL: Record<SourceStatus, string> = {
  queued: 'Queued', processing: 'Processing', needs_attention: 'Needs review', ready: 'Ready', failed: 'Failed',
};
export function SourceBadge({ status }: { status: SourceStatus }) {
  return <span className={`inline-block text-[12px] font-semibold px-2 py-0.5 rounded-full border ${SOURCE_TONE[status]}`}>{SOURCE_LABEL[status]}</span>;
}

const BRIEF_TONE: Partial<Record<BriefStatus, string>> = {
  approved: 'bg-verified-soft text-verified border-verified/30',
  scheduled: 'bg-verified-soft text-verified border-verified/30',
  produced: 'bg-verified-soft text-verified border-verified/30',
  producer_review: 'bg-signal-soft text-ink border-signal/50',
  specialist_review: 'bg-signal-soft text-ink border-signal',
  rejected: 'bg-blocked-soft text-blocked border-blocked/30',
};
export function BriefBadge({ status }: { status: BriefStatus }) {
  return (
    <span className={`inline-block text-[12px] font-semibold px-2 py-0.5 rounded-full border ${BRIEF_TONE[status] ?? 'bg-paper text-ink-soft border-line-strong'}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 rounded-full bg-line overflow-hidden" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-signal" style={{ width: `${Math.max(3, value)}%` }} />
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <p className="text-ink-faint text-sm py-8" aria-live="polite">{label}…</p>;
}
