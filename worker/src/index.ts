import { loadConfig } from './config.js';
import { runAnalyse } from './jobs/analyse.js';
import { runGenerateBriefs } from './jobs/generateBriefs.js';
import { runMapEpisode } from './jobs/mapEpisode.js';
import { makeYouTube, runYouTubeConnect, runYouTubeImport } from './jobs/youtube.js';
import { runTranscribe } from './jobs/transcribe.js';
import { makeDb, setSourceStatus } from './lib/db.js';
import { AnthropicLlm } from './lib/llm.js';
import { makeTranscriber } from './lib/transcribers.js';
import { PermanentError, type JobRow } from './types.js';

const cfg = loadConfig();
const db = makeDb(cfg);
const llm = new AnthropicLlm(cfg.anthropicKey, cfg.anthropicWorkspaceId);
const transcriber = makeTranscriber(cfg);
const yt = makeYouTube(cfg);
let stopping = false;

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), worker: cfg.workerId, msg, ...extra }));
}

async function execute(job: JobRow): Promise<Record<string, unknown>> {
  switch (job.kind) {
    case 'transcribe': return runTranscribe(job, { db, cfg, transcriber });
    case 'analyse': return runAnalyse(job, { db, cfg, llm });
    case 'generate_briefs': return runGenerateBriefs(job, { db, cfg, llm });
    case 'map_episode': return runMapEpisode(job, { db, cfg, llm });
    case 'youtube_import': return runYouTubeImport(job, { db, cfg, yt });
    case 'youtube_connect': return runYouTubeConnect(job, { db, cfg, yt });
    default: throw new PermanentError(`Unknown job kind ${(job as JobRow).kind}`);
  }
}

async function handle(job: JobRow) {
  log('job.start', { id: job.id, kind: job.kind, attempt: job.attempts });
  const heartbeat = setInterval(() => {
    void db.from('jobs').update({ locked_at: new Date().toISOString() }).eq('id', job.id);
  }, 30_000);
  const started = Date.now();
  try {
    const result = await execute(job);
    await db.from('jobs').update({ status: 'succeeded', progress: 100, message: 'Done', result,
      updated_at: new Date().toISOString(), locked_by: null }).eq('id', job.id);
    log('job.done', { id: job.id, ms: Date.now() - started });
  } catch (e) {
    const err = e as Error;
    const permanent = err instanceof PermanentError;
    const retry = !permanent && job.attempts < job.max_attempts;
    const backoffS = 30 * 2 ** (job.attempts - 1);
    await db.from('jobs').update({
      status: retry ? 'queued' : 'failed',
      error: err.message.slice(0, 2000),
      message: retry ? `Retrying in ${backoffS}s` : (permanent ? err.message.slice(0, 300) : 'Failed after retries'),
      run_after: new Date(Date.now() + backoffS * 1000).toISOString(),
      locked_by: null, updated_at: new Date().toISOString(),
    }).eq('id', job.id);
    // A failed ingestion must never leave a misleading "processing" or "ready" source.
    if (!retry && (job.kind === 'transcribe' || (job.kind === 'youtube_import' && job.payload.fetch_captions === true)) && typeof job.payload.source_id === 'string') {
      await setSourceStatus(db, job.payload.source_id, 'failed', err.message.slice(0, 300)).catch(() => {});
    }
    log('job.error', { id: job.id, permanent, retry, error: err.message });
  } finally {
    clearInterval(heartbeat);
  }
}

async function loop() {
  log('worker.start', { provider: cfg.transcribeProvider, analysis: cfg.analysisModel, brief: cfg.briefModel,
    youtube: { connect: !!(cfg.googleClientId && cfg.googleClientSecret), apiKey: !!cfg.youtubeApiKey } });
  while (!stopping) {
    const { data, error } = await db.rpc('claim_job', { p_worker: cfg.workerId });
    if (error) {
      // Network failures put the real reason (DNS, TLS, proxy) in details/hint.
      log('claim.error', { error: error.message, details: (error as { details?: string }).details?.slice(0, 600), hint: (error as { hint?: string }).hint, url: cfg.supabaseUrl });
      await new Promise((r) => setTimeout(r, cfg.pollMs * 3));
      continue;
    }
    const job = data as JobRow | null;
    if (!job || !job.id) {
      await new Promise((r) => setTimeout(r, cfg.pollMs));
      continue;
    }
    await handle(job);
  }
  log('worker.stopped');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log('worker.stopping', { sig }); stopping = true; });
}
void loop();
