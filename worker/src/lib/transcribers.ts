import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Config } from '../config.js';
import type { Segment } from '../types.js';
import { extractAudio, extractAudioChunks } from './media.js';

export interface TranscriptResult {
  provider: string;
  model: string;
  segments: Segment[];
}

/** Confidence below this is surfaced to the producer as uncertain speech. */
export const UNCERTAIN_BELOW = 0.6;

export type ProgressFn = (pct: number, message: string) => Promise<void>;

export interface Transcriber {
  transcribe(mediaPath: string, workDir: string, language: string, onProgress: ProgressFn): Promise<TranscriptResult>;
}

// ---------------------------------------------------------------------------
// OpenAI (whisper-1 verbose_json gives genuine segment start/end times).
// No diarisation: speaker stays null and is shown as unlabelled.
// ---------------------------------------------------------------------------
interface WhisperSegment { start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }

export function mapWhisperSegments(segs: WhisperSegment[], offsetMs: number, startIdx: number): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const text = s.text.trim();
    if (!text) continue;
    const confidence = typeof s.avg_logprob === 'number' ? Math.max(0, Math.min(1, Math.exp(s.avg_logprob))) : null;
    out.push({
      idx: startIdx + out.length,
      start_ms: offsetMs + Math.round(s.start * 1000),
      end_ms: offsetMs + Math.round(s.end * 1000),
      speaker: null,
      text,
      confidence,
      is_uncertain: (confidence !== null && confidence < UNCERTAIN_BELOW) || (s.no_speech_prob ?? 0) > 0.5,
    });
  }
  return out;
}

export class OpenAITranscriber implements Transcriber {
  constructor(private cfg: Config) {}

  async transcribe(mediaPath: string, workDir: string, language: string, onProgress: ProgressFn) {
    const chunks = await extractAudioChunks(mediaPath, workDir, this.cfg.chunkSeconds);
    const segments: Segment[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      await onProgress(20 + Math.round((i / chunks.length) * 70), `Transcribing part ${i + 1} of ${chunks.length}`);
      const form = new FormData();
      form.append('file', new Blob([await readFile(c.path)], { type: 'audio/mpeg' }), basename(c.path));
      form.append('model', this.cfg.openaiTranscribeModel);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      // Only pin the language for English; Pidgin/mixed/Twi are left to detection.
      if (language === 'en') form.append('language', 'en');
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.openaiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`OpenAI transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { segments?: WhisperSegment[] };
      if (!body.segments) throw new Error('OpenAI transcription returned no segment timestamps');
      segments.push(...mapWhisperSegments(body.segments, c.offsetMs, segments.length));
    }
    return { provider: 'openai', model: this.cfg.openaiTranscribeModel, segments };
  }
}

// ---------------------------------------------------------------------------
// Deepgram (utterances with diarised speaker labels and word timings).
// ---------------------------------------------------------------------------
interface DgUtterance { start: number; end: number; transcript: string; confidence: number; speaker?: number }

export function mapDeepgramUtterances(utts: DgUtterance[]): Segment[] {
  return utts
    .filter((u) => u.transcript.trim())
    .map((u, i) => ({
      idx: i,
      start_ms: Math.round(u.start * 1000),
      end_ms: Math.round(u.end * 1000),
      speaker: typeof u.speaker === 'number' ? `SPEAKER_${u.speaker + 1}` : null,
      text: u.transcript.trim(),
      confidence: u.confidence,
      is_uncertain: u.confidence < UNCERTAIN_BELOW,
    }));
}

export class DeepgramTranscriber implements Transcriber {
  constructor(private cfg: Config) {}

  async transcribe(mediaPath: string, workDir: string, language: string, onProgress: ProgressFn) {
    const audio = await extractAudio(mediaPath, workDir);
    await onProgress(30, 'Transcribing with speaker separation');
    const params = new URLSearchParams({
      model: this.cfg.deepgramModel,
      diarize: 'true',
      utterances: 'true',
      punctuate: 'true',
      smart_format: 'true',
      // English is pinned; code-switched programmes use multilingual detection.
      language: language === 'en' ? 'en' : 'multi',
    });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.cfg.deepgramKey}`, 'Content-Type': 'audio/mpeg' },
      body: await readFile(audio),
    });
    if (!res.ok) throw new Error(`Deepgram transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { results?: { utterances?: DgUtterance[] } };
    const utts = body.results?.utterances;
    if (!utts) throw new Error('Deepgram returned no utterances');
    return { provider: 'deepgram', model: this.cfg.deepgramModel, segments: mapDeepgramUtterances(utts) };
  }
}

export function makeTranscriber(cfg: Config): Transcriber {
  return cfg.transcribeProvider === 'deepgram' ? new DeepgramTranscriber(cfg) : new OpenAITranscriber(cfg);
}
