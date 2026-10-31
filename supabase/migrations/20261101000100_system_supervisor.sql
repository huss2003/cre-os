-- Workflow 22 "System Supervisor" (round 2, platform builder). Re-runnable.
--  1. claim_jobs: expired leases no longer loop forever (attempts >= max_attempts => dead; otherwise re-queued with back-off)
--  2. per-job timing (started_at / finished_at / duration_ms) + job_latency_stats() for p50/p95/drift on /admin
--  3. scheduler_run: one row per /api/cron/tick (platform-level, service role + platform admins), heartbeat RPC
--  4. supervisor_alert: deduplicated private owner/admin alerts (dead jobs, backups, AI budget, connectors, heartbeat)
--  5. job_pause: per-workspace "pause background jobs" + platform-wide pause; claim_jobs honours both (backups exempt)
--  6. restore_sample_table(): real restore of an export sample into a temp copy of the live table, compared row by row
set search_path = mudar, mudar_app, public, extensions;

-- ================================================================ 2. job timing (additive columns on the core job table)
alter table mudar.job add column if not exists started_at timestamptz;
alter table mudar.job add column if not exists finished_at timestamptz;
alter table mudar.job add column if not exists duration_ms int;
create index if not exists job_finished_idx on mudar.job(workspace_id, finished_at desc) where finished_at is not null;
create index if not exists job_running_lease_idx on mudar.job(lease_until) where state = 'running';

-- ================================================================ 5. job pause (kill switch for background processing)
create table if not exists mudar.job_pause (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references mudar.workspace(id) on delete cascade,   -- null = platform-wide pause
  reason text,
  paused_by uuid references auth.users(id),
  paused_at timestamptz not null default now()
);
create unique index if not exists job_pause_scope_uq on mudar.job_pause ((coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)));
alter table mudar.job_pause enable row level security;
drop policy if exists job_pause_sel on mudar.job_pause;
create policy job_pause_sel on mudar.job_pause for select to authenticated
  using (workspace_id is null or mudar_app.has_role(workspace_id, 'admin') or mudar_app.is_platform_admin());
revoke all on mudar.job_pause from anon, authenticated;
grant select on mudar.job_pause to authenticated;   -- writes only through set_jobs_paused (audited)
grant all on mudar.job_pause to service_role;

/** Job types that keep running while a workspace (or the platform) is paused: backups must never stop. */
create or replace function mudar_app.job_pause_exempt(p_job_type text) returns boolean
language sql immutable set search_path = mudar, mudar_app, public, extensions as $$
  select p_job_type in ('admin.export', 'admin.restore_sample')
$$;

create or replace function mudar_app.set_jobs_paused(p_workspace uuid, p_paused boolean, p_reason text default null)
returns boolean language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare prev boolean; w record;
begin
  if p_workspace is null then
    if not mudar_app.is_platform_admin() then
      raise exception 'platform admin required for a platform-wide pause' using errcode = '42501';
    end if;
  elsif not mudar_app.has_role(p_workspace, 'admin') then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select exists (select 1 from mudar.job_pause where workspace_id is not distinct from p_workspace) into prev;
  if p_paused and not prev then
    insert into mudar.job_pause(workspace_id, reason, paused_by) values (p_workspace, left(p_reason, 500), auth.uid())
    on conflict do nothing;
  elsif not p_paused then
    delete from mudar.job_pause where workspace_id is not distinct from p_workspace;
  end if;
  if prev is distinct from p_paused then
    for w in select id from mudar.workspace where (p_workspace is null and status <> 'archived') or id = p_workspace loop
      insert into mudar.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after, request_id, classification)
      values (w.id, auth.uid(), 'user',
              case when p_workspace is null then (case when p_paused then 'platform_pause_jobs' else 'platform_resume_jobs' end)
                   else (case when p_paused then 'pause_jobs' else 'resume_jobs' end) end,
              'workspace', w.id, jsonb_build_object('jobs_paused', prev, 'scope', coalesce(p_workspace::text, 'platform')),
              jsonb_build_object('jobs_paused', p_paused, 'reason', left(p_reason, 500), 'scope', coalesce(p_workspace::text, 'platform')),
              nullif(current_setting('mudar_app.request_id', true), ''), 'corporate_confidential');
    end loop;
  end if;
  return p_paused;
