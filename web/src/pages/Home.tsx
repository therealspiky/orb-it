import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Empty, PageHeader, Progress } from '../components/ui';
import { ago } from '../lib/format';
import { useOrg } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import type { Brief, Job } from '../lib/types';
import { BriefTable } from './Briefs';

const JOB_LABEL: Record<string, string> = { transcribe: 'Transcription', analyse: 'Source analysis', generate_briefs: 'Brief writing' };

export function HomePage() {
  const { org, shows, brands, can } = useOrg();
  const jobs = useQuery({
    queryKey: ['jobs', org!.id],
    refetchInterval: 5000,
    queryFn: async () => check(await supabase.from('jobs').select('*').eq('org_id', org!.id).order('created_at', { ascending: false }).limit(8)) as Job[],
  });
  const recent = useQuery({
    queryKey: ['recent-briefs', org!.id],
    queryFn: async () => check(await supabase.from('briefs').select('*').eq('org_id', org!.id).order('updated_at', { ascending: false }).limit(8)) as Brief[],
  });

  const needsProfile = shows.filter((s) => !s.archived_at && !s.current_profile_version_id);
  const setupSteps = [
    { done: brands.length > 0, text: 'Add your brands and their shows', to: '/admin' as const },
    { done: shows.length > 0 && needsProfile.length < shows.length, text: 'Approve an editorial profile for each show', to: '/admin' as const },
    { done: (jobs.data ?? []).some((j) => j.kind === 'transcribe'), text: 'Add a programme recording as a source', to: '/sources' as const },
    { done: (recent.data ?? []).length > 0, text: 'Write briefs for the shows that source can serve', to: '/sources' as const },
  ];
  const setupDone = setupSteps.every((s) => s.done);

  return (
    <>
      <PageHeader title={org!.name} lede="Sources come in, briefs go out, editors decide." />

      {!setupDone && can(['org_admin', 'brand_editor', 'show_editor', 'producer']) && (
        <section className="panel p-5 mb-8 max-w-[720px]">
          <h2 className="font-semibold mb-3">Getting to your first brief</h2>
          <ol className="space-y-2">
            {setupSteps.map((s, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className={`w-6 h-6 shrink-0 rounded-full text-[12px] font-bold grid place-items-center ${s.done ? 'bg-verified text-white' : 'border border-line-strong text-ink-soft'}`}>{s.done ? '✓' : i + 1}</span>
                <Link to={s.to} className={s.done ? 'text-ink-faint line-through' : 'hover:underline'}>{s.text}</Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {needsProfile.length > 0 && setupDone && (
        <p className="mb-6 text-sm bg-signal-soft rounded-md px-4 py-2">
          {needsProfile.length} show{needsProfile.length === 1 ? '' : 's'} without an approved profile: {needsProfile.map((s, i) => (
            <span key={s.id}>{i > 0 && ', '}<Link to="/shows/$showId" params={{ showId: s.id }} className="underline">{s.name}</Link></span>
          ))}.
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <h2 className="text-lg font-semibold mb-3">Recent briefs</h2>
          {recent.data?.length ? <BriefTable briefs={recent.data} /> : <Empty title="No briefs yet">They appear here once a source has been developed for your shows.</Empty>}
        </section>
        <section>
          <h2 className="text-lg font-semibold mb-3">Processing</h2>
          <ul className="panel divide-y divide-line">
            {(jobs.data ?? []).map((j) => (
              <li key={j.id} className="px-4 py-3 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{JOB_LABEL[j.kind] ?? j.kind}</span>
                  <span className={j.status === 'failed' ? 'text-blocked font-semibold' : j.status === 'succeeded' ? 'text-verified' : 'text-ink-soft'}>
                    {j.status === 'succeeded' ? 'Done' : j.status === 'failed' ? 'Failed' : j.status === 'queued' ? 'Waiting' : j.status === 'cancelled' ? 'Cancelled' : 'Running'}
                  </span>
                </div>
                {j.status === 'running' && <div className="mt-2"><Progress value={j.progress} /></div>}
                <p className="text-ink-faint mt-1">{j.status === 'failed' ? j.error ?? j.message : j.message} · {ago(j.updated_at)}</p>
                {typeof j.payload.source_id === 'string' && (
                  <Link to="/sources/$sourceId" params={{ sourceId: j.payload.source_id }} className="text-[13px] underline">Open source</Link>
                )}
              </li>
            ))}
            {!jobs.data?.length && <li className="px-4 py-3 text-sm text-ink-faint">Nothing processing.</li>}
          </ul>
        </section>
      </div>
    </>
  );
}
