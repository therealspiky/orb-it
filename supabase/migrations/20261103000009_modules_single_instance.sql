-- Modules and single-organisation instances.
--
-- Each client runs its own Orb.IT instance (own Supabase project, web app and
-- worker) holding exactly one organisation. Optional modules are licensed per
-- instance by the vendor: rows in instance_modules are readable by everyone
-- signed in but can only be changed with the service role or the SQL editor.

create table public.instance_modules (
  key         text primary key,
  label       text not null,
  enabled     boolean not null default true,
  config      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.instance_modules enable row level security;
create policy modules_select on public.instance_modules for select to authenticated using (true);
revoke insert, update, delete on public.instance_modules from anon, authenticated;

insert into public.instance_modules (key, label, enabled) values
  ('brand_profiles',          'Brand profiles',          true),
  ('recording_transcription', 'Recording transcription', true),
  ('episode_map',             'Episode map',             true),
  ('youtube',                 'YouTube import',          true)
on conflict (key) do nothing;

create or replace function public.module_enabled(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from instance_modules where key = p_key), false)
$$;

create or replace function public.require_module(p_key text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not module_enabled(p_key) then
    raise exception 'The % module is not enabled on this Orb.IT instance', coalesce((select label from instance_modules where key = p_key), p_key)
      using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Single organisation per instance
-- ---------------------------------------------------------------------------
create or replace function public.instance_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'has_organisation', exists (select 1 from organisations),
    'organisation_name', (select name from organisations order by created_at limit 1),
    'is_member', exists (select 1 from memberships where user_id = auth.uid())
  )
$$;

create or replace function public.create_organisation(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  -- The first person to set up the instance becomes its administrator; after that,
  -- people join only when an administrator adds them.
  perform pg_advisory_xact_lock(hashtext('orbit.create_organisation'));
  if exists (select 1 from organisations) then
    raise exception 'This Orb.IT instance already has an organisation. Ask its administrator to add you.' using errcode = '42501';
  end if;
  insert into organisations (name, created_by) values (p_name, auth.uid()) returning id into v_org;
  insert into memberships (org_id, user_id, role) values (v_org, auth.uid(), 'org_admin');
  perform log_audit(v_org, 'organisation.created', 'organisation', v_org, jsonb_build_object('name', p_name));
  return v_org;
end $$;

-- ---------------------------------------------------------------------------
-- Module enforcement
-- ---------------------------------------------------------------------------
-- Recordings need the recording transcription module.
drop policy if exists sources_insert on public.sources;
create policy sources_insert on public.sources for insert to authenticated
  with check (public.has_scope(org_id, brand_id, show_id, public.work_roles())
              and (kind <> 'recording' or public.module_enabled('recording_transcription')));

-- Brand profiles.
create or replace function public.create_brand_profile_draft(p_brand uuid, p_profile jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare b brands; v_id uuid; v_next int;
begin
  perform require_module('brand_profiles');
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
  perform require_module('brand_profiles');
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

drop policy if exists bpv_update_draft on public.brand_profile_versions;
create policy bpv_update_draft on public.brand_profile_versions for update to authenticated
  using (status = 'draft' and public.module_enabled('brand_profiles') and public.has_scope(org_id, brand_id, null, public.work_roles()))
  with check (status = 'draft' and approved_by is null and approved_at is null
              and public.has_scope(org_id, brand_id, null, public.work_roles()));

-- YouTube channel connection.
create or replace function public.submit_youtube_oauth_code(p_org uuid, p_code text, p_redirect_uri text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_pending uuid; v_job uuid;
begin
  perform require_module('youtube');
  if not exists (select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid()
                 and m.role in ('org_admin', 'brand_editor')) then
    raise exception 'Only organisation admins and brand editors can connect channels' using errcode = '42501';
  end if;
  if coalesce(trim(p_code), '') = '' or p_redirect_uri !~ '^https?://' then
    raise exception 'Invalid authorisation response';
  end if;
  delete from oauth_pending where created_at < now() - interval '1 hour';
  insert into oauth_pending (org_id, code, redirect_uri, created_by)
  values (p_org, p_code, p_redirect_uri, auth.uid()) returning id into v_pending;
  insert into jobs (org_id, kind, payload, idempotency_key, created_by)
  values (p_org, 'youtube_connect', jsonb_build_object('pending_id', v_pending), 'yt-connect:' || v_pending, auth.uid())
  returning id into v_job;
  perform log_audit(p_org, 'youtube.connect_requested', 'job', v_job, '{}'::jsonb);
  return v_job;
end $$;

-- Jobs: each optional module's work is refused when the module is off.
create or replace function public.enqueue_job(
  p_org uuid, p_kind public.job_kind, p_payload jsonb, p_idempotency_key text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_source uuid; v_show uuid; v_map uuid; s sources; sh shows;
begin
  if not is_member(p_org) then raise exception 'Not a member' using errcode = '42501'; end if;
  v_source := nullif(p_payload->>'source_id', '')::uuid;
  if v_source is not null then
    select * into s from sources where id = v_source and org_id = p_org;
    if s.id is null or not can_read_source(s.id) then
      raise exception 'Source not available to you' using errcode = '42501';
    end if;
  end if;

  if p_kind::text = 'youtube_connect' then
    raise exception 'Use the channel connection flow' using errcode = '42501';
  elsif p_kind::text in ('transcribe', 'analyse', 'youtube_import') then
    if s.id is null or not can_edit_source(s.id) then
      raise exception 'Not permitted to process this source' using errcode = '42501';
    end if;
    if p_kind::text = 'transcribe' and s.kind = 'recording' then perform require_module('recording_transcription'); end if;
    if p_kind::text = 'youtube_import' then perform require_module('youtube'); end if;
  elsif p_kind::text = 'map_episode' then
    perform require_module('episode_map');
    if s.id is null then raise exception 'map_episode needs source_id'; end if;
    if not exists (select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid()
                   and m.role = any(work_roles())) then
      raise exception 'Not permitted to map this source' using errcode = '42501';
    end if;
  elsif p_kind::text = 'generate_briefs' then
    if s.id is null then raise exception 'generate_briefs needs source_id'; end if;
    v_map := nullif(p_payload->>'episode_map_id', '')::uuid;
    if v_map is not null then
      perform require_module('episode_map');
      if not exists (select 1 from episode_maps where id = v_map and source_id = s.id) then
        raise exception 'Episode map does not belong to this source';
      end if;
      if coalesce(p_payload->>'conversation_key', '') = '' then
        raise exception 'Choose which conversation to develop';
      end if;
    end if;
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