end $$;
revoke all on function mudar_app.set_jobs_paused(uuid, boolean, text) from public, anon;
grant execute on function mudar_app.set_jobs_paused(uuid, boolean, text) to authenticated, service_role;

-- ================================================================ 1. durable queue fixes (same signatures as core)
create or replace function mudar_app.claim_jobs(p_worker text, p_limit int default 5, p_lease_seconds int default 300, p_types text[] default null)
returns setof mudar.job language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare v_global boolean;
begin
  -- (a) A running job whose lease expired never reported back (worker crashed or hit the serverless timeout).
  --     Out of attempts => dead (dead-letter, surfaced on /admin + owner alert). Otherwise re-queue with back-off.
  update mudar.job j set state = 'dead', lease_until = null, locked_by = null, finished_at = clock_timestamp(), updated_at = now(),
         last_error = left('lease expired after ' || j.attempts || ' attempts (worker crashed or timed out)'
                           || coalesce(E'\n' || j.last_error, ''), 4000)
  where j.id in (select id from mudar.job where state = 'running' and lease_until < now() and attempts >= max_attempts
                 for update skip locked);
  update mudar.job j set state = 'queued', lease_until = null, locked_by = null, updated_at = now(),
         due_at = now() + make_interval(secs => least(3600, (power(2, j.attempts) * 30)::int)),
         last_error = left('lease expired on attempt ' || j.attempts || ' (worker crashed or timed out); retrying with back-off'
                           || coalesce(E'\n' || j.last_error, ''), 4000)
  where j.id in (select id from mudar.job where state = 'running' and lease_until < now() and attempts < max_attempts
                 for update skip locked);

  -- (b) Claim due work, skipping paused workspaces (backups exempt) and everything during a platform-wide pause.
  select exists (select 1 from mudar.job_pause where workspace_id is null) into v_global;
  return query
  update mudar.job j set state = 'running', attempts = j.attempts + 1, locked_by = p_worker,
         lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now(),
         started_at = clock_timestamp(), finished_at = null, duration_ms = null
  where j.id in (
    select q.id from mudar.job q
    where q.state = 'queued' and q.due_at <= now()
      and (p_types is null or q.job_type = any(p_types))
      and (mudar_app.job_pause_exempt(q.job_type) or (
            not v_global
            and (q.workspace_id is null or not exists (select 1 from mudar.job_pause p where p.workspace_id = q.workspace_id))))
    order by q.due_at
    for update skip locked
    limit p_limit)
  returning j.*;
end $$;

create or replace function mudar_app.complete_job(p_id uuid, p_result jsonb default null) returns void
language sql security definer set search_path = mudar, mudar_app, public, extensions as $$
  update mudar.job set state = 'succeeded', result = p_result, lease_until = null, updated_at = now(),
         finished_at = clock_timestamp(),
         duration_ms = case when started_at is null then null
                            else least(2147483647, (extract(epoch from clock_timestamp() - started_at) * 1000)::bigint)::int end
  where id = p_id
$$;

create or replace function mudar_app.fail_job(p_id uuid, p_error text) returns void
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  update mudar.job set
    state = case when attempts >= max_attempts then 'dead' else 'queued' end,
    due_at = now() + make_interval(secs => least(3600, (power(2, attempts) * 30)::int)),  -- exponential backoff
    last_error = left(p_error, 4000), lease_until = null, updated_at = now(),
    finished_at = clock_timestamp(),
    duration_ms = case when started_at is null then null
                       else least(2147483647, (extract(epoch from clock_timestamp() - started_at) * 1000)::bigint)::int end
  where id = p_id;
end $$;

