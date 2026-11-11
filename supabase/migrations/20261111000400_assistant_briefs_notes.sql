-- Module 12 round 2 (briefs agent): automatic morning brief + notes → database updates. Re-runnable.

-- Per-user opt-in for the automatic morning brief (one row per user per workspace).
create table if not exists mudar.assistant_brief_setting (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null default false,
  time_local text not null default '08:00' check (time_local ~ '^[0-2][0-9]:[0-5][0-9]$'),
  timezone text not null default 'Asia/Kolkata',
  top_n int not null default 10 check (top_n between 1 and 50),
  next_run_at timestamptz,
  opted_in_at timestamptz
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_brief_setting' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_brief_setting');
  end if;
end $$;
create unique index if not exists assistant_brief_setting_user on mudar.assistant_brief_setting(workspace_id, owner_user_id);
create index if not exists assistant_brief_setting_due on mudar.assistant_brief_setting(next_run_at) where enabled;

-- One delivered brief per user per local day (dedupe + link from /home).
create table if not exists mudar.assistant_morning_brief (
  id uuid primary key default gen_random_uuid(),
  brief_date date not null,
  conversation_id uuid references mudar.assistant_conversation(id) on delete set null,
  status text not null default 'complete' check (status in ('complete','partial','failed')),
  failed_sources text[] not null default '{}',
  counts jsonb not null default '{}'
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_morning_brief' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_morning_brief');
  end if;
end $$;
create unique index if not exists assistant_morning_brief_day on mudar.assistant_morning_brief(workspace_id, owner_user_id, brief_date);

-- Pasted/dictated notes awaiting review. Raw text is untrusted evidence. Nothing canonical is written until approval.
create table if not exists mudar.assistant_note (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  body_hash text not null,
  meeting_visit_id uuid,
  org_id uuid,
  requirement_id uuid,
  status text not null default 'pending_review' check (status in ('pending_review','applied','discarded')),
  proposals jsonb not null default '[]',
  unresolved jsonb not null default '[]',
  extraction_model text,
  interaction_id uuid,
  results jsonb not null default '{}',
  decided_at timestamptz
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_note' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_note');
  end if;
end $$;
create unique index if not exists assistant_note_dedupe on mudar.assistant_note(workspace_id, owner_user_id, body_hash) where status = 'pending_review';
