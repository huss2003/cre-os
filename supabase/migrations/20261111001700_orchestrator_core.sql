-- Module 9 Orchestrator core (spec §3, §5, §6, §7, §10, §11, §15). Extends the existing workflow_run/workflow_step
-- tables (no parallel execution system), reuses mudar.job (queue), mudar.outbox (notifications), mudar.task,
-- mudar.audit_event. Adds: definitions (+versions), event outbox + idempotent processing log, workflow audit log,
-- reassessment marks (needs_refresh / stale), integration health. Re-runnable.

-- ---------------------------------------------------------------- executions: widen existing tables
alter table mudar.workflow_run drop constraint if exists workflow_run_kind_check;
alter table mudar.workflow_run add constraint workflow_run_kind_check check (kind in (
  'signal_chain', 'lease_chain', 'reply_chain', 'employer_chain', 'feedback_chain', 'meeting_chain',
  'orchestrated'      -- Module 9 engine: definition-driven executions
));
alter table mudar.workflow_run drop constraint if exists workflow_run_status_check;
alter table mudar.workflow_run add constraint workflow_run_status_check check (status in (
  'running', 'done', 'skipped', 'failed', 'waiting_approval',                       -- legacy chain values
  'queued', 'waiting_dependency', 'partially_completed', 'completed', 'cancelled', 'paused'));
alter table mudar.workflow_run
  add column if not exists definition_key text,
  add column if not exists definition_version int,
  add column if not exists trigger_type text,
  add column if not exists trigger_ref jsonb not null default '{}',
  add column if not exists priority int not null default 50,
  add column if not exists input jsonb not null default '{}',
  add column if not exists output_refs jsonb not null default '[]',
  add column if not exists error text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists timeout_at timestamptz,
  add column if not exists paused_from text,
  add column if not exists current_step text,
  add column if not exists progress int not null default 0;
create index if not exists workflow_run_orch_due_idx on mudar.workflow_run(workspace_id, status, next_attempt_at) where kind = 'orchestrated';
create index if not exists workflow_run_def_idx on mudar.workflow_run(workspace_id, definition_key, started_at desc);

alter table mudar.workflow_step drop constraint if exists workflow_step_status_check;
alter table mudar.workflow_step add constraint workflow_step_status_check check (status in (
  'queued', 'running', 'done', 'skipped', 'failed', 'waiting_approval', 'waiting_dependency', 'cancelled', 'dead'));
alter table mudar.workflow_step
  add column if not exists depends_on text[] not null default '{}',
  add column if not exists module text,
  add column if not exists attempts int not null default 0,
  add column if not exists max_attempts int not null default 3,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists error text,
  add column if not exists error_class text check (error_class in ('temporary', 'permanent')),
  add column if not exists output jsonb;

-- ---------------------------------------------------------------- definitions (code registry + per-workspace state)
create table if not exists mudar.workflow_definition (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  key text not null,
  status text not null default 'active' check (status in ('draft', 'active', 'paused')),
  version int not null default 1,
  priority int not null default 50 check (priority between 0 and 100),
  every_minutes int check (every_minutes is null or every_minutes >= 5),
  next_run_at timestamptz,
  last_run_at timestamptz,
  owner_user_id uuid references auth.users(id),
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);
create table if not exists mudar.workflow_definition_version (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  definition_id uuid not null references mudar.workflow_definition(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  changed_by uuid references auth.users(id),
  note text,
  created_at timestamptz not null default now(),
  unique (definition_id, version)
);

-- ---------------------------------------------------------------- audit (execution-level actions; row diffs stay in audit_event)
create table if not exists mudar.workflow_audit_log (
  id bigserial primary key,
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  run_id uuid references mudar.workflow_run(id) on delete cascade,
  definition_key text,
  action text not null,           -- started/duplicate/step_done/step_failed/retry_scheduled/dead/paused/resumed/cancelled/...
  actor_user_id uuid,
  actor_kind text not null default 'system' check (actor_kind in ('user', 'job', 'system')),
  detail jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index if not exists workflow_audit_run_idx on mudar.workflow_audit_log(workspace_id, run_id, occurred_at);

-- ---------------------------------------------------------------- events: transactional outbox + idempotent consumer log
create table if not exists mudar.event_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  event_type text not null,
  subject_type text,
  subject_id uuid,
  payload jsonb not null default '{}',
  dedupe_key text not null,
  duplicate_count int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'processed', 'failed', 'ignored')),
  attempts int not null default 0,
  last_error text,
  occurred_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (workspace_id, dedupe_key)
);
create index if not exists event_outbox_pending_idx on mudar.event_outbox(workspace_id, status, occurred_at) where status = 'pending';

create table if not exists mudar.event_processing_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  event_id uuid not null references mudar.event_outbox(id) on delete cascade,
  consumer text not null,
  status text not null default 'processing' check (status in ('processing', 'done', 'skipped', 'failed')),
  run_id uuid references mudar.workflow_run(id) on delete set null,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, consumer)
);

