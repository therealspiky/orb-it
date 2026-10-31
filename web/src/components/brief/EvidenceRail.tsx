import { useMutation } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { clock } from '../../lib/format';
import { check, supabase } from '../../lib/supabase';
import type { BriefContent, Evidence, Segment, Source } from '../../lib/types';
import { ErrorNote } from '../ui';

const STATE_LABEL: Record<string, string> = {
  verified: 'Verified by a person', auto_matched: 'Quote matches transcript — listen to confirm',
  unverified: 'Not yet verified', failed: 'Marked as not supported',
};
const KIND_LABEL: Record<string, string> = {
  source_statement: 'Said in the source', reported_claim: 'Reported claim', inferred_theme: 'Inferred theme', verified_fact: 'Verified fact',
};

/**
 * The evidence rail: every citation in the brief, with the source passage it
 * points to, its verification state and a player that jumps to the moment.
 */
export function EvidenceRail({ evidence, content, segments, source, mediaUrl, activeRef, onPick, canVerify, isCurrent, onChanged }: {
  evidence: Evidence[]; content: BriefContent; segments: Segment[]; source: Source | null; mediaUrl: string | null;
  activeRef: string | null; onPick: (ref: string | null) => void; canVerify: boolean; isCurrent: boolean; onChanged: () => void;
}) {
  const media = useRef<HTMLAudioElement & HTMLVideoElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const verify = useMutation({
    mutationFn: async ({ id, state }: { id: string; state: 'verified' | 'failed' | 'unverified' }) =>
      check(await supabase.rpc('verify_evidence', { p_evidence: id, p_state: state, p_note: null })),
    onSuccess: onChanged,
  });

  useEffect(() => {
    if (!activeRef) return;
    const ev = evidence.find((e) => e.ref_key === activeRef);
    listRef.current?.querySelector(`[data-ref="${activeRef}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (ev?.start_ms != null && media.current) {
      media.current.currentTime = ev.start_ms / 1000;
    }
  }, [activeRef, evidence]);

  function play(ev: Evidence) {
    onPick(ev.ref_key);
    if (media.current && ev.start_ms != null) {
      media.current.currentTime = ev.start_ms / 1000;
      void media.current.play();
    }
  }

  const relevance = Object.fromEntries((content.evidence ?? []).map((e) => [e.ref, e.relevance]));
  const counts = evidence.reduce<Record<string, number>>((a, e) => ({ ...a, [e.verification]: (a[e.verification] ?? 0) + 1 }), {});

  return (
    <div className="panel flex flex-col max-h-[calc(100vh-120px)] xl:sticky xl:top-6">
      <div className="p-4 border-b border-line">
        <h2 className="font-semibold">Evidence</h2>
        <p className="text-[13px] text-ink-soft">
          {evidence.length} citation{evidence.length === 1 ? '' : 's'}
          {counts.verified ? `, ${counts.verified} verified` : ''}{counts.auto_matched ? `, ${counts.auto_matched} quote-matched` : ''}
          {counts.unverified ? `, ${counts.unverified} unverified` : ''}{counts.failed ? `, ${counts.failed} not supported` : ''}
        </p>
        {source && <p className="text-[13px] text-ink-faint mt-1">From {source.programme_name ?? source.title}{source.timestamps_genuine ? '' : ' (no timestamps)'}</p>}
        {mediaUrl && (
          (source?.mime_type ?? '').startsWith('video')
            ? <video ref={media} src={mediaUrl} controls className="w-full mt-3 rounded-md bg-black max-h-[180px]" />
            : <audio ref={media} src={mediaUrl} controls className="w-full mt-3" />
        )}
      </div>
      <ol ref={listRef} className="overflow-y-auto divide-y divide-line">
        {evidence.map((ev) => {
          const active = activeRef === ev.ref_key;
          const passage = segments.filter((s) => s.idx >= ev.segment_start - (active ? 1 : 0) && s.idx <= ev.segment_end + (active ? 1 : 0));
          return (
            <li key={ev.id} data-ref={ev.ref_key} className={`p-4 ${active ? 'bg-paper' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <button className="tally" data-state={ev.verification} data-active={active} onClick={() => onPick(active ? null : ev.ref_key)}>{ev.ref_key}</button>
                <span className="text-[12px] text-ink-faint">{KIND_LABEL[ev.kind] ?? ev.kind}</span>
              </div>
              {ev.quote && <blockquote className="source-text mt-2 border-l-2 border-line-strong pl-3">“{ev.quote}”</blockquote>}
              <p className="text-[13px] mt-1.5 text-ink-soft">
                {ev.attribution && <>{ev.attribution} · </>}
                {ev.start_ms != null ? (
                  <button className="inline-flex items-center gap-1 underline" onClick={() => play(ev)}><Play size={11} aria-hidden />{clock(ev.start_ms)}–{clock(ev.end_ms)}</button>
                ) : <>passage {ev.segment_start}{ev.segment_end !== ev.segment_start ? `–${ev.segment_end}` : ''}</>}
              </p>
              {relevance[ev.ref_key] && <p className="text-[13px] mt-1">{relevance[ev.ref_key]}</p>}
              <p className={`text-[12px] mt-1.5 font-semibold ${ev.verification === 'verified' ? 'text-verified' : ev.verification === 'failed' ? 'text-blocked' : 'text-signal'}`}>{STATE_LABEL[ev.verification]}</p>
              {ev.note && <p className="text-[12px] text-ink-faint mt-0.5">{ev.note}</p>}
              {active && passage.length > 0 && (
                <div className="mt-3 rounded-md bg-surface border border-line p-3 space-y-1.5">
                  <p className="text-[12px] font-semibold text-ink-soft">Source passage, with one line of context either side</p>
                  {passage.map((s) => (
                    <p key={s.id} className={`source-text text-[14px] ${s.idx < ev.segment_start || s.idx > ev.segment_end ? 'text-ink-faint' : ''}`}>
                      {s.speaker && <span className="font-sans text-[12px] font-semibold mr-1.5">{s.speaker}</span>}{s.text}
                      {s.is_uncertain && <span className="font-sans text-[11px] text-signal ml-1">uncertain</span>}
                    </p>
                  ))}
                </div>
              )}
              {canVerify && isCurrent && (
                <div className="flex gap-2 mt-3">
                  {ev.verification !== 'verified' && <button className="btn btn-quiet btn-sm" onClick={() => verify.mutate({ id: ev.id, state: 'verified' })}>I checked the source: supported</button>}
                  {ev.verification !== 'failed' && <button className="btn btn-danger btn-sm" onClick={() => verify.mutate({ id: ev.id, state: 'failed' })}>Not supported</button>}
                </div>
              )}
            </li>
          );
        })}
        {evidence.length === 0 && <li className="p-4 text-sm text-ink-faint">This brief has no source evidence. Treat it as a research plan.</li>}
      </ol>
      <div className="px-4"><ErrorNote error={verify.error} /></div>
    </div>
  );
}
