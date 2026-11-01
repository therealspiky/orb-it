import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ago, clock } from '../lib/format';
import { useOrg } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import { WORK_ROLES, type Brief, type EpisodeMapRow, type MapConversation, type Show, type Source } from '../lib/types';
import { BriefBadge, ErrorNote, Progress } from './ui';

export const PLATFORM_LABEL: Record<string, string> = {
  radio: 'Radio', tv: 'TV', youtube: 'YouTube', tiktok: 'TikTok', instagram_reels: 'Instagram Reels',
  youtube_shorts: 'YouTube Shorts', facebook: 'Facebook', x: 'X', whatsapp_channel: 'WhatsApp channel',
  quote_cards: 'Quote cards', web_article: 'Web article', podcast: 'Podcast',
};
const ANGLE_LABEL: Record<string, string> = {
  debate: 'Debate', economic: 'Economics and money', human: 'Human and personal', grassroots: 'Grassroots voices',
  expert_explainer: 'Expert explainer', meta_media: 'About the coverage itself', practical_advice: 'Practical advice',
  cultural: 'Culture', other: 'Other',
};

/** Same sharing rule the database enforces; used here only to decide what to offer. */
export function sourceUsableBy(source: Source, show: Show): boolean {
  if (source.share_scope === 'organisation') return true;
  if (source.share_scope === 'brand') return show.brand_id === source.brand_id;
  return source.show_id ? show.id === source.show_id : show.brand_id === source.brand_id;
}

interface Props {
  source: Source;
  map: EpisodeMapRow | null;
  briefs: Brief[];
  mapping: { progress: number; message: string | null } | null;
  onPlay: (ms: number) => void;
  onQueued: () => void;
}

/**
 * The episode map: every conversation inside one episode, where it lives,
 * and which shows and platforms can take it — the "content inventory".
 */
