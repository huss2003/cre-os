-- Workflows (orchestrator, spec Module 9 / Workflow 1 + Workflow 7): visible, idempotent chains that call existing
-- module services. One workflow_run per trigger (unique dedupe_key per workspace), one workflow_step per step.
-- Re-runnable: tables are created if missing and make_business_table is applied only once per table.
create table if not exists mudar.workflow_run (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('signal_chain', 'lease_chain')),
  subject_type text not null,                 -- 'signal' | 'lease'
  subject_id uuid not null,
  org_id uuid references mudar.organisation(id),
  dedupe_key text not null,                   -- e.g. signal:<id>:strong | lease:<id>:expiry_12m:<date>
  status text not null default 'running' check (status in ('running', 'done', 'skipped', 'failed', 'waiting_approval')),
  summary text,
  actor_user_id uuid references auth.users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  attempts int not null default 1
);

create table if not exists mudar.workflow_step (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references mudar.workflow_run(id) on delete cascade,
  seq int not null,
  step_key text not null,
  label text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'skipped', 'failed', 'waiting_approval')),
  reason text,
  output_refs jsonb not null default '[]',    -- [{type, id, label?}]
  started_at timestamptz,
  finished_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'workflow_run') then
    perform mudar_app.make_business_table('workflow_run');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'workflow_step') then
    perform mudar_app.make_business_table('workflow_step', false);
  end if;
end $$;

create unique index if not exists workflow_run_dedupe_uq on mudar.workflow_run(workspace_id, dedupe_key);
create index if not exists workflow_run_recent_idx on mudar.workflow_run(workspace_id, started_at desc);
create index if not exists workflow_run_waiting_idx on mudar.workflow_run(workspace_id, status) where status = 'waiting_approval';
create unique index if not exists workflow_step_key_uq on mudar.workflow_step(run_id, step_key);
