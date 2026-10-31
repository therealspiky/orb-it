import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ErrorNote, Field } from '../components/ui';
import { useOrg } from '../lib/org';
import { supabase } from '../lib/supabase';

export function LoginPage() {
  const { session } = useOrg();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/" />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: name } } });
        if (error) throw error;
        if (!data.session) setNotice('Check your email to confirm your account, then sign in.');
      }
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full grid md:grid-cols-[1fr_minmax(360px,460px)]">
      <section className="hidden md:flex flex-col justify-between bg-rail text-white p-12">
        <p className="text-xl font-bold tracking-[-0.02em]">Orb.IT <span className="font-normal text-white/60">by ctrl.IT</span></p>
        <div className="max-w-[46ch]">
          <p className="source-text text-[26px] leading-snug text-white">
            One programme in. A sourced, show-ready brief out for every show it can serve.
          </p>
          <p className="mt-4 text-white/65">
            Upload a recording, check the transcript, and get editorial briefs that cite the exact passage behind every claim.
          </p>
        </div>
        <p className="text-[13px] text-white/45">Editors stay accountable. Orb.IT never publishes on its own.</p>
      </section>
      <section className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-[380px] space-y-4">
          <h1 className="text-2xl font-semibold">{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
          {mode === 'signup' && (
            <Field label="Your name"><input className="field-input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          )}
          <Field label="Email"><input className="field-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password"><input className="field-input" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <ErrorNote error={error} />
          {notice && <p className="text-sm bg-verified-soft text-verified rounded-md px-3 py-2">{notice}</p>}
          <button className="btn btn-primary w-full justify-center" disabled={busy}>{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
          <button type="button" className="text-sm text-ink-soft underline" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'New to Orb.IT? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}

export function OnboardingPage() {
  const { session, org, loading, refresh, setOrgId } = useOrg();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && !session) return <Navigate to="/login" />;
  if (!loading && org) return <Navigate to="/" />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { data, error } = await supabase.rpc('create_organisation', { p_name: name.trim() });
    setBusy(false);
    if (error) return setError(error);
    setOrgId(data as string);
    refresh();
    void navigate({ to: '/admin' });
  }

  return (
    <div className="max-w-[560px] mx-auto px-6 py-16">
      <h1 className="text-2xl font-semibold">Set up your media organisation</h1>
      <p className="mt-2 text-ink-soft">
        You will be its administrator. Next you add brands (stations, channels), their shows, and invite your team.
        If a colleague already set Orb.IT up, ask them to add you instead; you will see their organisation after signing in again.
      </p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <Field label="Organisation name" help="For example, the media group that owns your stations and channels.">
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <ErrorNote error={error} />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>Create organisation</button>
      </form>
    </div>
  );
}