revoke all on function mudar_app.claim_jobs(text, int, int, text[]), mudar_app.complete_job(uuid, jsonb), mudar_app.fail_job(uuid, text) from public, authenticated, anon;
grant execute on function mudar_app.claim_jobs(text, int, int, text[]), mudar_app.complete_job(uuid, jsonb), mudar_app.fail_job(uuid, text) to service_role;

/** Latency per job type for /admin: last 24 h vs the 7 days before (drift). SECURITY INVOKER => job RLS (admins). */
create or replace function mudar_app.job_latency_stats(p_workspace uuid, p_now timestamptz default now())
returns table(job_type text, runs_24h int, failed_24h int, p50_ms numeric, p95_ms numeric, max_ms int, runs_baseline int, p95_baseline_ms numeric)
language sql stable security invoker set search_path = mudar, mudar_app, public, extensions as $$
  with r as (
    select j.job_type, j.duration_ms, j.state, j.last_error, j.finished_at >= p_now - interval '24 hours' as recent
    from mudar.job j
    where j.workspace_id = p_workspace and j.finished_at >= p_now - interval '8 days'
      and j.duration_ms is not null
  )
  select r.job_type,
         count(*) filter (where recent)::int,
         count(*) filter (where recent and r.state <> 'succeeded')::int,
         round((percentile_cont(0.5) within group (order by r.duration_ms) filter (where recent))::numeric, 0),
         round((percentile_cont(0.95) within group (order by r.duration_ms) filter (where recent))::numeric, 0),
         max(r.duration_ms) filter (where recent),
         count(*) filter (where not recent)::int,
         round((percentile_cont(0.95) within group (order by r.duration_ms) filter (where not recent))::numeric, 0)
  from r group by r.job_type
  order by 5 desc nulls last
$$;
revoke all on function mudar_app.job_latency_stats(uuid, timestamptz) from public, anon;
grant execute on function mudar_app.job_latency_stats(uuid, timestamptz) to authenticated, service_role;

-- retry_job: also clear timing so the next attempt is measured cleanly
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
           started_at = null, finished_at = null, duration_ms = null,
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

-- ================================================================ 3. scheduler heartbeat (platform-level ops log)
create table if not exists mudar.scheduler_run (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ms int,
  ran int not null default 0,
  failed int not null default 0,
  schedule_errors jsonb not null default '[]',
  worker text,
  source text,
  prev_started_at timestamptz,
  gap_minutes numeric(12,1),           -- minutes since the previous tick started (null for the very first tick)
  supervisor jsonb                      -- summary of the supervisor pass (counts only)
);
create index if not exists scheduler_run_started_idx on mudar.scheduler_run(started_at desc);
alter table mudar.scheduler_run enable row level security;
drop policy if exists scheduler_run_platform on mudar.scheduler_run;
create policy scheduler_run_platform on mudar.scheduler_run for select to authenticated using (mudar_app.is_platform_admin());
revoke all on mudar.scheduler_run from anon, authenticated;
grant select on mudar.scheduler_run to authenticated;   -- platform admins only (policy); tenants use scheduler_heartbeat()
grant all on mudar.scheduler_run to service_role;
grant usage on sequence mudar.scheduler_run_id_seq to service_role;

/** Start-of-tick record; returns the gap since the previous tick. Keeps the latest ~2000 rows. Service role only. */
create or replace function mudar_app.begin_scheduler_run(p_worker text, p_source text default null)
returns jsonb language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare v_prev timestamptz; v_id bigint; v_gap numeric;
begin
  select max(started_at) into v_prev from mudar.scheduler_run;
  v_gap := case when v_prev is null then null else round((extract(epoch from now() - v_prev) / 60)::numeric, 1) end;
  insert into mudar.scheduler_run(worker, source, prev_started_at, gap_minutes) values (p_worker, p_source, v_prev, v_gap)
  returning id into v_id;
  delete from mudar.scheduler_run where id <= v_id - 2000;
  return jsonb_build_object('id', v_id, 'started_at', now(), 'prev_started_at', v_prev, 'gap_minutes', v_gap);
