/** YouTube helpers for the browser (mirrors worker/src/lib/youtube.ts parsing). */
export function parseVideoId(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  let u: URL;
  try { u = new URL(s.startsWith('http') ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  if (host === 'youtu.be') return /^[\w-]{11}/.exec(u.pathname.slice(1))?.[0] ?? null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = /^\/(?:shorts|live|embed|v)\/([\w-]{11})/.exec(u.pathname);
    if (m) return m[1]!;
  }
  return null;
}

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '';
export const YT_REDIRECT_PATH = '/integrations/youtube';
const STATE_KEY = 'orbit.ytOAuthState';

/**
 * Starts Google sign-in for connecting a channel. youtube.force-ssl is the
 * narrowest scope YouTube accepts for downloading caption tracks.
 */
export function startYouTubeConnect(orgId: string) {
  const state = `${orgId}.${crypto.randomUUID()}`;
  try { sessionStorage.setItem(STATE_KEY, state); } catch { /* storage unavailable: state check will fail safely */ }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${window.location.origin}${YT_REDIRECT_PATH}`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
  });
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/** Returns the org id when the returned state matches the one this browser started with. */
export function checkState(returned: string | null): string | null {
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* ignore */ }
  if (!returned || !saved || returned !== saved) return null;
  return returned.split('.')[0] ?? null;
}
