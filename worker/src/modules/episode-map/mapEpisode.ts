import type { Config } from '../../config.js';
import { audit, getSegments, getSource, jobProgress, must, type Db } from '../../lib/db.js';
import type { LlmClient } from '../../lib/llm.js';
import { describeSource, renderTranscript } from '../../lib/prompts.js';
import { MAP_PROMPT_VERSION, MAP_SYSTEM, mapUserPrompt, type MapShowContext } from './prompts.js';
import { EpisodeMapSchema } from './schema.js';
import { validateMap } from './validateMap.js';
import { PermanentError, type JobRow, type SourceRow } from '../../types.js';
import { ensureAnalysis, transcriptFingerprint } from '../../jobs/analyse.js';
import { sourceUsableFor } from '../../jobs/generateBriefs.js';

export interface MapDeps { db: Db; cfg: Config; llm: LlmClient }

/** Shows that may use this source and have an approved show profile, with their profiles. */
export async function eligibleShows(db: Db, src: SourceRow): Promise<{ shows: MapShowContext[]; skippedNoProfile: number }> {
  const rows = must(await db.from('shows')
    .select('id,brand_id,name,archived_at,current_profile_version_id,brands(name,current_profile_version_id)')
    .eq('org_id', src.org_id).is('archived_at', null), 'load shows') as unknown as {
      id: string; brand_id: string; name: string; current_profile_version_id: string | null;
      brands: { name: string; current_profile_version_id: string | null } | null }[];
  const usable = rows.filter((r) => sourceUsableFor(src, r));
  const withProfile = usable.filter((r) => r.current_profile_version_id);
  const spIds = withProfile.map((r) => r.current_profile_version_id!);
  const bpIds = [...new Set(withProfile.map((r) => r.brands?.current_profile_version_id).filter(Boolean))] as string[];
  const sp = spIds.length ? must(await db.from('show_profile_versions').select('id,profile,status').in('id', spIds), 'load show profiles') as { id: string; profile: unknown; status: string }[] : [];
  const bp = bpIds.length ? must(await db.from('brand_profile_versions').select('id,profile,status').in('id', bpIds), 'load brand profiles') as { id: string; profile: unknown; status: string }[] : [];
  const shows = withProfile.flatMap((r) => {
    const s = sp.find((x) => x.id === r.current_profile_version_id && x.status === 'approved');
    if (!s) return [];
    const b = bp.find((x) => x.id === r.brands?.current_profile_version_id && x.status === 'approved');
    return [{ id: r.id, name: r.name, brand: r.brands?.name ?? '', showProfile: s.profile, brandProfile: b?.profile ?? null }];
  });
  return { shows, skippedNoProfile: usable.length - shows.length };
}

export async function runMapEpisode(job: JobRow, deps: MapDeps): Promise<Record<string, unknown>> {
  const { db, cfg, llm } = deps;
  const src = await getSource(db, String(job.payload.source_id ?? ''));
  if (src.org_id !== job.org_id) throw new PermanentError('Source belongs to another organisation');
  const segments = await getSegments(db, src.id);
  if (!segments.length) throw new PermanentError('Source has no transcript yet');

  await jobProgress(db, job.id, 10, 'Reading the episode');
  const { analysis } = await ensureAnalysis(db, cfg, llm, src, segments);
  const { shows, skippedNoProfile } = await eligibleShows(db, src);

  await jobProgress(db, job.id, 35, 'Mapping the conversations in this episode');
  const res = await llm.structured({
    model: cfg.briefModel,
    system: MAP_SYSTEM,
    cachedContext: `SOURCE\n${describeSource(src)}\n\nTRANSCRIPT (cite by [segment number])\n${renderTranscript(segments, src.timestamps_genuine)}`,
    user: mapUserPrompt(analysis, shows),
    toolName: 'record_episode_map',
    toolDescription: 'Record the content inventory (conversations, moments, show and platform fits) of this episode.',
    schema: EpisodeMapSchema,
    maxTokens: 12000,
  });
  const { map, report } = validateMap(res.value, segments, shows.map((s) => ({ id: s.id, name: s.name, brand: s.brand })), src.timestamps_genuine);

  const ins = await db.from('episode_maps').insert({
    org_id: src.org_id, source_id: src.id, transcript_fingerprint: transcriptFingerprint(segments),
    model: res.model, prompt_version: MAP_PROMPT_VERSION, result: map, considered_shows: shows.map((s) => s.id),
    validation: { ...report, skipped_no_profile: skippedNoProfile, usage: res.usage },
  }).select('id').single();
  if (ins.error) throw new Error(`store map: ${ins.error.message}`);
  await audit(db, src.org_id, 'source.mapped', 'source', src.id, { conversations: map.conversations.length, model: res.model });
  return { map_id: ins.data.id, conversations: map.conversations.length, shows_considered: shows.length, skipped_no_profile: skippedNoProfile };
}
