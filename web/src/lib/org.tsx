import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { check, supabase } from './supabase';
import type { Brand, Membership, Organisation, Role, Show } from './types';

interface OrgState {
  session: Session | null;
  userId: string | null;
  loading: boolean;
  /** The organisation this instance serves (each client runs its own instance). */
  org: Organisation | null;
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

export function OrgProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const currentUser = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      currentUser.current = data.session?.user.id ?? null;
      setSession(data.session);
      setAuthLoading(false);
    });
    // Supabase re-validates the session when the tab regains focus and refreshes tokens
    // in the background. Those events must not reset the app (it would unmount open
    // forms); cached data is only cleared when a different user signs in or out.
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      const next = s?.user.id ?? null;
      if (currentUser.current !== undefined && next !== currentUser.current) qc.clear();
      currentUser.current = next;
      setSession((prev) => (prev?.access_token === s?.access_token && prev?.user.id === s?.user.id ? prev : s));
    });
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

  // One organisation per instance: the one the signed-in user belongs to.
  const org = useMemo(() => (orgs.data ?? [])[0] ?? null, [orgs.data]);

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
      org,
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
