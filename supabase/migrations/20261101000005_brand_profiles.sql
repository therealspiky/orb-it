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
