-- Module: search (spec §2.9 advanced NL + structured search, §14.4 structured queries for authoritative records).
-- Two SECURITY INVOKER functions (caller's RLS applies to every row; workspace filtered explicitly too):
--   mudar_app.find_accounts(ws, filter jsonb, today, limit) -> jsonb {results, coverage}
--   mudar_app.search_everything(ws, q, types, from, to, statuses, geography ids, source, limit) -> table
-- The filter is a typed object validated by zod in src/modules/search/filter.ts. Values are only ever bound as
-- parameters / read from jsonb — no SQL is built from text (S7). Re-runnable.

drop function if exists mudar_app.find_accounts(uuid, jsonb, date, int);
create function mudar_app.find_accounts(p_workspace uuid, p_filter jsonb, p_today date default null, p_limit int default 50)
returns jsonb
language plpgsql stable security invoker set search_path = mudar, mudar_app, public, extensions as $$
declare
  f jsonb := coalesce(p_filter, '{}'::jsonb);
  today date := coalesce(p_today, (now() at time zone 'Asia/Kolkata')::date);
  lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
  area_min numeric := nullif(f->>'areaMin', '')::numeric;
  area_max numeric := nullif(f->>'areaMax', '')::numeric;
  basis text := coalesce(nullif(f->>'areaBasis', ''), 'any');
  geo uuid[] := (select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(f->'geographyIds', '[]')) x);
  places text[] := (select array_agg(lower(x)) from jsonb_array_elements_text(coalesce(f->'placeNames', '[]')) x);
  grades text[] := (select array_agg(upper(x)) from jsonb_array_elements_text(coalesce(f->'grades', '[]')) x);
  ev_types text[] := (select array_agg(x) from jsonb_array_elements_text(coalesce(f->'eventTypes', '[]')) x);
  ev_from date := nullif(f->>'eventFrom', '')::date;
  ev_to date := nullif(f->>'eventTo', '')::date;
  sectors text[] := (select array_agg(lower(x)) from jsonb_array_elements_text(coalesce(f->'sectors', '[]')) x);
  known boolean := coalesce((f->>'knownContact')::boolean, false);
  sig_kinds text[] := (select array_agg(lower(x)) from jsonb_array_elements_text(coalesce(f->'signalKinds', '[]')) x);
  sig_since date := nullif(f->>'signalSince', '')::date;
  bands text[] := (select array_agg(lower(x)) from jsonb_array_elements_text(coalesce(f->'scoreBands', '[]')) x);
  req_status text[] := (select array_agg(x) from jsonb_array_elements_text(coalesce(f->'requirementStatuses', '[]')) x);
  open_opp boolean := (f->>'hasOpenOpportunity')::boolean;
  want_area boolean;
  want_events boolean;
  want_loc boolean;
  out jsonb;
