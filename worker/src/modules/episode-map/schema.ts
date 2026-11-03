import { z } from 'zod';

// ---------------------------------------------------------------------------
// Episode map: the content inventory of one episode
// ---------------------------------------------------------------------------
export const PLATFORMS = ['radio', 'tv', 'youtube', 'tiktok', 'instagram_reels', 'youtube_shorts', 'facebook', 'x', 'whatsapp_channel', 'quote_cards', 'web_article', 'podcast'] as const;

export const EpisodeMapSchema = z.object({
  summary: z.string().describe('One or two sentences: what this episode is, neutrally.'),
  conversations: z.array(z.object({
    key: z.string().regex(/^c\d+$/).describe('c1, c2, …'),
    question: z.string().max(200).describe('The conversation as the question an audience would argue about.'),
    summary: z.string().describe('What the conversation is and what in the episode sparked it.'),
    angle: z.enum(['debate', 'economic', 'human', 'grassroots', 'expert_explainer', 'meta_media', 'practical_advice', 'cultural', 'other']),
    why_it_travels: z.string().describe('Why audiences would engage, without inventing metrics or virality.'),
    moments: z.array(z.object({
      segment_start: z.number().int().min(0),
      segment_end: z.number().int().min(0),
      hook: z.string().max(300).nullable().describe('Exact words from these segments that could open a clip, or null.'),
      note: z.string(),
    })).describe('The passages where this conversation lives in the episode.'),
    needs_outside_evidence: z.boolean().describe('True when the conversation depends on material not in this source (for example public reactions).'),
    sensitivities: z.array(z.string()),
    show_fits: z.array(z.object({
      show_id: z.string(),
      fit: z.enum(['strong', 'possible']),
      treatment: z.string().max(300).describe("One line: how THIS show would take it, distinct from the other shows' takes."),
      why: z.string().max(300).describe('Which brand/show profile fields make it fit.'),
    })),
    platform_fits: z.array(z.object({
      platform: z.enum(PLATFORMS),
      format: z.string().max(120),
      why: z.string().max(200),
    })),
  })).min(1).max(12),
});
export type EpisodeMap = z.infer<typeof EpisodeMapSchema>;
