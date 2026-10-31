import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { FileAudio, Inbox, LayoutList, LogOut, Radio, Settings2 } from 'lucide-react';
import { useOrg } from '../lib/org';
import { configured, supabase } from '../lib/supabase';
import { Spinner } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: Radio, exact: true },
  { to: '/sources', label: 'Sources', icon: FileAudio },
  { to: '/briefs', label: 'Briefs', icon: LayoutList },
  { to: '/reviews', label: 'Review inbox', icon: Inbox },
  { to: '/admin', label: 'Organisation', icon: Settings2 },
] as const;

export function Layout() {
  const { session, loading, orgs, org, setOrgId, shows, brands } = useOrg();
  const path = useRouterState({ select: (s) => s.location.pathname });

  if (!configured) return <SetupNeeded />;
  if (loading) return <div className="p-8"><Spinner /></div>;
  if (!session) return <Navigate to="/login" />;
  if (!org) return <Navigate to="/onboarding" />;

  return (
    <div className="min-h-full md:grid md:grid-cols-[232px_1fr]">
      <aside className="bg-rail text-white md:min-h-screen md:sticky md:top-0 md:h-screen flex md:flex-col">
        <div className="px-5 py-5 hidden md:block">
          <p className="text-[19px] font-bold tracking-[-0.02em]">Orb.IT</p>
          <p className="text-[12px] text-white/55">by ctrl.IT</p>
        </div>
        {orgs.length > 1 ? (
          <label className="hidden md:block px-4 pb-4">
            <span className="sr-only">Organisation</span>
            <select value={org.id} onChange={(e) => setOrgId(e.target.value)}
              className="w-full bg-white/10 border border-white/15 rounded-md px-2 py-1.5 text-sm">
              {orgs.map((o) => <option key={o.id} value={o.id} className="text-ink">{o.name}</option>)}
            </select>
          </label>
        ) : (
          <p className="hidden md:block px-5 pb-4 text-sm text-white/80 font-medium">{org.name}</p>
        )}
        <nav className="flex md:flex-col gap-0.5 px-2 py-2 md:py-0 overflow-x-auto flex-1">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => {
            const active = 'exact' in rest ? path === to : path.startsWith(to);
            return (
              <Link key={to} to={to}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[14px] whitespace-nowrap ${active ? 'bg-white text-ink font-semibold' : 'text-white/80 hover:bg-white/10'}`}>
                <Icon size={16} aria-hidden /> {label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden md:block px-5 py-4 border-t border-white/10 text-[12px] text-white/60">
          <p>{brands.length} brands · {shows.length} shows</p>
          <p className="truncate mt-1" title={session.user.email}>{session.user.email}</p>
          <button onClick={() => supabase.auth.signOut()} className="mt-2 inline-flex items-center gap-1.5 text-white/80 hover:text-white">
            <LogOut size={14} aria-hidden /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 px-4 md:px-10 py-8 max-w-[1440px]">
        <Outlet />
      </main>
    </div>
  );
}

function SetupNeeded() {
  return (
    <div className="max-w-[640px] mx-auto p-10">
      <h1 className="text-2xl font-semibold">Connect Orb.IT to Supabase</h1>
      <p className="mt-3 text-ink-soft">
        Copy <code>web/.env.example</code> to <code>web/.env.local</code>, add your project URL and anon key, then restart the dev server.
        The README explains how to apply the database migrations.
      </p>
    </div>
  );
}
