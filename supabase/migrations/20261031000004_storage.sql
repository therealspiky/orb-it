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