end $$;
revoke all on function mudar_app.begin_scheduler_run(text, text) from public, anon, authenticated;
grant execute on function mudar_app.begin_scheduler_run(text, text) to service_role;

/** Aggregate heartbeat for any signed-in admin page (no error text, nothing tenant-specific). */
create or replace function mudar_app.scheduler_heartbeat()
returns jsonb language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select jsonb_build_object(
    'last_tick_at', (select max(started_at) from mudar.scheduler_run),
    'last_finished_at', (select max(finished_at) from mudar.scheduler_run),
    'ticks_24h', (select count(*) from mudar.scheduler_run where started_at > now() - interval '24 hours'),
    'ticks_with_errors_24h', (select count(*) from mudar.scheduler_run where started_at > now() - interval '24 hours'
                                and (failed > 0 or jsonb_array_length(schedule_errors) > 0)),
    'max_gap_minutes_24h', (select max(gap_minutes) from mudar.scheduler_run where started_at > now() - interval '24 hours'),
    'p95_tick_ms_24h', (select round((percentile_cont(0.95) within group (order by ms))::numeric, 0) from mudar.scheduler_run
                          where started_at > now() - interval '24 hours' and ms is not null),
    'now', now())
$$;
revoke all on function mudar_app.scheduler_heartbeat() from public, anon;
grant execute on function mudar_app.scheduler_heartbeat() to authenticated, service_role;

-- ================================================================ 4. supervisor alerts (failure queue + private notifications)
create table if not exists mudar.supervisor_alert (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  kind text not null check (kind in ('dead_job', 'backup_missed', 'backup_failed', 'restore_failed', 'ai_budget_80',
                                     'ai_budget_100', 'connector_failed', 'connector_stale', 'scheduler_gap')),
  subject text not null,                  -- what the alert is about (job id, month, connector:resource, previous tick time)
  severity text not null check (severity in ('critical', 'warning')),
  title text not null,                    -- actionable, non-sensitive summary (never stack traces or message content)
  action_href text,
  detail jsonb not null default '{}',     -- ids / counts only
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  notified_at timestamptz
);
create unique index if not exists supervisor_alert_open_uq on mudar.supervisor_alert(workspace_id, kind, subject) where resolved_at is null;
create unique index if not exists supervisor_alert_event_uq on mudar.supervisor_alert(workspace_id, kind, subject) where kind = 'scheduler_gap';
create index if not exists supervisor_alert_ws_idx on mudar.supervisor_alert(workspace_id, opened_at desc);
alter table mudar.supervisor_alert enable row level security;
drop policy if exists supervisor_alert_sel on mudar.supervisor_alert;
create policy supervisor_alert_sel on mudar.supervisor_alert for select to authenticated using (mudar_app.has_role(workspace_id, 'admin'));
drop policy if exists supervisor_alert_ack on mudar.supervisor_alert;
create policy supervisor_alert_ack on mudar.supervisor_alert for update to authenticated
  using (mudar_app.has_role(workspace_id, 'admin')) with check (mudar_app.has_role(workspace_id, 'admin'));
revoke all on mudar.supervisor_alert from anon, authenticated;
grant select on mudar.supervisor_alert to authenticated;
grant update (acknowledged_at, acknowledged_by) on mudar.supervisor_alert to authenticated;
grant all on mudar.supervisor_alert to service_role;

/**
 * Reconcile one workspace's alert candidates (service role). p_checked = kinds that were actually evaluated this pass:
 * only those may be auto-resolved (a check that errored must not mark its alerts healthy). Event kinds
 * (scheduler_gap) are inserted already resolved and deduplicated by subject. Returns ids of newly opened alerts.
 */