-- ---------------------------------------------------------------- reassessment marks + integration health
create table if not exists mudar.reassessment_mark (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  mark text not null check (mark in ('needs_refresh', 'stale', 'outdated_warning', 'review')),
  reason text not null,
  cause_type text,
  cause_id uuid,
  cause_event_id uuid references mudar.event_outbox(id) on delete set null,
  run_id uuid references mudar.workflow_run(id) on delete set null,
  state text not null default 'open' check (state in ('open', 'resolved', 'dismissed')),
  resolved_at timestamptz,
  detail jsonb not null default '{}',
  dedupe_key text not null
);
create table if not exists mudar.integration_health (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  source_key text not null,
  label text,
  status text not null default 'healthy' check (status in ('healthy', 'degraded', 'down')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  consecutive_failures int not null default 0,
  next_retry_at timestamptz,
  affects jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_key)
);

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'workflow_definition') then
    perform mudar_app.make_workspace_table('workflow_definition', 'admin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'workflow_definition_version') then
    perform mudar_app.make_workspace_table('workflow_definition_version', 'admin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'workflow_audit_log') then
    perform mudar_app.make_workspace_table('workflow_audit_log', 'editor');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'event_outbox') then
    perform mudar_app.make_workspace_table('event_outbox', 'editor');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'event_processing_log') then
    perform mudar_app.make_workspace_table('event_processing_log', 'editor');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'reassessment_mark') then
    perform mudar_app.make_business_table('reassessment_mark', false);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'integration_health') then
    perform mudar_app.make_workspace_table('integration_health', 'editor');
  end if;
end $$;
grant usage, select on sequence mudar.workflow_audit_log_id_seq to authenticated, service_role;
create unique index if not exists reassessment_mark_uq on mudar.reassessment_mark(workspace_id, dedupe_key);
create index if not exists reassessment_mark_entity_idx on mudar.reassessment_mark(workspace_id, entity_type, entity_id) where state = 'open';

-- ---------------------------------------------------------------- publish (idempotent; duplicates counted, never re-processed)
create or replace function mudar_app.publish_event(p_ws uuid, p_type text, p_subject_type text, p_subject_id uuid,
  p_payload jsonb, p_dedupe text) returns jsonb
language plpgsql security invoker set search_path = mudar, mudar_app, public as $$
declare r record;
begin
  insert into mudar.event_outbox(workspace_id, event_type, subject_type, subject_id, payload, dedupe_key)
  values (p_ws, p_type, p_subject_type, p_subject_id, coalesce(p_payload, '{}'), p_dedupe)
  on conflict (workspace_id, dedupe_key) do update set duplicate_count = mudar.event_outbox.duplicate_count + 1
  returning id, (xmax <> 0) as dup into r;
  return jsonb_build_object('id', r.id, 'duplicate', r.dup);
end $$;
grant execute on function mudar_app.publish_event(uuid, text, text, uuid, jsonb, text) to authenticated, service_role;

-- Internal publisher used by triggers: same transaction as the business write (transactional outbox). Never fails the write.
create or replace function mudar_app.orch_emit(p_ws uuid, p_type text, p_subject_type text, p_subject_id uuid, p_payload jsonb, p_dedupe text)
returns void language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  insert into mudar.event_outbox(workspace_id, event_type, subject_type, subject_id, payload, dedupe_key)
  values (p_ws, p_type, p_subject_type, p_subject_id, coalesce(p_payload, '{}'), p_dedupe)
  on conflict (workspace_id, dedupe_key) do update set duplicate_count = mudar.event_outbox.duplicate_count + 1;
exception when others then
  raise warning 'orch_emit % failed: %', p_type, sqlerrm;
end $$;
revoke all on function mudar_app.orch_emit(uuid, text, text, uuid, jsonb, text) from public, authenticated, anon;

-- ---------------------------------------------------------------- event triggers
create or replace function mudar_app.orch_meeting_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  if tg_op = 'INSERT' then
    perform mudar_app.orch_emit(new.workspace_id, 'meeting.scheduled', 'meeting_visit', new.id, jsonb_build_object('start_at', new.start_at), 'meeting:' || new.id || ':scheduled');
  elsif new.status is distinct from old.status and new.status in ('cancelled', 'completed') then
    perform mudar_app.orch_emit(new.workspace_id, 'meeting.' || new.status, 'meeting_visit', new.id,
      jsonb_build_object('from', old.status, 'start_at', new.start_at), 'meeting:' || new.id || ':' || new.status || ':' || new.row_version);
  elsif new.start_at is distinct from old.start_at and new.status <> 'cancelled' then
    perform mudar_app.orch_emit(new.workspace_id, 'meeting.rescheduled', 'meeting_visit', new.id,
      jsonb_build_object('from', old.start_at, 'to', new.start_at), 'meeting:' || new.id || ':rescheduled:' || new.row_version);
  end if;
  return new;
