import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ago } from '../../lib/format';
import { usePeople } from '../../lib/org';
import { check, supabase } from '../../lib/supabase';
import type { BriefContent, BriefVersion, Comment, Task } from '../../lib/types';
import { ErrorNote } from '../ui';

// ---------------------------------------------------------------------------
// Production tasks (research, booking, clearance). Blocking tasks stop approval.
// ---------------------------------------------------------------------------
export function TasksPanel({ briefId, orgId, tasks, canWork, onChanged }: {
  briefId: string; orgId: string; tasks: Task[]; canWork: boolean; onChanged: () => void;
}) {
  const [draft, setDraft] = useState({ title: '', owner_role: 'producer', due_date: '', blocking: false });
  const add = useMutation({
    mutationFn: async () => check(await supabase.from('research_tasks').insert({
      org_id: orgId, brief_id: briefId, title: draft.title.trim(), owner_role: draft.owner_role,
      due_date: draft.due_date || null, blocking: draft.blocking, origin: 'manual',
    })),
    onSuccess: () => { setDraft({ ...draft, title: '' }); onChanged(); },
  });
  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Task> }) => check(await supabase.from('research_tasks').update(patch).eq('id', id)),
    onSuccess: onChanged,
  });
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  const row = (t: Task) => (
    <li key={t.id} className="flex items-start gap-3 py-3">
      <input type="checkbox" className="mt-1.5" disabled={!canWork} checked={t.status === 'done'} aria-label={`Mark ${t.title} done`}
        onChange={(e) => update.mutate({ id: t.id, patch: { status: e.target.checked ? 'done' : 'open' } })} />
      <div className="min-w-0 flex-1">
        <p className={`font-semibold ${t.status === 'done' ? 'line-through text-ink-faint' : ''}`}>
          {t.title}
          {t.blocking && t.status !== 'done' && <span className="ml-2 text-[12px] text-blocked">Blocks approval</span>}
          {t.origin === 'unresolved' && <span className="ml-2 text-[12px] text-signal">Unresolved in draft</span>}
        </p>
        {t.detail && <p className="text-sm text-ink-soft whitespace-pre-line">{t.detail}</p>}
        <p className="text-[12px] text-ink-faint">{t.owner_role ?? 'Unassigned'}{t.due_date ? ` · due ${t.due_date}` : ''}</p>
      </div>
      {canWork && t.status !== 'done' && (
        <select className="field-input w-auto text-sm" value={t.status} aria-label="Task status"
          onChange={(e) => update.mutate({ id: t.id, patch: { status: e.target.value as Task['status'] } })}>
          <option value="open">Open</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option>
        </select>
      )}
    </li>
  );
  return (
    <div className="space-y-4">
      <ul className="panel px-4 divide-y divide-line">{open.map(row)}{!open.length && <li className="py-3 text-sm text-ink-faint">No open tasks.</li>}</ul>
      {done.length > 0 && <details><summary className="cursor-pointer text-sm text-ink-soft">{done.length} done</summary><ul className="px-4 divide-y divide-line">{done.map(row)}</ul></details>}
      {canWork && (
        <form className="grid gap-2 md:grid-cols-[1fr_160px_150px_auto_auto] items-center" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <input className="field-input" placeholder="New task" aria-label="Task" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <input className="field-input" placeholder="Owner role" aria-label="Owner role" value={draft.owner_role} onChange={(e) => setDraft({ ...draft, owner_role: e.target.value })} />
          <input className="field-input" type="date" aria-label="Due date" value={draft.due_date} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} />
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={draft.blocking} onChange={(e) => setDraft({ ...draft, blocking: e.target.checked })} />Blocking</label>
          <button className="btn btn-quiet" disabled={!draft.title.trim()}>Add task</button>
        </form>
      )}
      <ErrorNote error={add.error || update.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Version history and comparison
// ---------------------------------------------------------------------------
const SECTION_NAMES: Record<string, string> = {
  title: 'Title', premise: 'Premise', why_now: 'Why now', audience_value: 'Audience value', destination_fit: 'Profile fit',
  new_contribution: 'New contribution', recommendation: 'Recommendation', recommendation_reason: 'Recommendation reason',
  uncertainties: 'Uncertainties', contradictory_evidence: 'Contradictory evidence', treatment: 'Treatment', rundown: 'Rundown',
  guests: 'Guests', production_tasks: 'Production tasks', social_package: 'Social package', review_flags: 'Review flags',
  continuation: 'Continuation', unresolved: 'Unresolved', evidence: 'Evidence',
};

export function VersionsPanel({ versions }: { versions: BriefVersion[] }) {
  const person = usePeople();
  const [a, setA] = useState(versions[1]?.id ?? '');
  const [b, setB] = useState(versions[0]?.id ?? '');
  const va = versions.find((v) => v.id === a);
  const vb = versions.find((v) => v.id === b);
  const changed = va && vb
    ? Object.keys({ ...va.content, ...vb.content }).filter((k) => JSON.stringify((va.content as unknown as Record<string, unknown>)[k]) !== JSON.stringify((vb.content as unknown as Record<string, unknown>)[k]))
    : [];
  return (
    <div className="space-y-6">
      <ol className="panel divide-y divide-line">
        {versions.map((v) => (
          <li key={v.id} className="px-4 py-3 text-sm">
            <p><strong>Version {v.version}</strong> — {v.generated ? `written by ${v.model} from the source` : `edited by ${person(v.created_by)}`}, {ago(v.created_at)}</p>
            {v.change_note && <p className="text-ink-soft">{v.change_note}</p>}
            {v.locked_sections.length > 0 && <p className="text-ink-faint">Locked: {v.locked_sections.join(', ')}</p>}
            {v.generated && v.validation?.checks && (
              <ul className="mt-1 text-[13px]">
                {v.validation.checks.filter((c) => c.status !== 'ok').map((c) => <li key={c.name} className="text-signal">Automatic check: {c.detail}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {versions.length > 1 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            Compare
            <select className="field-input w-auto" value={a} onChange={(e) => setA(e.target.value)} aria-label="Earlier version">
              {versions.map((v) => <option key={v.id} value={v.id}>Version {v.version}</option>)}
            </select>
            with
            <select className="field-input w-auto" value={b} onChange={(e) => setB(e.target.value)} aria-label="Later version">
              {versions.map((v) => <option key={v.id} value={v.id}>Version {v.version}</option>)}
            </select>
          </div>
          {changed.length === 0 ? <p className="text-sm text-ink-faint">No differences.</p> : changed.map((k) => (
            <div key={k} className="panel p-4">
              <h3 className="font-semibold mb-2">{SECTION_NAMES[k] ?? k}</h3>
              <div className="grid gap-3 md:grid-cols-2 text-[13px]">
                <pre className="whitespace-pre-wrap bg-blocked-soft/50 rounded p-2 overflow-x-auto">{render((va!.content as unknown as Record<string, unknown>)[k])}</pre>
                <pre className="whitespace-pre-wrap bg-verified-soft/60 rounded p-2 overflow-x-auto">{render((vb!.content as unknown as Record<string, unknown>)[k])}</pre>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function render(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

// ---------------------------------------------------------------------------
// Discussion
// ---------------------------------------------------------------------------
export function DiscussionPanel({ briefId, orgId, userId, comments, canComment, onChanged }: {
  briefId: string; orgId: string; userId: string; comments: Comment[]; canComment: boolean; onChanged: () => void;
}) {
  const person = usePeople();
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: async () => check(await supabase.from('brief_comments').insert({ org_id: orgId, brief_id: briefId, body: body.trim(), author: userId })),
    onSuccess: () => { setBody(''); onChanged(); },
  });
  return (
    <div className="space-y-4 max-w-[760px]">
      <ol className="space-y-3">
        {comments.map((c) => (
          <li key={c.id} className="panel p-4">
            <p className="text-[13px] text-ink-faint">{person(c.author)}, {ago(c.created_at)}</p>
            <p className="whitespace-pre-line mt-1">{c.body}</p>
          </li>
        ))}
        {!comments.length && <li className="text-sm text-ink-faint">No comments yet.</li>}
      </ol>
      {canComment && (
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} className="space-y-2">
          <textarea className="field-input" placeholder="Add a note for the team" aria-label="Comment" value={body} onChange={(e) => setBody(e.target.value)} />
          <button className="btn btn-quiet" disabled={!body.trim() || add.isPending}>Post comment</button>
          <ErrorNote error={add.error} />
        </form>
      )}
    </div>
  );
}

export type { BriefContent };
