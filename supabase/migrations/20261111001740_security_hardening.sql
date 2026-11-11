-- Security hardening after the 2026-11-11 orchestrator/assistant migrations. Re-runnable.

-- 1) SECURITY DEFINER trigger functions are never called directly; triggers fire regardless of EXECUTE grants.
--    Functions default to EXECUTE for PUBLIC, so revoke from public/anon/authenticated.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as f
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('mudar_app','mudar') and p.prosecdef
              and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.f);
  end loop;
end $$;

-- 2) Writing-style profiles are personal: keep the owner-only restriction, but also require workspace membership.
drop policy if exists assistant_style_profile_owner_only on mudar.assistant_style_profile;
create policy assistant_style_profile_owner_only on mudar.assistant_style_profile as restrictive for all to authenticated
  using (mudar_app.is_member(workspace_id) and owner_user_id = auth.uid())
  with check (mudar_app.is_member(workspace_id) and owner_user_id = auth.uid());

-- 3) retry_job: restore the timing reset (started_at/finished_at/duration_ms) that 20261107000300 dropped.
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

-- 4) export_table: keyset paging (p_after/p_limit). A single jsonb_agg over a large table (e.g. 60k audit rows,
--    ~165 MB of JSON) overran the PostgREST statement timeout and broke nightly export + the restore test.
--    Without p_limit the behaviour is unchanged. Tables without an id column ignore paging (returned whole).
drop function if exists mudar_app.export_table(uuid, text);
drop function if exists mudar_app.export_table(uuid, text, uuid, int);
create or replace function mudar_app.export_table(p_workspace uuid, p_table text, p_after text default null, p_limit int default null)
returns jsonb language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare result jsonb; has_id boolean;
begin
  if p_table not in (select mudar_app.workspace_tables()) then
    raise exception 'table % is not a workspace table', p_table using errcode = '22023';
  end if;
  select exists (select 1 from information_schema.columns where table_schema = 'mudar' and table_name = p_table and column_name = 'id')
    into has_id;
  if p_limit is null or not has_id then
    execute format('select coalesce(jsonb_agg(to_jsonb(t) - ''search'' order by (to_jsonb(t)->>''id''), t::text), ''[]''::jsonb) from mudar.%I t where t.workspace_id = $1', p_table)
      into result using p_workspace;
  else
    -- keyset on id::text (ids are unique), the same order as the unpaged export, so pages concatenate identically.
    execute format('select coalesce(jsonb_agg(to_jsonb(x) - ''search'' order by x.id::text), ''[]''::jsonb) from (select * from mudar.%I t where t.workspace_id = $1 and ($2::text is null or t.id::text > $2) order by t.id::text limit $3) x', p_table)
      into result using p_workspace, p_after, p_limit;
  end if;
  return result;
end $$;
revoke all on function mudar_app.export_table(uuid, text, text, int) from public, anon, authenticated;
grant execute on function mudar_app.export_table(uuid, text, text, int) to service_role;
notify pgrst, 'reload schema';
