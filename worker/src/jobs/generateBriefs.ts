import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { audit, getSegments, getSource, jobProgress, must, type Db } from '../lib/db.js';
import type { LlmClient } from '../lib/llm.js';
import { BRIEF_PROMPT_VERSION, BRIEF_SYSTEM, briefUserPrompt, describeSource, renderTranscript } from '../lib/prompts.js';
import { BriefSchema, type Brief } from '../lib/schemas.js';
import { validateBrief, type EvidenceRow } from '../lib/validateBrief.js';
import { PermanentError, type JobRow, type SourceRow } from '../types.js';
import { ensureAnalysis } from './analyse.js';

export interface GenerateDeps { db: Db; cfg: Config; llm: LlmClient }

interface ShowRow {
  id: string; org_id: string; brand_id: string; name: string; archived_at: string | null;
  current_profile_version_id: string | null;
  brands: { name: string; current_profile_version_id: string | null } | null;
}

/** Same cross-brand sharing rule as enqueue_job(), re-checked at execution time. */
export function sourceUsableFor(src: Pick<SourceRow, 'share_scope' | 'brand_id' | 'show_id'>, show: { id: string; brand_id: string }): boolean {
  if (src.share_scope === 'organisation') return true;
  if (src.share_scope === 'brand') return src.brand_id === show.brand_id;
  return src.show_id === show.id || (src.show_id === null && src.brand_id === show.brand_id);
}

export function profileSlot(profile: Record<string, any>, brandProfile?: Record<string, any> | null) {
  const voice = profile?.voice ?? {};
  const lang = profile?.language ?? {};
  const brandLang = brandProfile?.language ?? {};
  const len = Number(voice.episode_length_minutes);
  return {
    episodeLengthMinutes: Number.isFinite(len) && len > 0 ? len : undefined,
    breaksMinutes: Number(voice.breaks_minutes) || 0,
    twiBeta: Boolean(lang.twi_beta) || Boolean(brandLang.twi_beta),
  };
}

/** Rows to insert for one validated brief. Pure, so it can be unit-tested. */
export function buildBriefRows(args: {
  brief: Brief; evidence: EvidenceRow[]; validation: unknown;
  src: SourceRow; show: ShowRow; profileVersionId: string; brandProfileVersionId: string | null;
  group: string; model: string; createdBy: string | null;
}) {
  const { brief, evidence, src, show } = args;
  const briefId = randomUUID();
  const versionId = randomUUID();
  const status = brief.recommendation === 'research' ? 'researching' : 'drafted';
  const content = {
    ...brief,
    social_package: brief.social_package.map((a) => ({ ...a, render_state: 'planned' as const })),
    guests: brief.guests.map((g) => ({ ...g, status: 'role_only' as const })),
  };
  const tasks = [
    ...brief.production_tasks.map((t) => ({
      title: t.title, detail: t.detail, owner_role: t.owner_role, blocking: t.blocking, origin: 'generated' as const,
    })),
    ...brief.unresolved.map((u) => ({
      title: `Resolve: ${u.field}`, detail: `${u.reason}\nNext action: ${u.next_action}`,
      owner_role: u.owner_role, blocking: true, origin: 'unresolved' as const,
    })),
  ].map((t) => ({ ...t, id: randomUUID(), org_id: src.org_id, brief_id: briefId, created_by: args.createdBy }));

  return {
    brief: {
      id: briefId, org_id: show.org_id, brand_id: show.brand_id, show_id: show.id, origin_source_id: src.id,
      generation_group: args.group, title: brief.title, status, recommendation: brief.recommendation,
      created_by: args.createdBy,
    },
    briefSource: { brief_id: briefId, source_id: src.id, org_id: src.org_id },
    version: {
      id: versionId, org_id: show.org_id, brand_id: show.brand_id, show_id: show.id, brief_id: briefId, version: 1,
      content, profile_version_id: args.profileVersionId, brand_profile_version_id: args.brandProfileVersionId,
      generated: true, model: args.model,
      prompt_version: BRIEF_PROMPT_VERSION, validation: args.validation, created_by: args.createdBy,
      change_note: 'Generated from source',
    },
    evidence: evidence.map((e) => ({ ...e, org_id: src.org_id, brief_version_id: versionId, source_id: src.id })),
    tasks,
  };
}

