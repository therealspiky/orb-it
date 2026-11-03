import type { EpisodeMap } from './schema.js';
import { normaliseForMatch, type CheckResult } from '../../lib/validateBrief.js';
import type { Segment } from '../../types.js';

export interface MapShow { id: string; name: string; brand: string }

/**
 * Deterministic checks on a generated episode map:
 *  - moments must cite passages that exist; times come from the transcript
 *  - hooks must appear verbatim in their passage or are removed
 *  - show fits must name shows that were offered (eligible to use this source)
 *  - a conversation with no surviving moment is marked as needing outside evidence
 */
export function validateMap(input: EpisodeMap, segments: Segment[], shows: MapShow[], timed: boolean) {
  const map: EpisodeMap = structuredClone(input);
  const byIdx = new Map(segments.map((s) => [s.idx, s]));
  const allowed = new Set(shows.map((s) => s.id));
  let droppedMoments = 0, droppedHooks = 0, droppedFits = 0;
  const seenKeys = new Set<string>();

  const conversations = map.conversations.map((c, i) => {
    let key = c.key;
    if (seenKeys.has(key)) key = `c${i + 1}`;
    seenKeys.add(key);

    const moments = c.moments.flatMap((m) => {
      const a = Math.min(m.segment_start, m.segment_end), b = Math.max(m.segment_start, m.segment_end);
      if (!byIdx.has(a) || !byIdx.has(b)) { droppedMoments++; return []; }
      const passage: Segment[] = [];
      for (let k = a; k <= b; k++) { const s = byIdx.get(k); if (s) passage.push(s); }
      let hook = m.hook?.trim() || null;
      if (hook && !normaliseForMatch(passage.map((s) => s.text).join(' ')).includes(normaliseForMatch(hook))) {
        hook = null; droppedHooks++;
      }
      return [{
        ...m, segment_start: a, segment_end: b, hook,
        start_ms: timed ? passage[0]?.start_ms ?? null : null,
        end_ms: timed ? passage[passage.length - 1]?.end_ms ?? null : null,
      }];
    });

    const seenShows = new Set<string>();
    const show_fits = c.show_fits.filter((f) => {
      const ok = allowed.has(f.show_id) && !seenShows.has(f.show_id);
      if (!ok) droppedFits++;
      seenShows.add(f.show_id);
      return ok;
    });

    return { ...c, key, moments, show_fits, needs_outside_evidence: c.needs_outside_evidence || moments.length === 0 };
  });

  // Strongly fitted, well-grounded conversations first.
  conversations.sort((x, y) =>
    Number(x.needs_outside_evidence) - Number(y.needs_outside_evidence)
    || y.show_fits.filter((f) => f.fit === 'strong').length - x.show_fits.filter((f) => f.fit === 'strong').length);

  const checks: CheckResult[] = [
    { name: 'moments', status: droppedMoments ? 'warn' : 'ok', detail: droppedMoments ? `${droppedMoments} moment(s) cited missing passages and were dropped` : 'All moments resolve to the transcript' },
    { name: 'hooks', status: droppedHooks ? 'warn' : 'ok', detail: droppedHooks ? `${droppedHooks} non-verbatim hook(s) removed` : 'Hooks are verbatim' },
    { name: 'show_fits', status: droppedFits ? 'warn' : 'ok', detail: droppedFits ? `${droppedFits} fit(s) for shows that cannot use this source were removed` : 'All suggested shows can use this source' },
  ];
  return { map: { ...map, conversations }, report: { checks, validated_at: new Date().toISOString() } };
}
