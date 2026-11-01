-- Fix: inserting a source from the app failed with "new row violates row-level
-- security policy". The read policy looked the row up by id, but a row being
-- inserted is not visible to that lookup during INSERT ... RETURNING. The read
-- rule is now evaluated on the row's own columns.

create or replace function public.source_visible(
  p_org uuid, p_brand uuid, p_show uuid, p_scope public.share_scope
) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_scope(p_org, p_brand, p_show, public.all_roles())
      or (p_scope = 'organisation' and public.is_member(p_org))
      or (p_scope = 'brand' and public.touches_brand(p_org, p_brand))
      or (p_scope = 'show' and p_show is null and public.touches_brand(p_org, p_brand))
$$;

-- Keep the id-based helper (used by transcripts, maps, storage) consistent with it.
create or replace function public.can_read_source(p_source uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from sources s
    where s.id = p_source and public.source_visible(s.org_id, s.brand_id, s.show_id, s.share_scope)
  )
$$;

drop policy if exists sources_select on public.sources;
create policy sources_select on public.sources for select to authenticated
  using (public.source_visible(org_id, brand_id, show_id, share_scope));
