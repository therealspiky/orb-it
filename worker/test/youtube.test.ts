import { describe, expect, it } from 'vitest';
import { chooseCaptionTrack, isYouTubeUrl, parseIsoDuration, parseVideoId, YouTubeClient, type FetchLike } from '../src/lib/youtube.js';
import { parseTextTranscript } from '../src/lib/textTranscript.js';
import { PermanentError } from '../src/types.js';

function fakeFetch(routes: Record<string, (url: string, init?: RequestInit) => { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not mocked', { status: 500 });
    const r = routes[key]!(url, init);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200 });
  };
  return { f, calls };
}

describe('YouTube links', () => {
  it.each([
    ['https://www.youtube.com/watch?v=j_Q1H_0gosI&t=1s', 'j_Q1H_0gosI'],
    ['https://youtu.be/j_Q1H_0gosI?si=abc', 'j_Q1H_0gosI'],
    ['https://www.youtube.com/shorts/j_Q1H_0gosI', 'j_Q1H_0gosI'],
    ['https://m.youtube.com/watch?v=j_Q1H_0gosI', 'j_Q1H_0gosI'],
    ['https://www.youtube.com/live/j_Q1H_0gosI?feature=share', 'j_Q1H_0gosI'],
    ['youtube.com/watch?v=j_Q1H_0gosI', 'j_Q1H_0gosI'],
  ])('reads the video id from %s', (url, id) => {
    expect(parseVideoId(url)).toBe(id);
  });

  it('rejects non-YouTube links', () => {
    expect(parseVideoId('https://www.facebook.com/share/v/19NCt6gBNH/')).toBeNull();
    expect(isYouTubeUrl('https://example.com/watch?v=j_Q1H_0gosI')).toBe(false);
    expect(isYouTubeUrl('https://youtu.be/j_Q1H_0gosI')).toBe(true);
  });

  it('parses ISO 8601 durations', () => {
    expect(parseIsoDuration('PT51M12S')).toBe(3072);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration('nonsense')).toBeNull();
  });
});

describe('caption track choice', () => {
  const tracks = [
    { id: 'asr-en', language: 'en', trackKind: 'asr', name: '' },
    { id: 'man-fr', language: 'fr', trackKind: 'standard', name: 'French' },
    { id: 'man-en-draft', language: 'en', trackKind: 'standard', name: 'Draft', isDraft: true },
    { id: 'man-en', language: 'en-GB', trackKind: 'standard', name: 'English' },
  ];
  it('prefers a published manual track in the wanted language', () => {
    expect(chooseCaptionTrack(tracks, 'en')!.id).toBe('man-en');
  });
  it('falls back to any manual track, then auto-generated', () => {
    expect(chooseCaptionTrack(tracks, 'tw')!.id).toBe('man-fr');
    expect(chooseCaptionTrack([tracks[0]!], 'en')!.id).toBe('asr-en');
    expect(chooseCaptionTrack([], 'en')).toBeNull();
  });
});

describe('YouTube client (official endpoints)', () => {
  it('reads full details from the Data API with an API key', async () => {
    const { f, calls } = fakeFetch({
      '/youtube/v3/videos': () => ({ body: { items: [{ snippet: { title: 'Joy Geek Squad: remote work', channelId: 'UCjoy', channelTitle: 'JoyNews',
        publishedAt: '2026-10-20T10:00:00Z', description: 'desc', thumbnails: { high: { url: 'https://i.ytimg.com/x.jpg' } }, defaultAudioLanguage: 'en' },
        contentDetails: { duration: 'PT51M12S' } }] } }),
    });
    const yt = new YouTubeClient({ apiKey: 'KEY' }, f);
    const m = await yt.videoMeta('j_Q1H_0gosI');
    expect(m).toMatchObject({ title: 'Joy Geek Squad: remote work', channel_id: 'UCjoy', duration_seconds: 3072, metadata_source: 'data_api' });
    expect(calls[0]!.url).toContain('key=KEY');
  });

  it('falls back to oEmbed without an API key or token', async () => {
    const { f } = fakeFetch({ 'youtube.com/oembed': () => ({ body: { title: 'A show', author_name: 'JoyNews', thumbnail_url: 'https://t' } }) });
    const m = await new YouTubeClient({}, f).videoMeta('j_Q1H_0gosI');
    expect(m).toMatchObject({ title: 'A show', channel_title: 'JoyNews', channel_id: null, metadata_source: 'oembed' });
  });

  it('explains private or removed videos', async () => {
    const { f } = fakeFetch({ 'youtube.com/oembed': () => ({ status: 404, body: 'Not Found' }) });
    await expect(new YouTubeClient({}, f).videoMeta('j_Q1H_0gosI')).rejects.toBeInstanceOf(PermanentError);
  });

  it('exchanges an OAuth code and lists the signed-in channels', async () => {
    const { f, calls } = fakeFetch({
      'oauth2.googleapis.com/token': () => ({ body: { access_token: 'AT', refresh_token: 'RT', scope: 'youtube.force-ssl' } }),
      '/youtube/v3/channels': () => ({ body: { items: [{ id: 'UCjoy', snippet: { title: 'JoyNews', thumbnails: { default: { url: 'u' } } } }] } }),
    });
    const yt = new YouTubeClient({ clientId: 'CID', clientSecret: 'SECRET' }, f);
    const t = await yt.exchangeCode('CODE', 'http://localhost:5173/integrations/youtube');
    expect(t.refresh_token).toBe('RT');
    expect(String(calls[0]!.init!.body)).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fintegrations%2Fyoutube');
    expect(await yt.myChannels('AT')).toEqual([{ id: 'UCjoy', title: 'JoyNews', thumb: 'u' }]);
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer AT');
  });

  it('turns a rejected code into a clear permanent error', async () => {
    const { f } = fakeFetch({ 'oauth2.googleapis.com/token': () => ({ status: 400, body: '{"error":"invalid_grant"}' }) });
    await expect(new YouTubeClient({ clientId: 'a', clientSecret: 'b' }, f).exchangeCode('x', 'http://x')).rejects.toBeInstanceOf(PermanentError);
  });

  it('marks a revoked connection when the refresh token stops working', async () => {
    const { f } = fakeFetch({ 'oauth2.googleapis.com/token': () => ({ status: 400, body: '{"error":"invalid_grant"}' }) });
    await expect(new YouTubeClient({ clientId: 'a', clientSecret: 'b' }, f).accessToken('RT')).rejects.toMatchObject({ revoked: true });
  });

  it('downloads captions as WebVTT that Orb.IT can parse, and reports refusals as null', async () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nwelcome to the show\n\n00:00:04.000 --> 00:00:07.000\ntoday we talk remote work\n';
    const ok = fakeFetch({ '/youtube/v3/captions/TRACK': () => ({ body: vtt }) });
    const text = await new YouTubeClient({}, ok.f).downloadCaption('TRACK', 'AT');
    expect(ok.calls[0]!.url).toContain('tfmt=vtt');
    const parsed = parseTextTranscript(text!, 'transcript');
    expect(parsed.timestampsGenuine).toBe(true);
    expect(parsed.segments[0]!.text).toBe('welcome to the show today we talk remote work');

    const denied = fakeFetch({ '/youtube/v3/captions/TRACK': () => ({ status: 403, body: 'forbidden' }) });
    expect(await new YouTubeClient({}, denied.f).downloadCaption('TRACK', 'AT')).toBeNull();
  });
});
