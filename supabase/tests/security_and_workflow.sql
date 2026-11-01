-- Orb.IT database tests: tenant isolation, scoped roles, sharing scope,
-- version-bound approval and invalidation (acceptance tests AT01, AT08, AT10 in part).
\set ON_ERROR_STOP 1

create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

-- Runs SQL as a given user and returns true when it raises an error.
create or replace function pg_temp.fails_as(p_user uuid, p_sql text) returns boolean
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql;
  exception when others then
    execute 'reset role';
    return true;
  end;
  execute 'reset role';
  return false;
end $$;

create or replace function pg_temp.count_as(p_user uuid, p_sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
  execute 'select count(*) from (' || p_sql || ') q' into n;
  execute 'reset role';
  return n;
end $$;

grant execute on all functions in schema pg_temp to authenticated;

-- Users -------------------------------------------------------------------
-- A = org admin, B = producer scoped to the Hitz Morning show only,
-- C = show editor for Hitz Morning, D = admin of a different organisation,
-- E = commercial user at org level.
insert into auth.users (id, email) values
 ('00000000-0000-0000-0000-00000000000a', 'admin@orbit.test'),
 ('00000000-0000-0000-0000-00000000000b', 'producer@orbit.test'),
 ('00000000-0000-0000-0000-00000000000c', 'editor@orbit.test'),
 ('00000000-0000-0000-0000-00000000000d', 'other@elsewhere.test'),
 ('00000000-0000-0000-0000-00000000000e', 'sales@orbit.test');

begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
set local role authenticated;
create temp table ids as select public.create_organisation('Test Media Group') as org;
reset role;
commit;

-- Store ids for later steps
create table t_ids (k text primary key, v uuid);
insert into t_ids select 'org', org from ids;

begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
set local role authenticated;
insert into brands (org_id, name) select v, 'Hitz FM' from t_ids where k='org';
insert into brands (org_id, name) select v, 'Joy Prime' from t_ids where k='org';
insert into shows (org_id, brand_id, name)
  select b.org_id, b.id, 'Morning Show' from brands b where b.name = 'Hitz FM';
insert into shows (org_id, brand_id, name)
  select b.org_id, b.id, 'Drive Time' from brands b where b.name = 'Hitz FM';
insert into shows (org_id, brand_id, name)
  select b.org_id, b.id, 'Talk Your Shh' from brands b where b.name = 'Joy Prime';
insert into shows (org_id, brand_id, name)
  select b.org_id, b.id, 'Prime Morning' from brands b where b.name = 'Joy Prime';
reset role;
commit;

insert into t_ids select 'hitz', id from brands where name='Hitz FM';
insert into t_ids select 'joy', id from brands where name='Joy Prime';
insert into t_ids select 'hitz_morning', id from shows where name='Morning Show';
insert into t_ids select 'hitz_drive', id from shows where name='Drive Time';
insert into t_ids select 'tys', id from shows where name='Talk Your Shh';
insert into t_ids select 'prime_morning', id from shows where name='Prime Morning';

begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
set local role authenticated;
select public.add_member((select v from t_ids where k='org'), 'producer@orbit.test', 'producer',
                         null, (select v from t_ids where k='hitz_morning'));
select public.add_member((select v from t_ids where k='org'), 'editor@orbit.test', 'show_editor',
                         null, (select v from t_ids where k='hitz_morning'));
select public.add_member((select v from t_ids where k='org'), 'sales@orbit.test', 'commercial');
reset role;
commit;

-- D runs their own organisation
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', true);
set local role authenticated;
select public.create_organisation('Other Group');
reset role;
commit;

do $$ begin
  perform pg_temp.ok((select count(*) from profiles) = 5, 'profiles mirrored from auth.users');
end $$;

-- AT01: tenant isolation ----------------------------------------------------
do $$ begin
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from brands') = 0,
    'other organisation sees none of our brands');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from organisations') = 1,
    'other organisation sees only its own organisation');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000d',
    format('insert into brands (org_id, name) values (%L, %L)', (select v from t_ids where k='org'), 'Hijack')),
    'outsider cannot create a brand in our organisation');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format('insert into brands (org_id, name) values (%L, %L)', (select v from t_ids where k='org'), 'Rogue')),
    'producer cannot create brands');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.add_member(%L, 'sales@orbit.test', 'org_admin')$q$, (select v from t_ids where k='org'))),
    'producer cannot grant roles');
