# Deploying an instance for a client

Each client organisation gets its own Orb.IT instance on its own stack: its own Supabase project
(database, storage, auth), its own worker and its own web address. An instance serves exactly one
organisation; there is no organisation switching, and data never shares a database with another client.

## 1. Supabase project (client's account or ctrl.IT's, per contract)

1. Create a new project in the client's region.
2. SQL Editor → New query → paste `supabase/setup.sql` → Run.
3. Set the licensed modules (see [MODULES.md](MODULES.md)), for example:
   ```sql
   update instance_modules set enabled = false where key in ('youtube', 'recording_transcription');
   ```
4. Storage: raise the upload size limit if recordings will be uploaded (free plan caps at 50 MB).
5. Authentication → URL Configuration: set the Site URL to the client's web address. Decide on email
   confirmation and, if wanted, the client's SMTP so mails come from their domain.
6. Note the project URL, anon key (public) and service role key (secret — worker only).

## 2. Worker

Any host that keeps a process running (VPS, Railway, Fly.io, Render, client's server). Needs Node 22 and,
if recording transcription is licensed, ffmpeg. Or use `worker/Dockerfile`.

`worker/.env`:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...        # secret
ANTHROPIC_API_KEY=...                # client's key or ctrl.IT's, per contract
ANTHROPIC_WORKSPACE_ID=...           # only if the key is workspace-scoped
OPENAI_API_KEY=... / DEEPGRAM_API_KEY=...   # recording_transcription only
GOOGLE_CLIENT_ID=... / GOOGLE_CLIENT_SECRET=...   # youtube only
```

On start the worker logs which modules are on, off, or on-but-missing-configuration.

## 3. Web app

Vercel, Netlify or Cloudflare Pages, root directory `web`, build `npm run build`, output `dist`.
Environment:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_GOOGLE_CLIENT_ID=...            # youtube only
```

Point the client's domain at it (for example `orbit.clientname.com`). To ship without a module's code,
remove it from the build as described in MODULES.md.

## 4. First administrator

1. The client's lead signs up first and is asked to name the organisation. They become its administrator.
   This only works once: after that, `create_organisation` refuses.
2. Everyone else signs up and sees "ask an administrator to add you" until the administrator adds them
   under Organisation → People and roles with a role and scope.
3. The administrator adds brands and shows, then the profiles are filled in and approved.

## Checks before handover

- `select * from instance_status();` as the administrator shows the organisation.
- Organisation page lists the expected modules.
- Add a pasted transcript to a show and confirm analysis and a brief complete (worker log shows the jobs).
