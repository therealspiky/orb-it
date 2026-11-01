-- YouTube: link-based import (metadata for any public video, captions through the
-- official API for channels the organisation has connected).

alter type public.job_kind add value if not exists 'youtube_import';
alter type public.job_kind add value if not exists 'youtube_connect';

-- Platform metadata captured at import (title, channel, published date, duration...).
alter table public.sources add column external jsonb not null default '{}'::jsonb;

-- Connected channels: visible to members; tokens live in a separate server-only table.
create table public.youtube_connections (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  channel_id    text not null,
  channel_title text,
  channel_thumb text,
  status        text not null default 'active' check (status in ('active', 'error', 'revoked')),
  error         text,
  connected_by  uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, channel_id)
);
alter table public.youtube_connections enable row level security;
create policy ytc_select on public.youtube_connections for select to authenticated
  using (public.is_member(org_id));
create policy ytc_delete on public.youtube_connections for delete to authenticated
  using (public.has_scope(org_id, null, null, array['org_admin']::public.member_role[]));

-- OAuth refresh tokens: row-level security on and no policies, so only the
-- service-role worker can read or write them.
create table public.youtube_credentials (
  connection_id uuid primary key references public.youtube_connections(id) on delete cascade,
  refresh_token text not null,
  scope         text,
  updated_at    timestamptz not null default now()
);
alter table public.youtube_credentials enable row level security;
revoke all on public.youtube_credentials from anon, authenticated;

-- One-time OAuth codes handed from the browser to the worker (server-only).
create table public.oauth_pending (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  provider     text not null default 'youtube',
  code         text not null,
  redirect_uri text not null,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
alter table public.oauth_pending enable row level security;
revoke all on public.oauth_pending from anon, authenticated;

-- Called by the OAuth callback page. Admins and brand editors only.
create or replace function public.submit_youtube_oauth_code(p_org uuid, p_code text, p_redirect_uri text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_pending uuid; v_job uuid;
begin
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

-- enqueue_job: adds youtube_import; youtube_connect is only created by the function above.
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
  elsif p_kind::text = 'map_episode' then
    if s.id is null then raise exception 'map_episode needs source_id'; end if;
    if not exists (select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid()
                   and m.role = any(work_roles())) then
      raise exception 'Not permitted to map this source' using errcode = '42501';
    end if;
  elsif p_kind::text = 'generate_briefs' then
    if s.id is null then raise exception 'generate_briefs needs source_id'; end if;
    v_map := nullif(p_payload->>'episode_map_id', '')::uuid;
    if v_map is not null then
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

-- Users may set platform metadata only on insert (the worker fills it in later).
create or replace function public.guard_source_update() returns trigger
language plpgsql as $$
begin
  if not public.is_privileged() then
    if new.status is distinct from old.status
       or new.storage_path is distinct from old.storage_path
       or new.checksum_sha256 is distinct from old.checksum_sha256
       or new.timestamps_genuine is distinct from old.timestamps_genuine
       or new.duration_seconds is distinct from old.duration_seconds
       or new.external is distinct from old.external
       or new.org_id <> old.org_id or new.kind <> old.kind then
      raise exception 'Source identity, media and processing state are immutable for users'
        using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Allow a pasted transcript to be attached to a source whose YouTube captions were unavailable.
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
  update sources set storage_path = p_path, checksum_sha256 = p_checksum, size_bytes = p_size, mime_type = p_mime,
         status = 'queued', status_message = null
   where id = s.id;
  perform log_audit(s.org_id, 'source.media_attached', 'source', s.id,
    jsonb_build_object('checksum', p_checksum, 'size', p_size));
end $$;
