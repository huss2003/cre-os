-- Module 9 Orchestrator — feature-audit gaps (docs/orchestrator/FEATURE-AUDIT.md). Re-runnable; mudar/mudar_app only.
--  1. automation_control: one-click global pause/resume of background automation per workspace (§2.13, UI A).
--  2. event_processing_log: 'routed' status + tracking of whether the receiving module completed the work (§2.4).
--  3. New event triggers: lease created/changed, company created/updated, contact created, contact info added (§2.5, rule 5).

-- ---------------------------------------------------------------- 1. global automation pause
create table if not exists mudar.automation_control (
  workspace_id uuid primary key references mudar.workspace(id) on delete cascade,
  paused boolean not null default false,
  paused_at timestamptz,
  paused_by uuid,
  reason text,
  resumed_at timestamptz,
  resumed_by uuid,
  updated_at timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'automation_control') then
    perform mudar_app.make_workspace_table('automation_control', 'editor');
  end if;
end $$;

-- ---------------------------------------------------------------- 2. routed-work tracking
alter table mudar.event_processing_log drop constraint if exists event_processing_log_status_check;
alter table mudar.event_processing_log add constraint event_processing_log_status_check
  check (status in ('processing', 'done', 'skipped', 'failed', 'routed'));
alter table mudar.event_processing_log
  add column if not exists routed_module text,
  add column if not exists routed_kind text,
  add column if not exists routed_status text check (routed_status in ('pending', 'running', 'completed', 'failed', 'delayed', 'untracked')),
  add column if not exists routed_run_id uuid references mudar.workflow_run(id) on delete set null,
  add column if not exists routed_checked_at timestamptz;
create index if not exists event_processing_log_routed_idx on mudar.event_processing_log(workspace_id, routed_status) where status = 'routed';

-- ---------------------------------------------------------------- 3. more event triggers (same transaction as the write)
create or replace function mudar_app.orch_lease_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
declare changed jsonb := '{}';
begin
  if tg_op = 'INSERT' then
    perform mudar_app.orch_emit(new.workspace_id, 'lease.created', 'lease', new.id,
      jsonb_build_object('tenant_org_id', new.tenant_org_id, 'asset_id', new.asset_id), 'lease:' || new.id || ':created');
    return new;
  end if;
  if new.area_sf is distinct from old.area_sf then changed := changed || jsonb_build_object('area_sf', jsonb_build_array(old.area_sf, new.area_sf)); end if;
  if new.rent_per_sf is distinct from old.rent_per_sf then changed := changed || jsonb_build_object('rent_per_sf', jsonb_build_array(old.rent_per_sf, new.rent_per_sf)); end if;
  if new.contractual_expiry is distinct from old.contractual_expiry then changed := changed || jsonb_build_object('contractual_expiry', jsonb_build_array(old.contractual_expiry, new.contractual_expiry)); end if;
  if new.start_date is distinct from old.start_date then changed := changed || jsonb_build_object('start_date', jsonb_build_array(old.start_date, new.start_date)); end if;
  if new.lockin_months_raw is distinct from old.lockin_months_raw then changed := changed || jsonb_build_object('lockin_months_raw', jsonb_build_array(old.lockin_months_raw, new.lockin_months_raw)); end if;
  if new.tenure_months_raw is distinct from old.tenure_months_raw then changed := changed || jsonb_build_object('tenure_months_raw', jsonb_build_array(old.tenure_months_raw, new.tenure_months_raw)); end if;
  if new.status is distinct from old.status then changed := changed || jsonb_build_object('status', jsonb_build_array(old.status, new.status)); end if;
  if new.tenant_org_id is distinct from old.tenant_org_id then changed := changed || jsonb_build_object('tenant_org_id', jsonb_build_array(old.tenant_org_id, new.tenant_org_id)); end if;
  if changed <> '{}'::jsonb then
    perform mudar_app.orch_emit(new.workspace_id, 'lease.changed', 'lease', new.id,
      jsonb_build_object('changed', changed, 'tenant_org_id', new.tenant_org_id), 'lease:' || new.id || ':v' || new.row_version);
  end if;
  return new;
