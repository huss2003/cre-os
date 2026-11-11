-- Module 9 Orchestrator — scheduling, notifications, capacity, budgets (spec §4, §8, §9, §12).
-- Re-runnable. Reuses: mudar.outbox (notification transport + dedupe), mudar.task, mudar.brief, mudar.model_usage,
-- mudar.user_preference (notification / timezone prefs). Only orchestration-specific structures are added here.

-- ------------------------------------------------------------------ 1. notification state (side table on outbox)
create table if not exists mudar.notification_state (
  outbox_id uuid primary key references mudar.outbox(id) on delete cascade,
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  category text not null default 'info',
  severity text not null default 'info' check (severity in ('urgent','info')),
  title text,
  body text,
  record_type text,
  record_id uuid,
  href text,
  group_key text,
  group_parent uuid references mudar.outbox(id) on delete cascade,   -- set when folded into another notification
  group_count int not null default 1,
  trigger_key text,                                                   -- condition key; cancelled when obsolete
  status text not null default 'pending' check (status in ('pending','dismissed','snoozed','completed','cancelled')),
  deliver_after timestamptz not null default now(),                  -- quiet/working hours deferral
  snoozed_until timestamptz,
  acted_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notification_state_user_idx on mudar.notification_state(workspace_id, user_id, status, deliver_after);
create index if not exists notification_state_group_idx on mudar.notification_state(workspace_id, user_id, group_key) where group_parent is null;
create index if not exists notification_state_trigger_idx on mudar.notification_state(workspace_id, trigger_key) where trigger_key is not null;
alter table mudar.notification_state enable row level security;
drop policy if exists notification_state_own_sel on mudar.notification_state;
create policy notification_state_own_sel on mudar.notification_state for select to authenticated
  using ((user_id = auth.uid() and mudar_app.is_member(workspace_id)) or mudar_app.has_role(workspace_id, 'admin'));
drop policy if exists notification_state_own_ins on mudar.notification_state;
create policy notification_state_own_ins on mudar.notification_state for insert to authenticated
  with check (user_id = auth.uid() and mudar_app.is_member(workspace_id)
    and exists (select 1 from mudar.outbox o where o.id = outbox_id and o.workspace_id = notification_state.workspace_id and o.user_id = auth.uid()));
drop policy if exists notification_state_own_upd on mudar.notification_state;
create policy notification_state_own_upd on mudar.notification_state for update to authenticated
  using (user_id = auth.uid() and mudar_app.is_member(workspace_id)) with check (user_id = auth.uid() and mudar_app.is_member(workspace_id));
grant select, insert, update on mudar.notification_state to authenticated;
grant all on mudar.notification_state to service_role;

-- ------------------------------------------------------------------ 2. daily plans + weekly reviews (deliverables)
do $$ begin
  if to_regclass('mudar.orch_plan') is null then
    create table mudar.orch_plan (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      kind text not null check (kind in ('daily','weekly')),
      period_key text not null,                 -- local date (daily) or ISO week (weekly)
      tz text not null,
      brief_id uuid references mudar.brief(id) on delete set null,   -- the brief module's daily brief this plan extends
      sections jsonb not null default '{}',
      recommended jsonb not null default '[]',
      ai_status text not null default 'ok' check (ai_status in ('ok','delayed','not_used')),
      ai_summary jsonb,
      content_hash text not null,
      version int not null default 1,
      generated_at timestamptz not null default now()
    );
    perform mudar_app.make_business_table('orch_plan', false);
    create unique index orch_plan_uq on mudar.orch_plan(workspace_id, user_id, kind, period_key);
  end if;
end $$;

-- ------------------------------------------------------------------ 3. task schedule (estimates, class, user override)
do $$ begin
  if to_regclass('mudar.task_schedule') is null then
    create table mudar.task_schedule (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null unique references mudar.task(id) on delete cascade,
      estimated_minutes int check (estimated_minutes is null or estimated_minutes between 1 and 1440),
      priority_class text,
      scheduled_start timestamptz,
      scheduled_end timestamptz,
      user_override boolean not null default false
    );
    perform mudar_app.make_business_table('task_schedule', false);
  end if;
end $$;

-- ------------------------------------------------------------------ 4. budgets + non-model usage
create table if not exists mudar.resource_budget (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  resource text not null check (resource in ('model_tokens','research','enrichment','transcription','documents','external_api','jobs')),
  provider text not null default '*',
  module text not null default '*',
  period text not null check (period in ('daily','monthly')),
  limit_units numeric(14,4) not null check (limit_units >= 0),
  unit text not null check (unit in ('usd','calls','credits','seconds','pages','runs')),
  alert_pct int not null default 80 check (alert_pct between 1 and 100),
  enabled boolean not null default true,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, resource, provider, module, period)
);
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'resource_budget') then
    perform mudar_app.make_workspace_table('resource_budget', 'admin');
  end if;
end $$;

create table if not exists mudar.resource_usage (
  id bigserial primary key,
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  resource text not null,
  provider text not null default 'internal',
  module text not null,
  workflow text,
  user_id uuid references auth.users(id),
  units numeric(14,4) not null default 0,
  unit text not null,
  job_id uuid,
  dedupe_key text,
  unique (workspace_id, dedupe_key)
);
create index if not exists resource_usage_ws_idx on mudar.resource_usage(workspace_id, resource, occurred_at);
alter table mudar.resource_usage enable row level security;
drop policy if exists resource_usage_sel on mudar.resource_usage;
create policy resource_usage_sel on mudar.resource_usage for select to authenticated using (mudar_app.has_role(workspace_id, 'admin'));
grant select on mudar.resource_usage to authenticated;
grant all on mudar.resource_usage to service_role;
grant usage on sequence mudar.resource_usage_id_seq to service_role;

notify pgrst, 'reload schema';
