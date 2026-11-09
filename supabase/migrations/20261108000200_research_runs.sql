-- Research run log: every web research run, what it searched and which sites it read. Re-runnable.
create table if not exists mudar.research_run (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'company' check (kind in ('company','discover')),
  org_id uuid references mudar.organisation(id) on delete set null,
  label text not null,
  status text not null default 'running' check (status in ('running','done','failed','skipped')),
  queries text[] not null default '{}',
  sources jsonb not null default '[]',      -- [{url,title,used:boolean}]
  findings int not null default 0,
  new_companies int not null default 0,
  usd numeric(10,4) not null default 0,
  error text,
  finished_at timestamptz
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='research_run' and column_name='workspace_id') then
    perform mudar_app.make_business_table('research_run');
  end if;
end $$;
create index if not exists research_run_ws_created on mudar.research_run(workspace_id, created_at desc);
notify pgrst, 'reload schema';
