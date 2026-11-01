-- Episode map: the content inventory of one source. Lists the distinct
-- conversations inside an episode, the moments that support each, and which
-- shows and platforms could take each one, so one episode can feed many.

alter type public.job_kind add value if not exists 'map_episode';

create table public.episode_maps (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organisations(id) on delete cascade,
  source_id              uuid not null references public.sources(id) on delete cascade,
  transcript_fingerprint text not null,
  model                  text not null,
  prompt_version         text not null,
  result                 jsonb not null,   -- { summary, conversations: [...] }
  considered_shows       uuid[] not null default '{}',
  validation             jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);
create index episode_maps_source on public.episode_maps (source_id, created_at desc);

alter table public.episode_maps enable row level security;
create policy episode_maps_select on public.episode_maps for select to authenticated
  using (public.can_read_source(source_id));

-- Briefs developed from a mapped conversation keep that link.
alter table public.briefs add column episode_map_id uuid references public.episode_maps(id) on delete set null;
alter table public.briefs add column conversation_key text;
create index briefs_map on public.briefs (episode_map_id, conversation_key);

-- enqueue_job: add map_episode (anyone with a work role in the organisation who can
-- read the source may refresh its map) and validate map-focused brief requests.
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

  if p_kind::text in ('transcribe', 'analyse') then
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
