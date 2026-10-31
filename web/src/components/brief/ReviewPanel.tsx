import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ago } from '../../lib/format';
import { usePeople } from '../../lib/org';
import { check, supabase } from '../../lib/supabase';
import { ROLE_LABEL, type Brief, type BriefContent, type Check, type ReviewDecision } from '../../lib/types';
import { ErrorNote } from '../ui';

const CHECKS: { key: Check; title: string; ask: string }[] = [
  { key: 'fact', title: 'Accuracy and source context', ask: 'Claims match what the source actually says, in context. No invented quotes, times or audience figures.' },
  { key: 'fairness', title: 'Fairness and balance', ask: 'Credible opposing views; no stereotyping, victim-blaming or predetermined conclusion.' },
  { key: 'privacy', title: 'Privacy and allegations', ask: 'No identifiable private individuals, minors or unsupported allegations; consent where needed.' },
  { key: 'rights', title: 'Rights and reuse', ask: 'Every excerpt, voice, image and music bed is cleared for this use.' },
  { key: 'language', title: 'Language', ask: 'English, Pidgin and code-switched wording checked against the audio. Twi needs a qualified reviewer.' },
  { key: 'commercial', title: 'Commercial conflicts', ask: 'Sponsor relationships disclosed; commercial interests did not shape the editorial conclusion.' },
];

