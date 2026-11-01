import { describe, expect, it } from 'vitest';
import { validateBrief, normaliseForMatch } from '../src/lib/validateBrief.js';
import { BriefSchema, toolSchema } from '../src/lib/schemas.js';
import { buildBriefRows, profileSlot, sourceUsableFor } from '../src/jobs/generateBriefs.js';
import { briefUserPrompt } from '../src/lib/prompts.js';
import { makeBrief, segments, source } from './fixtures.js';

const slot = { episodeLengthMinutes: 45 };

describe('validateBrief — evidence integrity (AT03)', () => {
  const v = validateBrief(makeBrief(), segments, source, slot);
  const byRef = Object.fromEntries(v.evidence.map((e) => [e.ref_key, e]));

  it('keeps verbatim quotes and marks them auto-matched', () => {
    expect(byRef.E1!.quote).toBe('money changes what people are willing to forgive');
    expect(byRef.E1!.verification).toBe('auto_matched');
  });

  it('matches quotes despite punctuation and apostrophe differences', () => {
    expect(byRef.E2!.verification).toBe('auto_matched');
  });

  it('removes a fabricated quote and leaves it unverified', () => {
    expect(byRef.E3!.quote).toBeNull();
    expect(byRef.E3!.verification).toBe('unverified');
    expect(byRef.E3!.note).toMatch(/did not match/);
  });

  it('drops evidence citing passages that do not exist', () => {
    expect(byRef.E4).toBeUndefined();
    expect(v.brief.evidence.map((e) => e.ref)).not.toContain('E4');
  });

  it('takes timecodes from the transcript, never from the model', () => {
    expect(byRef.E1!.start_ms).toBe(8000);
    expect(byRef.E1!.end_ms).toBe(15500);
  });

  it('strips dangling evidence references elsewhere in the brief', () => {
    expect(v.brief.treatment.lines_of_inquiry[0]!.evidence_refs).toEqual(['E1']);
    expect(v.brief.contradictory_evidence[0]!.evidence_refs).toEqual([]);
  });

  it('removes invalid clip ranges but keeps valid ones', () => {
    expect(v.brief.social_package[0]!.clip_candidate).not.toBeNull();
    expect(v.brief.social_package[1]!.clip_candidate).toBeNull();
  });

  it('replaces named guests with a role and raises a task', () => {
    expect(v.brief.guests[1]!.suggested_profile).toMatch(/Name removed/);
    expect(v.brief.unresolved.some((u) => u.field === 'guests')).toBe(true);
  });

  it('records a validation report', () => {
    const names = v.report.checks.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['evidence_ranges', 'quote_fidelity', 'rundown_arithmetic', 'guest_roles']));
  });
});

describe('validateBrief — attribution, rundown, recommendation, language', () => {
  it('removes attributions that do not match speaker labels', () => {
    const b = makeBrief({ evidence: [{ ref: 'E1', segment_start: 1, segment_end: 1, quote: null, attribution: 'Host Kofi', kind: 'source_statement', relevance: '' }] });
    const v = validateBrief(b, segments, source, slot);
    expect(v.evidence[0]!.attribution).toBeNull();
  });

  it('passes a reconciled 45-minute rundown (AT06)', () => {
    const v = validateBrief(makeBrief(), segments, source, slot);
    expect(v.report.checks.find((c) => c.name === 'rundown_arithmetic')!.status).toBe('ok');
    expect(v.brief.unresolved.some((u) => u.field === 'rundown')).toBe(false);
  });

  it('flags, but does not silently fix, a rundown that does not add up', () => {
    const b = makeBrief();
    b.rundown[1]!.duration_minutes = 25;
    const v = validateBrief(b, segments, source, slot);
    expect(v.report.checks.find((c) => c.name === 'rundown_arithmetic')!.status).toBe('warn');
    expect(v.brief.unresolved.find((u) => u.field === 'rundown')!.reason).toMatch(/50 min but the slot is 45/);
    expect(v.brief.rundown[1]!.duration_minutes).toBe(25);
  });

  it('downgrades "proceed" to "research" when no evidence survives', () => {
    const b = makeBrief({ evidence: [{ ref: 'E1', segment_start: 50, segment_end: 51, quote: null, attribution: null, kind: 'inferred_theme', relevance: '' }] });
    const v = validateBrief(b, segments, source, slot);
    expect(v.brief.recommendation).toBe('research');
  });

  it('adds a mandatory Twi review flag for Twi beta sources', () => {
    const v = validateBrief(makeBrief(), segments, { ...source, twi_beta: true }, slot);
    expect(v.brief.review_flags.some((f) => f.check === 'language' && /Twi/.test(f.concern))).toBe(true);
  });

  it('never attaches times to untimed sources and demotes notes to reported claims', () => {
    const v = validateBrief(makeBrief(), segments, { ...source, kind: 'notes', timestamps_genuine: false }, slot);
    expect(v.evidence.every((e) => e.start_ms === null && e.end_ms === null)).toBe(true);
    expect(v.evidence.every((e) => e.kind !== 'source_statement')).toBe(true);
  });
});