end $$;

-- Show profiles: producers draft, editors approve --------------------------
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
set local role authenticated;
insert into t_ids select 'hitz_profile_v1',
  public.create_profile_draft((select v from t_ids where k='hitz_morning'),
    '{"identity":{"remit":"High-energy morning debate"},"voice":{"episode_length_minutes":45,"breaks_minutes":0}}'::jsonb, 'initial');
reset role;
commit;

do $$ begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format('select public.approve_profile(%L)', (select v from t_ids where k='hitz_profile_v1'))),
    'producer cannot approve a show profile');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$update show_profile_versions set status='approved' where id=%L$q$, (select v from t_ids where k='hitz_profile_v1'))),
    'producer cannot approve a profile by direct update');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.create_profile_draft(%L, '{}'::jsonb)$q$, (select v from t_ids where k='prime_morning'))),
    'show-scoped producer cannot draft another show''s profile');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000c',
    format('select public.approve_profile(%L)', (select v from t_ids where k='hitz_profile_v1'))),
    'show editor approves the profile');
  perform pg_temp.ok((select current_profile_version_id from shows where id=(select v from t_ids where k='hitz_morning'))
    = (select v from t_ids where k='hitz_profile_v1'), 'approved version becomes the show''s current profile');
end $$;

-- Sources and sharing scope --------------------------------------------------
-- Joy Prime source shared organisation-wide; a second one restricted to its show.
insert into sources (org_id, brand_id, show_id, kind, title, share_scope, status, timestamps_genuine)
select (select v from t_ids where k='org'), (select v from t_ids where k='joy'), (select v from t_ids where k='tys'),
       'recording', 'TYS episode (shared)', 'organisation', 'ready', true;
insert into sources (org_id, brand_id, show_id, kind, title, share_scope, status)
select (select v from t_ids where k='org'), (select v from t_ids where k='joy'), (select v from t_ids where k='tys'),
       'recording', 'TYS raw tape (restricted)', 'show', 'ready';
insert into t_ids select 'src_shared', id from sources where title like '%shared%';
insert into t_ids select 'src_restricted', id from sources where title like '%restricted%';

insert into transcript_segments (org_id, source_id, idx, start_ms, end_ms, speaker, text)
select (select v from t_ids where k='org'), (select v from t_ids where k='src_shared'), i, i*10000, i*10000+9000,
       'SPEAKER_' || (i % 2), 'Segment ' || i || ' text about trust and money.'
from generate_series(0, 9) i;
insert into transcript_segments (org_id, source_id, idx, text)
select (select v from t_ids where k='org'), (select v from t_ids where k='src_restricted'), 0, 'Off the record remark.';

do $$ begin
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b',
    'select * from sources') = 1, 'Hitz producer sees the org-shared Joy Prime source only');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b',
    format('select * from transcript_segments where source_id=%L', (select v from t_ids where k='src_restricted'))) = 0,
    'restricted transcript leaves no trace for other shows');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from transcript_segments') = 0,
    'outsider sees no transcripts');
  -- Even an admin with edit rights cannot rewrite processing state or media identity.
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$update sources set status='failed' where id=%L$q$, (select v from t_ids where k='src_shared'))),
    'users cannot alter a source''s processing state');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$update sources set checksum_sha256=repeat('0',64) where id=%L$q$, (select v from t_ids where k='src_shared'))),
    'source checksum is immutable for users');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$update sources set rights_status='owned', rights_notes='In-house recording' where id=%L$q$, (select v from t_ids where k='src_shared'))),
    'rights metadata remains editable');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$update transcript_segments set text='tampered' where source_id=%L$q$, (select v from t_ids where k='src_shared')))
    or (select count(*) from transcript_segments where text='tampered') = 0,
    'transcripts cannot be edited directly (only via correct_segment)');
