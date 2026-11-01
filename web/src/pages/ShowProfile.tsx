import { Link, useParams } from '@tanstack/react-router';
import { ProfileEditor } from '../components/ProfileEditor';
import { Spinner } from '../components/ui';
import { useOrg } from '../lib/org';
import { PROFILE_GROUPS } from '../lib/profileFields';
import { EDITOR_ROLES, WORK_ROLES } from '../lib/types';

export function ShowProfilePage() {
  const { showId } = useParams({ from: '/app/shows/$showId' });
  const { shows, brands, can } = useOrg();
  const show = shows.find((s) => s.id === showId);
  if (!show) return <Spinner />;
  const brand = brands.find((b) => b.id === show.brand_id);
  return (
    <ProfileEditor
      key={show.id}
      kind="show"
      entityId={show.id}
      groups={PROFILE_GROUPS}
      title={`${show.name} profile`}
      lede={<>
        Part of <Link to="/brands/$brandId" params={{ brandId: show.brand_id }} className="underline">{brand?.name ?? 'its brand'}</Link>
        {brand && !brand.current_profile_version_id && ' (brand profile not yet approved)'}.
        The show profile sets this programme's remit, tone and format within the brand profile. Existing briefs keep the version they were written with.
      </>}
      canEdit={can(WORK_ROLES, show.brand_id, show.id)}
      canApprove={can(EDITOR_ROLES, show.brand_id, show.id)}
      approveHint="A show, brand or organisation editor needs to approve it."
      missingNotice="No approved profile yet, so Orb.IT cannot write briefs for this show."
    />
  );
}
