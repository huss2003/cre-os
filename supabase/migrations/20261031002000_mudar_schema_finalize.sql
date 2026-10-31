set search_path = mudar, mudar_app, public, extensions;
-- Pin search_path on every CRE OS function so it resolves mudar tables no matter which schema the caller
-- (PostgREST profile, pg_cron, service role) is using. Re-runnable.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('mudar', 'mudar_app') and p.prokind in ('f', 'p')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=pg_catalog%')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')  -- skip extension-owned functions
  loop
    execute format('alter function %s set search_path = mudar, mudar_app, public, extensions', r.fn);
  end loop;
end $$;

-- Future objects created in these schemas get the same grants as existing ones.
alter default privileges in schema mudar grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema mudar grant all on tables to service_role;
alter default privileges in schema mudar grant usage, select on sequences to authenticated, service_role;
grant usage, select on all sequences in schema mudar to authenticated, service_role;
revoke all on schema mudar from anon;
revoke all on schema mudar_app from anon;
