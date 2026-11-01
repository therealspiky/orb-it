/**
 * The show profile is the editorial contract (spec §4). These groups drive the
 * guided form; values are stored as JSON under profile[group][key].
 */
export type FieldKind = 'text' | 'long' | 'list' | 'number' | 'select' | 'bool';
export interface ProfileField { key: string; label: string; kind: FieldKind; help?: string; options?: { value: string; label: string }[]; required?: boolean }
export interface ProfileGroup { key: string; title: string; intro: string; fields: ProfileField[] }

export const PROFILE_GROUPS: ProfileGroup[] = [
  {
    key: 'identity', title: 'Identity and purpose',
    intro: 'What the show is for and who it serves. Briefs explain their fit against these answers.',
    fields: [
      { key: 'remit', label: 'Editorial remit', kind: 'long', required: true, help: 'What this show covers and why it exists.' },
      { key: 'audience', label: 'Intended audience', kind: 'long', required: true, help: 'Who listens or watches, and what they need from the show.' },
      { key: 'presenters', label: 'Presenters and producer roles', kind: 'text' },
      { key: 'positioning', label: 'Positioning against sister shows', kind: 'long' },
      { key: 'objectives', label: 'Programme objectives', kind: 'list' },
    ],
  },
  {
    key: 'voice', title: 'Voice and format',
    intro: 'Tone and shape. Rundowns are checked against the episode length and breaks.',
    fields: [
      { key: 'tone', label: 'Tone', kind: 'text', required: true, help: 'For example: high-energy and debate-first, or reflective and empathetic.' },
      { key: 'provocation', label: 'Degree of provocation', kind: 'select', options: [
        { value: 'low', label: 'Low — calm, explanatory' }, { value: 'medium', label: 'Medium — challenging but measured' },
        { value: 'high', label: 'High — open debate, strong positions' }] },
      { key: 'interview_style', label: 'Interview style', kind: 'text' },
      { key: 'recurring_segments', label: 'Recurring segments', kind: 'list' },
      { key: 'episode_length_minutes', label: 'Episode length (minutes)', kind: 'number', required: true },
      { key: 'breaks_minutes', label: 'Breaks per episode (minutes)', kind: 'number' },
      { key: 'frequency', label: 'Broadcast frequency', kind: 'text' },
      { key: 'platforms', label: 'Platforms', kind: 'list', help: 'Radio, TV, YouTube, TikTok, Instagram, X, WhatsApp channel…' },
    ],
  },
  {
    key: 'language', title: 'Audience and language',
    intro: 'English and Pidgin are supported for production. Twi is a supervised beta that always needs a qualified reviewer.',
    fields: [
      { key: 'primary', label: 'Production language', kind: 'select', required: true, options: [
        { value: 'en', label: 'English' }, { value: 'pcm', label: 'Ghanaian Pidgin' }, { value: 'mixed', label: 'English and Pidgin mix' }] },
      { key: 'code_switching', label: 'Code-switching conventions', kind: 'long' },
      { key: 'twi_beta', label: 'Uses Twi (beta, review required)', kind: 'bool' },
      { key: 'reviewer_requirements', label: 'Language reviewer requirements', kind: 'text' },
    ],
  },
  {
    key: 'boundaries', title: 'Editorial boundaries',
    intro: 'Exclusions and standards the show will not compromise on.',
    fields: [
      { key: 'excluded_topics', label: 'Excluded topics', kind: 'list' },
      { key: 'sensitive_rules', label: 'Sensitive-topic rules', kind: 'long' },
      { key: 'guest_standards', label: 'Guest standards', kind: 'long' },
      { key: 'balance', label: 'Required balance', kind: 'long' },
      { key: 'protected_identities', label: 'Protected identities', kind: 'long', help: 'People or groups who must not be identified.' },
      { key: 'correction_policy', label: 'Correction policy', kind: 'long' },
    ],
  },
  {
    key: 'production', title: 'Production constraints',
    intro: 'What the team can realistically deliver.',
    fields: [
      { key: 'team_capacity', label: 'Team capacity', kind: 'text' },
      { key: 'guest_lead_time_days', label: 'Guest booking lead time (days)', kind: 'number' },
      { key: 'studio', label: 'Studio and remote capabilities', kind: 'text' },
      { key: 'turnaround', label: 'Turnaround target', kind: 'text' },
    ],
  },
  {
    key: 'commercial', title: 'Commercial context',
    intro: 'Context only. Commercial considerations never change the factual basis or editorial conclusion.',
    fields: [
      { key: 'sponsors', label: 'Current sponsors', kind: 'list' },
      { key: 'category_exclusions', label: 'Category exclusions', kind: 'list' },
      { key: 'disclosure', label: 'Disclosure requirements', kind: 'long' },
    ],
  },
  {
    key: 'examples', title: 'Examples',
    intro: 'Show the system what good and unsuitable look like for this programme.',
    fields: [
      { key: 'approved_episodes', label: 'Approved example episodes', kind: 'list' },
      { key: 'unsuitable', label: 'Unsuitable treatments (and why)', kind: 'list' },
    ],
  },
];

