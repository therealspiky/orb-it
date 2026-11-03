import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { clock } from '../../lib/format';
import { check, supabase } from '../../lib/supabase';
import type { Source } from '../../lib/types';
import { ModuleGate } from '../runtime';
import type { SlotProps, SourceLinkHandler, WebModule } from '../types';
import { parseVideoId, YT_REDIRECT_PATH } from './youtube';
import { YouTubeCallbackPage } from './YouTubeCallbackPage';
import { YouTubeChannels } from './YouTubeChannels';

function VideoCard({ source }: SlotProps['source.facts']) {
  const x = source.external;
  if (x?.platform !== 'youtube') return null;
  return (
    <a href={x.url ?? source.origin_url ?? '#'} target="_blank" rel="noreferrer" className="flex gap-3 items-start rounded-md border border-line p-2 hover:bg-paper">
      {x.thumbnail && <img src={x.thumbnail} alt="" className="w-28 aspect-video object-cover rounded" />}
      <span className="min-w-0">
        <span className="block font-semibold leading-snug">{x.title}</span>
        <span className="block text-ink-faint">{[x.channel_title, x.published_at && new Date(x.published_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), x.duration_seconds ? clock(x.duration_seconds * 1000) : null].filter(Boolean).join(' · ')}</span>
        {x.caption_track && <span className="block text-ink-faint">Captions: {x.caption_track.kind.toLowerCase() === 'asr' ? 'YouTube auto-generated' : x.caption_track.name || 'uploaded'} ({x.caption_track.language})</span>}
      </span>
    </a>
  );
}

const youtubeLinks: SourceLinkHandler = {
  recognise: (url) => parseVideoId(url) ? {
    help: 'YouTube video recognised: title, channel, date and duration are filled in for you.',
    titleOptional: true,
    transcriptOptional: true,
    transcriptOptionalHelp: "Optional for YouTube links. Leave the file and text empty and Orb.IT imports the captions if the video's channel is connected (Organisation → YouTube channels); otherwise the source waits for you to paste the transcript.",
    submitLabel: 'Import from YouTube',
  } : null,
  async findDuplicate(orgId, url) {
    const id = parseVideoId(url);
    if (!id) return null;
    return (await supabase.from('sources').select('*').eq('org_id', orgId).ilike('origin_url', `%${id}%`).limit(1).maybeSingle()).data as Source | null;
  },
  async afterCreate({ orgId, source, hasTranscript, fillTitle }) {
    check(await supabase.rpc('enqueue_job', {
      p_org: orgId, p_kind: 'youtube_import',
      p_payload: { source_id: source.id, fetch_captions: !hasTranscript && source.kind === 'transcript', fill_title: fillTitle },
      p_idempotency_key: `youtube:${source.id}`,
    }));
  },
};

export const youtubeModule: WebModule = {
  key: 'youtube',
  label: 'YouTube import',
  routes: (parent: AnyRoute) => [createRoute({ getParentRoute: () => parent, path: YT_REDIRECT_PATH,
    component: () => <ModuleGate moduleKey="youtube"><YouTubeCallbackPage /></ModuleGate> })],
  slots: { 'admin.sections': YouTubeChannels, 'source.facts': VideoCard },
  sourceLink: youtubeLinks,
};
