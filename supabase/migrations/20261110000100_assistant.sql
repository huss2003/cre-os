-- Module 12: Supercharged AI Assistant. Supporting tables only; business data stays in existing tables.
-- Re-runnable.

-- Conversations ----------------------------------------------------------------
create table if not exists mudar.assistant_conversation (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New conversation',
  pinned boolean not null default false,
  context_entity_type text,          -- company | person | asset | requirement | opportunity | meeting | ...
  context_entity_id uuid,
  entity_refs jsonb not null default '[]',   -- [{type,id,label}] linked records
  summary text,                       -- rolling summary for long chats
  summary_upto int not null default 0, -- message seq covered by summary
  decisions jsonb not null default '[]',
  open_questions jsonb not null default '[]',
  last_message_at timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_conversation' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_conversation', false);
  end if;
end $$;
create index if not exists assistant_conversation_recent on mudar.assistant_conversation(workspace_id, owner_user_id, last_message_at desc) where archived_at is null;

create table if not exists mudar.assistant_message (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references mudar.assistant_conversation(id) on delete cascade,
  seq int not null,
  role text not null check (role in ('user','assistant','tool','system')),
  content text not null default '',
  blocks jsonb not null default '[]',     -- structured render blocks (see src/modules/assistant/types.ts)
  status text not null default 'complete' check (status in ('pending','running','complete','partial','failed','waiting_approval')),
  model text,
  usage jsonb,
  run_id uuid,
  search tsvector generated always as (to_tsvector('simple', coalesce(content,''))) stored
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_message' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_message', false);
  end if;
end $$;
create unique index if not exists assistant_message_seq on mudar.assistant_message(conversation_id, seq);
create index if not exists assistant_message_search on mudar.assistant_message using gin(search);

create table if not exists mudar.assistant_attachment (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references mudar.assistant_conversation(id) on delete cascade,
  message_id uuid references mudar.assistant_message(id) on delete set null,
  file_name text not null,
  mime text,
  size_bytes int,
  storage_path text,                 -- mudar-workspace-files bucket
  extracted_text text,               -- untrusted evidence; never instructions
  pages int,
  search tsvector generated always as (to_tsvector('simple', coalesce(file_name,'') || ' ' || coalesce(extracted_text,''))) stored
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_attachment' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_attachment', false);
  end if;
end $$;
create index if not exists assistant_attachment_search on mudar.assistant_attachment using gin(search);

-- Runs (one user request = one run, may be a background job) ---------------------
create table if not exists mudar.assistant_run (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references mudar.assistant_conversation(id) on delete cascade,
  command_id uuid,
  request text not null,
  intent text,
  model_route text,                  -- fast | deep
  status text not null default 'queued' check (status in ('queued','running','waiting_info','waiting_approval','partial','completed','failed','cancelled')),
  current_step text,
  progress int not null default 0,   -- 0..100
  steps_done int not null default 0,
  result_summary text,
  error text,
  idempotency_key text,
  started_at timestamptz,
  finished_at timestamptz,
  usage jsonb not null default '{}'
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_run' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_run', false);
  end if;
end $$;
create unique index if not exists assistant_run_idem on mudar.assistant_run(workspace_id, idempotency_key) where idempotency_key is not null;
create index if not exists assistant_run_status on mudar.assistant_run(workspace_id, status, created_at desc);

create table if not exists mudar.assistant_tool_execution (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references mudar.assistant_run(id) on delete cascade,
  step int not null,
  tool_id text not null,
  category text not null check (category in ('A','B','C')),
  input jsonb not null default '{}',
  output_summary text,
  output jsonb,                       -- trimmed structured output (references, not copies, where possible)
  status text not null check (status in ('ok','error','denied','needs_approval','timeout')),
  error text,
  duration_ms int,
  dedupe_key text
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_tool_execution' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_tool_execution', false);
  end if;
end $$;
create index if not exists assistant_tool_execution_run on mudar.assistant_tool_execution(run_id, step);
create unique index if not exists assistant_tool_execution_dedupe on mudar.assistant_tool_execution(workspace_id, dedupe_key) where dedupe_key is not null and status = 'ok';

create table if not exists mudar.assistant_approval (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references mudar.assistant_run(id) on delete cascade,
  tool_id text not null,
  title text not null,
  explanation text not null,
  affected jsonb not null default '[]',   -- [{type,id,label}]
  diff jsonb not null default '[]',       -- [{field,before,after}]
  input jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed','failed','expired')),
  change_proposal_id uuid,
  decided_by uuid,
  decided_at timestamptz,
  result jsonb
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_approval' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_approval', false);
  end if;
end $$;
create index if not exists assistant_approval_pending on mudar.assistant_approval(workspace_id, status, created_at desc);

-- Memory (Module 13 integration point) ------------------------------------------
create table if not exists mudar.assistant_memory (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('person','company','requirement','relationship')),
  entity_type text not null,          -- person | organisation | requirement
  entity_id uuid not null,
  org_context_id uuid,                -- employer at capture time (person memories); never carried to a new employer
  content text not null,
  source text not null,               -- e.g. 'conversation', 'meeting:<id>', 'user'
  source_ref jsonb,
  provided_by text,
  stated boolean not null default true, -- true = explicitly stated, false = inferred
  confidence numeric not null default 0.8 check (confidence between 0 and 1),
  sensitivity text not null default 'normal' check (sensitivity in ('normal','confidential','restricted')),
  status text not null default 'active' check (status in ('active','outdated','restricted','forgotten')),
  captured_at timestamptz not null default now(),
  last_verified_at timestamptz,
  review_at date,
  supersedes_id uuid references mudar.assistant_memory(id),
  superseded_by_id uuid references mudar.assistant_memory(id),
  search tsvector generated always as (to_tsvector('simple', coalesce(content,''))) stored
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_memory' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_memory', false);
  end if;
end $$;
create index if not exists assistant_memory_entity on mudar.assistant_memory(workspace_id, entity_type, entity_id, status);
create index if not exists assistant_memory_search on mudar.assistant_memory using gin(search);

-- Saved commands -----------------------------------------------------------------
create table if not exists mudar.assistant_command (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  prompt text not null,
  inputs jsonb not null default '[]',      -- [{key,label,required,default}]
  defaults jsonb not null default '{}',
  tools jsonb not null default '[]',
  output_format text not null default 'chat',
  version int not null default 1,
  schedule_cron text,                      -- e.g. '0 8 * * 1-5' (IST)
  schedule_enabled boolean not null default false, -- explicit opt-in
  schedule_authorised_at timestamptz,
  last_run_at timestamptz,
  next_run_at timestamptz
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_command' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_command', false);
  end if;
end $$;
create index if not exists assistant_command_due on mudar.assistant_command(next_run_at) where schedule_enabled and archived_at is null;

create table if not exists mudar.assistant_feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references mudar.assistant_message(id) on delete cascade,
  rating int check (rating in (-1, 1)),
  comment text
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_feedback' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_feedback', false);
  end if;
end $$;

-- Security events (denied access attempts etc.) ----------------------------------
create table if not exists mudar.assistant_security_event (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                -- access_denied | approval_bypass_attempt | ...
  tool_id text,
  detail jsonb not null default '{}'
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_security_event' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_security_event', false);
  end if;
end $$;

notify pgrst, 'reload schema';
