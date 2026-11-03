import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { audit, getSegments, getSource, jobProgress, type Db } from '../lib/db.js';
import { estimateTokens, type LlmClient } from '../lib/llm.js';
import { ANALYSIS_PROMPT_VERSION, ANALYSIS_SYSTEM, describeSource, renderTranscript } from '../lib/prompts.js';
import { AnalysisSchema, type Analysis } from '../lib/schemas.js';
import type { ModuleState } from '../modules/types.js';
import { PermanentError, type JobRow, type Segment, type SourceRow } from '../types.js';

export interface AnalyseDeps { db: Db; cfg: Config; llm: LlmClient; modules?: ModuleState }

export function transcriptFingerprint(segments: Segment[]): string {
  const h = createHash('sha256');
  for (const s of segments) h.update(`${s.idx}\u0000${s.speaker ?? ''}\u0000${s.text}\u0001`);
  return h.digest('hex');
}

/** Drops any extracted item that cites passages not in the transcript. */
export function cleanAnalysis(a: Analysis, segments: Segment[]): Analysis {
  const max = segments.length ? Math.max(...segments.map((s) => s.idx)) : -1;
  const ok = (x: { segment_start: number; segment_end: number }) =>
    x.segment_start >= 0 && x.segment_end <= max && x.segment_end >= x.segment_start;
  const speakers = new Set(segments.map((s) => s.speaker).filter(Boolean));
  return {
    ...a,
    themes: a.themes.filter(ok),
    claims: a.claims.filter(ok).map((c) => ({ ...c, speaker: c.speaker && speakers.has(c.speaker) ? c.speaker : null })),
    usable_moments: a.usable_moments.filter(ok),
    sensitivities: a.sensitivities.filter(ok),
  };
}

/** Returns the current analysis for a source, running the extraction pass if missing or stale. */
export async function ensureAnalysis(db: Db, cfg: Config, llm: LlmClient, src: SourceRow, segments: Segment[]):
  Promise<{ analysis: Analysis; id: string; reused: boolean }> {
  const fingerprint = transcriptFingerprint(segments);
  const existing = await db.from('source_analyses').select('id,result')
    .eq('source_id', src.id).eq('transcript_fingerprint', fingerprint).eq('prompt_version', ANALYSIS_PROMPT_VERSION)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing.data) return { analysis: existing.data.result as Analysis, id: existing.data.id as string, reused: true };

  const transcript = renderTranscript(segments, src.timestamps_genuine);
  // Haiku pricing rises sharply above 100K prompt tokens; use the brief model for very long sources.
  const model = estimateTokens(transcript) > 90_000 ? cfg.briefModel : cfg.analysisModel;
  const res = await llm.structured({
    model,
    system: ANALYSIS_SYSTEM,
    cachedContext: `SOURCE\n${describeSource(src)}\n\nTRANSCRIPT\n${transcript}`,
    user: 'Analyse this source and record the result with the record_analysis tool.',
    toolName: 'record_analysis',
    toolDescription: 'Record the structured analysis of the source.',
    schema: AnalysisSchema,
    maxTokens: 8000,
  });
  const analysis = cleanAnalysis(res.value, segments);
  const ins = await db.from('source_analyses').insert({
    org_id: src.org_id, source_id: src.id, transcript_fingerprint: fingerprint,
    model: res.model, prompt_version: ANALYSIS_PROMPT_VERSION, result: analysis,
  }).select('id').single();
  if (ins.error) throw new Error(`store analysis: ${ins.error.message}`);
  await audit(db, src.org_id, 'source.analysed', 'source', src.id, { model: res.model, usage: res.usage });
  return { analysis, id: ins.data.id as string, reused: false };
}

export async function runAnalyse(job: JobRow, deps: AnalyseDeps): Promise<Record<string, unknown>> {
  const src = await getSource(deps.db, String(job.payload.source_id ?? ''));
  if (src.org_id !== job.org_id) throw new PermanentError('Source belongs to another organisation');
  const segments = await getSegments(deps.db, src.id);
  if (!segments.length) throw new PermanentError('Source has no transcript yet');
  await jobProgress(deps.db, job.id, 20, 'Extracting themes, claims and usable moments');
  const { analysis, reused } = await ensureAnalysis(deps.db, deps.cfg, deps.llm, src, segments);
  // Next, when the episode map module is on: map the episode's conversations.
  if (deps.modules?.isEnabled('episode_map')) await deps.db.from('jobs').upsert({
    org_id: src.org_id, kind: 'map_episode', payload: { source_id: src.id },
    idempotency_key: `map:${src.id}:${transcriptFingerprint(segments)}`, created_by: job.created_by,
  }, { onConflict: 'org_id,idempotency_key', ignoreDuplicates: true });
  return { reused, themes: analysis.themes.length, claims: analysis.claims.length };
}
