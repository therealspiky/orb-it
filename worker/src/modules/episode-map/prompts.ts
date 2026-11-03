import type { Analysis } from '../../lib/schemas.js';
import { UNTRUSTED } from '../../lib/prompts.js';

// ---------------------------------------------------------------------------
// Episode map
// ---------------------------------------------------------------------------
export const MAP_PROMPT_VERSION = 'map-2026-11-01';

export const MAP_SYSTEM = `You are Orb.IT's content strategist for a media group. One episode is "content inventory":
it usually contains several distinct conversations that different shows, presenters and platforms can each take in a
different direction, all feeding attention back to the original moment. Map that inventory.

A conversation is not a topic label. It is a question an audience would genuinely argue about or want explained,
sparked by something in the episode (for example "When does financial security become financial dependence?").

Rules:
- Find every distinct conversation worth a programme or social package (typically 3–8). Merge near-duplicates.
- Cite the moments where each conversation lives by [segment number] ranges. A "hook" must be words copied exactly from
  those segments, or null.
- Suggest shows ONLY from the list provided, using their brand and show profiles. Different shows should take different
  angles of the same conversation so they feed each other instead of cannibalising each other; give each show's distinct
  treatment in one line. A show need not fit every conversation, and "strong" should be used sparingly.
- Suggest platforms that suit the conversation and the brands' channels, with a concrete format (e.g. "45s vertical clip",
  "quote card set", "X thread", "phone-in segment").
- You may include a conversation about the episode's own reception or ethics (angle meta_media), but if this source does
  not itself contain that reaction, set needs_outside_evidence to true.
- Do not invent audience numbers, virality, trends or reactions. Flag privacy, allegations, abuse, minors and
  stereotyping risks in sensitivities.
${UNTRUSTED}`;

function pick(obj: any, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) out[p] = v;
  }
  return out;
}

export interface MapShowContext {
  id: string; name: string; brand: string;
  brandProfile: unknown | null; showProfile: unknown;
}

export function mapUserPrompt(analysis: Analysis, shows: MapShowContext[]): string {
  const showList = shows.map((s) => ({
    show_id: s.id,
    show: s.name,
    brand: s.brand,
    brand_profile: s.brandProfile ? pick(s.brandProfile, ['identity.positioning', 'identity.audience', 'identity.channels',
      'identity.sister_brands', 'voice.personality', 'language.primary', 'standards.excluded_topics']) : 'not approved',
    show_profile: pick(s.showProfile, ['identity.remit', 'identity.audience', 'identity.positioning', 'voice.tone',
      'voice.provocation', 'voice.recurring_segments', 'voice.episode_length_minutes', 'voice.platforms',
      'language.primary', 'boundaries.excluded_topics']),
  }));
  return `SOURCE ANALYSIS:
${JSON.stringify(analysis, null, 2)}

SHOWS THAT MAY USE THIS SOURCE (suggest only these; use show_id exactly):
${JSON.stringify(showList, null, 2)}

Map the episode's conversations with the record_episode_map tool.`;
}

