-- Admin module: permission-respecting search, backup/restore log, retention policy, tenant invites,
-- kill switch + job retry helpers. Re-runnable (drops/recreates only its own objects).
-- Spec: Part I §7 (Search, Health), §14 (MFA, retention, backups RPO 24h / RTO 1 working day), Part III API.

-- ================================================================ backup_run (logical export + restore samples)
create table if not exists public.backup_run (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  kind text not null check (kind in ('logical_export','restore_sample','managed_backup_check','restore_drill')),
  status text not null default 'running' check (status in ('running','succeeded','failed','warning')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  storage_prefix text,                         -- workspace-files/<ws>/backups/<stamp>/
  table_counts jsonb not null default '{}',    -- {table: rows}
  table_hashes jsonb not null default '{}',    -- {table: sha256 of canonical JSON}
  manifest_hash text,
  bytes bigint,
  encrypted boolean not null default false,
  verified_export_id uuid references public.backup_run(id) on delete set null,  -- restore_sample -> export checked
  findings jsonb not null default '{}',        -- mismatches, suppression warnings, etc.
  error text,
  notes text,
  recorded_by uuid references auth.users(id),
  job_id uuid
);
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='backup_run') then
    perform app.make_workspace_table('backup_run', 'admin');
    -- backup metadata is admin-only (replace the generic member-read policy)
    drop policy backup_run_sel on public.backup_run;
    create policy backup_run_sel on public.backup_run for select to authenticated using (app.has_role(workspace_id, 'admin'));
  end if;
end $$;
create index if not exists backup_run_ws_kind_idx on public.backup_run(workspace_id, kind, started_at desc);

-- ================================================================ retention_policy (spec §14 proposed defaults; per tenant)
create table if not exists public.retention_policy (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  category text not null,                      -- raw_audio, working_transcripts, research_downloads, ...
  retain_days int check (retain_days is null or retain_days > 0),   -- null = retain with provenance/staleness labels
  basis text not null,                         -- what the clock starts from
  review_cadence text,
  legal_hold boolean not null default false,   -- legal holds override deletion
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  note text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, category)
);
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='retention_policy') then
    perform app.make_workspace_table('retention_policy', 'admin');
  end if;
end $$;

-- ================================================================ tenant_invite (members added by owners / platform admins; no email is sent by CRE OS)
create table if not exists public.tenant_invite (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  email citext not null,
  role public.member_role not null default 'viewer',
  method text not null check (method in ('invite_link','temp_password','existing_user')),
  invited_by uuid references auth.users(id),
  invited_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='tenant_invite') then
    perform app.make_workspace_table('tenant_invite', 'owner');
    drop policy tenant_invite_sel on public.tenant_invite;
    create policy tenant_invite_sel on public.tenant_invite for select to authenticated using (app.has_role(workspace_id, 'admin'));
  end if;
end $$;
create index if not exists tenant_invite_email_idx on public.tenant_invite(email);

-- ================================================================ search
create or replace function app.normalise_alias(s text) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(s, '')), '[^[:alnum:]]+', ' ', 'g'))
$$;

