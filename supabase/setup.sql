-- Orb.IT database setup: all migrations in order. Paste into Supabase > SQL Editor > New query, then Run.
-- Generated from supabase/migrations/. Safe to run once on a new project.

-- ===== 20261031000001_core_schema.sql =====
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

-- ===== 20261031000002_access_control.sql =====
-- Orb.IT access control: scoped role helpers, row-level security, guard triggers.
-- Authorisation lives here and in the RPCs (migration 3), never in model output.

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
create or replace function public.editor_roles() returns public.member_role[]
language sql immutable as $$
  select array['org_admin','brand_editor','show_editor']::public.member_role[]
$$;

create or replace function public.work_roles() returns public.member_role[]
language sql immutable as $$
  select array['org_admin','brand_editor','show_editor','producer','researcher','social_producer']::public.member_role[]
$$;

create or replace function public.reviewer_roles() returns public.member_role[]
language sql immutable as $$
  select array['org_admin','brand_editor','show_editor','producer','researcher','legal_reviewer']::public.member_role[]
$$;

create or replace function public.all_roles() returns public.member_role[]
language sql immutable as $$
  select enum_range(null::public.member_role)
$$;

create or replace function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid()
  )
$$;

-- True when the caller holds one of p_roles with a scope covering (brand, show).
-- Org-wide membership covers everything; brand membership covers the brand and
-- all of its shows; show membership covers only that show.
create or replace function public.has_scope(
  p_org uuid, p_brand uuid, p_show uuid, p_roles public.member_role[]
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.role = any(p_roles)
      and (m.brand_id is null or m.brand_id = p_brand)
      and (m.show_id  is null or m.show_id  = p_show)
  )
$$;

-- True when the caller has any membership touching the brand (org, brand or one of its shows).
create or replace function public.touches_brand(p_org uuid, p_brand uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.org_id = p_org and m.user_id = auth.uid()
      and (m.brand_id is null or m.brand_id = p_brand)
  )
$$;

-- Highest-authority role the caller holds for a scope (used to record reviewer role).
create or replace function public.best_role(p_org uuid, p_brand uuid, p_show uuid, p_roles public.member_role[])
returns public.member_role
language sql stable security definer set search_path = public as $$
  select m.role from memberships m
  where m.org_id = p_org and m.user_id = auth.uid() and m.role = any(p_roles)
    and (m.brand_id is null or m.brand_id = p_brand)
    and (m.show_id  is null or m.show_id  = p_show)
  order by array_position(enum_range(null::public.member_role), m.role)
  limit 1
$$;

-- Source visibility honours share scope: show-scoped sources stay with their show,
-- brand-scoped with their brand, organisation-scoped are visible to all members.
create or replace function public.can_read_source(p_source uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sources s
    where s.id = p_source and (
      public.has_scope(s.org_id, s.brand_id, s.show_id, public.all_roles())
      or (s.share_scope = 'organisation' and public.is_member(s.org_id))
      or (s.share_scope in ('brand') and public.touches_brand(s.org_id, s.brand_id))
      or (s.share_scope = 'show' and s.show_id is null and public.touches_brand(s.org_id, s.brand_id))
    )
  )
$$;

create or replace function public.can_edit_source(p_source uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sources s
    where s.id = p_source
      and public.has_scope(s.org_id, s.brand_id, s.show_id, public.work_roles())
  )
$$;

create or replace function public.can_read_brief(p_brief uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from briefs b
    where b.id = p_brief and public.has_scope(b.org_id, b.brand_id, b.show_id, public.all_roles())
  )
$$;

create or replace function public.can_work_brief(p_brief uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from briefs b
    where b.id = p_brief and public.has_scope(b.org_id, b.brand_id, b.show_id, public.work_roles())
  )
$$;

-- ---------------------------------------------------------------------------
-- Guard triggers: protected columns can only change through the RPCs
-- (security definer, run as the owner) or the service-role worker.
-- ---------------------------------------------------------------------------
create or replace function public.is_privileged() returns boolean
language sql stable as $$
  select current_user not in ('authenticated', 'anon')
$$;

create or replace function public.guard_brief_update() returns trigger
language plpgsql as $$
begin
  if not public.is_privileged() then
    if new.status is distinct from old.status
       or new.current_version_id is distinct from old.current_version_id
       or new.evidence_changed_at is distinct from old.evidence_changed_at
       or new.org_id <> old.org_id or new.brand_id <> old.brand_id or new.show_id <> old.show_id
       or new.origin_source_id is distinct from old.origin_source_id then
      raise exception 'Use the workflow functions to change brief status, versions or ownership'
        using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger briefs_guard before update on public.briefs
  for each row execute function public.guard_brief_update();

create or replace function public.guard_source_update() returns trigger
language plpgsql as $$
begin
  if not public.is_privileged() then
    if new.status is distinct from old.status
       or new.storage_path is distinct from old.storage_path
       or new.checksum_sha256 is distinct from old.checksum_sha256
       or new.timestamps_genuine is distinct from old.timestamps_genuine
       or new.duration_seconds is distinct from old.duration_seconds
       or new.org_id <> old.org_id or new.kind <> old.kind then
      raise exception 'Source identity, media and processing state are immutable for users'
        using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger sources_guard before update on public.sources
  for each row execute function public.guard_source_update();

create or replace function public.guard_source_insert() returns trigger
language plpgsql as $$
begin
  if not public.is_privileged() then
    new.status := 'queued';
    new.timestamps_genuine := false;
    new.duration_seconds := null;
    new.uploaded_by := auth.uid();
  end if;
  return new;
