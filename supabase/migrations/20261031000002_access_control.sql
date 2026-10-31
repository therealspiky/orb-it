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
