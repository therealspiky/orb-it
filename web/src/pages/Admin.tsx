import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Empty, ErrorNote, Field, PageHeader } from '../components/ui';
import { YouTubeChannels } from '../components/YouTubeChannels';
import { useOrg, usePeople } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import { ROLE_LABEL, type Membership, type Role } from '../lib/types';

export function AdminPage() {
  const { org, brands, shows, can, refresh, brandName, showName } = useOrg();
  const isAdmin = can(['org_admin']);
  const person = usePeople();

  const members = useQuery({
    queryKey: ['members', org!.id],
    queryFn: async () => check(await supabase.from('memberships').select('*').eq('org_id', org!.id).order('created_at')) as Membership[],
  });

  const [brandNameInput, setBrandNameInput] = useState('');
  const addBrand = useMutation({
    mutationFn: async () => check(await supabase.from('brands').insert({ org_id: org!.id, name: brandNameInput.trim() })),
    onSuccess: () => { setBrandNameInput(''); refresh(); },
  });

  const [newShow, setNewShow] = useState<Record<string, string>>({});
  const addShow = useMutation({
    mutationFn: async (brandId: string) =>
      check(await supabase.from('shows').insert({ org_id: org!.id, brand_id: brandId, name: (newShow[brandId] ?? '').trim() })),
    onSuccess: (_d, brandId) => { setNewShow({ ...newShow, [brandId]: '' }); refresh(); },
  });

  const archive = useMutation({
    mutationFn: async ({ table, id, archived }: { table: 'brands' | 'shows'; id: string; archived: boolean }) =>
      check(await supabase.from(table).update({ archived_at: archived ? null : new Date().toISOString() }).eq('id', id)),
    onSuccess: () => refresh(),
  });

  const [invite, setInvite] = useState({ email: '', role: 'producer' as Role, scope: '' });
  const addMember = useMutation({
    mutationFn: async () => {
      const [kind, id] = invite.scope.split(':');
      return check(await supabase.rpc('add_member', {
        p_org: org!.id, p_email: invite.email.trim(), p_role: invite.role,
        p_brand: kind === 'brand' ? id : null, p_show: kind === 'show' ? id : null,
      }));
    },
    onSuccess: () => { setInvite({ ...invite, email: '' }); void members.refetch(); },
  });
  const removeMember = useMutation({
    mutationFn: async (id: string) => check(await supabase.from('memberships').delete().eq('id', id)),
    onSuccess: () => void members.refetch(),
  });

  return (
    <>
      <PageHeader title={org!.name}
        lede="Brands own shows. Profile each brand (the station-wide identity and standards) and each show (its remit, tone and format); briefs are written against both." />

      <section className="mb-12">
        <h2 className="text-lg font-semibold mb-3">Brands and shows</h2>
        {brands.length === 0 && <Empty title="No brands yet">Add the stations and channels your organisation runs.</Empty>}
        <div className="grid gap-4 lg:grid-cols-2">
          {brands.map((b) => {
            const bShows = shows.filter((s) => s.brand_id === b.id);
            const canBrand = can(['org_admin', 'brand_editor'], b.id);
            return (
              <div key={b.id} className={`panel p-5 ${b.archived_at ? 'opacity-60' : ''}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <div>
                    <h3 className="text-[17px] font-semibold">
                      <Link to="/brands/$brandId" params={{ brandId: b.id }} className="hover:underline">{b.name}</Link>{b.archived_at && ' (archived)'}
                    </h3>
                    <Link to="/brands/$brandId" params={{ brandId: b.id }}
                      className={`text-[12px] font-semibold ${b.current_profile_version_id ? 'text-verified' : 'text-signal'}`}>
                      {b.current_profile_version_id ? 'Brand profile approved' : 'Brand profile needed'}
                    </Link>
                  </div>
                  {canBrand && (
                    <button className="text-sm text-ink-soft underline" onClick={() => archive.mutate({ table: 'brands', id: b.id, archived: !!b.archived_at })}>
                      {b.archived_at ? 'Restore' : 'Archive'}
                    </button>
                  )}
                </div>
                <ul className="mt-3 divide-y divide-line">
                  {bShows.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <Link to="/shows/$showId" params={{ showId: s.id }} className="font-medium hover:underline">{s.name}</Link>
                        {s.archived_at && <span className="text-ink-faint text-sm"> · archived</span>}
                      </div>
                      <span className={`text-[12px] font-semibold ${s.current_profile_version_id ? 'text-verified' : 'text-signal'}`}>
                        {s.current_profile_version_id ? 'Profile approved' : 'Profile needed'}
                      </span>
                    </li>
                  ))}
                  {bShows.length === 0 && <li className="py-2 text-ink-faint text-sm">No shows yet.</li>}
                </ul>
                {canBrand && !b.archived_at && (
                  <form className="mt-3 flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); addShow.mutate(b.id); }}>
                    <input className="field-input" placeholder="New show name" aria-label={`New show for ${b.name}`}
                      value={newShow[b.id] ?? ''} onChange={(e) => setNewShow({ ...newShow, [b.id]: e.target.value })} />
                    <button className="btn btn-quiet" disabled={!(newShow[b.id] ?? '').trim()}>Add show</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        <ErrorNote error={addShow.error || archive.error} />
        {isAdmin && (
          <form className="mt-4 flex gap-2 max-w-[520px]" onSubmit={(e) => { e.preventDefault(); addBrand.mutate(); }}>
            <input className="field-input" placeholder="New brand, e.g. a station or channel" aria-label="New brand name"
              value={brandNameInput} onChange={(e) => setBrandNameInput(e.target.value)} />
            <button className="btn btn-primary" disabled={!brandNameInput.trim()}>Add brand</button>
          </form>
        )}
        <ErrorNote error={addBrand.error} />
      </section>

      <YouTubeChannels />

      <section>
        <h2 className="text-lg font-semibold mb-1">People and roles</h2>
        <p className="text-ink-soft mb-4 max-w-[75ch]">
          Roles apply to the whole organisation, one brand, or one show. Editors approve; producers plan and draft;
          read-only members cannot approve or publish. The database enforces these rules, not the screen.
        </p>
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-ink-soft">
              <tr className="border-b border-line"><th className="px-4 py-2 font-semibold">Person</th><th className="px-4 py-2 font-semibold">Role</th><th className="px-4 py-2 font-semibold">Scope</th><th /></tr>
            </thead>
            <tbody>
              {(members.data ?? []).map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">{person(m.user_id)}</td>
                  <td className="px-4 py-2">{ROLE_LABEL[m.role]}</td>
                  <td className="px-4 py-2">{m.show_id ? showName(m.show_id) : m.brand_id ? brandName(m.brand_id) : 'Whole organisation'}</td>
                  <td className="px-4 py-2 text-right">
                    {isAdmin && <button className="text-blocked underline" onClick={() => removeMember.mutate(m.id)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorNote error={removeMember.error} />
        {isAdmin && (
          <form className="mt-4 grid gap-3 md:grid-cols-[2fr_1.3fr_1.5fr_auto] items-end" onSubmit={(e) => { e.preventDefault(); addMember.mutate(); }}>
            <Field label="Email" help="They need an Orb.IT account first.">
              <input className="field-input" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required />
            </Field>
            <Field label="Role">
              <select className="field-input" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
            <Field label="Scope">
              <select className="field-input" value={invite.scope} onChange={(e) => setInvite({ ...invite, scope: e.target.value })}>
                <option value="">Whole organisation</option>
                {invite.role !== 'org_admin' && brands.map((b) => (
                  <optgroup key={b.id} label={b.name}>
                    <option value={`brand:${b.id}`}>All of {b.name}</option>
                    {shows.filter((s) => s.brand_id === b.id).map((s) => <option key={s.id} value={`show:${s.id}`}>{s.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <button className="btn btn-primary" disabled={addMember.isPending}>Add person</button>
          </form>
        )}
        <div className="mt-2"><ErrorNote error={addMember.error} /></div>
      </section>
    </>
  );
}
