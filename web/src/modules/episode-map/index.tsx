import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import type { EpisodeMapRow } from '../../lib/types';
import type { SlotProps, WebModule } from '../types';
import { EpisodeMap } from './EpisodeMap';

/** Source page: the map of conversations in the episode. */
function EpisodeMapPanel({ source, briefs, jobs, onPlay, onQueued, onPrimaryView }: SlotProps['source.main']) {
  const mapJob = jobs.find((j) => j.kind === 'map_episode');
  const map = useQuery({
    queryKey: ['episode-map', source.id, mapJob?.status],
    queryFn: async () => (await supabase.from('episode_maps').select('*').eq('source_id', source.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()).data as EpisodeMapRow | null,
  });
  const running = jobs.find((j) => j.kind === 'map_episode' && ['queued', 'running'].includes(j.status));
  const analysing = jobs.find((j) => j.kind === 'analyse' && ['queued', 'running'].includes(j.status));
  const mapping = running ? { progress: running.progress, message: running.message }
    : analysing && !map.data ? { progress: 5, message: 'Reading the episode' } : null;
  useEffect(() => { onPrimaryView(!!map.data); }, [map.data, onPrimaryView]);
  if (!['ready', 'needs_attention'].includes(source.status) && !map.data) return null;
  return <EpisodeMap source={source} map={map.data ?? null} briefs={briefs} mapping={mapping} onPlay={onPlay} onQueued={onQueued} />;
}

/** Brief header: which mapped conversation the brief was developed from. */
function ConversationLine({ brief, sourceId }: SlotProps['brief.headerLine']) {
  const q = useQuery({
    queryKey: ['brief-conversation', brief.episode_map_id, brief.conversation_key],
    enabled: !!brief.episode_map_id && !!brief.conversation_key,
    queryFn: async () => {
      const r = (await supabase.from('episode_maps').select('result').eq('id', brief.episode_map_id!).maybeSingle()).data as
        { result: { conversations: { key: string; question: string }[] } } | null;
      return r?.result.conversations.find((c) => c.key === brief.conversation_key)?.question ?? null;
    },
  });
  if (!q.data || !sourceId) return null;
  return (
    <p className="mt-1 text-sm text-ink-soft">
      Developed from the conversation <Link to="/sources/$sourceId" params={{ sourceId }} className="underline">“{q.data}”</Link>
    </p>
  );
}

export const episodeMapModule: WebModule = {
  key: 'episode_map',
  label: 'Episode map',
  slots: { 'source.main': EpisodeMapPanel, 'brief.headerLine': ConversationLine },
};