export function EpisodeMap({ source, map, briefs, mapping, onPlay, onQueued }: Props) {
  const { org, shows, can } = useOrg();
  const ready = ['ready', 'needs_attention'].includes(source.status);
  const canWorkAnywhere = shows.some((sh) => can(WORK_ROLES, sh.brand_id, sh.id));

  const refresh = useMutation({
    mutationFn: async () => check(await supabase.rpc('enqueue_job', {
      p_org: org!.id, p_kind: 'map_episode', p_payload: { source_id: source.id },
      p_idempotency_key: `map:${source.id}:manual:${Date.now()}`,
    })),
    onSuccess: onQueued,
  });

  const conversations = map?.result.conversations ?? [];
  const noProfile = map?.validation?.skipped_no_profile ?? 0;

  return (
    <section aria-labelledby="map-title">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 id="map-title" className="text-[22px] font-semibold tracking-[-0.01em]">
            {map ? `${conversations.length} conversation${conversations.length === 1 ? '' : 's'} in this episode` : 'What’s inside this episode'}
          </h2>
          {map && <p className="source-text text-ink-soft mt-1 max-w-[75ch]">{map.result.summary}</p>}
        </div>
        {map && canWorkAnywhere && (
          <button className="btn btn-quiet btn-sm" disabled={!!mapping || refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw size={13} aria-hidden /> Map again
          </button>
        )}
      </div>

      {mapping && (
        <div className="panel p-4 mb-4">
          <p className="text-sm font-semibold mb-2">{mapping.message ?? 'Mapping the conversations in this episode'}</p>
          <Progress value={mapping.progress} />
        </div>
      )}

      {!map && !mapping && (
        <div className="panel p-6">
          {ready ? (
            <>
              <p className="max-w-[65ch]">Orb.IT reads the episode and lists every conversation inside it, where each one happens, and which of your shows and platforms could take it, each in its own direction.</p>
              {canWorkAnywhere && <button className="btn btn-primary mt-4" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Map this episode</button>}
            </>
          ) : <p className="text-ink-soft">The map is drawn once the transcript is ready.</p>}
        </div>
      )}
      <ErrorNote error={refresh.error} />

      {map && (
        <>
          <p className="text-[13px] text-ink-faint mb-4">
            Mapped {ago(map.created_at)} against {map.considered_shows.length} show{map.considered_shows.length === 1 ? '' : 's'} that can use this source
            {noProfile > 0 && <> · {noProfile} more need an approved show profile to be considered</>}.
          </p>
          <ol className="space-y-5">
            {conversations.map((c, i) => (
              <ConversationCard key={c.key} n={i + 1} c={c} source={source} mapId={map.id} briefs={briefs}
                timed={source.timestamps_genuine} onPlay={onPlay} onQueued={onQueued} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function ConversationCard({ n, c, source, mapId, briefs, timed, onPlay, onQueued }: {
  n: number; c: MapConversation; source: Source; mapId: string; briefs: Brief[]; timed: boolean;
  onPlay: (ms: number) => void; onQueued: () => void;
}) {
  const { org, shows, brands, can } = useOrg();
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const developed = briefs.filter((b) => b.episode_map_id === mapId && b.conversation_key === c.key);
  const developable = (sh: Show) => !sh.archived_at && !!sh.current_profile_version_id && sourceUsableBy(source, sh) && can(WORK_ROLES, sh.brand_id, sh.id);
  const suggestedIds = new Set(c.show_fits.map((f) => f.show_id));
  const others = shows.filter((sh) => developable(sh) && !suggestedIds.has(sh.id) && !developed.some((b) => b.show_id === sh.id));
  const brandOf = (id: string) => brands.find((b) => b.id === shows.find((s) => s.id === id)?.brand_id)?.name ?? '';

  const develop = useMutation({
    mutationFn: async () => {
      const group = crypto.randomUUID();
      const showIds = [...picked, ...(extra ? [extra] : [])];
      return check(await supabase.rpc('enqueue_job', {
        p_org: org!.id, p_kind: 'generate_briefs',
        p_payload: { source_id: source.id, show_ids: showIds, generation_group: group, episode_map_id: mapId, conversation_key: c.key },
        p_idempotency_key: `generate:${source.id}:${c.key}:${group}`,
      }));
    },
    onSuccess: () => { setPicked([]); setExtra(''); onQueued(); },
  });
  const count = picked.length + (extra ? 1 : 0);

  return (
    <li className="panel overflow-hidden">
      <div className="p-5 md:p-6">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-soft">
          <span className="font-semibold text-ink">Conversation {n}</span>
          <span>· {ANGLE_LABEL[c.angle] ?? c.angle}</span>
          {c.needs_outside_evidence && <span className="font-semibold text-signal">· Needs material from outside this episode</span>}
        </div>
        <h3 className="mt-1 text-[21px] leading-snug font-semibold tracking-[-0.01em] max-w-[60ch]">{c.question}</h3>
        <p className="mt-2 max-w-[75ch]">{c.summary}</p>
        <p className="mt-1 text-sm text-ink-soft max-w-[75ch]">{c.why_it_travels}</p>

        {c.moments.length > 0 && (
          <ul className="mt-4 space-y-2">
            {c.moments.map((m, i) => (
              <li key={i} className="flex gap-3 items-start">
                {timed && m.start_ms != null ? (
                  <button className="shrink-0 inline-flex items-center gap-1 text-[13px] font-semibold rounded-full border border-line-strong px-2 py-0.5 hover:bg-paper"
                    onClick={() => onPlay(m.start_ms!)} aria-label={`Play from ${clock(m.start_ms)}`}>
                    <Play size={11} aria-hidden />{clock(m.start_ms)}
                  </button>
                ) : <span className="shrink-0 text-[13px] text-ink-faint pt-0.5">#{m.segment_start}</span>}
                <span className="min-w-0">
                  {m.hook && <span className="source-text">“{m.hook}” </span>}
                  <span className="text-sm text-ink-soft">{m.note}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {c.sensitivities.length > 0 && (
          <p className="mt-3 text-[13px] text-blocked"><span className="font-semibold">Handle with care:</span> {c.sensitivities.join('; ')}</p>
        )}
        {c.platform_fits.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2" aria-label="Platform fits">
            {c.platform_fits.map((p, i) => (
              <li key={i} title={p.why} className="text-[13px] rounded-md bg-paper border border-line px-2 py-1">
                <span className="font-semibold">{PLATFORM_LABEL[p.platform] ?? p.platform}</span> {p.format}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line bg-paper/60 p-5 md:p-6">
        <h4 className="text-sm font-semibold mb-3">Which shows can take it</h4>
        <ul className="space-y-3">
          {c.show_fits.map((f) => {
            const sh = shows.find((s) => s.id === f.show_id);
            const done = developed.find((b) => b.show_id === f.show_id);
            const canDev = sh ? developable(sh) : false;
            return (
              <li key={f.show_id} className="grid grid-cols-[22px_1fr] gap-2">
                <input type="checkbox" className="mt-1.5 self-start" aria-label={`Develop for ${sh?.name ?? 'show'}`}
                  disabled={!canDev || !!done} checked={picked.includes(f.show_id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, f.show_id] : picked.filter((x) => x !== f.show_id))} />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-x-2">
                    <span className="font-semibold">{sh?.name ?? 'Unknown show'}</span>
                    <span className="text-ink-faint text-sm">{brandOf(f.show_id)}</span>
                    <span className={`text-[12px] font-semibold ${f.fit === 'strong' ? 'text-verified' : 'text-ink-soft'}`}>{f.fit === 'strong' ? 'Strong fit' : 'Possible fit'}</span>
                    {done && <Link to="/briefs/$briefId" params={{ briefId: done.id }} className="inline-flex items-center gap-1.5 text-sm underline">Brief <BriefBadge status={done.status} /></Link>}
                  </p>
                  <p className="text-[15px]">{f.treatment}</p>
                  <p className="text-[13px] text-ink-faint">{f.why}</p>
                  {sh && !canDev && !done && <p className="text-[12px] text-ink-faint">You can’t develop briefs for this show.</p>}
                </div>
              </li>
            );
          })}
          {c.show_fits.length === 0 && <li className="text-sm text-ink-faint">No show fits this conversation strongly enough to suggest.</li>}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {others.length > 0 && (
            <select className="field-input w-auto text-sm" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Also develop for another show">
              <option value="">Also develop for…</option>
              {others.map((sh) => <option key={sh.id} value={sh.id}>{sh.name} ({brands.find((b) => b.id === sh.brand_id)?.name})</option>)}
            </select>
          )}
          <button className="btn btn-primary" disabled={!count || develop.isPending} onClick={() => develop.mutate()}>
            {count ? `Develop for ${count} show${count === 1 ? '' : 's'}` : 'Select shows to develop'}
          </button>
        </div>
        <div className="mt-2"><ErrorNote error={develop.error} /></div>
      </div>
    </li>
  );
}
