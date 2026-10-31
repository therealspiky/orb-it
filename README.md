# Orb.IT by ctrl.IT

An editorial operating system for media organisations. A producer brings in a programme recording,
checks the transcript, and Orb.IT writes a complete opportunity brief for each show that can use it:
angle, fit with the show's approved profile, evidence that cites the exact passage, a timed rundown,
guest perspectives, a social plan, tasks and review checks. Editors approve specific versions;
Orb.IT never publishes on its own.

This repository is **Phase 1, the editorial spine**: hierarchy, permissions, ingestion, timed transcripts
with correction, evidence-checked brief generation, review and export. See [docs/STATUS.md](docs/STATUS.md)
for what is built against the product spec and what comes next.

```
web/       Producer app (React + Vite + TanStack + Tailwind), talks to Supabase with the user's session
worker/    Long-running job worker (Node 22 + ffmpeg): transcription, analysis, brief generation
supabase/  Database migrations (schema, row-level security, workflow functions) and tests
docs/      Architecture and status
```

## How it works

1. **Upload.** The browser fingerprints the file (SHA-256), creates a source record and uploads the original
   to a private storage bucket. Identical content is detected and refused as a duplicate.
2. **Transcribe.** The worker re-checks the fingerprint, probes the media with ffmpeg, and transcribes it with
   real timestamps (OpenAI `whisper-1`, or Deepgram `nova-3` with speaker separation). Pasted transcripts keep
   times only if the author's text genuinely has them. Low-confidence speech and all Twi passages are flagged.
3. **Correct.** Producers fix names and passages while listening. Each correction is versioned; any brief citing
   that passage has its evidence reset and any approval on it withdrawn.
4. **Analyse.** Claude Haiku extracts themes, claims (opinion vs. assertion vs. allegation), open questions,
   usable moments and sensitivities, all tied to transcript passages.
5. **Write briefs.** For each chosen show, Claude Sonnet writes a brief from that show's approved profile, its
   previous coverage, and the treatments already proposed for sister shows (so each one is different).
   Output must match a strict schema, then deterministic checks run before anything is saved:
   quotes must appear verbatim in the cited passage or they are removed; attributions must match speaker labels;
   times come from the transcript, never the model; rundowns must add up to the slot; named guests are replaced
   with roles; a brief with no surviving evidence is downgraded to "research first".
6. **Review.** Producers verify each citation by listening. Reviewers record fact, fairness, privacy, rights and
   language checks (and commercial, when flagged) against one version. An editor approves only when every gate
   is clear. Any edit creates a new version and withdraws earlier checks and approval.
7. **Export.** Markdown or JSON, including evidence, verification state, uncertainty and review decisions.

## Setup

You need a Supabase project, an Anthropic API key, and an OpenAI or Deepgram key.

### 1. Database

```bash
npm install -g supabase            # or use npx supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push                   # applies supabase/migrations/*
```

In the Supabase dashboard:
- **Storage:** the `media` bucket is created by the migrations. For long recordings raise the
  global upload size limit (Settings > Storage); the free plan caps uploads at 50 MB.
- **Auth:** email/password is used. Decide whether new sign-ups need email confirmation.

### 2. Worker

```bash
cd worker
cp .env.example .env               # fill in Supabase URL + service role key, Anthropic and OpenAI/Deepgram keys
npm install
npm start                          # needs ffmpeg on PATH
```

Or build the container: `docker build -t orbit-worker worker/` and run it with the same environment
on any host that keeps a process running (a VPS, Railway, Fly.io, Render, or your Mac during development).
Run more than one worker for throughput; jobs are claimed with `SKIP LOCKED`.

The service role key bypasses row-level security. It belongs only on the worker host, never in the web app.

### 3. Web app

```bash
cd web
cp .env.example .env.local         # Supabase URL + anon key
npm install
npm run dev                        # http://localhost:5173
```

Deploy `web/` to any static host (Vercel, Netlify, Cloudflare Pages) with the same two variables.

### 4. First run

1. Create an account and your organisation. You become its administrator.
2. Add brands and shows. Ask colleagues to sign up, then add them with a role and scope.
3. Fill in and approve each show's profile (episode length, tone, audience, boundaries).
4. Add a recording, wait for the transcript, correct uncertain passages.
5. Choose destination shows and write briefs.

## Tests

```bash
supabase/tests/run.sh              # 45 database checks on a throwaway PostgreSQL 16
cd worker && npm test              # 31 tests: validation, parsing, provider mapping, ffmpeg pipeline
cd web && npm run build            # typecheck + production build
```

The database suite covers tenant isolation, scoped roles, source sharing scope, immutable source
fingerprints, idempotent jobs, version-bound approval, and approval withdrawal after edits and source corrections.

## Costs (planning figures, October 2026 list prices)

Per programme hour, writing three briefs: transcription about $0.27–0.36, Haiku extraction about $0.01,
Sonnet briefs about $0.25 (less with prompt caching, which the worker uses for the transcript).
Roughly $0.55–0.75 per hour of source in total. Supabase Pro is $25/month plus compute.