create or replace function mudar_app.reconcile_supervisor_alerts(p_workspace uuid, p_checked text[], p_alerts jsonb)
returns setof uuid language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare a jsonb; v_id uuid; v_event boolean;
begin
  for a in select * from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) loop
    v_event := (a->>'kind') = 'scheduler_gap';
    v_id := null;
    insert into mudar.supervisor_alert(workspace_id, kind, subject, severity, title, action_href, detail, resolved_at)
    values (p_workspace, a->>'kind', a->>'subject', a->>'severity', left(a->>'title', 300), a->>'href',
            coalesce(a->'detail', '{}'::jsonb), case when v_event then now() end)
    on conflict do nothing
    returning id into v_id;
    if v_id is not null then
      return next v_id;
    elsif not v_event then
      update mudar.supervisor_alert set last_seen_at = now(), title = left(a->>'title', 300), detail = coalesce(a->'detail', '{}'::jsonb)
      where workspace_id = p_workspace and kind = a->>'kind' and subject = a->>'subject' and resolved_at is null;
    end if;
  end loop;
  update mudar.supervisor_alert s set resolved_at = now()
  where s.workspace_id = p_workspace and s.resolved_at is null and s.kind = any(p_checked) and s.kind <> 'scheduler_gap'
    and not exists (select 1 from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) c
                    where c->>'kind' = s.kind and c->>'subject' = s.subject);
end $$;
revoke all on function mudar_app.reconcile_supervisor_alerts(uuid, text[], jsonb) from public, anon, authenticated;
grant execute on function mudar_app.reconcile_supervisor_alerts(uuid, text[], jsonb) to service_role;

