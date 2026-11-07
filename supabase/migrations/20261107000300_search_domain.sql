-- DB-029: company search also matches website domain.
drop function if exists mudar_app.search_entities(uuid, text, text[], date, int, boolean);
create function mudar_app.search_entities(
  p_workspace uuid,
  p_query text,
  p_types text[] default null,
  p_as_of date default null,
  p_limit int default 50,
  p_include_archived boolean default false)
returns table(
  entity_type text, id uuid, title text, subtitle text, snippet text,
  classification mudar.classification, fact_status text, status_label text,
  freshness timestamptz, matched_alias text, score real, archived boolean)
language plpgsql stable security invoker set search_path = mudar, mudar_app, public, extensions as $$
declare
  q text := btrim(coalesce(p_query, ''));
  tsq tsquery;
  like_q text;
  qhash text;
  lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not mudar_app.is_member(p_workspace) then
    return;
  end if;
  -- p_as_of selects which FACTS are shown (employment / availability valid on that date); it does not hide
  -- records entered later, because a record captured today can describe a role held in 2024.
  if length(q) > 0 then
    select to_tsquery('simple', string_agg(quote_literal(t) || ':*', ' & '))
      into tsq
      from regexp_split_to_table(mudar_app.normalise_alias(q), '\s+') t
     where t <> '';
    like_q := '%' || mudar_app.like_escape(q) || '%';
    qhash := encode(extensions.digest(lower(q), 'sha256'), 'hex');
  end if;

  return query
  with al as (
    select * from mudar_app.alias_matches(p_workspace, q) where length(q) > 0
  ),
  orgs as (
    select 'organisation'::text as etype, o.id, o.display_name as title,
           nullif(concat_ws(' · ', o.legal_name, o.sector, o.domain::text), '') as subtitle,
           o.contact_restrictions as snippet, o.classification,
           null::text as fact_status,
           coalesce(o.source_confidence, case when o.crm_external_id is not null then 'CRM linked' end) as status_label,
           o.updated_at as freshness,
           (select a.raw_alias from al a where a.entity_type = 'organisation' and a.entity_id = o.id order by a.sim desc limit 1) as matched_alias,
           (case when length(q) = 0 then 0
                 else greatest(coalesce(ts_rank(o.search, tsq), 0), similarity(o.display_name, q),
                               coalesce((select max(a.sim) from al a where a.entity_type = 'organisation' and a.entity_id = o.id), 0)) end)::real as score,
           o.archived_at is not null as archived
    from mudar.organisation o
    where o.workspace_id = p_workspace
      and (p_types is null or 'organisation' = any(p_types))
      and (p_include_archived or o.archived_at is null)
      and (length(q) = 0 or o.search @@ tsq or o.display_name ilike like_q or o.legal_name ilike like_q
           or q <% o.display_name or o.cin = upper(q) or o.gstin = upper(q) or o.domain::text ilike like_q
           or exists (select 1 from al a where a.entity_type = 'organisation' and a.entity_id = o.id))
  ),
  people as (
    select 'person'::text, p.id, p.full_name,
           nullif(concat_ws(' @ ', emp.title, emp.org_name), ''),
           p.contact_restrictions, p.classification,
           emp.fs,
           case when emp.fs is null then 'no employment on record'
                when emp.is_current then 'current role' else 'role as of date' end,
           p.updated_at,
           coalesce((select a.raw_alias from al a where a.entity_type = 'person' and a.entity_id = p.id order by a.sim desc limit 1),
                    (select x from unnest(p.aliases) x where length(q) > 0 and x ilike like_q limit 1)),
           (case when length(q) = 0 then 0
                 else greatest(coalesce(ts_rank(p.search, tsq), 0), similarity(p.full_name, q),
                               case when exists (select 1 from mudar.contact_method c where c.person_id = p.id and c.value_hash = qhash) then 1 else 0 end,
                               coalesce((select max(a.sim) from al a where a.entity_type = 'person' and a.entity_id = p.id), 0)) end)::real,
           p.archived_at is not null
    from mudar.person p
    left join lateral (
      select e.title, e.fact_status::text as fs, og.display_name as org_name, e.is_current
      from mudar.employment e
      left join mudar.organisation og on og.id = e.org_id
      where e.person_id = p.id and e.archived_at is null
        and case when p_as_of is null then e.is_current
                 else (e.start_date is null or e.start_date <= p_as_of) and (e.end_date is null or e.end_date >= p_as_of) end
      order by e.start_date desc nulls last
      limit 1
    ) emp on true
    where p.workspace_id = p_workspace
      and (p_types is null or 'person' = any(p_types))
      and (p_include_archived or p.archived_at is null)
      and (length(q) = 0 or p.search @@ tsq or p.full_name ilike like_q or q <% p.full_name
           or exists (select 1 from mudar.contact_method c where c.person_id = p.id and c.value_hash = qhash)
           or exists (select 1 from al a where a.entity_type = 'person' and a.entity_id = p.id))
  ),
  assets as (
    select 'asset'::text, a.id, a.name,
           nullif(concat_ws(' · ', initcap(a.asset_kind), par.name, coalesce(loc.name, a.address)), ''),
           a.floor_size_text, a.classification,
           av.fs,
           case when av.status is null then 'no availability evidence'
                when av.valid_until is not null and av.valid_until < coalesce(p_as_of, current_date) then av.status || ' (expired ' || av.valid_until || ')'
                else av.status || ' as of ' || av.as_of end,
           coalesce(av.as_of::timestamptz, a.updated_at),
           (select x.raw_alias from al x where x.entity_type in ('asset', 'building') and x.entity_id = a.id order by x.sim desc limit 1),
           (case when length(q) = 0 then 0
                 else greatest(coalesce(ts_rank(a.search, tsq), 0), similarity(a.name, q),
                               coalesce((select max(x.sim) from al x where x.entity_type in ('asset', 'building') and x.entity_id = a.id), 0)) end)::real,
           a.archived_at is not null
    from mudar.asset a
    left join mudar.asset par on par.id = a.parent_asset_id
    left join mudar.geography loc on loc.id = coalesce(a.locality_id, a.micro_market_id)
    left join lateral (
      select v.status, v.fact_status::text as fs, v.as_of, v.valid_until
      from mudar.availability v join mudar.space s on s.id = v.space_id
      where s.asset_id = a.id and v.archived_at is null and (p_as_of is null or v.as_of <= p_as_of)
      order by v.as_of desc
      limit 1
    ) av on true
    where a.workspace_id = p_workspace
      and (p_types is null or 'asset' = any(p_types))
      and (p_include_archived or a.archived_at is null)
      and (length(q) = 0 or a.search @@ tsq or a.name ilike like_q or q <% a.name or par.name ilike like_q
           or exists (select 1 from al x where x.entity_type in ('asset', 'building') and x.entity_id = a.id))
  ),
  reqs as (
    select 'requirement'::text, r.id, r.title,
           nullif(concat_ws(' · ', og.display_name, r.objective,
                  case when r.area_target_sf is not null then r.area_target_sf::bigint || ' sf target' end), ''),
           null::text, r.classification,
           case r.status when 'client_confirmed' then 'currently_confirmed' when 'estimated' then 'ai_inference'
                         when 'draft' then 'reported' else 'unknown' end,
           r.status,
           r.updated_at,
           null::text,
           (case when length(q) = 0 then 0 else greatest(coalesce(ts_rank(r.search, tsq), 0), similarity(r.title, q)) end)::real,
           r.archived_at is not null
    from mudar.requirement r
    left join mudar.organisation og on og.id = r.org_id
    where r.workspace_id = p_workspace
      and (p_types is null or 'requirement' = any(p_types))
      and (p_include_archived or r.archived_at is null)
      and (length(q) = 0 or r.search @@ tsq or r.title ilike like_q or q <% r.title or og.display_name ilike like_q)
  ),
  opps as (
    select 'opportunity'::text, op.id, op.name,
           nullif(concat_ws(' · ', og.display_name, replace(op.stage, '_', ' '), op.outcome), ''),
           op.next_action, op.classification,
           null::text,
           op.stage,
           op.updated_at,
           null::text,
           (case when length(q) = 0 then 0 else greatest(similarity(op.name, q), case when og.display_name ilike like_q then 0.5 else 0 end) end)::real,
           op.archived_at is not null
    from mudar.opportunity op
    left join mudar.organisation og on og.id = op.org_id
    where op.workspace_id = p_workspace
      and (p_types is null or 'opportunity' = any(p_types))
      and (p_include_archived or op.archived_at is null)
      and (length(q) = 0 or op.name ilike like_q or q <% op.name or og.display_name ilike like_q)
  ),
  allr as (
    select * from orgs union all select * from people union all select * from assets
    union all select * from reqs union all select * from opps
  )
  select * from allr
  order by 11 desc, 9 desc nulls last
  limit lim;
