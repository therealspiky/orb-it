import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { audit, getSource, jobProgress, setSourceStatus, type Db } from '../lib/db.js';
import { probe, sha256File } from '../lib/media.js';
import { parseTextTranscript } from '../lib/textTranscript.js';
import type { Transcriber } from '../lib/transcribers.js';
import { PermanentError, type JobRow, type Segment } from '../types.js';
import mammoth from 'mammoth';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Text of an uploaded transcript or notes file (.txt, .srt, .vtt, .md or Word .docx). */
export async function readTextSource(path: string, mime: string | null, bytes: Buffer): Promise<string> {
  if (mime === DOCX || /\.docx$/i.test(path)) {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return value;
  }
  if (/\.(doc|pdf|pages|rtf)$/i.test(path)) {
    throw new PermanentError('This file type cannot be read as a transcript. Upload .txt, .srt, .vtt or .docx, or paste the text.');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

export interface TranscribeDeps { db: Db; cfg: Config; transcriber: Transcriber }

async function storeSegments(db: Db, orgId: string, sourceId: string, segments: Segment[]) {
  // Re-processing is only safe while nothing cites this transcript.
  const cited = await db.from('evidence').select('id', { count: 'exact', head: true }).eq('source_id', sourceId);
  if ((cited.count ?? 0) > 0) {
    throw new PermanentError('This transcript is already cited by briefs; correct individual passages instead of re-transcribing.');
  }
  const del = await db.from('transcript_segments').delete().eq('source_id', sourceId);
  if (del.error) throw new Error(`clear segments: ${del.error.message}`);
  for (let i = 0; i < segments.length; i += 500) {
    const batch = segments.slice(i, i + 500).map((s) => ({ ...s, org_id: orgId, source_id: sourceId }));
    const ins = await db.from('transcript_segments').insert(batch);
    if (ins.error) throw new Error(`insert segments: ${ins.error.message}`);
  }
}

export async function runTranscribe(job: JobRow, deps: TranscribeDeps): Promise<Record<string, unknown>> {
  const { db, cfg, transcriber } = deps;
  const sourceId = String(job.payload.source_id ?? '');
  const src = await getSource(db, sourceId);
  if (src.org_id !== job.org_id) throw new PermanentError('Source belongs to another organisation');
  if (!src.storage_path) throw new PermanentError('No uploaded file is attached to this source');

  await setSourceStatus(db, src.id, 'processing', 'Downloading original');
  await jobProgress(db, job.id, 5, 'Downloading original');

  const work = await mkdtemp(join(tmpdir(), 'orbit-'));
  try {
    const dl = await db.storage.from('media').download(src.storage_path);
    if (dl.error || !dl.data) throw new Error(`download failed: ${dl.error?.message ?? 'no data'}`);
    if (dl.data.size > cfg.maxUploadMb * 1024 * 1024) throw new PermanentError(`File exceeds ${cfg.maxUploadMb} MB limit`);
    const local = join(work, 'original');
    await writeFile(local, Buffer.from(await dl.data.arrayBuffer()));

    // The stored object must be the bytes the uploader fingerprinted.
    const checksum = await sha256File(local);
    if (src.checksum_sha256 && checksum !== src.checksum_sha256) {
      throw new PermanentError('Checksum mismatch: the stored file differs from what was uploaded');
    }

    let segments: Segment[];
    let timestampsGenuine: boolean;
    let duration: number | null = null;
    let providerInfo: Record<string, unknown>;

    if (src.kind === 'recording') {
      await jobProgress(db, job.id, 10, 'Inspecting media');
      const p = await probe(local);
      if (!p.hasAudio) throw new PermanentError('The recording has no audio track');
      if (p.durationSeconds < 1) throw new PermanentError('The recording is empty');
      duration = p.durationSeconds;
      const result = await transcriber.transcribe(local, work, src.language, (pct, msg) => jobProgress(db, job.id, pct, msg));
      segments = result.segments;
      timestampsGenuine = true;
      providerInfo = { provider: result.provider, model: result.model, format: p.formatName, has_video: p.hasVideo };
    } else {
      const text = await readTextSource(src.storage_path, src.mime_type, Buffer.from(await dl.data.arrayBuffer()));
      const parsed = parseTextTranscript(text, src.kind);
      segments = parsed.segments;
      timestampsGenuine = parsed.timestampsGenuine;
      providerInfo = { provider: 'text-parser', author_timestamps: parsed.timestampsGenuine };
    }

    if (segments.length === 0) throw new PermanentError('No speech or text could be extracted from this source');
    // Twi material always requires correction by a qualified reviewer.
    if (src.twi_beta || src.language === 'tw') segments = segments.map((s) => ({ ...s, is_uncertain: true }));

    await jobProgress(db, job.id, 92, 'Saving transcript');
    await storeSegments(db, src.org_id, src.id, segments);

    const uncertain = segments.filter((s) => s.is_uncertain).length;
    await setSourceStatus(db, src.id, uncertain > 0 ? 'needs_attention' : 'ready',
      uncertain > 0 ? `${uncertain} passage(s) flagged for review` : 'Transcript ready',
      { timestamps_genuine: timestampsGenuine, duration_seconds: duration });
    await audit(db, src.org_id, 'source.transcribed', 'source', src.id, { segments: segments.length, uncertain, ...providerInfo });

    // Chain the extraction pass.
    await db.from('jobs').upsert({
      org_id: src.org_id, kind: 'analyse', payload: { source_id: src.id },
      idempotency_key: `analyse:${src.id}:${checksum}`, created_by: job.created_by,
    }, { onConflict: 'org_id,idempotency_key', ignoreDuplicates: true });

    return { segments: segments.length, uncertain, timestamps_genuine: timestampsGenuine, ...providerInfo };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
