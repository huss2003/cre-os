-- /admin speed-up: aggregate in SQL instead of paging every model_usage row and running one count query per job state.
-- Also a member-safe "job backlog" probe so /automation and Failed jobs can say when queued work is overdue (rule S10).
-- Re-runnable.

-- Month spend per workflow. SECURITY INVOKER: RLS on model_usage still decides what the caller may see.
create or replace function mudar_app.model_spend_since(p_workspace uuid, p_since timestamptz)
returns table (workflow text, usd numeric, calls bigint, failed bigint, mocked bigint, pricing_versions text[])
language sql stable security invoker
set search_path = mudar, mudar_app, public, extensions
as $$
  select u.workflow, coalesce(sum(u.estimated_usd), 0), count(*), count(*) filter (where u.ok = false),
         count(*) filter (where u.model like 'mock:%'), array_agg(distinct u.pricing_version)
  from mudar.model_usage u
  where u.workspace_id = p_workspace and u.occurred_at >= p_since
  group by u.workflow;
$$;
revoke all on function mudar_app.model_spend_since(uuid, timestamptz) from public;
grant execute on function mudar_app.model_spend_since(uuid, timestamptz) to authenticated, service_role;

-- Job counts per state in one grouped query. SECURITY INVOKER (RLS on job applies).
create or replace function mudar_app.job_state_counts(p_workspace uuid)
returns table (state text, n bigint)
language sql stable security invoker
set search_path = mudar, mudar_app, public, extensions
as $$
  select j.state, count(*) from mudar.job j where j.workspace_id = p_workspace group by j.state;
$$;
revoke all on function mudar_app.job_state_counts(uuid) from public;
grant execute on function mudar_app.job_state_counts(uuid) to authenticated, service_role;

-- Queued jobs whose due time passed more than p_overdue_minutes ago. Counts only (no job content), so any member may
-- read it (SECURITY DEFINER with an explicit membership check), like failed_job_count.
create or replace function mudar_app.job_backlog(p_workspace uuid, p_overdue_minutes integer default 15)
returns table (overdue bigint, oldest_due_at timestamptz)
language sql stable security definer
set search_path = mudar, mudar_app, public, extensions
as $$
  select count(*), min(j.due_at)
  from mudar.job j
  where mudar_app.is_member(p_workspace)
    and j.workspace_id = p_workspace and j.state = 'queued'
    and j.due_at < now() - make_interval(mins => greatest(p_overdue_minutes, 0));
$$;
revoke all on function mudar_app.job_backlog(uuid, integer) from public;
grant execute on function mudar_app.job_backlog(uuid, integer) to authenticated, service_role;

create index if not exists job_ws_state_due_idx on mudar.job (workspace_id, state, due_at);
create index if not exists model_usage_ws_occurred_idx on mudar.model_usage (workspace_id, occurred_at);