begin
  if not mudar_app.is_member(p_workspace) then
    return jsonb_build_object('results', '[]'::jsonb, 'coverage', jsonb_build_object('candidates', 0));
  end if;
  want_area := area_min is not null or area_max is not null;
  want_events := coalesce(array_length(ev_types, 1), 0) > 0 or ev_from is not null or ev_to is not null;
  want_loc := coalesce(array_length(geo, 1), 0) > 0 or coalesce(array_length(places, 1), 0) > 0;
  if want_events and coalesce(array_length(ev_types, 1), 0) = 0 then
    ev_types := array['expiry', 'lockin_end', 'notice_deadline', 'break'];
  end if;

  with
  geo_all as (  -- selected geographies + descendants
    select g.id from mudar.geography g where g.workspace_id = p_workspace and g.id = any(coalesce(geo, '{}'))
    union
    select c.id from mudar.geography c join mudar.geography p on p.id = c.parent_id
     where c.workspace_id = p_workspace and p.id = any(coalesce(geo, '{}'))
    union
    select gc.id from mudar.geography gc join mudar.geography c on c.id = gc.parent_id join mudar.geography p on p.id = c.parent_id
     where gc.workspace_id = p_workspace and p.id = any(coalesce(geo, '{}'))
  ),
  orgs as (
    select o.id, o.display_name, o.sector
    from mudar.organisation o
    where o.workspace_id = p_workspace and o.archived_at is null
      and (coalesce(array_length(sectors, 1), 0) = 0
           or exists (select 1 from unnest(sectors) s where lower(coalesce(o.sector, '')) like '%' || mudar_app.like_escape(s) || '%'))
  ),
  -- current leases of candidate companies, with building location/grade
  ls as (
    select l.id, l.tenant_org_id as org_id, l.area_sf, l.area_basis, l.contractual_expiry, l.fact_status::text as fs,
           coalesce(a.name, l.tenant_name_raw) as building, a.id as asset_id,
           upper(coalesce(a.grade, pa.grade)) as grade,
           (not want_loc
             or coalesce(a.locality_id, pa.locality_id) in (select id from geo_all)
             or coalesce(a.micro_market_id, pa.micro_market_id) in (select id from geo_all)) as in_loc
    from mudar.lease l
    left join mudar.asset a on a.id = l.asset_id and a.workspace_id = p_workspace
    left join mudar.asset pa on pa.id = a.parent_asset_id and pa.workspace_id = p_workspace
    where l.workspace_id = p_workspace and l.archived_at is null
      and l.tenant_org_id in (select id from orgs)
      and coalesce(l.status, 'unknown') not in ('expired', 'terminated', 'surrendered')
      and (l.contractual_expiry is null or l.contractual_expiry >= today)
  ),
  ls_scope as (  -- leases that count for this filter (location + grade)
    select * from ls
    where in_loc and (coalesce(array_length(grades, 1), 0) = 0 or grade = any(grades))
  ),
  area as (
    select org_id,
           sum(area_sf) filter (where area_sf is not null and (basis = 'any' or area_basis = basis)) as area_sf,
           count(*) filter (where area_sf is not null and (basis = 'any' or area_basis = basis)) as n_known,
           count(*) as n_leases,
           string_agg(distinct area_basis, ',') filter (where area_sf is not null) as bases
    from ls_scope group by org_id
  ),
  ev as (
    select s.org_id, e.lease_id, e.event_type, e.event_date, e.confirmed
    from ls_scope s join mudar.lease_event e on e.lease_id = s.id
    where e.workspace_id = p_workspace and e.archived_at is null and e.event_date is not null
    union all  -- contractual expiry stands in for an expiry event that was not computed
    select s.org_id, s.id, 'expiry', s.contractual_expiry, null
    from ls_scope s
    where s.contractual_expiry is not null
      and not exists (select 1 from mudar.lease_event e where e.lease_id = s.id and e.event_type = 'expiry' and e.archived_at is null)
  ),
  ev_hit as (
    select org_id, jsonb_agg(jsonb_build_object('leaseId', lease_id, 'type', event_type, 'date', event_date, 'confirmed', confirmed)
                             order by event_date) as events
    from ev
    where event_type = any(coalesce(ev_types, '{}')) and (ev_from is null or event_date >= ev_from) and (ev_to is null or event_date <= ev_to)
    group by org_id
  ),
  ev_known as (select distinct org_id from ev),
  loc_ol as (  -- location via company locations (when there is no lease in the place)
    select distinct ol.org_id
    from mudar.org_location ol
    where ol.workspace_id = p_workspace and ol.archived_at is null and want_loc
      and (ol.geography_id in (select id from geo_all)
           or exists (select 1 from unnest(coalesce(places, '{}')) p
                      where lower(coalesce(ol.area, '')) like '%' || mudar_app.like_escape(p) || '%'
                         or lower(coalesce(ol.city, '')) = p))
  ),
  contacts as (
    select e.org_id, jsonb_agg(distinct jsonb_build_object('personId', p.id, 'name', p.full_name, 'title', e.title,
             'basis', case when k.n_int > 0 then k.n_int || ' interaction' || case when k.n_int > 1 then 's' else '' end
                           else 'relationship on record' end)) as people
    from mudar.employment e
    join mudar.person p on p.id = e.person_id and p.workspace_id = p_workspace and p.archived_at is null
    cross join lateral (
      select (select count(distinct il.interaction_id) from mudar.interaction_link il
               join mudar.interaction i on i.id = il.interaction_id and i.archived_at is null
              where il.workspace_id = p_workspace and il.entity_type = 'person' and il.entity_id = p.id and il.archived_at is null) as n_int,
             exists (select 1 from mudar.relationship_edge r where r.workspace_id = p_workspace and r.archived_at is null
                      and r.to_person_id = p.id and (r.valid_to is null or r.valid_to >= today))
             or exists (select 1 from mudar.relationship_context rc where rc.workspace_id = p_workspace and rc.archived_at is null
                         and rc.person_id = p.id) as has_rel
    ) k
    where e.workspace_id = p_workspace and e.archived_at is null and e.is_current
      and e.org_id in (select id from orgs) and (k.n_int > 0 or k.has_rel)
    group by e.org_id
  ),
  sigs as (
    select s.org_id, jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'category', s.category, 'title', s.title,
                                                  'detectedAt', s.detected_at::date) order by s.detected_at desc) as signals
    from mudar.signal s
    where s.workspace_id = p_workspace and s.archived_at is null and s.org_id in (select id from orgs)
      and (coalesce(array_length(sig_kinds, 1), 0) = 0 or lower(s.kind) = any(sig_kinds) or lower(s.category) = any(sig_kinds)
           or exists (select 1 from unnest(sig_kinds) k where lower(s.kind) like '%' || mudar_app.like_escape(k) || '%'))
      and (sig_since is null or s.detected_at::date >= sig_since)
    group by s.org_id
  ),
  score as (
    select distinct on (r.entity_id) r.entity_id as org_id, r.band, r.score
    from mudar.score_result r
    where r.workspace_id = p_workspace and r.is_current and r.archived_at is null and r.model_key = 'lead'
      and r.entity_type = 'organisation'
    order by r.entity_id, r.calculated_at desc
  ),
  reqs as (
    select r.org_id, jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status)) as requirements
    from mudar.requirement r
    where r.workspace_id = p_workspace and r.archived_at is null and r.org_id in (select id from orgs)
      and (coalesce(array_length(req_status, 1), 0) = 0 or r.status = any(req_status))
    group by r.org_id
  ),
  opps as (
    select o.org_id, jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'stage', o.stage)) as opportunities
    from mudar.opportunity o
    where o.workspace_id = p_workspace and o.archived_at is null and coalesce(o.outcome, 'open') = 'open'
      and o.org_id in (select id from orgs)
    group by o.org_id
  ),
  eval as (
    select o.id, o.display_name, o.sector, a.area_sf, a.bases, a.n_leases, a.n_known,
           (exists (select 1 from ls_scope s where s.org_id = o.id) or o.id in (select org_id from loc_ol)) as loc_ok,
           case when not want_area then true
                when coalesce(a.n_known, 0) = 0 then null
                else (area_min is null or a.area_sf >= area_min) and (area_max is null or a.area_sf <= area_max) end as area_ok,
           case when not want_events then true
                when h.events is not null then true
                when o.id not in (select org_id from ev_known) then null
                else false end as ev_ok,
           h.events, c.people, sg.signals, sc.band, sc.score, rq.requirements, op.opportunities
    from orgs o
    left join area a on a.org_id = o.id
    left join ev_hit h on h.org_id = o.id
    left join contacts c on c.org_id = o.id
    left join sigs sg on sg.org_id = o.id
    left join score sc on sc.org_id = o.id
    left join reqs rq on rq.org_id = o.id
    left join opps op on op.org_id = o.id
  ),
  base as (  -- every filter except the two lease-data ones (area, lease events), so coverage is honest
    select * from eval e
    where (not want_loc or e.loc_ok)
      and (coalesce(array_length(grades, 1), 0) = 0 or exists (select 1 from ls_scope s where s.org_id = e.id))
      and (not known or e.people is not null)
      and ((coalesce(array_length(sig_kinds, 1), 0) = 0 and sig_since is null) or e.signals is not null)
      and (coalesce(array_length(bands, 1), 0) = 0 or lower(e.band) = any(bands))
      and (coalesce(array_length(req_status, 1), 0) = 0 or e.requirements is not null)
      and (open_opp is null or (open_opp = (e.opportunities is not null)))
  ),
  hits as (
    select * from base where area_ok is true and ev_ok is true
  )
  select jsonb_build_object(
    'results', coalesce((
      select jsonb_agg(row_to_json(x)::jsonb) from (
        select h.id as "orgId", h.display_name as name, h.sector, h.area_sf as "areaSf", h.bases as "areaBasis",
               h.n_leases as "leasesInScope", h.n_known as "leasesWithArea",
               (select jsonb_agg(jsonb_build_object('id', s.id, 'building', s.building, 'assetId', s.asset_id, 'areaSf', s.area_sf,
                                                    'areaBasis', s.area_basis, 'grade', s.grade, 'expiry', s.contractual_expiry,
                                                    'factStatus', s.fs))
                  from ls_scope s where s.org_id = h.id) as leases,
               h.events, h.people as contacts, h.signals, h.band as "scoreBand", h.score,
               h.requirements, h.opportunities
        from hits h
        order by h.score desc nulls last, h.area_sf desc nulls last, h.display_name
        limit lim) x), '[]'::jsonb),
    'coverage', jsonb_build_object(
      'companiesChecked', (select count(*) from orgs),
      'candidates', (select count(*) from base),
      'matched', (select count(*) from hits),
      'areaUnknown', case when want_area then (select count(*) from base where area_ok is null) end,
      'eventsUnknown', case when want_events then (select count(*) from base where ev_ok is null) end,
      'truncated', (select count(*) from hits) > lim))
  into out;
  return out;