end $$;
create trigger sources_guard_insert before insert on public.sources
  for each row execute function public.guard_source_insert();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.organisations        enable row level security;
alter table public.brands               enable row level security;
alter table public.shows                enable row level security;
alter table public.memberships          enable row level security;
alter table public.profiles             enable row level security;
alter table public.show_profile_versions enable row level security;
alter table public.episodes             enable row level security;
alter table public.sources              enable row level security;
alter table public.transcript_segments  enable row level security;
alter table public.segment_corrections  enable row level security;
alter table public.source_analyses      enable row level security;
alter table public.briefs               enable row level security;
alter table public.brief_sources        enable row level security;
alter table public.brief_versions       enable row level security;
alter table public.evidence             enable row level security;
alter table public.review_decisions     enable row level security;
alter table public.research_tasks       enable row level security;
alter table public.brief_comments       enable row level security;
alter table public.jobs                 enable row level security;
alter table public.audit_events         enable row level security;

-- Organisations
create policy org_select on public.organisations for select to authenticated
  using (public.is_member(id));
create policy org_update on public.organisations for update to authenticated
  using (public.has_scope(id, null, null, array['org_admin']::public.member_role[]))
  with check (public.has_scope(id, null, null, array['org_admin']::public.member_role[]));

-- Brands
create policy brands_select on public.brands for select to authenticated
  using (public.is_member(org_id));
create policy brands_insert on public.brands for insert to authenticated
  with check (public.has_scope(org_id, null, null, array['org_admin']::public.member_role[]));
create policy brands_update on public.brands for update to authenticated
  using (public.has_scope(org_id, id, null, array['org_admin','brand_editor']::public.member_role[]))
  with check (public.has_scope(org_id, id, null, array['org_admin','brand_editor']::public.member_role[]));

-- Shows
create policy shows_select on public.shows for select to authenticated
  using (public.is_member(org_id));
create policy shows_insert on public.shows for insert to authenticated
  with check (public.has_scope(org_id, brand_id, null, array['org_admin','brand_editor']::public.member_role[])
              and current_profile_version_id is null);
create policy shows_update on public.shows for update to authenticated
  using (public.has_scope(org_id, brand_id, null, array['org_admin','brand_editor']::public.member_role[]))
  with check (public.has_scope(org_id, brand_id, null, array['org_admin','brand_editor']::public.member_role[]));

-- Memberships: visible to members of the org; changed only by org admins.
create policy memberships_select on public.memberships for select to authenticated
  using (public.is_member(org_id));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (public.has_scope(org_id, null, null, array['org_admin']::public.member_role[]));
create policy memberships_delete on public.memberships for delete to authenticated
  using (public.has_scope(org_id, null, null, array['org_admin']::public.member_role[])
         and not (user_id = auth.uid() and role = 'org_admin'));

-- Profiles: own row, plus people who share an organisation.
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from public.memberships a join public.memberships b on a.org_id = b.org_id
    where a.user_id = auth.uid() and b.user_id = profiles.user_id));
create policy profiles_upsert on public.profiles for insert to authenticated
  with check (user_id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Show profiles: members read; work roles edit drafts; approval only via RPC.
create policy spv_select on public.show_profile_versions for select to authenticated
  using (public.is_member(org_id));
create policy spv_update_draft on public.show_profile_versions for update to authenticated
  using (status = 'draft' and public.has_scope(org_id, brand_id, show_id, public.work_roles()))
  with check (status = 'draft' and approved_by is null and approved_at is null
              and public.has_scope(org_id, brand_id, show_id, public.work_roles()));
create policy spv_delete_draft on public.show_profile_versions for delete to authenticated
  using (status = 'draft' and public.has_scope(org_id, brand_id, show_id, public.work_roles()));

-- Episodes
create policy episodes_select on public.episodes for select to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.all_roles()));
create policy episodes_write on public.episodes for insert to authenticated
  with check (public.has_scope(org_id, brand_id, show_id, public.work_roles()));
create policy episodes_update on public.episodes for update to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.work_roles()))
  with check (public.has_scope(org_id, brand_id, show_id, public.work_roles()));

-- Sources
create policy sources_select on public.sources for select to authenticated
  using (public.can_read_source(id));
create policy sources_insert on public.sources for insert to authenticated
  with check (public.has_scope(org_id, brand_id, show_id, public.work_roles()));
create policy sources_update on public.sources for update to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.work_roles()))
  with check (public.has_scope(org_id, brand_id, show_id, public.work_roles()));

-- Transcripts: read with the source; corrections only through correct_segment().
create policy segments_select on public.transcript_segments for select to authenticated
  using (public.can_read_source(source_id));
create policy corrections_select on public.segment_corrections for select to authenticated
  using (exists (select 1 from public.transcript_segments t
                 where t.id = segment_id and public.can_read_source(t.source_id)));
create policy analyses_select on public.source_analyses for select to authenticated
  using (public.can_read_source(source_id));

-- Briefs
create policy briefs_select on public.briefs for select to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.all_roles()));
create policy briefs_update on public.briefs for update to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.work_roles()))
  with check (public.has_scope(org_id, brand_id, show_id, public.work_roles()));
create policy brief_sources_select on public.brief_sources for select to authenticated
  using (public.can_read_brief(brief_id));
