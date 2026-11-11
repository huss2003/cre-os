-- Review page: non-admin members see how many background jobs failed (details + retry stay admin-only via job RLS).
create or replace function mudar_app.failed_job_count(p_workspace uuid)
returns integer
language sql stable security definer
set search_path = mudar, mudar_app, public, extensions
as $$
  select case when mudar_app.is_member(p_workspace)
    then (select count(*)::int from mudar.job where workspace_id = p_workspace and state in ('failed', 'dead'))
    else 0 end;
$$;
revoke all on function mudar_app.failed_job_count(uuid) from public;
grant execute on function mudar_app.failed_job_count(uuid) to authenticated;
