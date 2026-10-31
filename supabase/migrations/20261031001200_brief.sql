set search_path = mudar, mudar_app, public, extensions;
-- brief module: daily plan (priority adviser output) and health-watchdog runs.
-- Re-runnable: objects are created only when absent. Owned by src/modules/brief.

do $$
begin
  if to_regclass('mudar.daily_plan') is null then
    create table mudar.daily_plan (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      plan_date date not null,
      input_version text not null,             -- hash of scores/tasks/meetings/capacity used (spec: user+local date+input version)
      mode text not null default 'workday' check (mode in ('workday','light')),
      capacity jsonb not null default '{}',    -- calendar capacity controller output
      items jsonb not null default '[]',       -- selected actions/targets with why + displaced
      displaced jsonb not null default '[]',   -- candidates below the cut line and why
      rubric_version text not null default 'v1',
      generated_at timestamptz not null default now()
    );
    perform mudar_app.make_business_table('daily_plan', false);
    create unique index daily_plan_uq on mudar.daily_plan(workspace_id, user_id, plan_date, input_version);
    create index daily_plan_user_date_idx on mudar.daily_plan(workspace_id, user_id, plan_date desc, generated_at desc);
  end if;

  if to_regclass('mudar.brief_health_run') is null then
    create table mudar.brief_health_run (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      run_date date not null,
      check_kind text not null check (check_kind in ('pre_brief','post_brief')),   -- 07:55 / 08:05
      ran_at timestamptz not null default now(),
      sources jsonb not null default '[]',     -- [{key,status,last_success_at,error}]
      brief_present boolean not null,
      brief_delivered boolean not null default false,
      action_taken text                        -- none / fallback_generated / owner_alerted
    );
    perform mudar_app.make_business_table('brief_health_run', false);
    create unique index brief_health_run_uq on mudar.brief_health_run(workspace_id, user_id, run_date, check_kind);
  end if;
end $$;
