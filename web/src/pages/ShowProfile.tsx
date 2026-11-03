import { useParams } from '@tanstack/react-router';
import { Slot } from '../modules/runtime';
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
        {brand?.name}. The show profile sets this programme's remit, tone and format. Existing briefs keep the version they were written with.
        {' '}<Slot name="showProfile.lede" show={show} />
      </>}
      canEdit={can(WORK_ROLES, show.brand_id, show.id)}
      canApprove={can(EDITOR_ROLES, show.brand_id, show.id)}
      approveHint="A show, brand or organisation editor needs to approve it."
      missingNotice="No approved profile yet, so Orb.IT cannot write briefs for this show."
    />
  );
}
