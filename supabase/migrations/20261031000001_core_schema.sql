-- Orb.IT core schema
-- Organisation > Brands > Shows > Episodes, with sources, transcripts, evidence,
-- briefs (versioned), review decisions, research tasks, jobs and audit events.
-- Every tenant-owned row carries org_id (and brand_id / show_id where relevant)
-- so row-level security can be evaluated without joins.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.member_role as enum (
  'org_admin',        -- users, policy, brand access
  'brand_editor',     -- standards and cross-brand sharing for a brand
  'show_editor',      -- approves editorial work for a show
  'producer',         -- plans episodes, ingests sources, drafts briefs
  'researcher',       -- sources and guest research
  'social_producer',  -- edits and exports media
  'commercial',       -- advertisers and sponsor proposals (restricted)
  'legal_reviewer',   -- receives escalations, specialist review
  'viewer'            -- read-only, cannot approve or publish
);

create type public.profile_status as enum ('draft', 'approved', 'superseded');
create type public.source_kind as enum ('recording', 'transcript', 'notes');
create type public.source_status as enum ('queued', 'processing', 'needs_attention', 'ready', 'failed');
create type public.rights_status as enum ('unknown', 'owned', 'licensed', 'permitted_reference', 'restricted');
create type public.share_scope as enum ('show', 'brand', 'organisation');

create type public.brief_status as enum (
  'discovered', 'researching', 'drafted', 'producer_review',
  'specialist_review', 'approved', 'scheduled', 'produced', 'closed',
  'rejected', 'archived'
);
create type public.evidence_verification as enum ('unverified', 'auto_matched', 'verified', 'failed');
create type public.evidence_kind as enum ('source_statement', 'reported_claim', 'inferred_theme', 'verified_fact');
create type public.review_check as enum ('fact', 'fairness', 'privacy', 'rights', 'language', 'commercial');
create type public.review_outcome as enum ('passed', 'failed', 'not_applicable');
create type public.task_status as enum ('open', 'in_progress', 'done', 'blocked');
create type public.job_kind as enum ('transcribe', 'analyse', 'generate_briefs');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Hierarchy
-- ---------------------------------------------------------------------------
create table public.organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  settings    jsonb not null default '{}'::jsonb,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create table public.brands (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  description text,
  languages   text[] not null default array['en']::text[],
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

create table public.shows (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  brand_id    uuid not null references public.brands(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  description text,
  current_profile_version_id uuid,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (brand_id, name)
);

create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  user_id     uuid not null,
  role        public.member_role not null,
  -- Scope: both null = whole organisation; brand only = that brand; show = that show.
  brand_id    uuid references public.brands(id) on delete cascade,
  show_id     uuid references public.shows(id) on delete cascade,
  created_at  timestamptz not null default now(),
  check (show_id is null or brand_id is not null),
  check (role <> 'org_admin' or (brand_id is null and show_id is null))
);
create unique index memberships_unique_scope
  on public.memberships (org_id, user_id, role,
                         coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
                         coalesce(show_id,  '00000000-0000-0000-0000-000000000000'::uuid));
create index memberships_user on public.memberships (user_id);

-- Display names for members (auth.users is not readable from the client).
create table public.profiles (
  user_id     uuid primary key,
  email       text,
  display_name text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Show profiles: the editorial contract. Versioned; only approved versions
-- drive generation. Inferred suggestions never overwrite approved fields.
-- ---------------------------------------------------------------------------
create table public.show_profile_versions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  brand_id    uuid not null references public.brands(id) on delete cascade,
  show_id     uuid not null references public.shows(id) on delete cascade,
  version     int  not null,
  status      public.profile_status not null default 'draft',
  profile     jsonb not null default '{}'::jsonb,
  change_note text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  unique (show_id, version)
);
alter table public.shows
  add constraint shows_current_profile_fk
  foreign key (current_profile_version_id) references public.show_profile_versions(id)
  on delete set null;

create table public.episodes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  brand_id    uuid not null references public.brands(id) on delete cascade,
  show_id     uuid not null references public.shows(id) on delete cascade,
  title       text not null,
  air_date    date,
  status      text not null default 'planned' check (status in ('planned', 'aired', 'cancelled')),
  brief_id    uuid,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sources, transcripts, analyses
-- ---------------------------------------------------------------------------
create table public.sources (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organisations(id) on delete cascade,
  brand_id        uuid not null references public.brands(id) on delete cascade,
  show_id         uuid references public.shows(id) on delete set null,
  episode_id      uuid references public.episodes(id) on delete set null,
  kind            public.source_kind not null,
  title           text not null,
  programme_name  text,                 -- originating programme as attributed
  origin_url      text,
  storage_path    text,                 -- object path in the private 'media' bucket
  mime_type       text,
  size_bytes      bigint,
  checksum_sha256 text,                 -- of the original bytes; originals are immutable
  duration_seconds numeric,
  language        text not null default 'en',      -- en | pcm (Pidgin) | mixed | tw (beta)
  twi_beta        boolean not null default false,
  rights_status   public.rights_status not null default 'unknown',
  rights_notes    text,
  share_scope     public.share_scope not null default 'brand',
  timestamps_genuine boolean not null default false,  -- false for pasted text without real times
  author          text,                 -- for transcripts/notes
  status          public.source_status not null default 'queued',
  status_message  text,
  uploaded_by     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index sources_org_checksum
  on public.sources (org_id, checksum_sha256) where checksum_sha256 is not null;
create index sources_org on public.sources (org_id, created_at desc);

create table public.transcript_segments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  source_id   uuid not null references public.sources(id) on delete cascade,
  idx         int  not null,
  start_ms    int,                      -- null when the source has no genuine timing
  end_ms      int,
  speaker     text,                     -- provider label (e.g. SPEAKER_1); identity is unverified
  text        text not null,
  confidence  real,
  is_uncertain boolean not null default false,
  version     int not null default 1,
  corrected_by uuid,
  corrected_at timestamptz,
  unique (source_id, idx),
  check (start_ms is null or end_ms is null or end_ms >= start_ms)
);

create table public.segment_corrections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  segment_id  uuid not null references public.transcript_segments(id) on delete cascade,
  previous_text text not null,
  new_text    text not null,
  previous_speaker text,
  new_speaker text,
  corrected_by uuid,
  created_at  timestamptz not null default now()
);