describe('schemas and row building', () => {
  it('produces a JSON schema for the tool without $schema', () => {
    const s = toolSchema(BriefSchema);
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe('object');
    expect((s.required as string[])).toContain('evidence');
  });

  it('the fixture brief satisfies the schema', () => {
    expect(BriefSchema.safeParse(makeBrief()).success).toBe(true);
  });

  it('builds linked rows with planned render state and blocking unresolved tasks', () => {
    const v = validateBrief(makeBrief(), segments, source, slot);
    const rows = buildBriefRows({
      brief: v.brief, evidence: v.evidence, validation: v.report, src: source,
      show: { id: 'show-hitz', org_id: 'org', brand_id: 'brand-hitz', name: 'Hitz Morning', archived_at: null, current_profile_version_id: 'pv', brands: { name: 'Hitz FM', current_profile_version_id: 'bpv' } },
      profileVersionId: 'pv', brandProfileVersionId: 'bpv', group: 'g', model: 'claude-sonnet-5-5', createdBy: null,
    });
    expect(rows.version.brief_id).toBe(rows.brief.id);
    expect(rows.evidence.every((e) => e.brief_version_id === rows.version.id)).toBe(true);
    expect((rows.version.content.social_package as { render_state: string }[]).every((a) => a.render_state === 'planned')).toBe(true);
    expect(rows.tasks.filter((t) => t.origin === 'unresolved').every((t) => t.blocking)).toBe(true);
    expect(rows.brief.status).toBe('drafted');
    expect(rows.version.brand_profile_version_id).toBe('bpv');
  });

  it('enforces source sharing scope at execution time', () => {
    const hitz = { id: 'show-hitz', brand_id: 'brand-hitz' };
    expect(sourceUsableFor({ share_scope: 'organisation', brand_id: 'brand-joy', show_id: 'show-tys' }, hitz)).toBe(true);
    expect(sourceUsableFor({ share_scope: 'brand', brand_id: 'brand-joy', show_id: 'show-tys' }, hitz)).toBe(false);
    expect(sourceUsableFor({ share_scope: 'show', brand_id: 'brand-hitz', show_id: 'show-other' }, hitz)).toBe(false);
  });

  it('applies a brand-level Twi setting to every show', () => {
    expect(profileSlot({}, { language: { twi_beta: true } }).twiBeta).toBe(true);
  });

  it('puts the approved brand profile in the prompt, or asks for one when missing', () => {
    const base = { showName: 'Morning Show', brandName: 'Joy FM', profile: {}, profileVersion: 1, priorCoverage: [], siblingTreatments: [],
      analysis: { summary: '', themes: [], claims: [], questions_raised: [], usable_moments: [], sensitivities: [] } };
    const withBrand = briefUserPrompt({ ...base, brandProfile: { identity: { positioning: 'Trusted news and talk' } }, brandProfileVersion: 3 });
    expect(withBrand).toContain('APPROVED BRAND PROFILE for Joy FM (version 3)');
    expect(withBrand).toContain('Trusted news and talk');
    const without = briefUserPrompt({ ...base, brandProfile: null, brandProfileVersion: null });
    expect(without).toContain('has no approved brand profile');
  });

  it('reads slot length from the approved profile', () => {
    expect(profileSlot({ voice: { episode_length_minutes: 45 } }).episodeLengthMinutes).toBe(45);
    expect(profileSlot({}).episodeLengthMinutes).toBeUndefined();
  });

  it('normalises text for quote matching', () => {
    expect(normaliseForMatch('“It’s  a DEAL-breaker!”')).toBe('its a deal breaker');
  });
});