end $$;

-- Job enqueue: idempotent, permission and sharing aware ----------------------
do $$
declare j1 uuid; j2 uuid;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  execute 'set local role authenticated';
  j1 := public.enqueue_job((select v from t_ids where k='org'), 'generate_briefs',
          jsonb_build_object('source_id', (select v from t_ids where k='src_shared'),
                             'show_ids', jsonb_build_array((select v from t_ids where k='hitz_morning'))), 'gen-1');
  j2 := public.enqueue_job((select v from t_ids where k='org'), 'generate_briefs',
          jsonb_build_object('source_id', (select v from t_ids where k='src_shared'),
                             'show_ids', jsonb_build_array((select v from t_ids where k='hitz_morning'))), 'gen-1');
  execute 'reset role';
  perform pg_temp.ok(j1 = j2, 'repeated enqueue with the same key returns the same job');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.enqueue_job(%L, 'generate_briefs', %L::jsonb, 'gen-2')$q$,
      (select v from t_ids where k='org'),
      jsonb_build_object('source_id', (select v from t_ids where k='src_shared'),
                         'show_ids', jsonb_build_array((select v from t_ids where k='prime_morning'))))),
    'producer cannot generate briefs for a show outside their scope');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.enqueue_job(%L, 'generate_briefs', %L::jsonb, 'gen-3')$q$,
      (select v from t_ids where k='org'),
      jsonb_build_object('source_id', (select v from t_ids where k='src_restricted'),
                         'show_ids', jsonb_build_array((select v from t_ids where k='hitz_morning'))))),
    'show-restricted source cannot feed another brand''s show, even for an admin');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.enqueue_job(%L, 'generate_briefs', %L::jsonb, 'gen-4')$q$,
      (select v from t_ids where k='org'),
      jsonb_build_object('source_id', (select v from t_ids where k='src_shared'),
                         'show_ids', jsonb_build_array((select v from t_ids where k='hitz_drive'))))),
    'briefs cannot be generated for a show without an approved profile');
end $$;

-- Briefs: created by the worker (service role) ------------------------------
insert into briefs (org_id, brand_id, show_id, origin_source_id, title, status)
select (select v from t_ids where k='org'), (select v from t_ids where k='hitz'), (select v from t_ids where k='hitz_morning'),
       (select v from t_ids where k='src_shared'), 'Are We Pretending to Hate Cheating?', 'drafted';
insert into t_ids select 'brief', id from briefs;
insert into brief_versions (org_id, brand_id, show_id, brief_id, version, content, profile_version_id, generated, model)
select org_id, brand_id, show_id, id, 1,
       '{"title":"Are We Pretending to Hate Cheating?","recommendation":"proceed","review_flags":[]}'::jsonb,
       (select v from t_ids where k='hitz_profile_v1'), true, 'claude-sonnet-5-5'
from briefs;
insert into t_ids select 'v1', id from brief_versions where version = 1;
insert into evidence (org_id, brief_version_id, ref_key, source_id, segment_start, segment_end, quote, verification)
select (select v from t_ids where k='org'), (select v from t_ids where k='v1'), 'E1',
       (select v from t_ids where k='src_shared'), 3, 4, 'Segment 3 text about trust', 'auto_matched';

do $$ begin
  perform pg_temp.ok((select current_version_id from briefs) = (select v from t_ids where k='v1'),
    'inserting a version makes it current');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b', 'select * from briefs') = 1,
    'Hitz producer sees the Hitz brief');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from briefs') = 0
    and pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from evidence') = 0,
    'outsider sees no briefs or evidence');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$update briefs set status='approved' where id=%L$q$, (select v from t_ids where k='brief'))),
    'status cannot be set to approved by direct update');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000e',
    format($q$select public.save_brief_version(%L, %L, '{}'::jsonb, '{}', 'x')$q$,
      (select v from t_ids where k='brief'), (select v from t_ids where k='v1'))),
    'commercial user cannot edit editorial briefs');
