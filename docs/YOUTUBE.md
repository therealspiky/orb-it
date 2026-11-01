# YouTube import

Orb.IT uses YouTube's official endpoints only.

| You paste a YouTube link and… | What happens |
|---|---|
| also paste or upload the transcript | The transcript is used straight away; the title, channel, date, duration, description and thumbnail are filled in from YouTube. |
| leave the transcript empty, and the video's channel **is connected** | Orb.IT downloads the channel's captions (its own uploaded captions first, then YouTube's auto-generated ones) through the YouTube Data API and processes them with their real timings. |
| leave the transcript empty, and the channel **is not connected** | Details are filled in and the source waits; paste the transcript on the source page to continue. |

Video details work for any public video. Without an API key, Orb.IT gets the title, channel and thumbnail from
YouTube's oEmbed endpoint; with a key (or once any channel is connected) it also gets the date, duration and description.

## One-time Google Cloud setup (about 15 minutes)

1. Go to **console.cloud.google.com**, create a project named *Orb.IT*.
2. **APIs & Services → Library**: enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**; app name *Orb.IT*; support email; your domain if you have one.
   - **Data access / Scopes**: add `https://www.googleapis.com/auth/youtube.force-ssl`
     (the narrowest scope YouTube accepts for downloading caption tracks).
   - **Audience / Test users**: add the Google accounts that manage your YouTube channels.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorised redirect URIs**: `http://localhost:5173/integrations/youtube` and, once deployed,
     `https://YOUR-APP-DOMAIN/integrations/youtube`.
   - Copy the **Client ID** and **Client secret**.
5. **Credentials → Create credentials → API key**, then **Edit → API restrictions → Restrict key → YouTube Data API v3**.

## Configure Orb.IT

Worker (`worker/.env`, never in the web app):

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
YOUTUBE_API_KEY=…
```

Web app (`web/.env.development` and `web/.env.production`, or your host's environment settings):

```
VITE_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
```

The client ID is public by design; the secret stays on the worker. Restart the worker and the web dev server.
The worker's start-up line shows `"youtube":{"connect":true,"apiKey":true}` when both are set.

## Connect a channel

Organisation → **YouTube channels → Connect a YouTube channel** (organisation admins and brand editors).
Sign in with the Google account that manages the channel; if it manages several (for example a brand account per
station), pick the channel when Google asks. Repeat for each channel. Orb.IT stores the refresh token in a table the
app cannot read; only the worker uses it.

## Limits to know

- **Testing mode tokens expire after 7 days.** While the consent screen's publishing status is *Testing*, Google
  revokes refresh tokens after a week, and the channel shows "Needs reconnecting". For production, set the app to
  *In production* and complete Google's verification for the `youtube.force-ssl` scope (privacy policy, demo video;
  typically a few days to a few weeks).
- **Only your own channels' captions.** YouTube lets a channel's owner or managers download its captions; other
  channels' videos still get details, and their transcripts are pasted.
- **Auto-generated captions** are downloaded when YouTube permits; if it refuses, the source asks for a pasted transcript.
- **Quota.** The default is 10,000 units a day. One import with captions costs about 251 units (video details 1,
  caption list 50, caption download 200), so about 39 imports a day. Request more under
  **APIs & Services → YouTube Data API v3 → Quotas** when you go live.
