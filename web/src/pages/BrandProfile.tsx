import { Link, useParams } from '@tanstack/react-router';
import { ProfileEditor } from '../components/ProfileEditor';
import { Spinner } from '../components/ui';
import { useOrg } from '../lib/org';
import { BRAND_PROFILE_GROUPS } from '../lib/profileFields';
import { WORK_ROLES } from '../lib/types';

export function BrandProfilePage() {
  const { brandId } = useParams({ from: '/app/brands/$brandId' });
  const { brands, shows, can } = useOrg();
  const brand = brands.find((b) => b.id === brandId);
  if (!brand) return <Spinner />;
  const brandShows = shows.filter((s) => s.brand_id === brand.id && !s.archived_at);
  return (
    <>
      <ProfileEditor
        key={brand.id}
        kind="brand"
        entityId={brand.id}
        groups={BRAND_PROFILE_GROUPS}
        title={`${brand.name} brand profile`}
        lede="The station-wide editorial contract. Every brief for every show on this brand must fit its identity and voice, and can never breach its standards or exclusions."
        canEdit={can(WORK_ROLES, brand.id, null)}
        canApprove={can(['org_admin', 'brand_editor'], brand.id, null)}
        approveHint="A brand editor or organisation admin needs to approve it."
        missingNotice="No approved brand profile yet. Briefs for this brand's shows will be marked as missing station-wide identity and standards until one is approved."
      />
      {brandShows.length > 0 && (
        <section className="mt-10 max-w-[760px]">
          <h2 className="text-lg font-semibold mb-2">Shows on {brand.name}</h2>
          <ul className="panel divide-y divide-line">
            {brandShows.map((s) => (
              <li key={s.id} className="flex justify-between gap-3 px-4 py-2.5">
                <Link to="/shows/$showId" params={{ showId: s.id }} className="font-medium hover:underline">{s.name}</Link>
                <span className={`text-[12px] font-semibold ${s.current_profile_version_id ? 'text-verified' : 'text-signal'}`}>
                  {s.current_profile_version_id ? 'Show profile approved' : 'Show profile needed'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