end $$;

-- AT08: review enforcement -----------------------------------------------------
do $$
declare blockers text[];
begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000c',
    format('select public.approve_brief(%L, %L)', (select v from t_ids where k='brief'), (select v from t_ids where k='v1'))),
    'cannot approve before submission and checks');

  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  execute 'set local role authenticated';
  perform public.set_brief_status((select v from t_ids where k='brief'), 'producer_review', 'ready');
  perform public.record_check((select v from t_ids where k='brief'), (select v from t_ids where k='v1'), c, 'passed', 'checked')
    from unnest(array['fact','fairness','privacy','rights','language']::review_check[]) c;
  execute 'reset role';

  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format('select public.approve_brief(%L, %L)', (select v from t_ids where k='brief'), (select v from t_ids where k='v1'))),
    'producer cannot give final approval');

  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
  execute 'set local role authenticated';
  blockers := public.approval_blockers((select v from t_ids where k='brief'));
  execute 'reset role';
  perform pg_temp.ok(blockers = '{}', 'no blockers once checks pass and evidence matches: ' || coalesce(array_to_string(blockers, ';'), ''));

  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000c',
    format('select public.approve_brief(%L, %L, %L)', (select v from t_ids where k='brief'), (select v from t_ids where k='v1'), 'Good to go')),
    'show editor approves the exact version');
  perform pg_temp.ok((select status from briefs) = 'approved', 'brief is approved');
end $$;

-- An edit creates version 2 and voids the approval.
do $$
declare v2 uuid;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  execute 'set local role authenticated';
  v2 := public.save_brief_version((select v from t_ids where k='brief'), (select v from t_ids where k='v1'),
          '{"title":"Are We Pretending to Hate Cheating? (revised)","evidence":[{"ref":"E9"}]}'::jsonb,
          array['rundown'], 'Tightened opening');
  execute 'reset role';
  insert into t_ids values ('v2', v2);
  perform pg_temp.ok((select status from briefs) = 'producer_review', 'material edit pulls the brief out of approved');
  perform pg_temp.ok((select count(*) from review_decisions where invalidated_at is null) = 0,
    'all review decisions on version 1 are invalidated');
  perform pg_temp.ok((select count(*) from evidence where brief_version_id = v2) = 1,
    'evidence carries forward to the new version');
  perform pg_temp.ok((select content->'evidence' from brief_versions where id = v2) is null
    or (select content->'evidence' from brief_versions where id = v2) = 'null'::jsonb
    or (select jsonb_array_length(content->'evidence') from brief_versions where id = v2) = 0,
    'users cannot inject evidence through content');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.save_brief_version(%L, %L, '{}'::jsonb, '{}', 'stale')$q$,
      (select v from t_ids where k='brief'), (select v from t_ids where k='v1'))),
    'saving on a stale base version is rejected');
end $$;

-- Re-approve v2, then correct the cited passage: approval must be voided.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
  execute 'set local role authenticated';
  perform public.record_check((select v from t_ids where k='brief'), (select v from t_ids where k='v2'), c, 'passed', 'ok')
    from unnest(array['fact','fairness','privacy','rights','language']::review_check[]) c;
  perform public.approve_brief((select v from t_ids where k='brief'), (select v from t_ids where k='v2'), 'v2 ok');
  execute 'reset role';
  perform pg_temp.ok((select status from briefs) = 'approved', 'version 2 approved');
end $$;