end $$;
revoke all on function mudar_app.find_accounts(uuid, jsonb, date, int) from public, anon;
grant execute on function mudar_app.find_accounts(uuid, jsonb, date, int) to authenticated, service_role;

-- ==================================================================== expanded global search
drop function if exists mudar_app.search_everything(uuid, text, text[], date, date, text[], uuid[], text, int);
create function mudar_app.search_everything(
  p_workspace uuid,
  p_query text,
  p_types text[] default null,
  p_from date default null,
  p_to date default null,
  p_statuses text[] default null,
  p_geography uuid[] default null,
  p_source text default null,
  p_limit int default 50)
returns table(entity_type text, id uuid, parent_id uuid, title text, subtitle text, status_label text, source text,
              occurred_on date, location text, classification mudar.classification, fact_status text, score real)
language plpgsql stable security invoker set search_path = mudar, mudar_app, public, extensions as $$
declare
  q text := btrim(coalesce(p_query, ''));
  lq text;
  lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
  geo uuid[];
  has_geo boolean := coalesce(array_length(p_geography, 1), 0) > 0;
  sts text[] := (select array_agg(lower(x)) from unnest(coalesce(p_statuses, '{}')) x);
  src text := nullif(btrim(coalesce(p_source, '')), '');
begin
  if not mudar_app.is_member(p_workspace) then return; end if;
  lq := '%' || mudar_app.like_escape(q) || '%';
  select array_agg(distinct g) into geo from (
    select x as g from unnest(coalesce(p_geography, '{}')) x
    union select c.id from mudar.geography c where c.workspace_id = p_workspace and c.parent_id = any(coalesce(p_geography, '{}'))
    union select gc.id from mudar.geography gc join mudar.geography c on c.id = gc.parent_id
           where gc.workspace_id = p_workspace and c.parent_id = any(coalesce(p_geography, '{}'))) s;

  return query
  with
  core as (  -- the original five types (companies, people, buildings, requirements, opportunities)
    select s.entity_type, s.id, null::uuid as parent_id, s.title, s.subtitle, s.status_label, null::text as source,
           s.freshness::date as occurred_on, null::text as location, s.classification, s.fact_status, s.score
    from mudar_app.search_entities(p_workspace, q, array(select t from unnest(coalesce(p_types,
           array['organisation','person','asset','requirement','opportunity'])) t
           where t in ('organisation','person','asset','requirement','opportunity')), null, 200, false) s
    where length(q) > 0
  ),
  leases as (
    select 'lease'::text, l.id, l.tenant_org_id, coalesce(og.display_name, l.tenant_name_raw, 'Lease') || ' — ' || coalesce(a.name, 'unknown building'),
           nullif(concat_ws(' · ', case when l.area_sf is not null then round(l.area_sf)::text || ' sf ' || coalesce(l.area_basis, '(basis unknown)') end,
                            case when l.contractual_expiry is not null then 'expires ' || l.contractual_expiry end), ''),
           l.status, 'lease'::text, coalesce(l.contractual_expiry, l.start_date), gl.name, l.classification, l.fact_status::text,
           (case when length(q) = 0 then 0 else greatest(similarity(coalesce(og.display_name, l.tenant_name_raw, ''), q), similarity(coalesce(a.name, ''), q)) end)::real
    from mudar.lease l
    left join mudar.organisation og on og.id = l.tenant_org_id
    left join mudar.asset a on a.id = l.asset_id
    left join mudar.asset pa on pa.id = a.parent_asset_id
    left join mudar.geography gl on gl.id = coalesce(a.micro_market_id, a.locality_id, pa.micro_market_id, pa.locality_id)
    where l.workspace_id = p_workspace and l.archived_at is null
      and (p_types is null or 'lease' = any(p_types))
      and (not has_geo or coalesce(a.micro_market_id, pa.micro_market_id) = any(geo) or coalesce(a.locality_id, pa.locality_id) = any(geo))
      and (length(q) = 0 or og.display_name ilike lq or l.tenant_name_raw ilike lq or a.name ilike lq or pa.name ilike lq or l.registration_ref ilike lq)
  ),
  spaces as (
    select 'space'::text, sp.id, sp.asset_id, a.name || ' — ' || concat_ws(' ', 'Floor ' || sp.floor_text, 'Unit ' || sp.unit),
           nullif(concat_ws(' · ', case when sp.chargeable_sf is not null then round(sp.chargeable_sf) || ' sf chargeable' end,
                            case when sp.carpet_sf is not null then round(sp.carpet_sf) || ' sf carpet' end), ''),
           av.status, 'space'::text, coalesce(av.as_of, sp.updated_at::date), gl.name, sp.classification, av.fs,
           (case when length(q) = 0 then 0 else similarity(a.name || ' ' || coalesce(sp.floor_text, '') || ' ' || coalesce(sp.unit, ''), q) end)::real
    from mudar.space sp
    join mudar.asset a on a.id = sp.asset_id
    left join mudar.asset pa on pa.id = a.parent_asset_id
    left join mudar.geography gl on gl.id = coalesce(a.micro_market_id, a.locality_id, pa.micro_market_id, pa.locality_id)
    left join lateral (select v.status, v.as_of, v.fact_status::text as fs from mudar.availability v
                        where v.space_id = sp.id and v.archived_at is null order by v.as_of desc limit 1) av on true
    where sp.workspace_id = p_workspace and sp.archived_at is null
      and (p_types is null or 'space' = any(p_types))
      and (not has_geo or coalesce(a.micro_market_id, pa.micro_market_id) = any(geo) or coalesce(a.locality_id, pa.locality_id) = any(geo))
      and (length(q) = 0 or a.name ilike lq or pa.name ilike lq or sp.floor_text ilike lq or sp.unit ilike lq
           or (a.name || ' ' || coalesce(sp.floor_text, '') || ' ' || coalesce(sp.unit, '')) ilike lq)
  ),
  meetings as (
    select 'meeting'::text, m.id, m.linked_entity_id, m.title, nullif(concat_ws(' · ', m.kind, m.location), ''),
           m.status, coalesce(m.provider, 'manual'), (m.start_at at time zone 'Asia/Kolkata')::date, m.location, m.classification, null::text,
           (case when length(q) = 0 then 0 else similarity(coalesce(m.title, ''), q) end)::real
    from mudar.meeting_visit m
    where m.workspace_id = p_workspace and m.archived_at is null and not has_geo
      and (p_types is null or 'meeting' = any(p_types))
      and (length(q) = 0 or m.title ilike lq or m.location ilike lq)
  ),
  tasks as (
    select 'task'::text, t.id, t.linked_entity_id, t.title, left(t.description, 160), t.status, t.source,
           (t.due_at at time zone 'Asia/Kolkata')::date, null::text, t.classification, null::text,
           (case when length(q) = 0 then 0 else similarity(t.title, q) end)::real
    from mudar.task t
    where t.workspace_id = p_workspace and t.archived_at is null and not has_geo
      and (p_types is null or 'task' = any(p_types))
      and (length(q) = 0 or t.title ilike lq or t.description ilike lq)
  ),
  sigs as (
    select 'signal'::text, s.id, s.org_id, s.title, nullif(concat_ws(' · ', s.category, s.kind, s.location_text), ''),
           s.status, 'signal:' || s.category, s.detected_at::date, s.location_text, s.classification, s.verification,
           (case when length(q) = 0 then 0 else greatest(similarity(s.title, q), similarity(coalesce(s.entity_name_raw, ''), q)) end)::real
    from mudar.signal s
    where s.workspace_id = p_workspace and s.archived_at is null and not has_geo
      and (p_types is null or 'signal' = any(p_types))
      and (length(q) = 0 or s.title ilike lq or s.summary ilike lq or s.entity_name_raw ilike lq or s.kind ilike lq)
  ),
  docs as (
    select 'document'::text, d.id, d.linked_entity_id, coalesce(d.purpose, d.kind) || ' v' || coalesce(d.version_no, 1), d.kind,
           d.status, 'generated:' || d.kind, d.updated_at::date, null::text, d.classification, null::text,
           (case when length(q) = 0 then 0 else similarity(coalesce(d.purpose, d.kind), q) end)::real
    from mudar.document_version d
    where d.workspace_id = p_workspace and d.archived_at is null and not has_geo
      and (p_types is null or 'document' = any(p_types))
      and (length(q) = 0 or d.purpose ilike lq or d.kind ilike lq)
    union all
    select 'legal_document'::text, ld.id, coalesce(ld.org_id, ld.opportunity_id), ld.title,
           nullif(concat_ws(' · ', ld.doc_kind, 'v' || ld.version), ''), ld.status, 'upload:' || coalesce(ld.file_kind, ld.doc_kind),
           ld.updated_at::date, null::text, ld.classification, case when ld.ocr_unverified then 'ocr_unverified' end,
           (case when length(q) = 0 then 0 else similarity(ld.title, q) end)::real
    from mudar.legal_document ld
    where ld.workspace_id = p_workspace and ld.archived_at is null and not has_geo
      and (p_types is null or 'legal_document' = any(p_types))
      and (length(q) = 0 or ld.title ilike lq or ld.doc_kind ilike lq)
  ),
  quotes as (
    select 'quote'::text, qt.id, qt.requirement_id,
           coalesce(og.display_name, 'Quote') || ' — ' || coalesce(qt.kind, 'quote') || ' v' || qt.version,
           nullif(concat_ws(' · ', a.name, case when qt.valid_until is not null then 'valid until ' || qt.valid_until end), ''),
           case when qt.superseded_by is not null then 'superseded' when qt.approved_at is not null then 'approved' else 'draft' end,
           'quote:' || coalesce(qt.kind, 'quote'), coalesce(qt.valid_until, qt.updated_at::date), gl.name, qt.classification, null::text,
           (case when length(q) = 0 then 0 else greatest(similarity(coalesce(og.display_name, ''), q), similarity(coalesce(a.name, ''), q)) end)::real
    from mudar.quote qt
    left join mudar.organisation og on og.id = qt.counterparty_org_id
    left join mudar.space sp on sp.id = qt.space_id
    left join mudar.asset a on a.id = sp.asset_id
    left join mudar.geography gl on gl.id = coalesce(a.micro_market_id, a.locality_id)
    where qt.workspace_id = p_workspace and qt.archived_at is null
      and (p_types is null or 'quote' = any(p_types))
      and (not has_geo or a.micro_market_id = any(geo) or a.locality_id = any(geo))
      and (length(q) = 0 or og.display_name ilike lq or a.name ilike lq or qt.kind ilike lq)
  ),
  convs as (
    select 'conversation'::text, c.id, c.context_entity_id, coalesce(c.title, 'Untitled conversation'), left(c.summary, 160),
           case when c.pinned then 'pinned' else 'open' end, 'assistant'::text,
           coalesce(c.last_message_at, c.updated_at)::date, null::text, c.classification, null::text,
           (case when length(q) = 0 then 0 else similarity(coalesce(c.title, ''), q) end)::real
    from mudar.assistant_conversation c
    where c.workspace_id = p_workspace and c.archived_at is null and not has_geo
      and (p_types is null or 'conversation' = any(p_types))
      and (length(q) = 0 or c.title ilike lq or c.summary ilike lq)
  ),
  core_geo as (  -- location filter for the original types: buildings by geography, companies by lease/location
    select c.* from core c
    where not has_geo
       or (c.entity_type = 'asset' and exists (select 1 from mudar.asset a left join mudar.asset pa on pa.id = a.parent_asset_id
             where a.id = c.id and (coalesce(a.micro_market_id, pa.micro_market_id) = any(geo) or coalesce(a.locality_id, pa.locality_id) = any(geo))))
       or (c.entity_type = 'organisation' and (
             exists (select 1 from mudar.org_location ol where ol.org_id = c.id and ol.archived_at is null and ol.geography_id = any(geo))
             or exists (select 1 from mudar.lease l join mudar.asset a on a.id = l.asset_id
                        where l.tenant_org_id = c.id and l.archived_at is null and (a.micro_market_id = any(geo) or a.locality_id = any(geo)))))
  ),
  allr as (
    select * from core_geo
    union all select * from leases union all select * from spaces union all select * from meetings
    union all select * from tasks union all select * from sigs union all select * from docs
    union all select * from quotes union all select * from convs
  )
  select r.* from allr r
  where (p_from is null or r.occurred_on >= p_from)
    and (p_to is null or r.occurred_on <= p_to)
    and (coalesce(array_length(sts, 1), 0) = 0 or lower(coalesce(r.status_label, '')) = any(sts))
    and (src is null or r.source ilike '%' || mudar_app.like_escape(src) || '%')
  order by r.score desc, r.occurred_on desc nulls last
  limit lim;
end $$;
revoke all on function mudar_app.search_everything(uuid, text, text[], date, date, text[], uuid[], text, int) from public, anon;
grant execute on function mudar_app.search_everything(uuid, text, text[], date, date, text[], uuid[], text, int) to authenticated, service_role;
