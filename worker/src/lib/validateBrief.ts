import type { Brief } from './schemas.js';
import type { Segment, SourceRow } from '../types.js';

/**
 * Deterministic checks applied to every generated brief before it is stored.
 * The model proposes; this code decides what may be presented as evidence.
 *
 *  - Evidence ranges must exist in the transcript.
 *  - Quotes must appear verbatim in the cited passage or they are removed.
 *  - Attributions must match a speaker label in the cited passage.
 *  - Times come from transcript segments, never from model output.
 *  - Every evidence reference used elsewhere must resolve.
 *  - Rundown arithmetic must reconcile with the treatment and the slot length.
 *  - Recommendations without evidence are downgraded to research.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface CheckResult { name: string; status: CheckStatus; detail: string }

export interface EvidenceRow {
  ref_key: string;
  segment_start: number;
  segment_end: number;
  start_ms: number | null;
  end_ms: number | null;
  quote: string | null;
  attribution: string | null;
  kind: 'source_statement' | 'reported_claim' | 'inferred_theme';
  verification: 'unverified' | 'auto_matched';
  note: string | null;
}

export interface ValidationResult {
  brief: Brief;
  evidence: EvidenceRow[];
  report: { checks: CheckResult[]; passed: boolean; validated_at: string };
}

export interface ProfileSlot {
  episodeLengthMinutes?: number;
  breaksMinutes?: number;
  twiBeta?: boolean;
}

export function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Apostrophes are dropped entirely so "it's" and "its" compare equal.
    .replace(/['‘’`´]/g, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PERSON_NAME = /\b(Dr|Prof|Professor|Rev|Reverend|Mr|Mrs|Ms|Miss|Hon|Nana|Opanin|Togbe)\.?\s+[A-Z][a-z]+/;

export function validateBrief(
  input: Brief,
  segments: Segment[],
  source: Pick<SourceRow, 'kind' | 'timestamps_genuine' | 'language' | 'twi_beta'>,
  slot: ProfileSlot,
): ValidationResult {
  const brief: Brief = structuredClone(input);
  const checks: CheckResult[] = [];
  const byIdx = new Map(segments.map((s) => [s.idx, s]));
  const maxIdx = segments.length ? Math.max(...segments.map((s) => s.idx)) : -1;
  const addUnresolved = (field: string, reason: string, next_action: string, owner_role = 'producer') =>
    brief.unresolved.push({ field, reason, next_action, owner_role });

  // --- Evidence ------------------------------------------------------------
  const evidence: EvidenceRow[] = [];
  const seenRefs = new Set<string>();
  let dropped = 0, quotesRemoved = 0, attributionsRemoved = 0, matched = 0;

  for (const e of brief.evidence) {
    if (seenRefs.has(e.ref)) { dropped++; continue; }
    let start = Math.min(e.segment_start, e.segment_end);
    let end = Math.max(e.segment_start, e.segment_end);
    if (start < 0 || end > maxIdx || !byIdx.has(start) || !byIdx.has(end)) { dropped++; continue; }
    seenRefs.add(e.ref);
    const range: Segment[] = [];
    for (let i = start; i <= end; i++) { const s = byIdx.get(i); if (s) range.push(s); }
    const passage = normaliseForMatch(range.map((s) => s.text).join(' '));

    let quote = e.quote?.trim() || null;
    let verification: EvidenceRow['verification'] = 'unverified';
    let note: string | null = null;
    if (quote) {
      const nq = normaliseForMatch(quote.replace(/^["'“”‘’]+|["'“”‘’]+$/g, ''));
      if (nq.length >= 3 && passage.includes(nq)) {
        verification = 'auto_matched';
        matched++;
      } else {
        quote = null;
        quotesRemoved++;
        note = 'Model-proposed quote did not match the transcript and was removed.';
      }
    }

    let attribution = e.attribution?.trim() || null;
    if (attribution && !range.some((s) => s.speaker && s.speaker.toLowerCase() === attribution!.toLowerCase())) {
      attribution = null;
      attributionsRemoved++;
      note = [note, 'Attribution did not match transcript speaker labels and was removed.'].filter(Boolean).join(' ');
    }

    // Producer notes are not verified quotations.
    const kind = source.kind === 'notes' && e.kind === 'source_statement' ? 'reported_claim' : e.kind;
    const first = range[0];
    const last = range[range.length - 1];
    evidence.push({
      ref_key: e.ref,
      segment_start: start,
      segment_end: end,
      start_ms: source.timestamps_genuine ? first?.start_ms ?? null : null,
      end_ms: source.timestamps_genuine ? last?.end_ms ?? null : null,
      quote,
      attribution,
      kind,
      verification,
      note,
    });
  }
  brief.evidence = brief.evidence.filter((e) => evidence.some((x) => x.ref_key === e.ref))
    .map((e) => {
      const row = evidence.find((x) => x.ref_key === e.ref)!;
      return { ...e, segment_start: row.segment_start, segment_end: row.segment_end, quote: row.quote,
               attribution: row.attribution, kind: row.kind };
    });

  checks.push({
    name: 'evidence_ranges',
    status: dropped ? 'warn' : 'ok',
    detail: dropped ? `${dropped} evidence item(s) cited passages that do not exist and were dropped` : `${evidence.length} evidence item(s) resolve to the transcript`,
  });
  checks.push({
    name: 'quote_fidelity',
    status: quotesRemoved ? 'warn' : 'ok',
    detail: `${matched} quote(s) matched verbatim; ${quotesRemoved} non-matching quote(s) removed`,
  });
  if (attributionsRemoved) {
    checks.push({ name: 'attribution', status: 'warn', detail: `${attributionsRemoved} attribution(s) removed` });
  }
  if (!source.timestamps_genuine) {
    checks.push({ name: 'timecodes', status: 'warn', detail: 'Source has no genuine timestamps; evidence carries passage numbers only' });
  }

  // --- Reference integrity -----------------------------------------------------
  let badRefs = 0;
  const keep = (refs: string[]) => refs.filter((r) => { const ok = seenRefs.has(r); if (!ok) badRefs++; return ok; });
  brief.treatment.lines_of_inquiry = brief.treatment.lines_of_inquiry.map((l) => ({ ...l, evidence_refs: keep(l.evidence_refs) }));
  brief.rundown = brief.rundown.map((r) => ({ ...r, evidence_refs: keep(r.evidence_refs) }));
  brief.contradictory_evidence = brief.contradictory_evidence.map((c) => ({ ...c, evidence_refs: keep(c.evidence_refs) }));
  checks.push({ name: 'evidence_references', status: badRefs ? 'warn' : 'ok',
    detail: badRefs ? `${badRefs} dangling evidence reference(s) removed` : 'All evidence references resolve' });

  // --- Clip candidates ----------------------------------------------------------
  let badClips = 0;
  brief.social_package = brief.social_package.map((a) => {
    const c = a.clip_candidate;
    if (c && (!byIdx.has(c.segment_start) || !byIdx.has(c.segment_end) || c.segment_end < c.segment_start)) {
      badClips++;
      return { ...a, clip_candidate: null };
    }
    return a;
  });
  if (badClips) checks.push({ name: 'clip_candidates', status: 'warn', detail: `${badClips} invalid clip range(s) removed` });

  // --- Rundown arithmetic --------------------------------------------------------
  const total = brief.rundown.reduce((n, r) => n + r.duration_minutes, 0);
  const target = slot.episodeLengthMinutes ?? brief.treatment.duration_minutes;
  let gaps = 0;
  const sorted = [...brief.rundown].sort((a, b) => a.start_minute - b.start_minute);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    if (sorted[i]!.start_minute !== prev.start_minute + prev.duration_minutes) gaps++;
  }
  const rundownOk = total === target && total === brief.treatment.duration_minutes && gaps === 0;
  checks.push({
    name: 'rundown_arithmetic',
    status: rundownOk ? 'ok' : 'warn',
    detail: `Rundown totals ${total} min; treatment ${brief.treatment.duration_minutes} min; slot ${target} min` +
      (gaps ? `; ${gaps} timing gap/overlap(s)` : ''),
  });
  if (!rundownOk) {
    addUnresolved('rundown', `Rundown totals ${total} min but the slot is ${target} min${gaps ? ' and segments do not run back to back' : ''}.`,
      'Adjust segment durations so the plan reconciles with the slot and breaks.');
  }

  // --- Guests are roles, not invented people --------------------------------------
  const named = brief.guests.filter((g) => PERSON_NAME.test(g.suggested_profile));
  if (named.length) {
    brief.guests = brief.guests.map((g) => PERSON_NAME.test(g.suggested_profile)
      ? { ...g, suggested_profile: `[Name removed — select a verified candidate] ${g.perspective_needed}` } : g);
    checks.push({ name: 'guest_roles', status: 'warn', detail: `${named.length} guest suggestion(s) named a person; replaced with role` });
    addUnresolved('guests', 'A model-suggested name is not a vetted expert.', 'Choose verified candidates for each perspective.', 'researcher');
  } else {
    checks.push({ name: 'guest_roles', status: 'ok', detail: 'Guests described as roles' });
  }

  // --- Recommendation needs evidence ------------------------------------------------
  if (brief.recommendation === 'proceed' && evidence.length === 0) {
    brief.recommendation = 'research';
    brief.recommendation_reason = `Downgraded to research: no verifiable evidence from the source. ${brief.recommendation_reason}`;
    checks.push({ name: 'recommendation', status: 'warn', detail: 'No evidence; recommendation changed to research' });
  }

  // --- Language safeguards ---------------------------------------------------------
  const twi = source.twi_beta || source.language === 'tw' || slot.twiBeta;
  if (twi && !brief.review_flags.some((f) => f.check === 'language' && /twi/i.test(f.concern))) {
    brief.review_flags.push({ check: 'language', severity: 'high',
      concern: 'Twi is a supervised beta: a qualified Twi reviewer must check transcript passages, wording and subtitles.' });
  }
  if (!source.timestamps_genuine) {
    brief.review_flags.push({ check: 'fact', severity: 'medium',
      concern: 'Source text has no genuine timestamps; verify excerpts against the original recording before use.' });
  }

  const passed = !checks.some((c) => c.status === 'fail');
  return { brief, evidence, report: { checks, passed, validated_at: new Date().toISOString() } };
}