create policy brief_versions_select on public.brief_versions for select to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.all_roles()));
create policy evidence_select on public.evidence for select to authenticated
  using (exists (select 1 from public.brief_versions v
                 where v.id = brief_version_id
                   and public.has_scope(v.org_id, v.brand_id, v.show_id, public.all_roles())));
create policy reviews_select on public.review_decisions for select to authenticated
  using (public.can_read_brief(brief_id));

create policy tasks_select on public.research_tasks for select to authenticated
  using (public.can_read_brief(brief_id));
create policy tasks_insert on public.research_tasks for insert to authenticated
  with check (public.can_work_brief(brief_id) and origin = 'manual');
create policy tasks_update on public.research_tasks for update to authenticated
  using (public.can_work_brief(brief_id)) with check (public.can_work_brief(brief_id));
create policy tasks_delete on public.research_tasks for delete to authenticated
  using (public.can_work_brief(brief_id) and origin = 'manual');

create policy comments_select on public.brief_comments for select to authenticated
  using (public.can_read_brief(brief_id));
create policy comments_insert on public.brief_comments for insert to authenticated
  with check (author = auth.uid() and public.can_read_brief(brief_id)
              and exists (select 1 from public.briefs b where b.id = brief_id
                          and public.has_scope(b.org_id, b.brand_id, b.show_id,
                              public.work_roles() || public.reviewer_roles())));

-- Jobs: members of the organisation can follow job state; enqueue via RPC only.
create policy jobs_select on public.jobs for select to authenticated
  using (public.is_member(org_id));

-- Audit: organisation admins and editors.
create policy audit_select on public.audit_events for select to authenticated
  using (public.has_scope(org_id, null, null, array['org_admin']::public.member_role[])
         or exists (select 1 from public.memberships m where m.org_id = audit_events.org_id
                    and m.user_id = auth.uid() and m.role in ('brand_editor','show_editor','legal_reviewer')));

-- ===== 20261031000003_workflow.sql =====
-- Orb.IT workflow functions. All run as security definer with explicit,
-- server-side authorisation checks, and write audit events.

create or replace function public.log_audit(
  p_org uuid, p_action text, p_entity text, p_entity_id uuid, p_detail jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into audit_events (org_id, actor, action, entity, entity_id, detail)
  values (p_org, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb));