/**
 * Brand (station/channel) profile. Applies to every show of the brand: briefs must fit
 * the brand's identity and may never breach its standards or exclusions.
 */
export const BRAND_PROFILE_GROUPS: ProfileGroup[] = [
  {
    key: 'identity', title: 'Station identity',
    intro: 'Who the station is and who it serves. Every show of this brand is judged against this first.',
    fields: [
      { key: 'positioning', label: 'Brand positioning', kind: 'long', required: true, help: 'What the station stands for, in a few sentences.' },
      { key: 'audience', label: 'Core audience', kind: 'long', required: true, help: 'Who listens or watches across the station, and why they choose it.' },
      { key: 'market', label: 'Market and coverage', kind: 'text', help: 'Regions, frequencies or channel numbers.' },
      { key: 'channels', label: 'Channels and platforms', kind: 'list', help: 'Radio frequency, TV channel, website, YouTube, TikTok, Instagram, X…' },
      { key: 'sister_brands', label: 'How it differs from sister brands', kind: 'long', help: 'Helps Orb.IT give each brand a distinct treatment of the same story.' },
      { key: 'editorial_lead', label: 'Editorial leadership', kind: 'text' },
    ],
  },
  {
    key: 'voice', title: 'Brand voice',
    intro: 'How the station sounds across all its shows.',
    fields: [
      { key: 'personality', label: 'Personality and tone', kind: 'long', required: true, help: 'For example: authoritative and measured, or young, playful and street-smart.' },
      { key: 'format', label: 'Format mix', kind: 'long', help: 'Talk/music balance, genres, news commitments.' },
      { key: 'vocabulary', label: 'Brand phrases and taglines', kind: 'list' },
      { key: 'avoid', label: 'Words and styles to avoid', kind: 'list' },
    ],
  },
  {
    key: 'language', title: 'Language',
    intro: 'Station-wide language policy. Twi is a supervised beta: marking it here makes every brief for this brand require a Twi reviewer.',
    fields: [
      { key: 'primary', label: 'Main broadcast language', kind: 'select', required: true, options: [
        { value: 'en', label: 'English' }, { value: 'pcm', label: 'Ghanaian Pidgin' }, { value: 'mixed', label: 'English and Pidgin mix' }, { value: 'tw', label: 'Twi (beta)' }] },
      { key: 'code_switching', label: 'Code-switching policy', kind: 'long' },
      { key: 'twi_beta', label: 'Broadcasts in Twi (beta, review required)', kind: 'bool' },
      { key: 'reviewer_requirements', label: 'Language reviewer requirements', kind: 'text' },
    ],
  },
  {
    key: 'standards', title: 'Brand standards',
    intro: 'Binding on every show. Briefs that conflict with these are flagged, and exclusions are never overridden by a show profile.',
    fields: [
      { key: 'values', label: 'Editorial values', kind: 'long' },
      { key: 'excluded_topics', label: 'Brand-wide excluded topics', kind: 'list' },
      { key: 'sensitive_rules', label: 'Sensitive-topic rules', kind: 'long' },
      { key: 'balance', label: 'Balance and fairness requirements', kind: 'long' },
      { key: 'protected_identities', label: 'Protected identities', kind: 'long' },
      { key: 'correction_policy', label: 'Correction policy', kind: 'long' },
    ],
  },
  {
    key: 'rights', title: 'Rights and reuse',
    intro: 'What can be reused, where, and with whose permission.',
    fields: [
      { key: 'music', label: 'Music and audio rights', kind: 'long' },
      { key: 'sister_reuse', label: 'Reuse of content from sister brands', kind: 'long' },
      { key: 'clips', label: 'Clip and social media policy', kind: 'long' },
    ],
  },
  {
    key: 'commercial', title: 'Commercial context',
    intro: 'Context only. Commercial considerations never change the factual basis or editorial conclusion.',
    fields: [
      { key: 'sponsors', label: 'Brand-level sponsors and partners', kind: 'list' },
      { key: 'category_exclusions', label: 'Advertiser category exclusions', kind: 'list' },
      { key: 'disclosure', label: 'Disclosure requirements', kind: 'long' },
    ],
  },
  {
    key: 'examples', title: 'Examples',
    intro: 'Show Orb.IT what is on-brand and off-brand for this station.',
    fields: [
      { key: 'signature', label: 'Signature content that defines the brand', kind: 'list' },
      { key: 'off_brand', label: 'Off-brand treatments (and why)', kind: 'list' },
    ],
  },
];

export function missingRequired(profile: Record<string, Record<string, unknown>> | undefined, groups: ProfileGroup[] = PROFILE_GROUPS): string[] {
  const out: string[] = [];
  for (const g of groups) for (const f of g.fields) {
    if (!f.required) continue;
    const v = profile?.[g.key]?.[f.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) out.push(f.label);
  }
  return out;
}
