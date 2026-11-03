import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractAudioChunks, probe, sha256File } from '../src/lib/media.js';
import { parseTextTranscript } from '../src/lib/textTranscript.js';
import { mapDeepgramUtterances, mapWhisperSegments } from '../src/modules/recording/transcribers.js';
import { cleanAnalysis, transcriptFingerprint } from '../src/jobs/analyse.js';
import { segments } from './fixtures.js';

describe('text transcripts and notes', () => {
  it('keeps author timestamps when nearly every line has one', () => {
    const p = parseTextTranscript('[00:00:05] HOST: Good morning\n[00:00:12] GUEST: Thank you\n[00:01:02] HOST: Let us begin', 'transcript');
    expect(p.timestampsGenuine).toBe(true);
    expect(p.segments.map((s) => s.start_ms)).toEqual([5000, 12000, 62000]);
    expect(p.segments[0]!.end_ms).toBe(12000);
    expect(p.segments[1]!.speaker).toBe('GUEST');
  });

  it('never invents times for untimed transcripts and merges continuation lines', () => {
    const p = parseTextTranscript('HOST: Good morning\nand welcome\nGUEST: Thanks', 'transcript');
    expect(p.timestampsGenuine).toBe(false);
    expect(p.segments.every((s) => s.start_ms === null && s.end_ms === null)).toBe(true);
    expect(p.segments[0]!.text).toBe('Good morning and welcome');
  });

  it('distrusts out-of-order timestamps', () => {
    const p = parseTextTranscript('[00:05:00] A: one\n[00:01:00] B: two', 'transcript');
    expect(p.timestampsGenuine).toBe(false);
  });

  it('splits notes into untimed paragraphs without speakers', () => {
    const p = parseTextTranscript('Idea one about trust.\n\nIdea two: money.', 'notes');
    expect(p.segments).toHaveLength(2);
    expect(p.segments[1]!.speaker).toBeNull();
  });
});

describe('provider mapping', () => {
  it('offsets Whisper chunk timings and flags low confidence', () => {
    const out = mapWhisperSegments([
      { start: 0, end: 4.2, text: ' Hello ', avg_logprob: -0.1 },
      { start: 4.2, end: 9, text: 'mumble', avg_logprob: -1.5 },
      { start: 9, end: 9.5, text: '   ' },
    ], 600_000, 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ idx: 10, start_ms: 600_000, end_ms: 604_200, text: 'Hello', is_uncertain: false });
    expect(out[1]!.is_uncertain).toBe(true);
  });

  it('maps Deepgram diarised utterances to labelled segments', () => {
    const out = mapDeepgramUtterances([{ start: 1.5, end: 3, transcript: 'Hi', confidence: 0.97, speaker: 0 },
                                       { start: 3, end: 5, transcript: 'Hey', confidence: 0.4, speaker: 1 }]);
    expect(out[0]).toMatchObject({ speaker: 'SPEAKER_1', start_ms: 1500 });
    expect(out[1]!.is_uncertain).toBe(true);
  });
});

describe('analysis hygiene', () => {
  it('drops extracted items outside the transcript and unknown speakers', () => {
    const cleaned = cleanAnalysis({
      summary: 's', questions_raised: [],
      themes: [{ theme: 't', note: 'n', segment_start: 0, segment_end: 2 }, { theme: 'x', note: 'n', segment_start: 3, segment_end: 9 }],
      claims: [{ claim: 'c', speaker: 'Mystery', claim_type: 'stated_opinion', needs_verification: true, segment_start: 1, segment_end: 1 }],
      usable_moments: [], sensitivities: [],
    }, segments);
    expect(cleaned.themes).toHaveLength(1);
    expect(cleaned.claims[0]!.speaker).toBeNull();
  });

  it('fingerprint changes when a passage is corrected', () => {
    const a = transcriptFingerprint(segments);
    const b = transcriptFingerprint(segments.map((s) => (s.idx === 2 ? { ...s, text: s.text + ' corrected' } : s)));
    expect(a).not.toBe(b);
  });
});

describe('media pipeline (ffmpeg)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('probes, fingerprints and chunks a 25-second recording into offset parts', async () => {
    const input = join(dir, 'tone.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=25', input]);
    const p = await probe(input);
    expect(p.hasAudio).toBe(true);
    expect(Math.round(p.durationSeconds)).toBe(25);
    expect(await sha256File(input)).toMatch(/^[0-9a-f]{64}$/);
    const chunks = await extractAudioChunks(input, dir, 10);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.offsetMs).toBe(0);
    expect(Math.abs(chunks[1]!.offsetMs - 10_000)).toBeLessThan(150);
    expect(Math.abs(chunks[2]!.offsetMs - 20_000)).toBeLessThan(300);
  });

  it('rejects files that are not media', async () => {
    const bad = join(dir, 'bad.mp3');
    execFileSync('sh', ['-c', `echo not audio > ${bad}`]);
    await expect(probe(bad)).rejects.toThrow(/could not be read/);
  });
});
