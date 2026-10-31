import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { check, supabase } from './supabase';
import type { Brand, Membership, Organisation, Role, Show } from './types';

interface OrgState {
  session: Session | null;
  userId: string | null;
  loading: boolean;
  orgs: Organisation[];
  org: Organisation | null;
  setOrgId: (id: string) => void;
  memberships: Membership[];
  brands: Brand[];
  shows: Show[];
  brandName: (id: string | null | undefined) => string;
  showName: (id: string | null | undefined) => string;
  /** Client-side mirror of has_scope(); the database enforces the real rule. */
  can: (roles: Role[], brandId?: string | null, showId?: string | null) => boolean;
  refresh: () => void;
}

const Ctx = createContext<OrgState | null>(null);
const ORG_KEY = 'orbit.currentOrg';

export function OrgProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [orgId, setOrgIdState] = useState<string | null>(() => {
    try { return localStorage.getItem(ORG_KEY); } catch { return null; }
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); qc.clear(); });
    return () => data.subscription.unsubscribe();
  }, [qc]);

  const userId = session?.user.id ?? null;

  const myMemberships = useQuery({
    queryKey: ['my-memberships', userId],
    enabled: !!userId,
    queryFn: async () => check(await supabase.from('memberships').select('*').eq('user_id', userId!)) as Membership[],
  });
  const orgs = useQuery({
    queryKey: ['orgs', userId],
    enabled: !!userId,
    queryFn: async () => check(await supabase.from('organisations').select('id,name').order('name')) as Organisation[],
  });

  const org = useMemo(() => {
    const list = orgs.data ?? [];
    return list.find((o) => o.id === orgId) ?? list[0] ?? null;
  }, [orgs.data, orgId]);

  const brands = useQuery({
    queryKey: ['brands', org?.id],
    enabled: !!org,
    queryFn: async () => check(await supabase.from('brands').select('*').eq('org_id', org!.id).order('name')) as Brand[],
  });
  const shows = useQuery({
    queryKey: ['shows', org?.id],
    enabled: !!org,
    queryFn: async () => check(await supabase.from('shows').select('*').eq('org_id', org!.id).order('name')) as Show[],
  });

  const value = useMemo<OrgState>(() => {
    const mine = (myMemberships.data ?? []).filter((m) => m.org_id === org?.id);
    const b = brands.data ?? [];
    const s = shows.data ?? [];
    return {
      session,
      userId,
      loading: authLoading || (!!userId && (myMemberships.isLoading || orgs.isLoading)),
      orgs: orgs.data ?? [],
      org,
      setOrgId: (id) => { try { localStorage.setItem(ORG_KEY, id); } catch { /* storage unavailable */ } setOrgIdState(id); },
      memberships: mine,
      brands: b,
      shows: s,
      brandName: (id) => b.find((x) => x.id === id)?.name ?? '—',
      showName: (id) => s.find((x) => x.id === id)?.name ?? '—',
      can: (roles, brandId, showId) =>
        mine.some((m) => roles.includes(m.role)
          && (m.brand_id === null || m.brand_id === brandId)
          && (m.show_id === null || m.show_id === showId)),
      refresh: () => { void qc.invalidateQueries(); },
    };
  }, [session, userId, authLoading, myMemberships.data, myMemberships.isLoading, orgs.data, orgs.isLoading, org, brands.data, shows.data, qc]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOrg(): OrgState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOrg outside OrgProvider');
  return v;
}

/** Display names for user ids (profiles are readable for people who share an organisation). */
export function usePeople() {
  const { org } = useOrg();
  const q = useQuery({
    queryKey: ['people', org?.id],
    enabled: !!org,
    queryFn: async () => check(await supabase.from('profiles').select('user_id,email,display_name')) as
      { user_id: string; email: string | null; display_name: string | null }[],
  });
  return (id: string | null | undefined) => {
    if (!id) return 'System';
    const p = q.data?.find((x) => x.user_id === id);
    return p?.display_name || p?.email || 'Unknown user';
  };
}
