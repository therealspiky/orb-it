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
