import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { audit, getSource, jobProgress, setSourceStatus, type Db } from '../lib/db.js';
import { chooseCaptionTrack, parseVideoId, YouTubeClient } from '../lib/youtube.js';
import { PermanentError, type JobRow } from '../types.js';

export interface YouTubeDeps { db: Db; cfg: Config; yt: YouTubeClient }

export function makeYouTube(cfg: Config) {
  return new YouTubeClient({ clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, apiKey: cfg.youtubeApiKey });
}

/** Exchanges the one-time OAuth code from the browser for a stored refresh token. */
export async function runYouTubeConnect(job: JobRow, { db, yt }: YouTubeDeps): Promise<Record<string, unknown>> {
  const pendingId = String(job.payload.pending_id ?? '');
  const p = await db.from('oauth_pending').select('*').eq('id', pendingId).maybeSingle();
  if (!p.data) throw new PermanentError('This sign-in has expired; connect the channel again.');
  // The code is single-use: remove it whatever happens next.
  await db.from('oauth_pending').delete().eq('id', pendingId);
  if (p.data.org_id !== job.org_id) throw new PermanentError('Sign-in belongs to another organisation');

  const tokens = await yt.exchangeCode(p.data.code, p.data.redirect_uri);
  if (!tokens.refresh_token) {
    throw new PermanentError('Google did not grant offline access. Remove Orb.IT from your Google account permissions and connect again.');
  }
  const channels = await yt.myChannels(tokens.access_token);
  if (!channels.length) throw new PermanentError('That Google account has no YouTube channel. Choose the channel account when signing in.');

  const connected: string[] = [];
  for (const c of channels) {
    const up = await db.from('youtube_connections').upsert({
      org_id: job.org_id, channel_id: c.id, channel_title: c.title, channel_thumb: c.thumb,
      status: 'active', error: null, connected_by: p.data.created_by, updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,channel_id' }).select('id').single();
    if (up.error) throw new Error(`save connection: ${up.error.message}`);
    const cred = await db.from('youtube_credentials').upsert({
      connection_id: up.data.id, refresh_token: tokens.refresh_token, scope: tokens.scope ?? null, updated_at: new Date().toISOString(),
    });
    if (cred.error) throw new Error(`save credentials: ${cred.error.message}`);
    connected.push(c.title);
    await audit(db, job.org_id, 'youtube.connected', 'youtube_connection', up.data.id, { channel: c.id, title: c.title });
  }
  return { channels: connected };
}

async function connectionToken(db: Db, yt: YouTubeClient, orgId: string, channelId: string | null) {
  let q = db.from('youtube_connections').select('id,channel_id,channel_title').eq('org_id', orgId).eq('status', 'active');
  if (channelId) q = q.eq('channel_id', channelId);
  const conn = (await q.limit(1).maybeSingle()).data as { id: string; channel_id: string; channel_title: string } | null;
  if (!conn || !yt.canAuthorise) return null;
  const cred = (await db.from('youtube_credentials').select('refresh_token').eq('connection_id', conn.id).maybeSingle()).data;
  if (!cred) return null;
  try {
    return { conn, token: await yt.accessToken(cred.refresh_token as string) };
  } catch (e) {
    if ((e as { revoked?: boolean }).revoked) {
      await db.from('youtube_connections').update({ status: 'error', error: (e as Error).message, updated_at: new Date().toISOString() }).eq('id', conn.id);
      return null;
    }
    throw e;
  }
}

/**
 * Imports a YouTube link: fills in the video's details and, when the channel is
 * connected and no transcript was supplied, fetches its captions through the
 * official API and hands them to transcription. Otherwise the source waits for
 * a pasted transcript.
 */
export async function runYouTubeImport(job: JobRow, { db, yt }: YouTubeDeps): Promise<Record<string, unknown>> {
  const src = await getSource(db, String(job.payload.source_id ?? ''));
  if (src.org_id !== job.org_id) throw new PermanentError('Source belongs to another organisation');
  const videoId = parseVideoId(src.origin_url);
  if (!videoId) throw new PermanentError('The origin link is not a YouTube video link');
  const wantCaptions = job.payload.fetch_captions === true && !src.storage_path;

  if (wantCaptions) await setSourceStatus(db, src.id, 'processing', 'Reading YouTube details');
  await jobProgress(db, job.id, 10, 'Reading YouTube details');

  // Metadata: API key if configured, else any connected channel's token, else oEmbed.
  const anyToken = yt.apiKeyConfigured ? null : await connectionToken(db, yt, src.org_id, null);
  const meta = await yt.videoMeta(videoId, anyToken?.token);

  const patch: Record<string, unknown> = { external: meta };
  if (job.payload.fill_title === true) patch.title = meta.title.slice(0, 300);
  if (!src.programme_name && meta.channel_title) patch.programme_name = meta.channel_title;
  if (meta.duration_seconds && !src.duration_seconds && !src.storage_path) patch.duration_seconds = meta.duration_seconds;
  const upd = await db.from('sources').update(patch).eq('id', src.id);
  if (upd.error) throw new Error(`update source: ${upd.error.message}`);

  if (!wantCaptions) return { video_id: videoId, metadata: meta.metadata_source, captions: 'not requested' };

  const waitForPaste = async (why: string) => {
    await setSourceStatus(db, src.id, 'needs_attention', `${why} Paste the transcript on this page to continue.`);
    return { video_id: videoId, metadata: meta.metadata_source, captions: why };
  };

  await jobProgress(db, job.id, 40, 'Looking for captions');
  const auth = meta.channel_id ? await connectionToken(db, yt, src.org_id, meta.channel_id) : null;
  if (!auth) {
    return waitForPaste(meta.channel_id
      ? `${meta.channel_title ?? 'This channel'} is not connected to Orb.IT, so its captions cannot be fetched.`
      : 'Video details were found, but captions need a connected channel.');
  }
  const tracks = await yt.listCaptions(videoId, auth.token);
  const track = chooseCaptionTrack(tracks, src.language === 'tw' ? 'tw' : 'en');
  if (!track) return waitForPaste('This video has no captions on YouTube yet.');
  const vtt = await yt.downloadCaption(track.id, auth.token);
  if (!vtt || !/-->/.test(vtt)) return waitForPaste('YouTube did not allow these captions to be downloaded.');

  const bytes = Buffer.from(vtt, 'utf8');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const dup = (await db.from('sources').select('id,title').eq('org_id', src.org_id).eq('checksum_sha256', checksum).neq('id', src.id).maybeSingle()).data;
  if (dup) return waitForPaste(`These captions were already imported as "${dup.title}".`);

  const path = `${src.org_id}/${src.id}/youtube-${track.trackKind.toLowerCase() === 'asr' ? 'auto-' : ''}captions.vtt`;
  const up = await db.storage.from('media').upload(path, bytes, { contentType: 'text/vtt', upsert: false });
  if (up.error) throw new Error(`store captions: ${up.error.message}`);
  const att = await db.from('sources').update({
    storage_path: path, checksum_sha256: checksum, size_bytes: bytes.length, mime_type: 'text/vtt',
    status: 'queued', status_message: `Captions imported from YouTube (${track.trackKind.toLowerCase() === 'asr' ? 'auto-generated' : track.name || 'manual'}, ${track.language})`,
    external: { ...meta, caption_track: { kind: track.trackKind, language: track.language, name: track.name } },
  }).eq('id', src.id);
  if (att.error) throw new Error(`attach captions: ${att.error.message}`);
  await db.from('jobs').upsert({
    org_id: src.org_id, kind: 'transcribe', payload: { source_id: src.id }, idempotency_key: `transcribe:${src.id}`, created_by: job.created_by,
  }, { onConflict: 'org_id,idempotency_key', ignoreDuplicates: true });
  await audit(db, src.org_id, 'source.youtube_captions', 'source', src.id, { video: videoId, track: track.trackKind, language: track.language });
  return { video_id: videoId, metadata: meta.metadata_source, captions: track.trackKind, language: track.language };
}