-- AT10: correcting a cited source passage -------------------------------------
do $$
declare seg uuid;
begin
  select id into seg from transcript_segments
   where source_id = (select v from t_ids where k='src_shared') and idx = 3;
  -- Hitz producer cannot correct a Joy Prime transcript (no work role on that show).
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.correct_segment(%L, 'changed')$q$, seg)),
    'producer outside the source''s show cannot correct its transcript');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.correct_segment(%L, 'Segment 3 text about trust, corrected name.', 'SPEAKER_1')$q$, seg)),
    'admin corrects the cited passage');
  perform pg_temp.ok((select status from briefs) = 'producer_review', 'approval voided after source correction');
  perform pg_temp.ok((select evidence_changed_at from briefs) is not null, 'brief flagged for evidence review');
  perform pg_temp.ok((select verification from evidence where brief_version_id=(select v from t_ids where k='v2'))
    = 'unverified', 'dependent evidence reset to unverified');
  perform pg_temp.ok((select count(*) from segment_corrections) = 1, 'correction history recorded');
  perform pg_temp.ok((select version from transcript_segments where id = seg) = 2, 'segment version incremented');
end $$;

do $$ begin
  perform pg_temp.ok((select count(*) from audit_events where action in
    ('brief.approved','transcript.corrected','brief.evidence_changed','profile.approved')) >= 5,
    'decisions are written to the audit log');
end $$;

-- Brand profiles -----------------------------------------------------------------
do $$
declare bp uuid; v3 uuid;
begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.create_brand_profile_draft(%L, '{}'::jsonb)$q$, (select v from t_ids where k='hitz'))),
    'show-scoped producer cannot draft the brand profile');

  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  execute 'set local role authenticated';
  bp := public.create_brand_profile_draft((select v from t_ids where k='hitz'),
          '{"identity":{"positioning":"Youthful urban hits and talk"}}'::jsonb, 'first');
  execute 'reset role';

  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$update brands set current_profile_version_id=%L where id=%L$q$, bp, (select v from t_ids where k='hitz'))),
    'a draft cannot be made current by editing the brand directly');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000c',
    format('select public.approve_brand_profile(%L)', bp)),
    'a show editor cannot approve a brand profile');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format('select public.approve_brand_profile(%L)', bp)),
    'organisation admin approves the brand profile');
  perform pg_temp.ok((select current_profile_version_id from brands where id=(select v from t_ids where k='hitz')) = bp,
    'approved brand profile becomes current');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b', 'select * from brand_profile_versions') = 1,
    'members can read brand profiles');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$update shows set current_profile_version_id=null where id=%L$q$, (select v from t_ids where k='hitz_morning'))),
    'show profile pointer is also protected');

  update brief_versions set brand_profile_version_id = bp where id = (select v from t_ids where k='v2');
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  execute 'set local role authenticated';
  v3 := public.save_brief_version((select v from t_ids where k='brief'), (select v from t_ids where k='v2'),
          '{"title":"Revised after correction"}'::jsonb, '{}', 'post-correction');
  execute 'reset role';
  perform pg_temp.ok((select brand_profile_version_id from brief_versions where id = v3) = bp,
    'edited versions keep the brand profile version they were written against');
end $$;

-- Creating a source from the app (INSERT ... RETURNING as a signed-in user) ----------
do $$
declare new_id uuid;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  execute 'set local role authenticated';
  insert into sources (org_id, brand_id, show_id, kind, title, share_scope)
  values ((select v from t_ids where k='org'), (select v from t_ids where k='hitz'), (select v from t_ids where k='hitz_morning'),
          'transcript', 'Pasted transcript', 'organisation')
  returning id into new_id;
  execute 'reset role';
  perform pg_temp.ok(new_id is not null, 'a producer can create a source and read it back in the same request');
  perform pg_temp.ok((select status from sources where id = new_id) = 'queued'
    and (select uploaded_by from sources where id = new_id) = '00000000-0000-0000-0000-00000000000b',
    'new sources start queued and record who uploaded them');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$insert into sources (org_id, brand_id, show_id, kind, title) values (%L, %L, %L, 'transcript', 'x') returning id$q$,
      (select v from t_ids where k='org'), (select v from t_ids where k='joy'), (select v from t_ids where k='tys'))),
    'a producer cannot create sources for a show outside their scope');
end $$;

