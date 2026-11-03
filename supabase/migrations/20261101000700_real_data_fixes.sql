-- Real-data fixes (found by scripts/real-data-e2e.ts on the tenant's six Pune workbooks). Re-runnable (create or replace only).
--
-- 1. mudar_app.steward_stale_candidates: deterministic total order (lv, entity_type, entity_id) so the stale-record
--    detector can page through the result. PostgREST caps every response at max_rows = 1000, so with 1,231 imported
--    companies the detector saw only 1,000 candidates (the rest were never flagged and could be wrongly marked fresh).
--    changes/steward.ts#runStaleDetector now pages with .range(); paging needs a stable order (ties on created_at are
--    common after a bulk import). Body otherwise unchanged from 20261101000200_capture_imports_round2.sql.
create or replace function mudar_app.steward_stale_candidates(p_ws uuid, p_windows jsonb, p_now timestamptz default now(), p_limit int default 500)
returns table(entity_type text, entity_id uuid, label text, owner_user_id uuid, classification mudar.classification,
              last_verified_at timestamptz, basis text, window_days int)
language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare w_org int := nullif(coalesce((p_windows->>'organisation')::int, 0), 0);
        w_per int := nullif(coalesce((p_windows->>'person')::int, 0), 0);
        w_ast int := nullif(coalesce((p_windows->>'asset')::int, 0), 0);
        w_av  int := nullif(coalesce((p_windows->>'availability')::int, 0), 0);
begin
  p_limit := least(greatest(coalesce(p_limit, 500), 1), 5000);
  return query
  with ver as (
    select f.entity_type, f.entity_id, f.last_verified_at as at from mudar.record_freshness f
     where f.workspace_id = p_ws and f.verified_by is not null and f.archived_at is null
  ), appl as (
    select cp.target_type as entity_type, cp.target_id as entity_id, max(cp.updated_at) as at from mudar.change_proposal cp
     where cp.workspace_id = p_ws and cp.state = 'applied' and cp.target_id is not null and cp.reversal_of is null
       and cp.target_type in ('organisation','person','asset','availability')
     group by 1, 2
  ), org as (
    select 'organisation'::text et, o.id, o.display_name lbl, o.owner_user_id own, o.classification cls,
           o.created_at c, (select v.at from ver v where v.entity_type = 'organisation' and v.entity_id = o.id) v,
           (select a.at from appl a where a.entity_type = 'organisation' and a.entity_id = o.id) a, null::timestamptz obs, w_org w
      from mudar.organisation o where w_org is not null and o.workspace_id = p_ws and o.archived_at is null
  ), per as (
    select 'person'::text, p.id, p.full_name, p.owner_user_id, p.classification, p.created_at,
           (select v.at from ver v where v.entity_type = 'person' and v.entity_id = p.id),
           (select a.at from appl a where a.entity_type = 'person' and a.entity_id = p.id),
           (select max(cm.verified_on)::timestamptz from mudar.contact_method cm where cm.workspace_id = p_ws and cm.person_id = p.id and cm.archived_at is null),
           w_per
      from mudar.person p where w_per is not null and p.workspace_id = p_ws and p.archived_at is null
  ), ast as (
    select 'asset'::text, s.id, s.name, s.owner_user_id, s.classification, s.created_at,
           (select v.at from ver v where v.entity_type = 'asset' and v.entity_id = s.id),
           (select a.at from appl a where a.entity_type = 'asset' and a.entity_id = s.id),
           (select max(coalesce(ao.as_of::timestamptz, ao.created_at)) from mudar.asset_observation ao where ao.workspace_id = p_ws and ao.asset_id = s.id and ao.archived_at is null),
           w_ast
      from mudar.asset s where w_ast is not null and s.workspace_id = p_ws and s.archived_at is null
  ), av as (
    select 'availability'::text, x.id, coalesce(a2.name, 'Space') || coalesce(' · ' || sp.floor_text, '') || ' (' || x.status || ')',
           x.owner_user_id, x.classification, x.as_of::timestamptz,
           (select v.at from ver v where v.entity_type = 'availability' and v.entity_id = x.id),
           (select a.at from appl a where a.entity_type = 'availability' and a.entity_id = x.id), null::timestamptz, w_av
      from (select distinct on (av0.space_id) av0.* from mudar.availability av0
             where w_av is not null and av0.workspace_id = p_ws and av0.archived_at is null
             order by av0.space_id, av0.as_of desc, av0.created_at desc) x
      join mudar.space sp on sp.id = x.space_id
      left join mudar.asset a2 on a2.id = sp.asset_id
     where x.status in ('available','under_offer')
  ), allr as (
    select * from org union all select * from per union all select * from ast union all select * from av
  ), scored as (
    select r.*, greatest(r.c, coalesce(r.v, '-infinity'), coalesce(r.a, '-infinity'), coalesce(r.obs, '-infinity')) lv from allr r
  )
  select s.et, s.id, s.lbl, s.own, s.cls, s.lv,
         case when s.v is not null and s.v = s.lv then 'marked_verified'
              when s.a is not null and s.a = s.lv then 'approved_change'
              when s.obs is not null and s.obs = s.lv then case s.et when 'person' then 'contact_verified' else 'source_observation' end
              else case s.et when 'availability' then 'snapshot_as_of' else 'created' end end,
         s.w
    from scored s
   where s.lv < p_now - make_interval(days => s.w)
   order by s.lv asc, s.et asc, s.id asc
   limit p_limit;
end $$;
revoke execute on function mudar_app.steward_stale_candidates(uuid, jsonb, timestamptz, int) from public, anon, authenticated;
grant execute on function mudar_app.steward_stale_candidates(uuid, jsonb, timestamptz, int) to service_role;
