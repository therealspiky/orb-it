import { z } from 'zod';

// ---------------------------------------------------------------------------
// Source analysis (extraction pass)
// ---------------------------------------------------------------------------
const Range = { segment_start: z.number().int().min(0), segment_end: z.number().int().min(0) };

export const AnalysisSchema = z.object({
  summary: z.string().describe('Neutral 3-5 sentence summary of what the source actually contains.'),
  themes: z.array(z.object({
    theme: z.string(),
    note: z.string().describe('Why this theme matters, grounded in the source.'),
    ...Range,
  })).describe('Main themes with the transcript range where each is discussed.'),
  claims: z.array(z.object({
    claim: z.string().describe('The claim as made, paraphrased neutrally.'),
    speaker: z.string().nullable().describe('Speaker label exactly as in the transcript, or null.'),
    claim_type: z.enum(['stated_opinion', 'factual_assertion', 'allegation', 'anecdote']),
    needs_verification: z.boolean(),
    ...Range,
  })),
  questions_raised: z.array(z.string()).describe('Open questions the source raises but does not resolve.'),
  usable_moments: z.array(z.object({ why: z.string(), ...Range }))
    .describe('Self-contained passages that could work as excerpts or clips, keeping context.'),
  sensitivities: z.array(z.object({
    issue: z.string().describe('Privacy, allegation, minors, abuse, defamation or rights concern.'),
    ...Range,
  })),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---------------------------------------------------------------------------
// Opportunity brief — the complete editable production workspace (spec §8)
// ---------------------------------------------------------------------------
const Ref = z.string().regex(/^E\d+$/).describe('Evidence reference such as E1');
const Refs = z.array(Ref);

export const BriefSchema = z.object({
  title: z.string().max(140),
  premise: z.string().describe('The editorial question, framed fairly; not a predetermined conclusion.'),
  why_now: z.string(),
  audience_value: z.string(),
  destination_fit: z.object({
    summary: z.string(),
    profile_fields: z.array(z.object({
      field: z.string().describe('Profile field used, e.g. voice.tone or identity.audience'),
      how_it_fits: z.string(),
    })).describe('Concrete fit against the approved show profile fields.'),
  }),
  new_contribution: z.string().describe('What this treatment adds that the source programme did not.'),
  recommendation: z.enum(['proceed', 'research']),
  recommendation_reason: z.string(),
  evidence: z.array(z.object({
    ref: Ref,
    segment_start: z.number().int().min(0),
    segment_end: z.number().int().min(0),
    quote: z.string().max(400).nullable()
      .describe('Verbatim words copied exactly from the cited segments, or null. Never paraphrase inside quote.'),
    attribution: z.string().nullable().describe('Speaker label exactly as in the transcript, or null.'),
    kind: z.enum(['source_statement', 'reported_claim', 'inferred_theme']),
    relevance: z.string(),
  })),
  uncertainties: z.array(z.string()).describe('What is unknown or unverified.'),
  contradictory_evidence: z.array(z.object({ description: z.string(), evidence_refs: Refs })),
  treatment: z.object({
    format: z.string(),
    duration_minutes: z.number().int().positive(),
    lines_of_inquiry: z.array(z.object({ question: z.string(), evidence_refs: Refs })),
    presenter_opening: z.string(),
    interview_questions: z.array(z.string()),
    takeaway: z.string(),
  }),
  rundown: z.array(z.object({
    title: z.string(),
    purpose: z.string(),
    start_minute: z.number().int().min(0),
    duration_minutes: z.number().int().min(0),
    is_break: z.boolean(),
    owner_role: z.string(),
    prompts: z.string(),
    evidence_refs: Refs,
    cues: z.string(),
    fallback: z.string(),
  })),
  guests: z.array(z.object({
    perspective_needed: z.string(),
    why_needed: z.string(),
    suggested_profile: z.string().describe('Describe the kind of person. Never name a real or invented individual.'),
    credentials_to_verify: z.array(z.string()),
    conflicts_to_check: z.array(z.string()),
  })),
  production_tasks: z.array(z.object({
    title: z.string(),
    detail: z.string(),
    owner_role: z.string(),
    blocking: z.boolean(),
  })),
  social_package: z.array(z.object({
    asset_type: z.enum(['teaser', 'debate_highlight', 'poll', 'quote_card', 'thumbnail', 'audiogram', 'thread']),
    platform: z.string(),
    format: z.string(),
    hook: z.string(),
    caption_draft: z.string(),
    clip_candidate: z.object({
      segment_start: z.number().int().min(0),
      segment_end: z.number().int().min(0),
      rationale: z.string(),
    }).nullable(),
    thumbnail_direction: z.string().nullable(),
  })),
  review_flags: z.array(z.object({
    check: z.enum(['fact', 'fairness', 'privacy', 'rights', 'language', 'commercial']),
    concern: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
  })),
  continuation: z.object({
    success_criteria: z.array(z.string()),
    post_show_questions: z.array(z.string()),
    follow_up_ideas: z.array(z.object({ title: z.string(), advance: z.string() })),
  }),
  unresolved: z.array(z.object({
    field: z.string(),
    reason: z.string(),
    next_action: z.string(),
    owner_role: z.string(),
  })),
});
export type Brief = z.infer<typeof BriefSchema>;

/** JSON Schema for an Anthropic tool input, generated from the zod schema. */
export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