export function ReviewPanel({ brief, versionId, versionNumber, content, decisions, blockers, canReview, canApprove, dirty, onChanged }: {
  brief: Brief; versionId: string; versionNumber: number; content: BriefContent; decisions: ReviewDecision[]; blockers: string[];
  canReview: boolean; canApprove: boolean; dirty: boolean; onChanged: () => void;
}) {
  const person = usePeople();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState({ reason: '', conditions: '' });
  const needsCommercial = (content.review_flags ?? []).some((f) => f.check === 'commercial');
  const required = CHECKS.filter((c) => c.key !== 'commercial' || needsCommercial);
  const live = decisions.filter((d) => !d.invalidated_at && d.brief_version_id === versionId);

  const record = useMutation({
    mutationFn: async ({ check: c, outcome }: { check: Check; outcome: 'passed' | 'failed' | 'not_applicable' }) =>
      check(await supabase.rpc('record_check', { p_brief: brief.id, p_version: versionId, p_check: c, p_outcome: outcome, p_reason: reasons[c] || null })),
    onSuccess: onChanged,
  });
  const approve = useMutation({
    mutationFn: async () => check(await supabase.rpc('approve_brief', {
      p_brief: brief.id, p_version: versionId, p_reason: approval.reason || null, p_conditions: approval.conditions || null,
    })),
    onSuccess: onChanged,
  });

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-soft max-w-[72ch]">
        Checks and approval apply to <strong>version {versionNumber}</strong> only. Any edit, or a correction to a cited source passage, withdraws them.
        Ticking a box here is a recorded decision with your name on it.
      </p>
      {dirty && <p className="text-sm bg-signal-soft rounded-md px-3 py-2">You have unsaved edits. Save them as a new version before reviewing.</p>}

      {(content.review_flags ?? []).length > 0 && (
        <div className="panel p-4">
          <h3 className="font-semibold mb-2">Raised while drafting</h3>
          <ul className="space-y-1.5 text-sm">
            {content.review_flags.map((f, i) => (
              <li key={i}><span className={`font-semibold ${f.severity === 'critical' || f.severity === 'high' ? 'text-blocked' : 'text-ink'}`}>{CHECKS.find((c) => c.key === f.check)?.title ?? f.check} ({f.severity})</span>: {f.concern}</li>
            ))}
          </ul>
        </div>
      )}

      <ol className="space-y-3">
        {required.map((c) => {
          const d = live.find((x) => x.check_key === c.key);
          return (
            <li key={c.key} className="panel p-4">
              <div className="flex flex-wrap justify-between gap-3">
                <div className="max-w-[60ch]">
                  <h3 className="font-semibold">{c.title}</h3>
                  <p className="text-sm text-ink-soft">{c.ask}</p>
                </div>
                {d ? (
                  <p className={`text-sm font-semibold ${d.outcome === 'failed' ? 'text-blocked' : 'text-verified'}`}>
                    {d.outcome === 'passed' ? 'Passed' : d.outcome === 'failed' ? 'Failed' : 'Not applicable'}
                    <span className="block font-normal text-ink-faint">{person(d.reviewer)}, {ROLE_LABEL[d.reviewer_role]}, {ago(d.created_at)}</span>
                    {d.reason && <span className="block font-normal text-ink">{d.reason}</span>}
                  </p>
                ) : <p className="text-sm font-semibold text-signal">Not checked</p>}
              </div>
              {canReview && !dirty && (
                <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto] items-center">
                  <input className="field-input" placeholder="Note (required for not applicable)" aria-label={`Note for ${c.title}`}
                    value={reasons[c.key] ?? ''} onChange={(e) => setReasons({ ...reasons, [c.key]: e.target.value })} />
                  <div className="flex gap-2">
                    <button className="btn btn-quiet btn-sm" onClick={() => record.mutate({ check: c.key, outcome: 'passed' })}>Pass</button>
                    <button className="btn btn-danger btn-sm" onClick={() => record.mutate({ check: c.key, outcome: 'failed' })}>Fail</button>
                    <button className="btn btn-quiet btn-sm" onClick={() => record.mutate({ check: c.key, outcome: 'not_applicable' })}>N/A</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <ErrorNote error={record.error} />

      <div className="panel p-5">
        <h3 className="font-semibold">Final approval</h3>
        {brief.status === 'approved' ? (
          <p className="text-verified font-semibold mt-1">Approved{live.find((d) => d.is_final_approval) && ` by ${person(live.find((d) => d.is_final_approval)!.reviewer)}`}.</p>
        ) : blockers.length ? (
          <>
            <p className="text-sm text-ink-soft mt-1">Version {versionNumber} cannot be approved yet:</p>
            <ul className="list-disc pl-5 mt-1 text-sm">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </>
        ) : <p className="text-sm text-verified mt-1">All gates are clear for version {versionNumber}.</p>}
        {canApprove && brief.status !== 'approved' && (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <input className="field-input" placeholder="Decision note" aria-label="Decision note" value={approval.reason} onChange={(e) => setApproval({ ...approval, reason: e.target.value })} />
            <input className="field-input" placeholder="Conditions, if any" aria-label="Conditions" value={approval.conditions} onChange={(e) => setApproval({ ...approval, conditions: e.target.value })} />
            <div><button className="btn btn-approve" disabled={blockers.length > 0 || dirty || approve.isPending} onClick={() => approve.mutate()}>Approve version {versionNumber}</button></div>
          </div>
        )}
        {!canApprove && <p className="text-[13px] text-ink-faint mt-3">Only a show, brand or organisation editor for this show can give final approval.</p>}
        <div className="mt-2"><ErrorNote error={approve.error} /></div>
      </div>

      <div>
        <h3 className="font-semibold mb-2">Decision history</h3>
        <ol className="text-sm space-y-1.5">
          {decisions.map((d) => (
            <li key={d.id} className={d.invalidated_at ? 'text-ink-faint' : ''}>
              <span className={d.invalidated_at ? 'line-through' : ''}>
                {d.is_final_approval ? 'Final approval' : `${CHECKS.find((c) => c.key === d.check_key)?.title}: ${d.outcome?.replace('_', ' ')}`}
              </span>{' '}by {person(d.reviewer)}, {ago(d.created_at)}
              {d.invalidated_at && <> — withdrawn: {d.invalidated_reason}</>}
            </li>
          ))}
          {!decisions.length && <li className="text-ink-faint">No decisions yet.</li>}
        </ol>
      </div>
    </div>
  );
}
