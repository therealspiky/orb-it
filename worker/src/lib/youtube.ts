/**
 * YouTube via official endpoints only: OAuth 2.0, the YouTube Data API v3
 * (videos, channels, captions) and oEmbed. Captions are downloaded only with
 * the channel owner's authorisation.
 */
import { PermanentError } from '../types.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://www.googleapis.com/youtube/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Video id from the common URL shapes (watch, youtu.be, shorts, live, embed) or a bare id. */
export function parseVideoId(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
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

export function isYouTubeUrl(input: string | null | undefined): boolean {
  return parseVideoId(input) !== null && !/^[\w-]{11}$/.test((input ?? '').trim());
}

/** ISO 8601 duration (PT1H2M3S) to seconds. */
export function parseIsoDuration(d: string | null | undefined): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d ?? '');
  if (!m) return null;
  const [, days, h, mi, s] = m.map((x) => Number(x ?? 0));
  return days! * 86400 + h! * 3600 + mi! * 60 + s!;
}

export interface VideoMeta {
  platform: 'youtube';
  video_id: string;
  url: string;
  title: string;
  channel_id: string | null;
  channel_title: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  description: string | null;
  thumbnail: string | null;
  language: string | null;
  metadata_source: 'data_api' | 'oembed';
}

export interface CaptionTrack { id: string; language: string; trackKind: string; name: string; isDraft?: boolean }

/** Prefers a published manual track in the wanted language, then any manual track, then auto-generated. */
export function chooseCaptionTrack(tracks: CaptionTrack[], wanted: string | null): CaptionTrack | null {
  const usable = tracks.filter((t) => !t.isDraft);
  const lang = (wanted ?? 'en').toLowerCase().split('-')[0];
  const manual = usable.filter((t) => t.trackKind.toLowerCase() !== 'asr');
  const auto = usable.filter((t) => t.trackKind.toLowerCase() === 'asr');
  const byLang = (list: CaptionTrack[]) => list.find((t) => t.language.toLowerCase().split('-')[0] === lang);
  return byLang(manual) ?? manual[0] ?? byLang(auto) ?? auto[0] ?? null;
}

export class YouTubeClient {
  constructor(
    private opts: { clientId?: string; clientSecret?: string; apiKey?: string },
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async json<T>(res: Response, what: string): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    const body = await res.text();
    const err = new Error(`${what} failed (${res.status}): ${body.slice(0, 300)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  get canAuthorise(): boolean { return !!(this.opts.clientId && this.opts.clientSecret); }
  get apiKeyConfigured(): boolean { return !!this.opts.apiKey; }

  async exchangeCode(code: string, redirectUri: string): Promise<{ access_token: string; refresh_token?: string; scope?: string }> {
    if (!this.canAuthorise) throw new PermanentError('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set on the worker');
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: this.opts.clientId!, client_secret: this.opts.clientSecret!,
        redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    if (res.status === 400) throw new PermanentError(`Google rejected the sign-in (${(await res.text()).slice(0, 200)}). Try connecting again.`);
    return this.json(res, 'Token exchange');
  }

  async accessToken(refreshToken: string): Promise<string> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: this.opts.clientId!, client_secret: this.opts.clientSecret!,
        grant_type: 'refresh_token' }),
    });
    if (res.status === 400 || res.status === 401) {
      const e = new Error('The channel connection has expired or was revoked; reconnect it under Organisation.') as Error & { revoked?: boolean };
      e.revoked = true;
      throw e;
    }
    return (await this.json<{ access_token: string }>(res, 'Token refresh')).access_token;
  }

  async myChannels(accessToken: string): Promise<{ id: string; title: string; thumb: string | null }[]> {
    const res = await this.fetchImpl(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await this.json<{ items?: { id: string; snippet: { title: string; thumbnails?: Record<string, { url: string }> } }[] }>(res, 'Channel lookup');
    return (body.items ?? []).map((c) => ({ id: c.id, title: c.snippet.title, thumb: c.snippet.thumbnails?.default?.url ?? null }));
  }

  /** Metadata from the Data API (API key or any OAuth token), falling back to oEmbed. */
  async videoMeta(videoId: string, accessToken?: string): Promise<VideoMeta> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    if (this.opts.apiKey || accessToken) {
      const q = new URLSearchParams({ part: 'snippet,contentDetails', id: videoId });
      if (this.opts.apiKey && !accessToken) q.set('key', this.opts.apiKey);
      const res = await this.fetchImpl(`${API}/videos?${q}`, accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined);
      const body = await this.json<{ items?: any[] }>(res, 'Video lookup');
      const v = body.items?.[0];
      if (!v) throw new PermanentError('YouTube has no public video at that link (it may be private or removed).');
      const thumbs = v.snippet?.thumbnails ?? {};
      return {
        platform: 'youtube', video_id: videoId, url, title: v.snippet.title, channel_id: v.snippet.channelId ?? null,
        channel_title: v.snippet.channelTitle ?? null, published_at: v.snippet.publishedAt ?? null,
        duration_seconds: parseIsoDuration(v.contentDetails?.duration), description: v.snippet.description ?? null,
        thumbnail: (thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null,
        language: v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage ?? null, metadata_source: 'data_api',
      };
    }
    const res = await this.fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (res.status === 404 || res.status === 401 || res.status === 403) throw new PermanentError('YouTube has no public video at that link (it may be private or removed).');
    const o = await this.json<{ title: string; author_name?: string; thumbnail_url?: string }>(res, 'oEmbed lookup');
    return {
      platform: 'youtube', video_id: videoId, url, title: o.title, channel_id: null, channel_title: o.author_name ?? null,
      published_at: null, duration_seconds: null, description: null, thumbnail: o.thumbnail_url ?? null, language: null,
      metadata_source: 'oembed',
    };
  }

  async listCaptions(videoId: string, accessToken: string): Promise<CaptionTrack[]> {
    const res = await this.fetchImpl(`${API}/captions?part=snippet&videoId=${videoId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await this.json<{ items?: { id: string; snippet: { language: string; trackKind: string; name: string; isDraft?: boolean } }[] }>(res, 'Caption list');
    return (body.items ?? []).map((i) => ({ id: i.id, language: i.snippet.language, trackKind: i.snippet.trackKind, name: i.snippet.name, isDraft: i.snippet.isDraft }));
  }

  /** WebVTT text of a caption track; null when YouTube does not allow downloading it. */
  async downloadCaption(trackId: string, accessToken: string): Promise<string | null> {
    const res = await this.fetchImpl(`${API}/captions/${trackId}?tfmt=vtt`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) await this.json(res, 'Caption download');
    return await res.text();
  }
}
