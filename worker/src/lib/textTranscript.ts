import type { Segment } from '../types.js';

/**
 * Parses a pasted/uploaded transcript or producer notes into segments.
 *
 * Timestamps are kept only when the author's text actually contains them on
 * (nearly) every line; Orb.IT never invents timings for untimed text.
 */
const TIME_RE = /^\s*[[(]?\s*((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?\s*[\])]?\s*[-–—]?\s*/;
const SPEAKER_RE = /^([A-Z][\p{L}0-9 .'’_-]{0,40}?)\s*:\s+(.+)$/u;

export function parseClock(s: string): number {
  const parts = s.split(':').map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs * 1000;
}

export interface ParsedText {
  segments: Segment[];
  timestampsGenuine: boolean;
}

export function parseTextTranscript(raw: string, kind: 'transcript' | 'notes'): ParsedText {
  const text = raw.replace(/\r\n?/g, '\n').replace(/ /g, ' ');

  if (kind === 'notes') {
    // Notes become paragraph segments with no speaker and no time.
    const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return {
      timestampsGenuine: false,
      segments: paras.map((p, idx) => ({
        idx, start_ms: null, end_ms: null, speaker: null, text: p, confidence: null, is_uncertain: false,
      })),
    };
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const timed = lines.filter((l) => TIME_RE.test(l)).length;
  const useTimes = lines.length > 0 && timed / lines.length >= 0.8;

  const rows: { start: number | null; speaker: string | null; text: string }[] = [];
  for (const line of lines) {
    let rest = line;
    let start: number | null = null;
    const tm = TIME_RE.exec(rest);
    if (tm) {
      if (useTimes) start = parseClock(tm[1]!);
      rest = rest.slice(tm[0].length);
    }
    let speaker: string | null = null;
    const sm = SPEAKER_RE.exec(rest);
    if (sm) {
      speaker = sm[1]!.trim();
      rest = sm[2]!.trim();
    }
    if (!rest) continue;
    // Untimed continuation lines from the same speaker merge into the previous row.
    const prev = rows[rows.length - 1];
    if (!useTimes && prev && !speaker && !tm) {
      prev.text += ' ' + rest;
      continue;
    }
    rows.push({ start, speaker, text: rest });
  }

  // Times must be non-decreasing to be trusted as genuine.
  let monotonic = useTimes;
  for (let i = 1; i < rows.length && monotonic; i++) {
    if ((rows[i]!.start ?? 0) < (rows[i - 1]!.start ?? 0)) monotonic = false;
  }

  const segments: Segment[] = rows.map((r, idx) => {
    const next = rows[idx + 1];
    return {
      idx,
      start_ms: monotonic ? r.start : null,
      end_ms: monotonic && next?.start != null ? next.start : null,
      speaker: r.speaker,
      text: r.text,
      confidence: null,
      is_uncertain: false,
    };
  });
  return { segments, timestampsGenuine: monotonic };
}