$$;
revoke execute on function public.log_audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.log_audit(uuid, text, text, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Organisation setup and membership
-- ---------------------------------------------------------------------------
create or replace function public.create_organisation(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  insert into organisations (name, created_by) values (p_name, auth.uid()) returning id into v_org;
  insert into memberships (org_id, user_id, role) values (v_org, auth.uid(), 'org_admin');
  perform log_audit(v_org, 'organisation.created', 'organisation', v_org, jsonb_build_object('name', p_name));
  return v_org;
end $$;

-- Adds an existing Orb.IT user (they must have signed up) to an organisation.
create or replace function public.add_member(
  p_org uuid, p_email text, p_role public.member_role, p_brand uuid default null, p_show uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_id uuid;
begin
  if not has_scope(p_org, null, null, array['org_admin']::member_role[]) then
    raise exception 'Only organisation administrators can add members' using errcode = '42501';
  end if;
  select user_id into v_user from profiles where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No Orb.IT account for %; ask them to sign up first', p_email using errcode = 'P0002';
  end if;
  if p_show is not null then
    select brand_id into p_brand from shows where id = p_show and org_id = p_org;
    if p_brand is null then raise exception 'Show not in this organisation'; end if;
  elsif p_brand is not null and not exists (select 1 from brands where id = p_brand and org_id = p_org) then
    raise exception 'Brand not in this organisation';
  end if;
  insert into memberships (org_id, user_id, role, brand_id, show_id)
  values (p_org, v_user, p_role, p_brand, p_show) returning id into v_id;
  perform log_audit(p_org, 'membership.added', 'membership', v_id,
    jsonb_build_object('user', v_user, 'role', p_role, 'brand', p_brand, 'show', p_show));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Show profiles
-- ---------------------------------------------------------------------------
create or replace function public.create_profile_draft(p_show uuid, p_profile jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare s shows; v_id uuid; v_next int;
begin
  select * into s from shows where id = p_show;
  if s.id is null or not has_scope(s.org_id, s.brand_id, s.id, work_roles()) then
    raise exception 'Not permitted to edit this show profile' using errcode = '42501';
  end if;
  select coalesce(max(version), 0) + 1 into v_next from show_profile_versions where show_id = p_show;
  insert into show_profile_versions (org_id, brand_id, show_id, version, status, profile, change_note, created_by)
  values (s.org_id, s.brand_id, s.id, v_next, 'draft', coalesce(p_profile, '{}'::jsonb), p_note, auth.uid())
  returning id into v_id;
  perform log_audit(s.org_id, 'profile.draft_created', 'show_profile_version', v_id,
    jsonb_build_object('show', s.id, 'version', v_next));
  return v_id;
end $$;

create or replace function public.approve_profile(p_version uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v show_profile_versions;
begin
  select * into v from show_profile_versions where id = p_version for update;
  if v.id is null then raise exception 'Profile version not found'; end if;
  if not has_scope(v.org_id, v.brand_id, v.show_id, editor_roles()) then
    raise exception 'Only show, brand or organisation editors can approve a profile' using errcode = '42501';
  end if;
  if v.status <> 'draft' then raise exception 'Only draft profiles can be approved'; end if;
  update show_profile_versions set status = 'superseded'
    where show_id = v.show_id and status = 'approved';
  update show_profile_versions set status = 'approved', approved_by = auth.uid(), approved_at = now()
    where id = v.id;
  update shows set current_profile_version_id = v.id where id = v.show_id;
  perform log_audit(v.org_id, 'profile.approved', 'show_profile_version', v.id,
    jsonb_build_object('show', v.show_id, 'version', v.version));
end $$;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
-- Enqueue is idempotent per (org, idempotency_key): repeating a request returns the
-- existing job instead of creating duplicate work.
create or replace function public.enqueue_job(
  p_org uuid, p_kind public.job_kind, p_payload jsonb, p_idempotency_key text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_source uuid; v_show uuid; s sources; sh shows;
begin
  if not is_member(p_org) then raise exception 'Not a member' using errcode = '42501'; end if;
  v_source := nullif(p_payload->>'source_id', '')::uuid;
  if v_source is not null then
    select * into s from sources where id = v_source and org_id = p_org;
    if s.id is null or not can_read_source(s.id) then
      raise exception 'Source not available to you' using errcode = '42501';
    end if;
  end if;

  if p_kind in ('transcribe', 'analyse') then
    if s.id is null or not can_edit_source(s.id) then
      raise exception 'Not permitted to process this source' using errcode = '42501';
    end if;
  elsif p_kind = 'generate_briefs' then
    if s.id is null then raise exception 'generate_briefs needs source_id'; end if;
    if jsonb_typeof(p_payload->'show_ids') <> 'array' or jsonb_array_length(p_payload->'show_ids') = 0 then
      raise exception 'Choose at least one destination show';
    end if;
    for v_show in select (jsonb_array_elements_text(p_payload->'show_ids'))::uuid loop
      select * into sh from shows where id = v_show and org_id = p_org and archived_at is null;
      if sh.id is null then raise exception 'Show % not found', v_show; end if;
      if not has_scope(p_org, sh.brand_id, sh.id, work_roles()) then
        raise exception 'Not permitted to create briefs for %', sh.name using errcode = '42501';
      end if;
      if sh.current_profile_version_id is null then
        raise exception '% has no approved show profile yet', sh.name;
      end if;
      -- Cross-brand use must respect the source's sharing scope.
      if not (s.share_scope = 'organisation'
              or (s.share_scope = 'brand' and s.brand_id = sh.brand_id)
              or (s.share_scope = 'show' and (s.show_id = sh.id or (s.show_id is null and s.brand_id = sh.brand_id)))) then
        raise exception 'Source sharing scope does not allow use for %', sh.name using errcode = '42501';
      end if;
    end loop;
  end if;

  insert into jobs (org_id, kind, payload, idempotency_key, created_by)
  values (p_org, p_kind, coalesce(p_payload, '{}'::jsonb), p_idempotency_key, auth.uid())
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from jobs where org_id = p_org and idempotency_key = p_idempotency_key;
  else
    perform log_audit(p_org, 'job.enqueued', 'job', v_id, jsonb_build_object('kind', p_kind, 'payload', p_payload));
  end if;
  return v_id;
end $$;

-- Worker-only: claim the next runnable job with SKIP LOCKED.
create or replace function public.claim_job(p_worker text) returns public.jobs
language plpgsql security definer set search_path = public as $$
declare j jobs;
begin
  -- Recover jobs whose worker died (no heartbeat for 15 minutes).
  update jobs set status = 'queued', locked_by = null, locked_at = null,
         message = 'Re-queued after worker timeout'
   where status = 'running' and locked_at < now() - interval '15 minutes';

  select * into j from jobs
   where status = 'queued' and run_after <= now()
   order by created_at
   for update skip locked
   limit 1;
  if j.id is null then return null; end if;
  update jobs set status = 'running', attempts = attempts + 1, locked_by = p_worker,
         locked_at = now(), updated_at = now(), error = null
   where id = j.id returning * into j;
  return j;
end $$;
revoke execute on function public.claim_job(text) from public, anon, authenticated;
grant execute on function public.claim_job(text) to service_role;

create or replace function public.cancel_job(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare j jobs;
begin
  select * into j from jobs where id = p_job;
  if j.id is null or not (j.created_by = auth.uid()
     or has_scope(j.org_id, null, null, array['org_admin']::member_role[])) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  update jobs set status = 'cancelled', updated_at = now(), message = 'Cancelled by user'
   where id = p_job and status in ('queued', 'failed');
end $$;

-- ---------------------------------------------------------------------------
-- Transcript correction: versioned, and propagated to dependent evidence,
-- briefs and approvals so a corrected quote cannot leave an approval standing.
-- ---------------------------------------------------------------------------
create or replace function public.correct_segment(
  p_segment uuid, p_text text, p_speaker text default null
) returns void language plpgsql security definer set search_path = public as $$
declare t transcript_segments; v_brief record;
begin
  select * into t from transcript_segments where id = p_segment for update;
  if t.id is null then raise exception 'Segment not found'; end if;
  if not can_edit_source(t.source_id) then
    raise exception 'Not permitted to correct this transcript' using errcode = '42501';
  end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'Text cannot be empty'; end if;
  if p_text = t.text and p_speaker is not distinct from t.speaker then return; end if;

  insert into segment_corrections (org_id, segment_id, previous_text, new_text,
                                   previous_speaker, new_speaker, corrected_by)
  values (t.org_id, t.id, t.text, p_text, t.speaker, p_speaker, auth.uid());
  update transcript_segments
     set text = p_text, speaker = p_speaker, version = version + 1,
         corrected_by = auth.uid(), corrected_at = now(), is_uncertain = false
   where id = t.id;

  -- Evidence citing this passage must be re-verified.
  update evidence set verification = 'unverified', verified_by = null, verified_at = null,
         note = coalesce(note || ' ', '') || '[Source passage corrected ' || to_char(now(), 'YYYY-MM-DD') || ']'
   where source_id = t.source_id and t.idx between segment_start and segment_end;

  -- Briefs whose current version cites it: flag, invalidate approvals, pull back from approved.
  for v_brief in
    select distinct b.id, b.org_id, b.status
      from briefs b
      join evidence e on e.brief_version_id = b.current_version_id
     where e.source_id = t.source_id and t.idx between e.segment_start and e.segment_end
  loop
    update review_decisions set invalidated_at = now(),
           invalidated_reason = 'Cited source passage was corrected'
     where brief_id = v_brief.id and invalidated_at is null;
    update briefs set evidence_changed_at = now(),
           status = case when status in ('approved', 'scheduled', 'specialist_review')
                         then 'producer_review'::brief_status else status end,
           status_reason = case when status in ('approved', 'scheduled', 'specialist_review')
                         then 'Approval invalidated: cited source passage was corrected' else status_reason end
     where id = v_brief.id;
    perform log_audit(v_brief.org_id, 'brief.evidence_changed', 'brief', v_brief.id,
      jsonb_build_object('segment', t.id, 'source', t.source_id));
  end loop;

  perform log_audit(t.org_id, 'transcript.corrected', 'transcript_segment', t.id,
    jsonb_build_object('source', t.source_id, 'idx', t.idx));
end $$;

-- ---------------------------------------------------------------------------
-- Brief versions: every edit is a new version. A new version supersedes all
-- review decisions on earlier versions (approval is bound to an exact version).
-- ---------------------------------------------------------------------------
create or replace function public.on_brief_version_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare b briefs;
begin
  select * into b from briefs where id = new.brief_id for update;
  update review_decisions set invalidated_at = now(),
         invalidated_reason = 'Superseded by version ' || new.version
   where brief_id = new.brief_id and invalidated_at is null and brief_version_id <> new.id;
  update briefs set
      current_version_id = new.id,
      title = coalesce(nullif(new.content->>'title', ''), title),
      recommendation = coalesce(nullif(new.content->>'recommendation', ''), recommendation),
      evidence_changed_at = null,
      status = case when new.version > 1 and status in ('approved', 'scheduled', 'specialist_review')
                    then 'producer_review'::brief_status else status end,
      status_reason = case when new.version > 1 and status in ('approved', 'scheduled', 'specialist_review')
                    then 'Approval invalidated by version ' || new.version else status_reason end,
      updated_at = now()
   where id = new.brief_id;
  return new;
end $$;
create trigger brief_versions_after_insert after insert on public.brief_versions
  for each row execute function public.on_brief_version_insert();

create or replace function public.save_brief_version(
  p_brief uuid, p_base_version uuid, p_content jsonb, p_locked text[], p_note text
) returns uuid language plpgsql security definer set search_path = public as $$
declare b briefs; base brief_versions; v_id uuid; v_next int; k text;
begin
  select * into b from briefs where id = p_brief for update;
  if b.id is null or not has_scope(b.org_id, b.brand_id, b.show_id, work_roles()) then
    raise exception 'Not permitted to edit this brief' using errcode = '42501';
  end if;
  if b.status in ('closed', 'archived', 'rejected') then
    raise exception 'Brief is %; reopen it before editing', b.status;
  end if;
  if b.current_version_id is distinct from p_base_version then
    raise exception 'This brief changed since you opened it. Reload and re-apply your edits.'
      using errcode = '40001';
  end if;
  select * into base from brief_versions where id = p_base_version;
  -- Evidence is server-owned: users cannot add or rewrite evidence records via content.
  if p_content ? 'evidence' then
    p_content := jsonb_set(p_content, '{evidence}', coalesce(base.content->'evidence', '[]'::jsonb));
  end if;
  select coalesce(max(version), 0) + 1 into v_next from brief_versions where brief_id = p_brief;
  insert into brief_versions (org_id, brand_id, show_id, brief_id, version, content, locked_sections,
                              profile_version_id, generated, model, prompt_version, validation,
                              change_note, created_by)
  values (b.org_id, b.brand_id, b.show_id, b.id, v_next, p_content, coalesce(p_locked, '{}'),
          base.profile_version_id, false, null, null, base.validation, p_note, auth.uid())
  returning id into v_id;
  -- Carry evidence records forward unchanged.
  insert into evidence (org_id, brief_version_id, ref_key, source_id, segment_start, segment_end,
                        start_ms, end_ms, quote, attribution, kind, verification, note, verified_by, verified_at)
  select org_id, v_id, ref_key, source_id, segment_start, segment_end, start_ms, end_ms, quote,
         attribution, kind, verification, note, verified_by, verified_at
    from evidence where brief_version_id = p_base_version;
  perform log_audit(b.org_id, 'brief.version_saved', 'brief', b.id,
    jsonb_build_object('version', v_next, 'note', p_note));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Evidence verification by a producer/researcher listening to the source.
-- ---------------------------------------------------------------------------
create or replace function public.verify_evidence(
  p_evidence uuid, p_state public.evidence_verification, p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare e evidence; v brief_versions; b briefs;
begin
  select * into e from evidence where id = p_evidence for update;
  select * into v from brief_versions where id = e.brief_version_id;
  select * into b from briefs where id = v.brief_id;
  if e.id is null or not has_scope(v.org_id, v.brand_id, v.show_id, reviewer_roles()) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  if v.id <> b.current_version_id then raise exception 'Only evidence on the current version can be verified'; end if;
  if p_state = 'auto_matched' then raise exception 'auto_matched is set by the system only'; end if;
  update evidence set verification = p_state,
         verified_by = case when p_state = 'verified' then auth.uid() end,
         verified_at = case when p_state = 'verified' then now() end,
         note = coalesce(p_note, note)
   where id = e.id;
  perform log_audit(v.org_id, 'evidence.' || p_state, 'evidence', e.id,
    jsonb_build_object('brief', b.id, 'ref', e.ref_key));
end $$;

-- ---------------------------------------------------------------------------
-- Review checks and approval, bound to an exact brief version.
-- ---------------------------------------------------------------------------
create or replace function public.required_checks(p_version uuid) returns public.review_check[]
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from brief_versions v,
                   jsonb_array_elements(coalesce(v.content->'review_flags', '[]'::jsonb)) f
                 where v.id = p_version and f->>'check' = 'commercial')
      then array['fact','fairness','privacy','rights','language','commercial']::review_check[]
    else array['fact','fairness','privacy','rights','language']::review_check[]
  end
$$;

create or replace function public.record_check(
  p_brief uuid, p_version uuid, p_check public.review_check, p_outcome public.review_outcome,
  p_reason text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare b briefs; v_id uuid; v_role member_role;
begin
  select * into b from briefs where id = p_brief;
  v_role := best_role(b.org_id, b.brand_id, b.show_id, reviewer_roles());
  if b.id is null or v_role is null then
    raise exception 'Not permitted to review this brief' using errcode = '42501';
  end if;
  if b.current_version_id <> p_version then
    raise exception 'Checks must be recorded against the current version';
  end if;
  if p_outcome = 'not_applicable' and coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason when marking a check not applicable';
  end if;
  update review_decisions set invalidated_at = now(), invalidated_reason = 'Replaced by a newer decision'
   where brief_version_id = p_version and check_key = p_check and invalidated_at is null;
  insert into review_decisions (org_id, brief_id, brief_version_id, check_key, outcome, reviewer, reviewer_role, reason)
  values (b.org_id, b.id, p_version, p_check, p_outcome, auth.uid(), v_role, p_reason)
  returning id into v_id;
  perform log_audit(b.org_id, 'review.check_recorded', 'brief', b.id,
    jsonb_build_object('check', p_check, 'outcome', p_outcome, 'version', p_version));
  return v_id;
end $$;

-- Returns the list of reasons the current version cannot be approved (empty = approvable).
create or replace function public.approval_blockers(p_brief uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare b briefs; out text[] := '{}'; c review_check; n int;
begin
  select * into b from briefs where id = p_brief;
  if b.id is null or not can_read_brief(b.id) then return array['Brief not found']; end if;
  if b.status not in ('producer_review', 'specialist_review') then
    out := out || ('Submit for review first (status is ' || b.status || ')');
  end if;
  if b.evidence_changed_at is not null then
    out := out || 'A cited source passage was corrected; save a reviewed version'::text;
  end if;
  foreach c in array required_checks(b.current_version_id) loop
    if not exists (select 1 from review_decisions d
                   where d.brief_version_id = b.current_version_id and d.check_key = c
                     and d.invalidated_at is null and d.outcome in ('passed', 'not_applicable')) then
      out := out || (initcap(c::text) || ' check not passed');
    end if;
  end loop;
  select count(*) into n from evidence e where e.brief_version_id = b.current_version_id
     and e.verification in ('failed', 'unverified');
  if n > 0 then out := out || (n || ' evidence item(s) not verified against the source'); end if;
  select count(*) into n from research_tasks t where t.brief_id = b.id and t.blocking and t.status <> 'done';
  if n > 0 then out := out || (n || ' blocking task(s) still open'); end if;
  return out;
end $$;

create or replace function public.approve_brief(
  p_brief uuid, p_version uuid, p_reason text default null, p_conditions text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare b briefs; v_role member_role; v_id uuid; v_blockers text[];
begin
  select * into b from briefs where id = p_brief for update;
  v_role := best_role(b.org_id, b.brand_id, b.show_id, editor_roles());
  if b.id is null or v_role is null then
    raise exception 'Only an authorised editor for this show can approve' using errcode = '42501';
  end if;
  if b.current_version_id <> p_version then
    raise exception 'Approval must be for the current version';
  end if;
  v_blockers := approval_blockers(p_brief);
  if array_length(v_blockers, 1) > 0 then
    raise exception 'Cannot approve: %', array_to_string(v_blockers, '; ');
  end if;
  insert into review_decisions (org_id, brief_id, brief_version_id, is_final_approval, outcome,
                                reviewer, reviewer_role, reason, conditions)
  values (b.org_id, b.id, p_version, true, 'passed', auth.uid(), v_role, p_reason, p_conditions)
  returning id into v_id;
  update briefs set status = 'approved', status_reason = p_reason where id = b.id;
  perform log_audit(b.org_id, 'brief.approved', 'brief', b.id,
    jsonb_build_object('version', p_version, 'conditions', p_conditions));
  return v_id;
end $$;

-- Status transitions other than approval.
create or replace function public.set_brief_status(
  p_brief uuid, p_status public.brief_status, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare b briefs; allowed boolean := false;
begin
  select * into b from briefs where id = p_brief for update;
  if b.id is null or not can_read_brief(b.id) then raise exception 'Brief not found'; end if;
  if p_status = 'approved' then raise exception 'Use approve_brief to approve'; end if;

  if p_status in ('discovered', 'researching', 'drafted', 'producer_review') then
    allowed := has_scope(b.org_id, b.brand_id, b.show_id, work_roles())
               and b.status not in ('closed', 'archived');
  elsif p_status = 'specialist_review' then
    allowed := has_scope(b.org_id, b.brand_id, b.show_id, work_roles())
               and b.status in ('producer_review', 'drafted');
  elsif p_status in ('scheduled', 'produced') then
    allowed := has_scope(b.org_id, b.brand_id, b.show_id, work_roles())
               and b.status in ('approved', 'scheduled');
  elsif p_status = 'closed' then
    allowed := has_scope(b.org_id, b.brand_id, b.show_id, work_roles())
               and b.status in ('produced', 'approved', 'scheduled');
  elsif p_status in ('rejected', 'archived') then
    allowed := has_scope(b.org_id, b.brand_id, b.show_id, editor_roles() || array['producer']::member_role[]);
  end if;

  if not allowed then
    raise exception 'Cannot move brief from % to %', b.status, p_status using errcode = '42501';
  end if;
  if p_status = 'rejected' and coalesce(trim(p_reason), '') = '' then
    raise exception 'Record why the opportunity is rejected (it informs future recommendations)';
  end if;
  -- Moving backwards out of approval voids the approval.
  if b.status in ('approved', 'scheduled') and p_status in ('drafted', 'researching', 'producer_review', 'discovered') then
    update review_decisions set invalidated_at = now(), invalidated_reason = 'Brief reopened'
     where brief_id = b.id and invalidated_at is null;
  end if;
  update briefs set status = p_status, status_reason = p_reason where id = b.id;
  perform log_audit(b.org_id, 'brief.status', 'brief', b.id,
    jsonb_build_object('from', b.status, 'to', p_status, 'reason', p_reason));
end $$;

-- Keep profiles.email in sync with auth.users (Supabase only).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth')
     and exists (select 1 from pg_tables where schemaname = 'auth' and tablename = 'users') then
    execute $f$
      create or replace function public.handle_new_user() returns trigger
      language plpgsql security definer set search_path = public as $b$
      begin
        insert into profiles (user_id, email, display_name)
        values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
        on conflict (user_id) do update set email = excluded.email;
        return new;
      end $b$;
    $f$;
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created after insert on auth.users
             for each row execute function public.handle_new_user()';
  end if;
end $$;

-- ===== 20261031000004_storage.sql =====
-- Private media bucket. Object paths are {org_id}/{source_id}/{filename}.
-- Reads follow source visibility; uploads require a work role on the source's scope.
-- Clients receive short-lived signed URLs; there are no public media URLs.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then

    insert into storage.buckets (id, name, public, file_size_limit)
    values ('media', 'media', false, 2147483648)
    on conflict (id) do update set public = false;

    execute $p$
      create policy media_read on storage.objects for select to authenticated
      using (bucket_id = 'media' and public.can_read_source(((storage.foldername(name))[2])::uuid))
    $p$;
    execute $p$
      create policy media_upload on storage.objects for insert to authenticated
      with check (bucket_id = 'media' and public.can_edit_source(((storage.foldername(name))[2])::uuid)
                  and exists (select 1 from public.sources s
                              where s.id = ((storage.foldername(name))[2])::uuid
                                and s.org_id = ((storage.foldername(name))[1])::uuid
                                and s.storage_path is null and s.status = 'queued'))
    $p$;
  end if;
end $$;

-- Users attach the uploaded object to their source once (then it is immutable).
create or replace function public.attach_source_upload(
  p_source uuid, p_path text, p_checksum text, p_size bigint, p_mime text
) returns void language plpgsql security definer set search_path = public as $$
declare s sources;
begin
  select * into s from sources where id = p_source for update;
  if s.id is null or not can_edit_source(s.id) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  if s.storage_path is not null then raise exception 'Source media already attached'; end if;
  if split_part(p_path, '/', 1) <> s.org_id::text or split_part(p_path, '/', 2) <> s.id::text then
    raise exception 'Upload path does not belong to this source';
  end if;
  if p_checksum !~ '^[0-9a-f]{64}$' then raise exception 'Invalid SHA-256 checksum'; end if;
  if exists (select 1 from sources where org_id = s.org_id and checksum_sha256 = p_checksum and id <> s.id) then
    raise exception 'DUPLICATE: identical content already ingested as another source' using errcode = '23505';
  end if;
  update sources set storage_path = p_path, checksum_sha256 = p_checksum, size_bytes = p_size, mime_type = p_mime
   where id = s.id;
  perform log_audit(s.org_id, 'source.media_attached', 'source', s.id,
    jsonb_build_object('checksum', p_checksum, 'size', p_size));
end $$;

-- ===== 20261101000005_brand_profiles.sql =====
-- Brand (station/channel) profiles: the brand-wide editorial contract.
-- Every brief is written against the approved brand profile and the approved
-- show profile. Brand standards and exclusions bind every show of the brand.

create table public.brand_profile_versions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  brand_id    uuid not null references public.brands(id) on delete cascade,
  version     int  not null,
  status      public.profile_status not null default 'draft',
  profile     jsonb not null default '{}'::jsonb,
  change_note text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  unique (brand_id, version)
);

alter table public.brands add column current_profile_version_id uuid
  references public.brand_profile_versions(id) on delete set null;
alter table public.brief_versions add column brand_profile_version_id uuid
  references public.brand_profile_versions(id) on delete set null;

alter table public.brand_profile_versions enable row level security;

create policy bpv_select on public.brand_profile_versions for select to authenticated
  using (public.is_member(org_id));
-- Drafting needs a work role covering the whole brand (org- or brand-scoped), not just one show.
create policy bpv_update_draft on public.brand_profile_versions for update to authenticated
  using (status = 'draft' and public.has_scope(org_id, brand_id, null, public.work_roles()))
  with check (status = 'draft' and approved_by is null and approved_at is null
              and public.has_scope(org_id, brand_id, null, public.work_roles()));
create policy bpv_delete_draft on public.brand_profile_versions for delete to authenticated
  using (status = 'draft' and public.has_scope(org_id, brand_id, null, public.work_roles()));

-- Current approved profile pointers may only change through the approval functions.
create or replace function public.guard_profile_pointer() returns trigger
language plpgsql as $$
begin
  if not public.is_privileged()
     and new.current_profile_version_id is distinct from old.current_profile_version_id then
    raise exception 'Approve a profile version to make it current' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger brands_profile_guard before update on public.brands
  for each row execute function public.guard_profile_pointer();
create trigger shows_profile_guard before update on public.shows
  for each row execute function public.guard_profile_pointer();

create or replace function public.create_brand_profile_draft(p_brand uuid, p_profile jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare b brands; v_id uuid; v_next int;
begin
  select * into b from brands where id = p_brand;
  if b.id is null or not has_scope(b.org_id, b.id, null, work_roles()) then
    raise exception 'Not permitted to edit this brand profile' using errcode = '42501';
  end if;
  select coalesce(max(version), 0) + 1 into v_next from brand_profile_versions where brand_id = p_brand;
  insert into brand_profile_versions (org_id, brand_id, version, status, profile, change_note, created_by)
  values (b.org_id, b.id, v_next, 'draft', coalesce(p_profile, '{}'::jsonb), p_note, auth.uid())
  returning id into v_id;
  perform log_audit(b.org_id, 'brand_profile.draft_created', 'brand_profile_version', v_id,
    jsonb_build_object('brand', b.id, 'version', v_next));
  return v_id;
end $$;

create or replace function public.approve_brand_profile(p_version uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v brand_profile_versions;
begin
  select * into v from brand_profile_versions where id = p_version for update;
  if v.id is null then raise exception 'Brand profile version not found'; end if;
  if not has_scope(v.org_id, v.brand_id, null, array['org_admin','brand_editor']::member_role[]) then
    raise exception 'Only brand or organisation editors can approve a brand profile' using errcode = '42501';
  end if;
  if v.status <> 'draft' then raise exception 'Only draft profiles can be approved'; end if;
  update brand_profile_versions set status = 'superseded' where brand_id = v.brand_id and status = 'approved';
  update brand_profile_versions set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = v.id;
  update brands set current_profile_version_id = v.id where id = v.brand_id;
  perform log_audit(v.org_id, 'brand_profile.approved', 'brand_profile_version', v.id,
    jsonb_build_object('brand', v.brand_id, 'version', v.version));
end $$;

-- Human edits keep the profile versions the brief was generated against.
create or replace function public.save_brief_version(
  p_brief uuid, p_base_version uuid, p_content jsonb, p_locked text[], p_note text
) returns uuid language plpgsql security definer set search_path = public as $$
declare b briefs; base brief_versions; v_id uuid; v_next int;
begin
  select * into b from briefs where id = p_brief for update;
  if b.id is null or not has_scope(b.org_id, b.brand_id, b.show_id, work_roles()) then
    raise exception 'Not permitted to edit this brief' using errcode = '42501';
  end if;
  if b.status in ('closed', 'archived', 'rejected') then
    raise exception 'Brief is %; reopen it before editing', b.status;
  end if;
  if b.current_version_id is distinct from p_base_version then
    raise exception 'This brief changed since you opened it. Reload and re-apply your edits.'
      using errcode = '40001';
  end if;
  select * into base from brief_versions where id = p_base_version;
  if p_content ? 'evidence' then
    p_content := jsonb_set(p_content, '{evidence}', coalesce(base.content->'evidence', '[]'::jsonb));
  end if;
  select coalesce(max(version), 0) + 1 into v_next from brief_versions where brief_id = p_brief;
  insert into brief_versions (org_id, brand_id, show_id, brief_id, version, content, locked_sections,
                              profile_version_id, brand_profile_version_id, generated, model, prompt_version,
                              validation, change_note, created_by)
  values (b.org_id, b.brand_id, b.show_id, b.id, v_next, p_content, coalesce(p_locked, '{}'),
          base.profile_version_id, base.brand_profile_version_id, false, null, null, base.validation,
          p_note, auth.uid())
  returning id into v_id;
  insert into evidence (org_id, brief_version_id, ref_key, source_id, segment_start, segment_end,
                        start_ms, end_ms, quote, attribution, kind, verification, note, verified_by, verified_at)
  select org_id, v_id, ref_key, source_id, segment_start, segment_end, start_ms, end_ms, quote,
         attribution, kind, verification, note, verified_by, verified_at
    from evidence where brief_version_id = p_base_version;
  perform log_audit(b.org_id, 'brief.version_saved', 'brief', b.id,
    jsonb_build_object('version', v_next, 'note', p_note));
  return v_id;
end $$;