-- ================================================================ 6. real restore test (service role only)
/** Value equality after a JSON round trip: numbers by value (1.5 = 1.50), timestamps by instant, arrays/objects recursively. */
create or replace function mudar_app.restore_value_eq(a jsonb, b jsonb) returns boolean
language plpgsql stable set search_path = mudar, mudar_app, public, extensions as $$
declare k text; i int;
begin
  if a is not distinct from b then return true; end if;
  if coalesce(a, 'null'::jsonb) = 'null'::jsonb or coalesce(b, 'null'::jsonb) = 'null'::jsonb then
    return coalesce(a, 'null'::jsonb) = coalesce(b, 'null'::jsonb);
  end if;
  if jsonb_typeof(a) <> jsonb_typeof(b) then return false; end if;
  if jsonb_typeof(a) = 'number' then return (a::text)::numeric = (b::text)::numeric; end if;
  if jsonb_typeof(a) = 'string' then
    begin
      return (a #>> '{}')::timestamptz = (b #>> '{}')::timestamptz;
    exception when others then return false;
    end;
  end if;
  if jsonb_typeof(a) = 'array' then
    if jsonb_array_length(a) <> jsonb_array_length(b) then return false; end if;
    for i in 0 .. jsonb_array_length(a) - 1 loop
      if not mudar_app.restore_value_eq(a->i, b->i) then return false; end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(a) = 'object' then
    if (select array_agg(x order by x) from jsonb_object_keys(a) x) is distinct from (select array_agg(x order by x) from jsonb_object_keys(b) x) then
      return false;
    end if;
    for k in select jsonb_object_keys(a) loop
      if not mudar_app.restore_value_eq(a->k, b->k) then return false; end if;
    end loop;
    return true;
  end if;
  return false;
end $$;

/**
 * Restore a sample of exported rows into a TEMP copy of the live table (LIKE mudar.<t> incl. defaults + CHECK/NOT NULL),
 * using only the columns present in the export (so defaults fill new columns, as a real restore would), then compare
 * the restored rows with the export value by value. The temp table is dropped (and is ON COMMIT DROP anyway); nothing
 * touches live data. Returns findings; insert/cast failures (schema drift that would break a restore) come back as error.
 */
create or replace function mudar_app.restore_sample_table(p_workspace uuid, p_table text, p_rows jsonb)
returns jsonb language plpgsql security definer
set search_path = mudar, mudar_app, public, extensions set timezone = 'UTC' as $$
declare
  t0 timestamptz := clock_timestamp();
  v_tmp text := '_restore_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
  v_in int := coalesce(jsonb_array_length(p_rows), 0);
  v_cols text[]; v_keys text[]; v_use text[]; v_dropped text[]; v_defaulted text[];
  v_list text; v_sel text; v_out int := 0; v_mismatch int := 0; v_mismatch_cols text[]; v_dupes int := 0; v_hash text;
begin
  if p_table not in (select mudar_app.workspace_tables()) then
    raise exception 'table % is not a workspace table', p_table using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'rows must be a JSON array' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where e->>'workspace_id' is distinct from p_workspace::text) then
    return jsonb_build_object('table', p_table, 'rows_in', v_in, 'error', 'sample contains a row from another workspace');
  end if;

  select array_agg(a.attname::text order by a.attnum) into v_cols
  from pg_attribute a where a.attrelid = format('mudar.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped;
  select coalesce(array_agg(distinct k), '{}') into v_keys from jsonb_array_elements(p_rows) e, jsonb_object_keys(e) k;
  v_use := array(select c from unnest(v_cols) with ordinality u(c, o) where c = any(v_keys) order by o);
  v_dropped := array(select k from unnest(v_keys) k where not (k = any(v_cols)) order by 1);
  v_defaulted := case when v_in = 0 then '{}'::text[] else array(
    select a.attname::text from pg_attribute a
    where a.attrelid = format('mudar.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped
      and a.attgenerated = '' and not (a.attname::text = any(v_keys)) order by a.attnum) end;

  begin
    execute format('create temp table %I (like mudar.%I including defaults including constraints) on commit drop', v_tmp, p_table);
    execute format('alter table %I add column _ord bigint', v_tmp);
    if v_in > 0 and array_length(v_use, 1) > 0 then
      select string_agg(format('%I', c), ', '), string_agg(format('r.%I', c), ', ') into v_list, v_sel from unnest(v_use) c;
      execute format('insert into %1$I (%2$s, _ord) select %3$s, e.ord from jsonb_array_elements($1) with ordinality e(j, ord), '
                     'lateral jsonb_populate_record(null::%1$I, e.j) r', v_tmp, v_list, v_sel) using p_rows;
    end if;
    execute format('select count(*) from %I', v_tmp) into v_out;
    -- value-by-value comparison of every exported column that still exists
    execute format($q$
      select count(distinct e.ord), coalesce(array_agg(distinct kv.key), '{}')
      from %I r join jsonb_array_elements($1) with ordinality e(j, ord) on e.ord = r._ord
      cross join lateral jsonb_each(e.j) kv
      where kv.key = any($2) and not mudar_app.restore_value_eq(to_jsonb(r) -> kv.key, kv.value)$q$, v_tmp)
      into v_mismatch, v_mismatch_cols using p_rows, v_use;
    if 'id' = any(v_cols) then
      execute format('select count(*) - count(distinct id) from %I', v_tmp) into v_dupes;
    end if;
    execute format($q$select md5(coalesce(string_agg((to_jsonb(r) - '_ord')::text, E'\n' order by r._ord), '')) from %I r$q$, v_tmp) into v_hash;
    execute format('drop table %I', v_tmp);
  exception when others then
    return jsonb_build_object('table', p_table, 'rows_in', v_in, 'rows_restored', 0,
      'error', sqlstate || ': ' || left(sqlerrm, 300), 'dropped_columns', to_jsonb(v_dropped),
      'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int);
  end;
  return jsonb_build_object('table', p_table, 'rows_in', v_in, 'rows_restored', v_out,
    'value_mismatch_rows', v_mismatch, 'value_mismatch_columns', to_jsonb(v_mismatch_cols),
    'duplicate_ids', v_dupes, 'dropped_columns', to_jsonb(v_dropped), 'defaulted_columns', to_jsonb(v_defaulted),
    'restored_hash', v_hash, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int);
end $$;
revoke all on function mudar_app.restore_value_eq(jsonb, jsonb), mudar_app.restore_sample_table(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function mudar_app.restore_value_eq(jsonb, jsonb), mudar_app.restore_sample_table(uuid, text, jsonb) to service_role;

notify pgrst, 'reload schema';
