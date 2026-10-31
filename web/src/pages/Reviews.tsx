import { useQuery } from '@tanstack/react-query';
import { Empty, PageHeader, Spinner } from '../components/ui';
import { useOrg } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import { REVIEWER_ROLES, type Brief } from '../lib/types';
import { BriefTable } from './Briefs';

export function ReviewsPage() {
  const { org, can } = useOrg();
  const q = useQuery({
    queryKey: ['reviews', org!.id],
    queryFn: async () => check(await supabase.from('briefs').select('*').eq('org_id', org!.id)
      .or('status.in.(producer_review,specialist_review),evidence_changed_at.not.is.null')
      .order('updated_at', { ascending: true })) as Brief[],
  });
  const mine = (q.data ?? []).filter((b) => can(REVIEWER_ROLES, b.brand_id, b.show_id));
  return (
    <>
      <PageHeader title="Review inbox"
        lede="Briefs waiting for checks or approval, and briefs whose cited source passages were corrected. Oldest first." />
      {q.isLoading ? <Spinner /> : mine.length ? <BriefTable briefs={mine} /> : (
        <Empty title="Nothing waiting for you">Briefs submitted for review on shows you can review will appear here.</Empty>
      )}
    </>
  );
}