end $$;

revoke all on function mudar_app.search_entities(uuid, text, text[], date, int, boolean) from public, anon;
grant execute on function mudar_app.search_entities(uuid, text, text[], date, int, boolean) to authenticated, service_role;
revoke all on function mudar_app.alias_matches(uuid, text) from public, anon;
grant execute on function mudar_app.alias_matches(uuid, text) to authenticated, service_role;
grant execute on function mudar_app.normalise_alias(text), mudar_app.like_escape(text) to authenticated, service_role;

-- ================================================================ kill switch (POST /v1/admin/pause): admins, audited
create or replace function mudar_app.set_ai_paused(p_workspace uuid, p_paused boolean, p_reason text default null)
returns boolean language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare prev boolean;
begin
  if not mudar_app.has_role(p_workspace, 'admin') then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select ai_paused into prev from mudar.workspace where id = p_workspace for update;
  update mudar.workspace set ai_paused = p_paused, updated_at = now() where id = p_workspace;
  insert into mudar.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after,
                                 request_id, classification)
  values (p_workspace, auth.uid(), 'user', case when p_paused then 'pause' else 'resume' end, 'workspace', p_workspace,
          jsonb_build_object('ai_paused', prev), jsonb_build_object('ai_paused', p_paused, 'reason', p_reason),
          nullif(current_setting('mudar_app.request_id', true), ''), 'corporate_confidential');
  return p_paused;