end $$;
drop trigger if exists orch_meeting_event on mudar.meeting_visit;
create trigger orch_meeting_event after insert or update on mudar.meeting_visit for each row execute function mudar_app.orch_meeting_event();

create or replace function mudar_app.orch_quote_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  perform mudar_app.orch_emit(new.workspace_id, 'commercial.quote_received', 'quote', new.id,
    jsonb_build_object('space_id', new.space_id, 'requirement_id', new.requirement_id, 'version', new.version), 'quote:' || new.id);
  return new;
end $$;
drop trigger if exists orch_quote_event on mudar.quote;
create trigger orch_quote_event after insert on mudar.quote for each row execute function mudar_app.orch_quote_event();

create or replace function mudar_app.orch_requirement_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
declare changed jsonb := '{}';
begin
  if new.area_min_sf is distinct from old.area_min_sf then changed := changed || jsonb_build_object('area_min_sf', jsonb_build_array(old.area_min_sf, new.area_min_sf)); end if;
  if new.area_target_sf is distinct from old.area_target_sf then changed := changed || jsonb_build_object('area_target_sf', jsonb_build_array(old.area_target_sf, new.area_target_sf)); end if;
  if new.area_max_sf is distinct from old.area_max_sf then changed := changed || jsonb_build_object('area_max_sf', jsonb_build_array(old.area_max_sf, new.area_max_sf)); end if;
  if new.seats_target is distinct from old.seats_target then changed := changed || jsonb_build_object('seats_target', jsonb_build_array(old.seats_target, new.seats_target)); end if;
  if new.budget_max is distinct from old.budget_max then changed := changed || jsonb_build_object('budget_max', jsonb_build_array(old.budget_max, new.budget_max)); end if;
  if new.preferred_geography_ids is distinct from old.preferred_geography_ids then changed := changed || jsonb_build_object('preferred_geography_ids', true); end if;
  if new.occupation_date is distinct from old.occupation_date then changed := changed || jsonb_build_object('occupation_date', jsonb_build_array(old.occupation_date, new.occupation_date)); end if;
  if new.constraints is distinct from old.constraints then changed := changed || jsonb_build_object('constraints', true); end if;
  if changed <> '{}'::jsonb then
    perform mudar_app.orch_emit(new.workspace_id, 'commercial.requirement_changed', 'requirement', new.id,
      jsonb_build_object('changed', changed, 'org_id', new.org_id, 'row_version', new.row_version), 'requirement:' || new.id || ':v' || new.row_version);
  end if;
  return new;
end $$;
drop trigger if exists orch_requirement_event on mudar.requirement;
create trigger orch_requirement_event after update on mudar.requirement for each row execute function mudar_app.orch_requirement_event();

create or replace function mudar_app.orch_employment_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  if new.is_current and exists (select 1 from mudar.employment e where e.workspace_id = new.workspace_id and e.person_id = new.person_id and e.id <> new.id and e.org_id <> new.org_id) then
    perform mudar_app.orch_emit(new.workspace_id, 'contact.employment_changed', 'person', new.person_id,
      jsonb_build_object('employment_id', new.id, 'new_org_id', new.org_id), 'employment:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists orch_employment_event on mudar.employment;
create trigger orch_employment_event after insert on mudar.employment for each row execute function mudar_app.orch_employment_event();

create or replace function mudar_app.orch_signal_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  perform mudar_app.orch_emit(new.workspace_id, 'research.signal_detected', new.subject_type, new.subject_id,
    jsonb_build_object('signal_id', new.id, 'claim_type', new.claim_type), 'signal_claim:' || new.id);
  return new;
end $$;
drop trigger if exists orch_signal_event on mudar.signal_claim;
create trigger orch_signal_event after insert on mudar.signal_claim for each row execute function mudar_app.orch_signal_event();

create or replace function mudar_app.orch_connector_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  if new.status is distinct from old.status then
    if new.status in ('error', 'expired', 'revoked') then
      perform mudar_app.orch_emit(new.workspace_id, 'integration.failed', 'connector_account', new.id,
        jsonb_build_object('source', 'connector:' || new.provider, 'status', new.status, 'error', new.last_error), 'connector:' || new.id || ':' || new.status || ':' || extract(epoch from now())::bigint);
    elsif new.status = 'connected' and old.status in ('error', 'expired', 'revoked') then
      perform mudar_app.orch_emit(new.workspace_id, 'integration.recovered', 'connector_account', new.id,
        jsonb_build_object('source', 'connector:' || new.provider), 'connector:' || new.id || ':recovered:' || extract(epoch from now())::bigint);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists orch_connector_event on mudar.connector_account;
create trigger orch_connector_event after update on mudar.connector_account for each row execute function mudar_app.orch_connector_event();