end $$;
drop trigger if exists orch_lease_event on mudar.lease;
create trigger orch_lease_event after insert or update on mudar.lease for each row execute function mudar_app.orch_lease_event();

create or replace function mudar_app.orch_org_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
declare changed jsonb := '{}';
begin
  if tg_op = 'INSERT' then
    perform mudar_app.orch_emit(new.workspace_id, 'company.created', 'organisation', new.id, '{}'::jsonb, 'organisation:' || new.id || ':created');
    return new;
  end if;
  if new.display_name is distinct from old.display_name then changed := changed || jsonb_build_object('display_name', true); end if;
  if new.legal_name is distinct from old.legal_name then changed := changed || jsonb_build_object('legal_name', true); end if;
  if new.domain is distinct from old.domain then changed := changed || jsonb_build_object('domain', true); end if;
  if new.sector is distinct from old.sector then changed := changed || jsonb_build_object('sector', true); end if;
  if new.headcount_min is distinct from old.headcount_min or new.headcount_max is distinct from old.headcount_max then changed := changed || jsonb_build_object('headcount', true); end if;
  if new.is_gcc is distinct from old.is_gcc then changed := changed || jsonb_build_object('is_gcc', true); end if;
  if new.hq_country is distinct from old.hq_country then changed := changed || jsonb_build_object('hq_country', true); end if;
  if changed <> '{}'::jsonb then
    perform mudar_app.orch_emit(new.workspace_id, 'company.updated', 'organisation', new.id, jsonb_build_object('changed', changed), 'organisation:' || new.id || ':v' || new.row_version);
  end if;
  return new;
end $$;
drop trigger if exists orch_org_event on mudar.organisation;
create trigger orch_org_event after insert or update on mudar.organisation for each row execute function mudar_app.orch_org_event();

create or replace function mudar_app.orch_person_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  perform mudar_app.orch_emit(new.workspace_id, 'contact.created', 'person', new.id, '{}'::jsonb, 'person:' || new.id || ':created');
  return new;
end $$;
drop trigger if exists orch_person_event on mudar.person;
create trigger orch_person_event after insert on mudar.person for each row execute function mudar_app.orch_person_event();

create or replace function mudar_app.orch_contact_method_event() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
begin
  perform mudar_app.orch_emit(new.workspace_id, 'contact.info_added', 'person', new.person_id,
    jsonb_build_object('contact_method_id', new.id, 'method_type', new.method_type), 'contact_method:' || new.id);
  return new;
end $$;
drop trigger if exists orch_contact_method_event on mudar.contact_method;
create trigger orch_contact_method_event after insert on mudar.contact_method for each row execute function mudar_app.orch_contact_method_event();

-- ---------------------------------------------------------------- 4. resume: release deferred work (editor+, audited by caller)
-- Jobs are not user-writable, so resume goes through this definer function: jobs deferred by the automation pause
-- become due now and queued orchestrated runs are picked up at the next tick. No rows are created (no duplicates).
create or replace function mudar_app.release_automation_deferred(p_workspace uuid) returns int
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
declare n int;
begin
  if auth.uid() is not null and not mudar_app.has_role(p_workspace, 'editor') then
    raise exception 'editor role required' using errcode = '42501';
  end if;
  update mudar.job set due_at = now(), updated_at = now()
   where workspace_id = p_workspace and state = 'queued' and payload ? '_automationDeferredFrom';
  get diagnostics n = row_count;
  update mudar.workflow_run set next_attempt_at = now()
   where workspace_id = p_workspace and kind = 'orchestrated' and status = 'queued';
  return n;
end $$;
revoke all on function mudar_app.release_automation_deferred(uuid) from public, anon;
grant execute on function mudar_app.release_automation_deferred(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- 5. lock down the new SECURITY DEFINER trigger functions
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('mudar_app','mudar') and p.prosecdef and p.prorettype = 'trigger'::regtype
  loop execute format('revoke execute on function %s from public, anon, authenticated', r.f); end loop;
end $$;
notify pgrst, 'reload schema';
