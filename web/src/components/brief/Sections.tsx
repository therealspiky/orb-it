import type { BriefContent, RundownItem, SocialAsset } from '../../lib/types';
import { EList, EText, ObjList, RefChips, SectionHead } from './edit';

export interface SectionProps {
  c: BriefContent;
  set: (patch: Partial<BriefContent>) => void;
  disabled: boolean;
  refStates: Record<string, string>;
  activeRef: string | null;
  onPick: (ref: string) => void;
}

export function DecisionSection({ c, set, disabled, refStates, activeRef, onPick }: SectionProps) {
  return (
    <div className="space-y-5">
      <EText label="Title" value={c.title} onChange={(v) => set({ title: v })} disabled={disabled} />
      <EText label="Premise: the editorial question" value={c.premise} onChange={(v) => set({ premise: v })} disabled={disabled} long serif />
      <div className="grid gap-5 md:grid-cols-2">
        <EText label="Why now" value={c.why_now} onChange={(v) => set({ why_now: v })} disabled={disabled} long />
        <EText label="Value to the audience" value={c.audience_value} onChange={(v) => set({ audience_value: v })} disabled={disabled} long />
      </div>
      <EText label="What this treatment adds" value={c.new_contribution} onChange={(v) => set({ new_contribution: v })} disabled={disabled} long />
      <div>
        <h3 className="text-[13px] font-semibold text-ink-soft mb-1">Fit with the show profile</h3>
        <EText label="Summary" value={c.destination_fit?.summary} onChange={(v) => set({ destination_fit: { ...c.destination_fit, summary: v } })} disabled={disabled} long />
        <div className="mt-3">
          <ObjList items={c.destination_fit?.profile_fields ?? []} disabled={disabled} addLabel="Add profile reason"
            blank={{ field: '', how_it_fits: '' }}
            onChange={(v) => set({ destination_fit: { ...c.destination_fit, profile_fields: v } })}
            render={(f, u) => (
              <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                <EText label="Profile field" value={f.field} onChange={(v) => u({ field: v })} disabled={disabled} />
                <EText label="How it fits" value={f.how_it_fits} onChange={(v) => u({ how_it_fits: v })} disabled={disabled} />
              </div>
            )} />
        </div>
      </div>
      <div className="grid gap-5 md:grid-cols-[220px_1fr]">
        <label className="block">
          <span className="block text-[13px] font-semibold text-ink-soft mb-1">Recommendation</span>
          <select className="field-input" disabled={disabled} value={c.recommendation} onChange={(e) => set({ recommendation: e.target.value as BriefContent['recommendation'] })}>
            <option value="proceed">Proceed to production</option>
            <option value="research">Research first</option>
          </select>
        </label>
        <EText label="Reason" value={c.recommendation_reason} onChange={(v) => set({ recommendation_reason: v })} disabled={disabled} long />
      </div>
      <EList label="Unknowns and uncertainties" value={c.uncertainties} onChange={(v) => set({ uncertainties: v })} disabled={disabled} />
      {(c.contradictory_evidence ?? []).length > 0 && (
        <div>
          <h3 className="text-[13px] font-semibold text-ink-soft mb-1">Contradictory evidence</h3>
          <ul className="space-y-1">
            {c.contradictory_evidence.map((x, i) => (
              <li key={i}>{x.description} <RefChips refs={x.evidence_refs} states={refStates} active={activeRef} onPick={onPick} /></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function TreatmentSection({ c, set, disabled, refStates, activeRef, onPick }: SectionProps) {
  const t = c.treatment;
  const up = (patch: Partial<BriefContent['treatment']>) => set({ treatment: { ...t, ...patch } });
  return (
    <div className="space-y-5">
      <div className="grid gap-5 md:grid-cols-[1fr_180px]">
        <EText label="Format" value={t.format} onChange={(v) => up({ format: v })} disabled={disabled} />
        <label className="block">
          <span className="block text-[13px] font-semibold text-ink-soft mb-1">Duration (minutes)</span>
          <input className="field-input" type="number" min={1} disabled={disabled} value={t.duration_minutes} onChange={(e) => up({ duration_minutes: Number(e.target.value) })} />
        </label>
      </div>
      <EText label="Presenter opening" value={t.presenter_opening} onChange={(v) => up({ presenter_opening: v })} disabled={disabled} long serif />
      <div>
        <h3 className="text-[13px] font-semibold text-ink-soft mb-2">Lines of inquiry</h3>
        <ObjList items={t.lines_of_inquiry} disabled={disabled} addLabel="Add line of inquiry" blank={{ question: '', evidence_refs: [] }}
          onChange={(v) => up({ lines_of_inquiry: v })}
          render={(l, u) => (
            <div className="space-y-2">
              <EText label="Question" value={l.question} onChange={(v) => u({ question: v })} disabled={disabled} />
              <RefChips refs={l.evidence_refs} states={refStates} active={activeRef} onPick={onPick} />
            </div>
          )} />
      </div>
      <EList label="Interview questions" value={t.interview_questions} onChange={(v) => up({ interview_questions: v })} disabled={disabled} />
      <EText label="Intended takeaway" value={t.takeaway} onChange={(v) => up({ takeaway: v })} disabled={disabled} long />
    </div>
  );
}

export function RundownSection({ c, set, disabled, refStates, activeRef, onPick, slotMinutes }: SectionProps & { slotMinutes: number | null }) {
  const rows = c.rundown ?? [];
  const total = rows.reduce((n, r) => n + (Number(r.duration_minutes) || 0), 0);
  const target = slotMinutes ?? c.treatment.duration_minutes;
  const ok = total === target;
  const update = (i: number, patch: Partial<RundownItem>) => set({ rundown: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const restart = () => {
    let t = 0;
    set({ rundown: rows.map((r) => { const x = { ...r, start_minute: t }; t += Number(r.duration_minutes) || 0; return x; }) });
  };
  return (
    <div className="space-y-4">
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-md px-4 py-2.5 text-sm border ${ok ? 'bg-verified-soft border-verified/30' : 'bg-signal-soft border-signal/50'}`}>
        <span>Segments total <strong>{total} min</strong> against a <strong>{target} min</strong> slot{slotMinutes ? ' (from the show profile, breaks included)' : ''}.
          {!ok && <> {total > target ? `${total - target} min over.` : `${target - total} min unaccounted for.`}</>}</span>
        {!disabled && <button className="btn btn-quiet btn-sm" onClick={restart}>Run segments back to back</button>}
      </div>
      <ol className="space-y-3">
        {rows.map((r, i) => (
          <li key={i} className={`border rounded-md p-4 ${r.is_break ? 'bg-paper border-dashed border-line-strong' : 'bg-surface border-line'}`}>
            <div className="grid gap-3 md:grid-cols-[70px_1fr_90px_auto] items-end">
              <div className="text-sm text-ink-soft pb-2">{String(r.start_minute).padStart(2, '0')}:00</div>
              <EText label="Segment" value={r.title} onChange={(v) => update(i, { title: v })} disabled={disabled} />
              <label className="block">
                <span className="block text-[13px] font-semibold text-ink-soft mb-1">Minutes</span>
                <input className="field-input" type="number" min={0} disabled={disabled} value={r.duration_minutes} onChange={(e) => update(i, { duration_minutes: Number(e.target.value) })} />
              </label>
              <div className="flex items-center gap-3 pb-2">
                <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" disabled={disabled} checked={r.is_break} onChange={(e) => update(i, { is_break: e.target.checked })} />Break</label>
                {!disabled && <button className="text-sm text-blocked underline" onClick={() => set({ rundown: rows.filter((_, j) => j !== i) })}>Remove</button>}
              </div>
            </div>
            {!r.is_break && (
              <div className="grid gap-3 md:grid-cols-2 mt-3">
                <EText label="Purpose" value={r.purpose} onChange={(v) => update(i, { purpose: v })} disabled={disabled} />
                <EText label="Owner" value={r.owner_role} onChange={(v) => update(i, { owner_role: v })} disabled={disabled} />
                <EText label="Script prompts" value={r.prompts} onChange={(v) => update(i, { prompts: v })} disabled={disabled} long />
                <EText label="Media cues" value={r.cues} onChange={(v) => update(i, { cues: v })} disabled={disabled} long />
                <EText label="Fallback if this falls through" value={r.fallback} onChange={(v) => update(i, { fallback: v })} disabled={disabled} />
                <div className="pt-6"><RefChips refs={r.evidence_refs} states={refStates} active={activeRef} onPick={onPick} /></div>
              </div>
            )}
          </li>
        ))}
      </ol>
      {!disabled && (
        <button className="btn btn-quiet btn-sm" onClick={() => set({ rundown: [...rows, { title: '', purpose: '', start_minute: total, duration_minutes: 5, is_break: false, owner_role: 'producer', prompts: '', evidence_refs: [], cues: '', fallback: '' }] })}>
          Add segment
        </button>
      )}
    </div>
  );
}

export function GuestsSection({ c, set, disabled }: SectionProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft max-w-[70ch]">
        These are perspectives to book, not people. A name suggested by a model is not a vetted guest: verify credentials and conflicts before anyone is contacted.
      </p>
      <ObjList items={c.guests ?? []} disabled={disabled} addLabel="Add perspective"
        blank={{ perspective_needed: '', why_needed: '', suggested_profile: '', credentials_to_verify: [], conflicts_to_check: [], status: 'role_only' }}
        onChange={(v) => set({ guests: v })}
        render={(g, u) => (
          <div className="grid gap-3 md:grid-cols-2">
            <EText label="Perspective needed" value={g.perspective_needed} onChange={(v) => u({ perspective_needed: v })} disabled={disabled} />
            <EText label="Kind of person" value={g.suggested_profile} onChange={(v) => u({ suggested_profile: v })} disabled={disabled} />
            <div className="md:col-span-2"><EText label="Why the programme needs it" value={g.why_needed} onChange={(v) => u({ why_needed: v })} disabled={disabled} long /></div>
            <EList label="Credentials to verify" value={g.credentials_to_verify} onChange={(v) => u({ credentials_to_verify: v })} disabled={disabled} />
            <EList label="Conflicts to check" value={g.conflicts_to_check} onChange={(v) => u({ conflicts_to_check: v })} disabled={disabled} />
          </div>
        )} />
    </div>
  );
}

const ASSET_LABEL: Record<string, string> = {
  teaser: 'Teaser', debate_highlight: 'Debate highlight', poll: 'Poll', quote_card: 'Quote card', thumbnail: 'Thumbnail', audiogram: 'Audiogram', thread: 'Thread',
};

export function SocialSection({ c, set, disabled }: SectionProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft max-w-[70ch]">
        Planned assets. Clip rendering arrives in the next phase; until then nothing here is a finished file, and every asset shows its real state.
      </p>
      <ObjList<SocialAsset> items={c.social_package ?? []} disabled={disabled} addLabel="Add asset"
        blank={{ asset_type: 'teaser', platform: '', format: '9:16 vertical', hook: '', caption_draft: '', clip_candidate: null, thumbnail_direction: null, render_state: 'planned' }}
        onChange={(v) => set({ social_package: v })}
        render={(a, u) => (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{ASSET_LABEL[a.asset_type] ?? a.asset_type}</span>
              <span className="text-[12px] font-semibold px-2 py-0.5 rounded-full bg-paper border border-line-strong">{a.render_state === 'rendered' ? 'Rendered' : 'Planned — not rendered'}</span>
              {a.clip_candidate && <span className="text-[12px] text-ink-faint">Clip candidate: passages {a.clip_candidate.segment_start}–{a.clip_candidate.segment_end}</span>}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block"><span className="block text-[13px] font-semibold text-ink-soft mb-1">Type</span>
                <select className="field-input" disabled={disabled} value={a.asset_type} onChange={(e) => u({ asset_type: e.target.value })}>
                  {Object.entries(ASSET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <EText label="Platform" value={a.platform} onChange={(v) => u({ platform: v })} disabled={disabled} />
              <EText label="Format" value={a.format} onChange={(v) => u({ format: v })} disabled={disabled} />
            </div>
            <EText label="Hook" value={a.hook} onChange={(v) => u({ hook: v })} disabled={disabled} />
            <EText label="Caption draft" value={a.caption_draft} onChange={(v) => u({ caption_draft: v })} disabled={disabled} long />
            {a.clip_candidate && <p className="text-[13px] text-ink-soft">Why this clip: {a.clip_candidate.rationale}</p>}
            <EText label="Thumbnail direction" value={a.thumbnail_direction ?? ''} onChange={(v) => u({ thumbnail_direction: v || null })} disabled={disabled} />
          </div>
        )} />
    </div>
  );
}

export function ContinuationSection({ c, set, disabled }: SectionProps) {
  const k = c.continuation;
  const up = (patch: Partial<BriefContent['continuation']>) => set({ continuation: { ...k, ...patch } });
  return (
    <div className="space-y-5">
      <EList label="What success looks like" value={k.success_criteria} onChange={(v) => up({ success_criteria: v })} disabled={disabled} />
      <EList label="Questions to answer from the aired programme" value={k.post_show_questions} onChange={(v) => up({ post_show_questions: v })} disabled={disabled}
        help="Answered from the actual recording after broadcast, not from this plan." />
      <div>
        <h3 className="text-[13px] font-semibold text-ink-soft mb-2">Possible follow-ups</h3>
        <ObjList items={k.follow_up_ideas} disabled={disabled} addLabel="Add follow-up" blank={{ title: '', advance: '' }}
          onChange={(v) => up({ follow_up_ideas: v })}
          render={(f, u) => (
            <div className="grid gap-3 md:grid-cols-2">
              <EText label="Episode idea" value={f.title} onChange={(v) => u({ title: v })} disabled={disabled} />
              <EText label="What it would add" value={f.advance} onChange={(v) => u({ advance: v })} disabled={disabled} />
            </div>
          )} />
      </div>
    </div>
  );
}

export { SectionHead };
