import { useMutation, useQuery } from '@tanstack/react-query';
import { ago } from '../../lib/format';
import { useOrg, usePeople } from '../../lib/org';
import { check, supabase } from '../../lib/supabase';
import { GOOGLE_CLIENT_ID, startYouTubeConnect } from './youtube';
import { ErrorNote } from '../../components/ui';

interface Connection {
  id: string; channel_id: string; channel_title: string | null; channel_thumb: string | null;
  status: 'active' | 'error' | 'revoked'; error: string | null; connected_by: string | null; created_at: string;
}

/** Organisation page section: YouTube channels whose captions Orb.IT may fetch. */
export function YouTubeChannels() {
  const { org, memberships } = useOrg();
  const person = usePeople();
  const canConnect = memberships.some((m) => m.role === 'org_admin' || m.role === 'brand_editor');
  const isAdmin = memberships.some((m) => m.role === 'org_admin');
  const list = useQuery({
    queryKey: ['yt-connections', org!.id],
    queryFn: async () => check(await supabase.from('youtube_connections').select('*').eq('org_id', org!.id).order('created_at')) as Connection[],
  });
  const remove = useMutation({
    mutationFn: async (id: string) => check(await supabase.from('youtube_connections').delete().eq('id', id)),
    onSuccess: () => void list.refetch(),
  });

  return (
    <section className="mb-12">
      <h2 className="text-lg font-semibold mb-1">YouTube channels</h2>
      <p className="text-ink-soft mb-4 max-w-[75ch]">
        Connect your organisation's channels and Orb.IT imports captions for their videos automatically, through YouTube's official API.
        For videos from other channels, Orb.IT still fills in the details from the link; you paste the transcript.
      </p>
      <ul className="panel divide-y divide-line max-w-[760px]">
        {(list.data ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-3 px-4 py-3">
            {c.channel_thumb ? <img src={c.channel_thumb} alt="" className="w-9 h-9 rounded-full" /> : <span className="w-9 h-9 rounded-full bg-line" />}
            <div className="min-w-0 flex-1">
              <p className="font-semibold truncate">{c.channel_title ?? c.channel_id}</p>
              <p className={`text-[13px] ${c.status === 'active' ? 'text-ink-faint' : 'text-blocked'}`}>
                {c.status === 'active' ? `Connected by ${person(c.connected_by)} ${ago(c.created_at)}` : c.error ?? 'Needs reconnecting'}
              </p>
            </div>
            {isAdmin && <button className="text-sm text-blocked underline" onClick={() => remove.mutate(c.id)}>Disconnect</button>}
          </li>
        ))}
        {!list.data?.length && <li className="px-4 py-3 text-sm text-ink-faint">No channels connected yet.</li>}
      </ul>
      <ErrorNote error={remove.error} />
      {canConnect && (
        GOOGLE_CLIENT_ID ? (
          <button className="btn btn-primary mt-4" onClick={() => startYouTubeConnect(org!.id)}>Connect a YouTube channel</button>
        ) : (
          <p className="mt-4 text-sm bg-signal-soft rounded-md px-3 py-2 max-w-[760px]">
            Channel connection is not set up yet: add the Google OAuth client ID as <code>VITE_GOOGLE_CLIENT_ID</code> in the web app settings
            and the client ID and secret on the worker (see docs/YOUTUBE.md).
          </p>
        )
      )}
      {canConnect && GOOGLE_CLIENT_ID && (
        <p className="text-[13px] text-ink-faint mt-2 max-w-[75ch]">
          Sign in with the Google account that manages the channel. If it manages several (for example a brand account per station), choose the channel when Google asks.
          Disconnecting stops new imports; to revoke access fully, also remove Orb.IT at myaccount.google.com/permissions.
        </p>
      )}
    </section>
  );
}