create table public.source_analyses (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  source_id      uuid not null references public.sources(id) on delete cascade,
  transcript_fingerprint text not null, -- hash of segment texts used; stale when it changes
  model          text not null,
  prompt_version text not null,
  result         jsonb not null,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Briefs (opportunities) — the core work product
-- ---------------------------------------------------------------------------
create table public.briefs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  brand_id         uuid not null references public.brands(id) on delete cascade,
  show_id          uuid not null references public.shows(id) on delete cascade,
  origin_source_id uuid references public.sources(id) on delete set null,
  generation_group uuid,                -- briefs generated together from one source
  title            text not null,
  status           public.brief_status not null default 'drafted',
  recommendation   text check (recommendation in ('proceed', 'research')),
  current_version_id uuid,
  assigned_to      uuid,
  decision_deadline date,
  evidence_changed_at timestamptz,      -- set when a cited transcript passage is corrected
  status_reason    text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index briefs_show on public.briefs (show_id, created_at desc);

create table public.brief_sources (
  brief_id   uuid not null references public.briefs(id) on delete cascade,
  source_id  uuid not null references public.sources(id) on delete cascade,
  org_id     uuid not null references public.organisations(id) on delete cascade,
  primary key (brief_id, source_id)
);

create table public.brief_versions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organisations(id) on delete cascade,
  brand_id           uuid not null references public.brands(id) on delete cascade,
  show_id            uuid not null references public.shows(id) on delete cascade,
  brief_id           uuid not null references public.briefs(id) on delete cascade,
  version            int  not null,
  content            jsonb not null,
  locked_sections    text[] not null default '{}',
  profile_version_id uuid references public.show_profile_versions(id) on delete set null,
  generated          boolean not null default false,
  model              text,
  prompt_version     text,
  validation         jsonb not null default '{}'::jsonb, -- deterministic validator report
  change_note        text,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  unique (brief_id, version)
);
alter table public.briefs
  add constraint briefs_current_version_fk
  foreign key (current_version_id) references public.brief_versions(id) on delete set null;
alter table public.episodes
  add constraint episodes_brief_fk
  foreign key (brief_id) references public.briefs(id) on delete set null;

create table public.evidence (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  brief_version_id uuid not null references public.brief_versions(id) on delete cascade,
  ref_key          text not null,       -- e.g. E1, cited inside version content
  source_id        uuid not null references public.sources(id) on delete cascade,
  segment_start    int not null,
  segment_end      int not null,
  start_ms         int,                 -- copied from segments, never from model output
  end_ms           int,
  quote            text,
  attribution      text,
  kind             public.evidence_kind not null default 'source_statement',
  verification     public.evidence_verification not null default 'unverified',
  note             text,
  verified_by      uuid,
  verified_at      timestamptz,
  unique (brief_version_id, ref_key),
  check (segment_end >= segment_start)
);
create index evidence_source on public.evidence (source_id, segment_start, segment_end);

create table public.review_decisions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  brief_id         uuid not null references public.briefs(id) on delete cascade,
  brief_version_id uuid not null references public.brief_versions(id) on delete cascade,
  check_key        public.review_check,  -- null for the final approval decision
  outcome          public.review_outcome,
  is_final_approval boolean not null default false,
  reviewer         uuid not null,
  reviewer_role    public.member_role not null,
  reason           text,
  conditions       text,
  created_at       timestamptz not null default now(),
  invalidated_at   timestamptz,
  invalidated_reason text
);
create index review_decisions_brief on public.review_decisions (brief_id, created_at desc);

create table public.research_tasks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  brief_id    uuid not null references public.briefs(id) on delete cascade,
  title       text not null,
  detail      text,
  owner_role  text,
  owner       uuid,
  due_date    date,
  blocking    boolean not null default false,
  status      public.task_status not null default 'open',
  origin      text not null default 'manual' check (origin in ('manual', 'generated', 'unresolved')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.brief_comments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  brief_id    uuid not null references public.briefs(id) on delete cascade,
  body        text not null check (length(trim(body)) > 0),
  author      uuid not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Durable jobs and audit
-- ---------------------------------------------------------------------------
create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organisations(id) on delete cascade,
  kind            public.job_kind not null,
  payload         jsonb not null default '{}'::jsonb,
  status          public.job_status not null default 'queued',
  idempotency_key text not null,
  attempts        int not null default 0,
  max_attempts    int not null default 3,
  progress        int not null default 0 check (progress between 0 and 100),
  message         text,
  error           text,
  result          jsonb,
  run_after       timestamptz not null default now(),
  locked_by       text,
  locked_at       timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index jobs_claim on public.jobs (status, run_after) where status = 'queued';

create table public.audit_events (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.organisations(id) on delete cascade,
  actor       uuid,
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_org on public.audit_events (org_id, created_at desc);