end $$;
revoke all on function mudar_app.set_ai_paused(uuid, boolean, text) from public, anon;
grant execute on function mudar_app.set_ai_paused(uuid, boolean, text) to authenticated, service_role;

-- ================================================================ job retry (admin health page)
create or replace function mudar_app.retry_job(p_job uuid) returns void
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare j mudar.job;
begin
  select * into j from mudar.job where id = p_job for update;
  if j.id is null then raise exception 'job not found' using errcode = 'P0002'; end if;
  if j.workspace_id is null or not mudar_app.has_role(j.workspace_id, 'admin') then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if j.state not in ('failed', 'dead', 'cancelled') then
    raise exception 'job is %; only failed/dead/cancelled jobs can be retried', j.state using errcode = '22023';
  end if;
  begin
    update mudar.job set state = 'queued', attempts = 0, due_at = now(), lease_until = null, locked_by = null,
           last_error = left('[manual retry by ' || coalesce(auth.uid()::text, 'system') || '] ' || coalesce(last_error, ''), 4000),
           updated_at = now()
     where id = p_job;
  exception when unique_violation then
    raise exception 'an equivalent job (same dedupe key) is already queued or succeeded' using errcode = '23505';
  end;
  insert into mudar.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, before, after, job_id, classification)
  values (j.workspace_id, auth.uid(), 'user', 'retry', 'job', jsonb_build_object('state', j.state, 'attempts', j.attempts),
          jsonb_build_object('state', 'queued'), j.id, 'corporate_confidential');
end $$;
revoke all on function mudar_app.retry_job(uuid) from public, anon;
grant execute on function mudar_app.retry_job(uuid) to authenticated, service_role;

-- ================================================================ service-role-only helpers (platform admin, backups)
create or replace function mudar_app.user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = mudar, mudar_app, public, extensions, auth as $$
  select id from auth.users where lower(email) = lower(btrim(p_email)) limit 1
$$;
grant execute on function mudar_app.search_entities(uuid, text, text[], date, int, boolean) to authenticated, service_role;
