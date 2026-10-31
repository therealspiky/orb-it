import type { Brief } from '../src/lib/schemas.js';
import type { Segment, SourceRow } from '../src/types.js';

// Synthetic programme passage written for tests (not a real broadcast).
export const segments: Segment[] = [
  { idx: 0, start_ms: 0, end_ms: 8000, speaker: 'SPEAKER_1', text: 'Welcome back to the show, today we are talking about trust.', confidence: 0.94, is_uncertain: false },
  { idx: 1, start_ms: 8000, end_ms: 15500, speaker: 'SPEAKER_2', text: 'For me, money changes what people are willing to forgive.', confidence: 0.91, is_uncertain: false },
  { idx: 2, start_ms: 15500, end_ms: 24000, speaker: 'SPEAKER_1', text: 'So you are saying the rules are different when someone is comfortable?', confidence: 0.9, is_uncertain: false },
  { idx: 3, start_ms: 24000, end_ms: 31000, speaker: 'SPEAKER_2', text: "Exactly. Everybody says it's a deal-breaker until it happens to them.", confidence: 0.88, is_uncertain: false },
  { idx: 4, start_ms: 31000, end_ms: 36000, speaker: 'SPEAKER_3', text: 'Chale, that one is not true at all.', confidence: 0.42, is_uncertain: true },
];

export const source: SourceRow = {
  id: '11111111-1111-1111-1111-111111111111', org_id: 'org', brand_id: 'brand-joy', show_id: 'show-tys',
  kind: 'recording', title: 'Test programme', programme_name: 'Test Talk Show', origin_url: null, storage_path: 'x',
  mime_type: 'audio/mpeg', size_bytes: 1, checksum_sha256: null, duration_seconds: 36, language: 'mixed',
  twi_beta: false, rights_status: 'owned', rights_notes: null, share_scope: 'organisation', timestamps_genuine: true,
  author: null, status: 'ready',
};

export function makeBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    title: 'Are We Pretending to Hate Cheating?',
    premise: 'Do people apply consistent standards to infidelity when money and circumstances change?',
    why_now: 'The source discussion raised the question directly.',
    audience_value: 'Helps listeners examine their own standards.',
    destination_fit: { summary: 'Debate-led morning format.', profile_fields: [{ field: 'voice.tone', how_it_fits: 'Provocative but fair' }] },
    new_contribution: 'Moves from personal anecdote to consistency of standards.',
    recommendation: 'proceed',
    recommendation_reason: 'Clear editorial question with source support.',
    evidence: [
      { ref: 'E1', segment_start: 1, segment_end: 1, quote: 'money changes what people are willing to forgive', attribution: 'SPEAKER_2', kind: 'source_statement', relevance: 'Core claim' },
      { ref: 'E2', segment_start: 3, segment_end: 3, quote: 'Everybody says its a deal breaker', attribution: 'SPEAKER_2', kind: 'source_statement', relevance: 'Double standard' },
      { ref: 'E3', segment_start: 2, segment_end: 3, quote: 'People secretly approve of cheating', attribution: 'SPEAKER_1', kind: 'source_statement', relevance: 'Fabricated' },
      { ref: 'E4', segment_start: 40, segment_end: 41, quote: null, attribution: null, kind: 'inferred_theme', relevance: 'Out of range' },
    ],
    uncertainties: ['Speaker identities unverified'],
    contradictory_evidence: [{ description: 'Pushback from a third voice', evidence_refs: ['E9'] }],
    treatment: {
      format: 'Panel + phone-in', duration_minutes: 45,
      lines_of_inquiry: [{ question: 'Does money change standards?', evidence_refs: ['E1', 'E4'] }],
      presenter_opening: 'Where do you draw the line?', interview_questions: ['What would change your view?'], takeaway: 'Standards should be consistent.',
    },
    rundown: [
      { title: 'Open', purpose: 'Frame', start_minute: 0, duration_minutes: 5, is_break: false, owner_role: 'presenter', prompts: '', evidence_refs: ['E1'], cues: '', fallback: '' },
      { title: 'Debate', purpose: 'Explore', start_minute: 5, duration_minutes: 20, is_break: false, owner_role: 'presenter', prompts: '', evidence_refs: ['E2'], cues: '', fallback: '' },
      { title: 'Calls', purpose: 'Listeners', start_minute: 25, duration_minutes: 15, is_break: false, owner_role: 'producer', prompts: '', evidence_refs: [], cues: '', fallback: '' },
      { title: 'Close', purpose: 'Recap', start_minute: 40, duration_minutes: 5, is_break: false, owner_role: 'presenter', prompts: '', evidence_refs: [], cues: '', fallback: '' },
    ],
    guests: [
      { perspective_needed: 'Relationship specialist', why_needed: 'Evidence-based view', suggested_profile: 'A qualified counsellor with media experience', credentials_to_verify: ['Licence'], conflicts_to_check: [] },
      { perspective_needed: 'Social commentator', why_needed: 'Norms', suggested_profile: 'Dr. Kwame Example, a sociologist', credentials_to_verify: [], conflicts_to_check: [] },
    ],
    production_tasks: [{ title: 'Obtain original recording', detail: 'Request from source team', owner_role: 'producer', blocking: true }],
    social_package: [
      { asset_type: 'teaser', platform: 'Reels', format: '9:16 30-45s', hook: 'Where do you draw the line?', caption_draft: 'Join us.', clip_candidate: { segment_start: 1, segment_end: 3, rationale: 'Contrast' }, thumbnail_direction: null },
      { asset_type: 'debate_highlight', platform: 'Shorts', format: '9:16', hook: 'x', caption_draft: 'y', clip_candidate: { segment_start: 3, segment_end: 99, rationale: 'bad' }, thumbnail_direction: null },
    ],
    review_flags: [{ check: 'fairness', concern: 'Avoid gender stereotyping', severity: 'medium' }],
    continuation: { success_criteria: ['Balanced debate'], post_show_questions: ['What remained unanswered?'], follow_up_ideas: [{ title: 'Would You Stay?', advance: 'Listener experiences' }] },
    unresolved: [],
    ...overrides,
  };
}
