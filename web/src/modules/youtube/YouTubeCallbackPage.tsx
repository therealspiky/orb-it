import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ErrorNote, PageHeader, Spinner } from '../../components/ui';
import { useOrg } from '../../lib/org';
import { check, supabase } from '../../lib/supabase';
import type { Job } from '../../lib/types';
import { checkState, YT_REDIRECT_PATH } from './youtube';

/** Google sends the user back here; the one-time code is handed to the worker. */
export function YouTubeCallbackPage() {
  const { refresh } = useOrg();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const q = new URLSearchParams(window.location.search);
    // Remove the code from the address bar and history straight away.
    window.history.replaceState(null, '', YT_REDIRECT_PATH);
    if (q.get('error')) { setError(q.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : `Google returned: ${q.get('error')}`); return; }
    const orgId = checkState(q.get('state'));
    const code = q.get('code');
    if (!orgId || !code) { setError('This sign-in could not be verified. Start again from the Organisation page.'); return; }
    supabase.rpc('submit_youtube_oauth_code', { p_org: orgId, p_code: code, p_redirect_uri: `${window.location.origin}${YT_REDIRECT_PATH}` })
      .then(({ data, error: e }) => (e ? setError(e.message) : setJobId(data as string)));
  }, []);

  const job = useQuery({
    queryKey: ['yt-connect-job', jobId],
    enabled: !!jobId,
    refetchInterval: (qq) => (['queued', 'running'].includes((qq.state.data as Job | undefined)?.status ?? 'queued') ? 2000 : false),
    queryFn: async () => check(await supabase.from('jobs').select('*').eq('id', jobId!).single()) as Job,
  });
  const done = job.data?.status === 'succeeded';
  useEffect(() => { if (done) refresh(); }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  const channels = (job.data as (Job & { result?: { channels?: string[] } }) | undefined)?.result?.channels ?? [];

  return (
    <div className="max-w-[640px]">
      <PageHeader title="Connecting YouTube" />
      {error && <ErrorNote error={error} />}
      {!error && !done && job.data?.status !== 'failed' && <Spinner label={job.data?.status === 'queued' ? 'Waiting for the Orb.IT worker' : 'Finishing the connection'} />}
      {job.data?.status === 'failed' && <ErrorNote error={job.data.error ?? job.data.message ?? 'The connection failed.'} />}
      {done && (
        <p className="bg-verified-soft text-verified rounded-md px-4 py-3">
          Connected: <strong>{channels.join(', ')}</strong>. Links to these channels' videos now import their captions automatically.
        </p>
      )}
      <Link to="/admin" className="btn btn-quiet mt-6">Back to Organisation</Link>
    </div>
  );
}