export async function runGenerateBriefs(job: JobRow, deps: GenerateDeps): Promise<Record<string, unknown>> {
  const { db, cfg, llm } = deps;
  const src = await getSource(db, String(job.payload.source_id ?? ''));
  if (src.org_id !== job.org_id) throw new PermanentError('Source belongs to another organisation');
  if (!['ready', 'needs_attention'].includes(src.status)) throw new PermanentError(`Source is ${src.status}; it must be transcribed first`);
  const showIds = (job.payload.show_ids as string[] | undefined) ?? [];
  if (!showIds.length) throw new PermanentError('No destination shows selected');
  const group = String(job.payload.generation_group ?? job.id);

  const segments = await getSegments(db, src.id);
  if (!segments.length) throw new PermanentError('Source has no transcript');
  await jobProgress(db, job.id, 5, 'Analysing source');
  const { analysis } = await ensureAnalysis(db, cfg, llm, src, segments);

  const transcriptBlock = `SOURCE\n${describeSource(src)}\n\nTRANSCRIPT (cite by [segment number])\n${renderTranscript(segments, src.timestamps_genuine)}`;
  const shows = must(await db.from('shows').select('id,org_id,brand_id,name,archived_at,current_profile_version_id,brands(name,current_profile_version_id)')
    .in('id', showIds), 'load shows') as unknown as ShowRow[];

  // Retries resume: briefs already created for this group are kept and fed in as siblings.
  const done = must(await db.from('briefs').select('id,show_id,title,current_version_id').eq('generation_group', group), 'load group') as
    { id: string; show_id: string; title: string; current_version_id: string }[];
  const siblings: { show: string; title: string; premise: string }[] = [];
  for (const d of done) {
    const v = await db.from('brief_versions').select('content').eq('id', d.current_version_id).maybeSingle();
    const s = shows.find((x) => x.id === d.show_id);
    siblings.push({ show: s?.name ?? 'Other show', title: d.title, premise: String((v.data?.content as any)?.premise ?? '') });
  }

  const created: string[] = [];
  const skipped: { show: string; reason: string }[] = [];
  let i = 0;
  for (const showId of showIds) {
    i++;
    const show = shows.find((s) => s.id === showId);
    if (!show || show.org_id !== src.org_id) { skipped.push({ show: showId, reason: 'not found' }); continue; }
    if (done.some((d) => d.show_id === show.id)) continue;
    if (show.archived_at) { skipped.push({ show: show.name, reason: 'archived' }); continue; }
    if (!sourceUsableFor(src, show)) { skipped.push({ show: show.name, reason: 'source sharing scope' }); continue; }
    if (!show.current_profile_version_id) { skipped.push({ show: show.name, reason: 'no approved profile' }); continue; }

    const pv = must(await db.from('show_profile_versions').select('id,version,profile,status')
      .eq('id', show.current_profile_version_id).single(), 'load profile') as { id: string; version: number; profile: any; status: string };
    if (pv.status !== 'approved') { skipped.push({ show: show.name, reason: 'profile not approved' }); continue; }

    // Brand profile: applied when approved; its absence is recorded as unresolved, not guessed.
    const bpvId = show.brands?.current_profile_version_id ?? null;
    const bpvRow = bpvId
      ? (await db.from('brand_profile_versions').select('id,version,profile,status').eq('id', bpvId).maybeSingle()).data as
          { id: string; version: number; profile: any; status: string } | null
      : null;
    const bpv = bpvRow?.status === 'approved' ? bpvRow : null;

    const prior = must(await db.from('briefs').select('title,status,status_reason').eq('show_id', show.id)
      .order('created_at', { ascending: false }).limit(20), 'load coverage') as { title: string; status: string; status_reason: string | null }[];

    await jobProgress(db, job.id, 10 + Math.round(((i - 1) / showIds.length) * 85), `Writing brief for ${show.name}`);
    const res = await llm.structured({
      model: cfg.briefModel,
      system: BRIEF_SYSTEM,
      cachedContext: transcriptBlock,
      user: briefUserPrompt({
        showName: show.name, brandName: show.brands?.name ?? '', profile: pv.profile, profileVersion: pv.version,
        brandProfile: bpv?.profile ?? null, brandProfileVersion: bpv?.version ?? null,
        analysis, priorCoverage: prior.map((p) => ({ title: p.title, status: p.status, reason: p.status_reason })),
        siblingTreatments: siblings,
      }),
      toolName: 'record_brief',
      toolDescription: 'Record the complete opportunity brief for the destination show.',
      schema: BriefSchema,
      maxTokens: 16000,
    });

    const v = validateBrief(res.value, segments, src, profileSlot(pv.profile, bpv?.profile));
    if (!bpv && !v.brief.unresolved.some((u) => /brand profile/i.test(u.field))) {
      v.brief.unresolved.push({ field: 'brand profile', reason: `${show.brands?.name ?? 'This brand'} has no approved brand profile, so station-wide identity and standards were not applied.`,
        next_action: 'Approve a brand profile, then review this brief against it.', owner_role: 'brand_editor' });
    }
    const rows = buildBriefRows({
      brief: v.brief, evidence: v.evidence, validation: { ...v.report, usage: res.usage },
      src, show, profileVersionId: pv.id, brandProfileVersionId: bpv?.id ?? null, group, model: res.model, createdBy: job.created_by,
    });
    must(await db.from('briefs').insert(rows.brief).select('id').single(), 'insert brief');
    must(await db.from('brief_sources').insert(rows.briefSource).select('brief_id'), 'insert brief source');
    must(await db.from('brief_versions').insert(rows.version).select('id').single(), 'insert version');
    if (rows.evidence.length) must(await db.from('evidence').insert(rows.evidence).select('id'), 'insert evidence');
    if (rows.tasks.length) must(await db.from('research_tasks').insert(rows.tasks).select('id'), 'insert tasks');
    await audit(db, src.org_id, 'brief.generated', 'brief', rows.brief.id, {
      show: show.id, source: src.id, model: res.model, prompt_version: BRIEF_PROMPT_VERSION,
      profile_version: pv.id, validation: v.report.checks.filter((c) => c.status !== 'ok'),
    });
    created.push(rows.brief.id);
    siblings.push({ show: show.name, title: v.brief.title, premise: v.brief.premise });
  }

  if (!created.length && !done.length) {
    throw new PermanentError(`No briefs created: ${skipped.map((s) => `${s.show} (${s.reason})`).join(', ') || 'nothing to do'}`);
  }
  return { created, skipped, group };
}
