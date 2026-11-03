import { createRoute, Link, type AnyRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useOrg } from '../../lib/org';
import { supabase } from '../../lib/supabase';
import { ModuleGate } from '../runtime';
import type { SlotProps, WebModule } from '../types';
import { BrandProfilePage } from './BrandProfilePage';

// Module routes are not part of the core route types, so links to them are cast.
const brandLink = (brandId: string) => ({ to: '/brands/$brandId' as never, params: { brandId } as never });

function BrandStatus({ brand }: SlotProps['admin.brandStatus']) {
  return (
    <Link {...brandLink(brand.id)} className={`text-[12px] font-semibold ${brand.current_profile_version_id ? 'text-verified' : 'text-signal'}`}>
      {brand.current_profile_version_id ? 'Brand profile approved' : 'Brand profile needed'}
    </Link>
  );
}

function ShowLede({ show }: SlotProps['showProfile.lede']) {
  const { brands } = useOrg();
  const brand = brands.find((b) => b.id === show.brand_id);
  if (!brand) return null;
  return (
    <span>
      It works within the <Link {...brandLink(brand.id)} className="underline">{brand.name} brand profile</Link>
      {!brand.current_profile_version_id && ' (not yet approved)'}.
    </span>
  );
}

function GenerateNotice({ shows }: SlotProps['source.generateNotice']) {
  const { brands } = useOrg();
  const missing = brands.filter((b) => shows.some((s) => s.brand_id === b.id) && !b.current_profile_version_id);
  if (!missing.length) return null;
  return (
    <p className="text-[13px] text-ink mb-3 bg-signal-soft rounded px-2 py-1">
      No approved brand profile for {missing.map((b) => b.name).join(', ')}. Those briefs will not reflect station-wide identity and standards.
    </p>
  );
}

function BriefBrandMeta({ brief, version }: SlotProps['brief.headerMeta']) {
  const q = useQuery({
    queryKey: ['brand-profile-version', version.brand_profile_version_id],
    enabled: !!version.brand_profile_version_id,
    queryFn: async () => (await supabase.from('brand_profile_versions').select('version').eq('id', version.brand_profile_version_id!).maybeSingle()).data as { version: number } | null,
  });
  return version.brand_profile_version_id
    ? <Link {...brandLink(brief.brand_id)} className="underline">Brand profile{q.data ? ` v${q.data.version}` : ''}</Link>
    : <Link {...brandLink(brief.brand_id)} className="underline text-signal">No brand profile applied</Link>;
}

export const brandProfilesModule: WebModule = {
  key: 'brand_profiles',
  label: 'Brand profiles',
  routes: (parent: AnyRoute) => [createRoute({ getParentRoute: () => parent, path: '/brands/$brandId',
    component: () => <ModuleGate moduleKey="brand_profiles"><BrandProfilePage /></ModuleGate> })],
  slots: {
    'admin.brandStatus': BrandStatus,
    'showProfile.lede': ShowLede,
    'source.generateNotice': GenerateNotice,
    'brief.headerMeta': BriefBrandMeta,
  },
};