create or replace function app.like_escape(s text) returns text language sql immutable as $$
  select replace(replace(replace(coalesce(s, ''), '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- Alias lookup (security-review H3). SECURITY DEFINER only so that a colleague who can see a shared record also
-- matches that record's aliases (alias rows carry their own owner, which the share does not cover). Every match is
-- filtered through app.can_read on the TARGET entity (its own workspace, classification, owner and shares), and the
-- alias's own classification must be allowed too — so nothing about an invisible account (id or alias text) leaks.
-- Unknown entity types never match.
create or replace function app.alias_target_readable(p_workspace uuid, p_type text, p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_type = 'organisation' then exists (
      select 1 from public.organisation o where o.id = p_id and o.workspace_id = p_workspace
        and app.can_read(o.workspace_id, o.classification, o.owner_user_id, 'organisation', o.id))
    when p_type = 'person' then exists (
      select 1 from public.person p where p.id = p_id and p.workspace_id = p_workspace
        and app.can_read(p.workspace_id, p.classification, p.owner_user_id, 'person', p.id))
    when p_type in ('asset', 'building') then exists (
      select 1 from public.asset a where a.id = p_id and a.workspace_id = p_workspace
        and app.can_read(a.workspace_id, a.classification, a.owner_user_id, 'asset', a.id))
    else false
  end
$$;
revoke all on function app.alias_target_readable(uuid, text, uuid) from public, anon;
grant execute on function app.alias_target_readable(uuid, text, uuid) to authenticated, service_role;

create or replace function app.alias_matches(p_workspace uuid, p_query text)
returns table(entity_type text, entity_id uuid, raw_alias text, sim real)
language sql stable security definer set search_path = public, extensions as $$
  with q as (select app.normalise_alias(p_query) as nq)
  select a.entity_type, a.entity_id, a.raw_alias,
         greatest(similarity(a.canonical_alias, q.nq), similarity(lower(a.raw_alias), lower(p_query)))::real
  from public.entity_alias a
  cross join q
  join public.membership m on m.workspace_id = a.workspace_id and m.user_id = auth.uid()
  where a.workspace_id = p_workspace
    and length(q.nq) > 0
    and a.archived_at is null
    and a.classification = any(m.allowed_classifications)
    and (a.canonical_alias % q.nq
         or a.canonical_alias like '%' || app.like_escape(q.nq) || '%'
         or lower(a.raw_alias) like '%' || app.like_escape(lower(p_query)) || '%')
    and app.alias_target_readable(a.workspace_id, a.entity_type, a.entity_id)
  order by 4 desc
  limit 200
$$;

-- Permission-respecting typed search (GET /v1/search). SECURITY INVOKER: every table read is filtered by the
-- caller's RLS (membership, classification, assignment/sharing). Returns one row per entity; fact status and
-- "as of" semantics are explicit so reported / currently confirmed / inferred facts are never blended.
drop function if exists app.search_entities(uuid, text, text[], date, int, boolean);
create function app.search_entities(
  p_workspace uuid,
  p_query text,
  p_types text[] default null,
  p_as_of date default null,
  p_limit int default 50,
  p_include_archived boolean default false)
returns table(
  entity_type text, id uuid, title text, subtitle text, snippet text,
  classification public.classification, fact_status text, status_label text,
  freshness timestamptz, matched_alias text, score real, archived boolean)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  q text := btrim(coalesce(p_query, ''));
  tsq tsquery;
  like_q text;
  qhash text;
  lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not app.is_member(p_workspace) then
    return;
  end if;
  -- p_as_of selects which FACTS are shown (employment / availability valid on that date); it does not hide
  -- records entered later, because a record captured today can describe a role held in 2024.
  if length(q) > 0 then
    select to_tsquery('simple', string_agg(quote_literal(t) || ':*', ' & '))
      into tsq
      from regexp_split_to_table(app.normalise_alias(q), '\s+') t
     where t <> '';
    like_q := '%' || app.like_escape(q) || '%';
    qhash := encode(extensions.digest(lower(q), 'sha256'), 'hex');
  end if;

  return query
  with al as (
    select * from app.alias_matches(p_workspace, q) where length(q) > 0
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
    from public.organisation o
    where o.workspace_id = p_workspace
      and (p_types is null or 'organisation' = any(p_types))
      and (p_include_archived or o.archived_at is null)
      and (length(q) = 0 or o.search @@ tsq or o.display_name ilike like_q or o.legal_name ilike like_q
           or q <% o.display_name or o.cin = upper(q) or o.gstin = upper(q)
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
                               case when exists (select 1 from public.contact_method c where c.person_id = p.id and c.value_hash = qhash) then 1 else 0 end,
                               coalesce((select max(a.sim) from al a where a.entity_type = 'person' and a.entity_id = p.id), 0)) end)::real,
           p.archived_at is not null
    from public.person p
    left join lateral (
      select e.title, e.fact_status::text as fs, og.display_name as org_name, e.is_current
      from public.employment e
      left join public.organisation og on og.id = e.org_id
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
           or exists (select 1 from public.contact_method c where c.person_id = p.id and c.value_hash = qhash)
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
    from public.asset a
    left join public.asset par on par.id = a.parent_asset_id
    left join public.geography loc on loc.id = coalesce(a.locality_id, a.micro_market_id)
    left join lateral (
      select v.status, v.fact_status::text as fs, v.as_of, v.valid_until
      from public.availability v join public.space s on s.id = v.space_id
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
    from public.requirement r
    left join public.organisation og on og.id = r.org_id
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
    from public.opportunity op
    left join public.organisation og on og.id = op.org_id
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

revoke all on function app.search_entities(uuid, text, text[], date, int, boolean) from public, anon;
grant execute on function app.search_entities(uuid, text, text[], date, int, boolean) to authenticated, service_role;
revoke all on function app.alias_matches(uuid, text) from public, anon;
grant execute on function app.alias_matches(uuid, text) to authenticated, service_role;
grant execute on function app.normalise_alias(text), app.like_escape(text) to authenticated, service_role;

-- ================================================================ kill switch (POST /v1/admin/pause): admins, audited
create or replace function app.set_ai_paused(p_workspace uuid, p_paused boolean, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare prev boolean;
begin
  if not app.has_role(p_workspace, 'admin') then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select ai_paused into prev from public.workspace where id = p_workspace for update;
  update public.workspace set ai_paused = p_paused, updated_at = now() where id = p_workspace;
  insert into public.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after,
                                 request_id, classification)
  values (p_workspace, auth.uid(), 'user', case when p_paused then 'pause' else 'resume' end, 'workspace', p_workspace,
          jsonb_build_object('ai_paused', prev), jsonb_build_object('ai_paused', p_paused, 'reason', p_reason),
          nullif(current_setting('app.request_id', true), ''), 'corporate_confidential');
  return p_paused;
end $$;
revoke all on function app.set_ai_paused(uuid, boolean, text) from public, anon;
grant execute on function app.set_ai_paused(uuid, boolean, text) to authenticated, service_role;

-- ================================================================ job retry (admin health page)
create or replace function app.retry_job(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare j public.job;
begin
  select * into j from public.job where id = p_job for update;
  if j.id is null then raise exception 'job not found' using errcode = 'P0002'; end if;
  if j.workspace_id is null or not app.has_role(j.workspace_id, 'admin') then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if j.state not in ('failed', 'dead', 'cancelled') then
    raise exception 'job is %; only failed/dead/cancelled jobs can be retried', j.state using errcode = '22023';
  end if;
  begin
    update public.job set state = 'queued', attempts = 0, due_at = now(), lease_until = null, locked_by = null,
           last_error = left('[manual retry by ' || coalesce(auth.uid()::text, 'system') || '] ' || coalesce(last_error, ''), 4000),
           updated_at = now()
     where id = p_job;
  exception when unique_violation then
    raise exception 'an equivalent job (same dedupe key) is already queued or succeeded' using errcode = '23505';
  end;
  insert into public.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, before, after, job_id, classification)
  values (j.workspace_id, auth.uid(), 'user', 'retry', 'job', jsonb_build_object('state', j.state, 'attempts', j.attempts),
          jsonb_build_object('state', 'queued'), j.id, 'corporate_confidential');
end $$;
revoke all on function app.retry_job(uuid) from public, anon;
grant execute on function app.retry_job(uuid) to authenticated, service_role;

-- ================================================================ service-role-only helpers (platform admin, backups)
create or replace function app.user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public, auth as $$
  select id from auth.users where lower(email) = lower(btrim(p_email)) limit 1
$$;
revoke all on function app.user_id_by_email(text) from public, anon, authenticated;
grant execute on function app.user_id_by_email(text) to service_role;

-- Tables carrying workspace_id (for the nightly logical export). Includes other modules' tables automatically.
create or replace function app.workspace_tables() returns setof text
language sql stable security definer set search_path = public as $$
  select c.table_name::text
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
  order by 1
$$;
revoke all on function app.workspace_tables() from public, anon, authenticated;
grant execute on function app.workspace_tables() to service_role;

-- Display names of workspace members (for owner/assignee labels) without exposing membership rows to non-admins.
create or replace function app.member_directory(p_workspace uuid)
returns table(user_id uuid, display_name text, role public.member_role)
language sql stable security definer set search_path = public, auth as $$
  select m.user_id, coalesce(m.display_name, split_part(u.email, '@', 1)), m.role
  from public.membership m join auth.users u on u.id = m.user_id
  where m.workspace_id = p_workspace and app.is_member(p_workspace)
  order by 2
$$;
revoke all on function app.member_directory(uuid) from public, anon;
grant execute on function app.member_directory(uuid) to authenticated, service_role;

-- One table's rows for one workspace as a single JSON array (logical export; avoids PostgREST row caps).
-- Service role only. Table name must be one returned by app.workspace_tables().
create or replace function app.export_table(p_workspace uuid, p_table text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if p_table not in (select app.workspace_tables()) then
    raise exception 'table % is not a workspace table', p_table using errcode = '22023';
  end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t) - ''search'' order by (to_jsonb(t)->>''id''), t::text), ''[]''::jsonb) from public.%I t where t.workspace_id = $1', p_table)
    into result using p_workspace;
  return result;
end $$;
revoke all on function app.export_table(uuid, text) from public, anon, authenticated;
grant execute on function app.export_table(uuid, text) to service_role;
