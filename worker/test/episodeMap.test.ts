import { describe, expect, it } from 'vitest';
import { focusFor } from '../src/jobs/generateBriefs.js';
import { briefUserPrompt } from '../src/lib/prompts.js';
import { mapUserPrompt } from '../src/modules/episode-map/prompts.js';
import { EpisodeMapSchema, type EpisodeMap } from '../src/modules/episode-map/schema.js';
import { validateMap } from '../src/modules/episode-map/validateMap.js';
import { segments } from './fixtures.js';

const shows = [
  { id: 'hitz', name: 'Morning Show', brand: 'Hitz FM' },
  { id: 'prime', name: 'Prime Morning', brand: 'Joy Prime' },
];

function makeMap(): EpisodeMap {
  return {
    summary: 'A studio conversation about money and forgiveness.',
    conversations: [
      {
        key: 'c1', question: 'Are we pretending to hate cheating?', summary: 'Guest says rules change with comfort.',
        angle: 'debate', why_it_travels: 'Everyone has a view.', needs_outside_evidence: false, sensitivities: ['Gender stereotyping'],
        moments: [
          { segment_start: 1, segment_end: 1, hook: 'money changes what people are willing to forgive', note: 'Core claim' },
          { segment_start: 3, segment_end: 3, hook: 'Everybody secretly cheats', note: 'Fabricated hook' },
          { segment_start: 30, segment_end: 31, hook: null, note: 'Out of range' },
        ],
        show_fits: [
          { show_id: 'hitz', fit: 'strong', treatment: 'Put the idea on trial with a panel and phone-in.', why: 'show.voice.tone' },
          { show_id: 'adom', fit: 'strong', treatment: 'Street vox pops', why: 'not offered' },
          { show_id: 'hitz', fit: 'possible', treatment: 'duplicate', why: '' },
        ],
        platform_fits: [{ platform: 'tiktok', format: '45s vertical clip', why: 'Short contrast' }],
      },
      {
        key: 'c2', question: 'Did the programme go too far?', summary: 'Reception of the episode.', angle: 'meta_media',
        why_it_travels: 'Media accountability.', needs_outside_evidence: false, sensitivities: [],
        moments: [], show_fits: [{ show_id: 'prime', fit: 'possible', treatment: 'Ethics roundtable', why: 'brand.standards' }],
        platform_fits: [],
      },
      {
        key: 'c1', question: 'When does financial security become dependence?', summary: 'Economic angle.', angle: 'economic',
        why_it_travels: 'Cost of living.', needs_outside_evidence: false, sensitivities: [],
        moments: [{ segment_start: 2, segment_end: 3, hook: null, note: 'Comfort and rules' }],
        show_fits: [{ show_id: 'prime', fit: 'strong', treatment: 'Studio analysis of dependence', why: 'show.identity.remit' }],
        platform_fits: [{ platform: 'youtube', format: '8 min explainer', why: 'Depth' }],
      },
    ],
  };
}

describe('episode map validation', () => {
  const { map, report } = validateMap(makeMap(), segments, shows, true);
  const c1 = map.conversations.find((c) => c.question.startsWith('Are we'))!;

  it('the fixture matches the schema', () => {
    expect(EpisodeMapSchema.safeParse(makeMap()).success).toBe(true);
  });

  it('keeps verbatim hooks, removes invented ones, drops missing passages', () => {
    expect(c1.moments).toHaveLength(2);
    expect(c1.moments[0]!.hook).toBe('money changes what people are willing to forgive');
    expect(c1.moments[1]!.hook).toBeNull();
  });

  it('attaches transcript times to moments', () => {
    expect((c1.moments[0] as any).start_ms).toBe(8000);
  });

  it('only suggests shows that can use the source, once each', () => {
    expect(c1.show_fits.map((f) => f.show_id)).toEqual(['hitz']);
  });

  it('marks ungrounded conversations as needing outside evidence and lists them last', () => {
    const last = map.conversations[map.conversations.length - 1]!;
    expect(last.question).toMatch(/too far/);
    expect(last.needs_outside_evidence).toBe(true);
  });

  it('gives every conversation a unique key', () => {
    const keys = map.conversations.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports what it removed', () => {
    expect(report.checks.find((c) => c.name === 'show_fits')!.status).toBe('warn');
    expect(report.checks.find((c) => c.name === 'hooks')!.status).toBe('warn');
  });
});

describe('prompts', () => {
  it('summarises only key profile fields for the map', () => {
    const p = mapUserPrompt({ summary: '', themes: [], claims: [], questions_raised: [], usable_moments: [], sensitivities: [] }, [{
      id: 'hitz', name: 'Morning Show', brand: 'Hitz FM',
      brandProfile: { identity: { positioning: 'Urban youth culture' }, rights: { music: 'secret detail' } },
      showProfile: { voice: { tone: 'Loud but fair' } },
    }]);
    expect(p).toContain('Urban youth culture');
    expect(p).toContain('Loud but fair');
    expect(p).not.toContain('secret detail');
  });

  it('focuses a brief on one conversation with the show-specific treatment', () => {
    const { map } = validateMap(makeMap(), segments, shows, true);
    const c1 = map.conversations.find((c) => c.question.startsWith('Are we'))!;
    const focus = focusFor(c1, 'hitz');
    expect(focus.suggestedTreatment).toMatch(/on trial/);
    const prompt = briefUserPrompt({
      showName: 'Morning Show', brandName: 'Hitz FM', profile: {}, profileVersion: 1, brandProfile: null, brandProfileVersion: null,
      analysis: { summary: '', themes: [], claims: [], questions_raised: [], usable_moments: [], sensitivities: [] },
      priorCoverage: [], siblingTreatments: [], focus,
    });
    expect(prompt).toContain('CONVERSATION TO DEVELOP');
    expect(prompt).toContain('Are we pretending to hate cheating?');
    expect(prompt).toContain('[1–1]');
  });
});
