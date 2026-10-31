import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { BriefBadge, Empty, PageHeader, Spinner } from '../components/ui';
import { ago } from '../lib/format';
import { useOrg } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import { STATUS_LABEL, type Brief, type BriefStatus } from '../lib/types';

const OPEN: BriefStatus[] = ['discovered', 'researching', 'drafted', 'producer_review', 'specialist_review', 'approved', 'scheduled'];

export function BriefTable({ briefs }: { briefs: Brief[] }) {
  const { showName, brandName } = useOrg();
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-ink-soft">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-semibold">Brief</th><th className="px-4 py-2 font-semibold">Show</th>
            <th className="px-4 py-2 font-semibold">Recommendation</th><th className="px-4 py-2 font-semibold">Status</th>
            <th className="px-4 py-2 font-semibold">Updated</th>
          </tr>
        </thead>
        <tbody>
          {briefs.map((b) => (
            <tr key={b.id} className="border-b border-line last:border-0 align-top">
              <td className="px-4 py-2.5">
                <Link to="/briefs/$briefId" params={{ briefId: b.id }} className="font-semibold hover:underline">{b.title}</Link>
                {b.evidence_changed_at && <span className="block text-[12px] font-semibold text-blocked">Cited source passage corrected</span>}
                {b.status_reason && !b.evidence_changed_at && <span className="block text-ink-faint">{b.status_reason}</span>}
              </td>
              <td className="px-4 py-2.5">{showName(b.show_id)}<span className="block text-ink-faint">{brandName(b.brand_id)}</span></td>
              <td className="px-4 py-2.5">{b.recommendation === 'research' ? 'Research first' : b.recommendation === 'proceed' ? 'Proceed' : '—'}</td>
              <td className="px-4 py-2.5"><BriefBadge status={b.status} /></td>
              <td className="px-4 py-2.5 text-ink-soft whitespace-nowrap">{ago(b.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BriefsPage() {
  const { org, shows } = useOrg();
  const [show, setShow] = useState('');
  const [status, setStatus] = useState<'open' | BriefStatus | 'all'>('open');
  const q = useQuery({
    queryKey: ['briefs', org!.id, show, status],
    queryFn: async () => {
      let r = supabase.from('briefs').select('*').eq('org_id', org!.id).order('updated_at', { ascending: false }).limit(300);
      if (show) r = r.eq('show_id', show);
      if (status === 'open') r = r.in('status', OPEN);
      else if (status !== 'all') r = r.eq('status', status);
      return check(await r) as Brief[];
    },
  });
  return (
    <>
      <PageHeader title="Briefs" lede="Every opportunity brief you can see, newest activity first." />
      <div className="flex flex-wrap gap-3 mb-4">
        <select className="field-input w-auto" value={show} onChange={(e) => setShow(e.target.value)} aria-label="Filter by show">
          <option value="">All shows</option>
          {shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="field-input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
          <option value="open">In progress</option><option value="all">All statuses</option>
          {(Object.keys(STATUS_LABEL) as BriefStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      {q.isLoading ? <Spinner /> : q.data?.length ? <BriefTable briefs={q.data} /> : (
        <Empty title="No briefs match">Open a source and choose the shows to write for. Briefs appear here as they are written.</Empty>
      )}
    </>
  );
}