-- Episode map ---------------------------------------------------------------------
insert into episode_maps (org_id, source_id, transcript_fingerprint, model, prompt_version, result)
select (select v from t_ids where k='org'), (select v from t_ids where k='src_shared'), 'fp', 'm', 'p', '{"conversations":[{"key":"c1"}]}';
insert into episode_maps (org_id, source_id, transcript_fingerprint, model, prompt_version, result)
select (select v from t_ids where k='org'), (select v from t_ids where k='src_restricted'), 'fp', 'm', 'p', '{"conversations":[]}';
insert into t_ids select 'map_shared', id from episode_maps where source_id = (select v from t_ids where k='src_shared');
insert into t_ids select 'map_restricted', id from episode_maps where source_id = (select v from t_ids where k='src_restricted');

do $$ begin
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b', 'select * from episode_maps') = 1,
    'Hitz producer sees the map of the shared source only');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from episode_maps') = 0,
    'outsider sees no episode maps');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.enqueue_job(%L, 'map_episode', %L::jsonb, 'map-1')$q$,
      (select v from t_ids where k='org'), jsonb_build_object('source_id', (select v from t_ids where k='src_shared')))),
    'a producer can refresh the map of a source shared with them');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000e',
    format($q$select public.enqueue_job(%L, 'map_episode', %L::jsonb, 'map-2')$q$,
      (select v from t_ids where k='org'), jsonb_build_object('source_id', (select v from t_ids where k='src_shared')))),
    'a commercial user cannot run editorial jobs');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.enqueue_job(%L, 'generate_briefs', %L::jsonb, 'conv-1')$q$,
      (select v from t_ids where k='org'),
      jsonb_build_object('source_id', (select v from t_ids where k='src_shared'), 'episode_map_id', (select v from t_ids where k='map_shared'),
        'conversation_key', 'c1', 'show_ids', jsonb_build_array((select v from t_ids where k='hitz_morning'))))),
    'developing a mapped conversation for an eligible show is allowed');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.enqueue_job(%L, 'generate_briefs', %L::jsonb, 'conv-2')$q$,
      (select v from t_ids where k='org'),
      jsonb_build_object('source_id', (select v from t_ids where k='src_shared'), 'episode_map_id', (select v from t_ids where k='map_restricted'),
        'conversation_key', 'c1', 'show_ids', jsonb_build_array((select v from t_ids where k='hitz_morning'))))),
    'a map from a different source cannot be used');
end $$;

-- YouTube connections ------------------------------------------------------------
insert into youtube_connections (org_id, channel_id, channel_title)
select v, 'UC_test', 'Test Channel' from t_ids where k='org';
insert into youtube_credentials (connection_id, refresh_token)
select id, 'secret-refresh-token' from youtube_connections;

do $$ begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.submit_youtube_oauth_code(%L, 'code', 'http://localhost:5173/integrations/youtube')$q$, (select v from t_ids where k='org'))),
    'a producer cannot connect a YouTube channel');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.submit_youtube_oauth_code(%L, 'code', 'http://localhost:5173/integrations/youtube')$q$, (select v from t_ids where k='org'))),
    'an admin hands the OAuth code to the worker');
  perform pg_temp.ok((select count(*) from jobs where kind = 'youtube_connect') = 1, 'a connect job is queued for the worker');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a', 'select * from youtube_credentials'),
    'refresh tokens are unreadable even for admins');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a', 'select * from oauth_pending'),
    'pending OAuth codes are unreadable from the app');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b', 'select * from youtube_connections') = 1,
    'members can see which channels are connected');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from youtube_connections') = 0,
    'other organisations cannot see our channels');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.enqueue_job(%L, 'youtube_connect', '{}'::jsonb, 'x')$q$, (select v from t_ids where k='org'))),
    'connect jobs cannot be created directly');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.enqueue_job(%L, 'youtube_import', %L::jsonb, 'yt-1')$q$, (select v from t_ids where k='org'),
      jsonb_build_object('source_id', (select v from t_ids where k='src_shared')))),
    'an editor of a source can queue a YouTube import for it');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$update sources set external='{"title":"x"}' where id=%L$q$, (select v from t_ids where k='src_shared'))),
    'platform metadata is written by the worker, not edited by users');
end $$;

\echo 'database tests complete'
