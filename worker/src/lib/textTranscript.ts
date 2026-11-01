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

  // Caption files (SRT / WebVTT) exported from editing tools, YouTube or Descript.
  if (kind === 'transcript' && /\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*\d/.test(text)) return parseCaptions(text);

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
  return { segments: monotonic ? mergeTimedFragments(segments) : segments, timestampsGenuine: monotonic };
}

/**
 * Timed transcripts from YouTube and similar tools put a short fragment on every
 * line. Merge consecutive fragments from the same speaker into passages of up to
 * ~25 s, breaking at a sentence end once a passage is at least 8 s long.
 * Times stay genuine: a passage starts at its first fragment and ends where the
 * next passage begins.
 */
export function mergeTimedFragments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    const sameSpeaker = !!p && (p.speaker === s.speaker || s.speaker === null);
    const span = p && p.start_ms != null && s.start_ms != null ? s.start_ms - p.start_ms : Infinity;
    const sentenceEnd = !!p && /[.!?…]["”’)]?$/.test(p.text);
    if (p && sameSpeaker && span < 25_000 && !(sentenceEnd && span >= 8000)) {
      p.text += ' ' + s.text;
      p.end_ms = s.end_ms;
    } else {
      out.push({ ...s });
    }
  }
  return out.map((s, idx) => ({ ...s, idx }));
}

// ---------------------------------------------------------------------------
// SRT / WebVTT captions
// ---------------------------------------------------------------------------
const CUE_TIME = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

export function parseCueTime(s: string): number {
  const [clock, frac = '0'] = s.trim().replace(',', '.').split('.');
  return parseClock(clock!) + Math.round(Number(`0.${frac}`) * 1000);
}

interface Cue { start: number; end: number; speaker: string | null; text: string }

function cleanCueText(lines: string[]): { speaker: string | null; text: string } {
  let speaker: string | null = null;
  const parts: string[] = [];
  for (let line of lines) {
    const v = /<v(?:\.[^ >]*)?\s+([^>]+)>/.exec(line);
    if (v) speaker = v[1]!.trim();
    line = line
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '') // VTT inline timestamps
      .replace(/<\/?[^>]+>/g, '')                             // VTT/HTML tags
      .replace(/\{\\[^}]*\}/g, '')                            // SSA override tags like {\an8}
      .replace(/^\s*[-–]\s+/, '')                             // dialogue dash
      .trim();
    if (!line) continue;
    const sm = SPEAKER_RE.exec(line);
    if (sm && sm[1]!.length <= 30) { speaker = sm[1]!.trim(); line = sm[2]!.trim(); }
    else {
      const bracket = /^\[([^\]]{1,30})\]\s*:?\s*(.+)$/.exec(line);
      if (bracket && /^[A-Z]/.test(bracket[1]!)) { speaker = bracket[1]!.trim(); line = bracket[2]!; }
    }
    parts.push(line);
  }
  return { speaker, text: parts.join(' ').replace(/\s+/g, ' ').trim() };
}

/**
 * Parses caption cues and merges them into readable passages. Cue times come
 * from the editing tool, so they are kept when they run in order. Rolling
 * auto-captions (each cue repeating the previous line) are de-duplicated.
 */
export function parseCaptions(text: string): ParsedText {
  const cues: Cue[] = [];
  let lastText = '';
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trimEnd());
    const ti = lines.findIndex((l) => CUE_TIME.test(l));
    if (ti < 0) continue; // WEBVTT header, NOTE, STYLE, REGION
    const m = CUE_TIME.exec(lines[ti]!)!;
    const cleaned = cleanCueText(lines.slice(ti + 1));
    let t = cleaned.text;
    if (!t) continue;
    if (lastText) {
      const prevWords = lastText.split(' ');
      for (let k = Math.min(prevWords.length, 20); k > 0; k--) {
        const tail = prevWords.slice(-k).join(' ');
        if (t === tail) { t = ''; break; }
        if (t.startsWith(tail + ' ')) { t = t.slice(tail.length + 1); break; }
      }
      if (!t) continue;
    }
    cues.push({ start: parseCueTime(m[1]!), end: parseCueTime(m[2]!), speaker: cleaned.speaker, text: t });
    lastText = cleaned.text;
  }

  // Merge short cues into passages: same speaker, small gap, up to ~25 s,
  // breaking at a sentence end once a passage is at least 8 s long.
  const merged: Cue[] = [];
  for (const c of cues) {
    const p = merged[merged.length - 1];
    const sameSpeaker = !p || p.speaker === c.speaker || c.speaker === null;
    const gap = p ? c.start - p.end : 0;
    const len = p ? c.end - p.start : 0;
    const sentenceEnd = p ? /[.!?…]["”’)]?$/.test(p.text) : false;
    if (p && sameSpeaker && gap < 2000 && len <= 25_000 && !(sentenceEnd && p.end - p.start >= 8000)) {
      p.text += ' ' + c.text;
      p.end = Math.max(p.end, c.end);
    } else {
      merged.push({ ...c });
    }
  }

  let monotonic = merged.length > 0;
  for (let i = 1; i < merged.length && monotonic; i++) if (merged[i]!.start < merged[i - 1]!.start) monotonic = false;
  return {
    timestampsGenuine: monotonic,
    segments: merged.map((c, idx) => ({
      idx, start_ms: monotonic ? c.start : null, end_ms: monotonic ? c.end : null,
      speaker: c.speaker, text: c.text, confidence: null, is_uncertain: false,
    })),
  };
}
