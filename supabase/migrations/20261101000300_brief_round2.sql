set search_path = mudar, mudar_app, public, extensions;
-- brief module, round 2: Priority Adviser day order + event-driven re-planning (07), Lease Radar calculated events (10),
-- Relationship Caretaker (18). Re-runnable. Owned by src/modules/brief.

-- ------------------------------------------------------------------ lease_event: calculated radar rows
-- Calculated dates are persisted as their own rows (calc_key not null, date_basis 'calculated_by_radar', confirmed=false)
-- so they stay distinct from imported/verified events; calc_inputs keeps the formula inputs + source clause.
alter table mudar.lease_event add column if not exists calc_key text;
alter table mudar.lease_event add column if not exists calc_inputs jsonb;
alter table mudar.lease_event add column if not exists source_clause_id uuid;
create unique index if not exists lease_event_calc_key_uq on mudar.lease_event(workspace_id, calc_key) where calc_key is not null;

do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint where conrelid = 'mudar.lease_event'::regclass and conname = 'lease_event_date_basis_check';
  if v_def is null or position('calculated_by_radar' in v_def) = 0 then
    -- widen only (non-destructive): every previously valid value stays valid
    alter table mudar.lease_event drop constraint if exists lease_event_date_basis_check;
    alter table mudar.lease_event add constraint lease_event_date_basis_check check (date_basis in
      ('contractual','calculated_from_source_tenure','source_formula_cached','reported','estimated','calculated_by_radar'));
  end if;
end $$;

-- calculated rows must never claim to be confirmed/verified
create or replace function mudar_app.brief_calc_event_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
begin
  if new.calc_key is not null and (new.confirmed or new.date_basis <> 'calculated_by_radar') then
    raise exception 'calculated lease events must have date_basis calculated_by_radar and confirmed=false' using errcode = '23514';
  end if;
  if new.calc_key is null and new.date_basis = 'calculated_by_radar' then
    raise exception 'date_basis calculated_by_radar is reserved for radar-calculated rows (calc_key)' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists brief_calc_event_guard on mudar.lease_event;
create trigger brief_calc_event_guard before insert or update on mudar.lease_event for each row execute function mudar_app.brief_calc_event_guard();

-- ------------------------------------------------------------------ daily_plan: full day order
alter table mudar.daily_plan add column if not exists agenda jsonb not null default '{}';
alter table mudar.daily_plan add column if not exists trigger_reason text;

-- ------------------------------------------------------------------ task: never "done" without evidence (07/18)
create or replace function mudar_app.brief_task_done_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
begin
  if new.status = 'done'
     and (tg_op = 'INSERT' or old.status is distinct from 'done' or old.completion_evidence is distinct from new.completion_evidence)
     and coalesce(btrim(new.completion_evidence), '') = '' then
    raise exception 'completion_evidence_required: a task can only be marked done with completion evidence' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists brief_task_done_guard on mudar.task;
create trigger brief_task_done_guard before insert or update on mudar.task for each row execute function mudar_app.brief_task_done_guard();

-- ------------------------------------------------------------------ debounced, deduped brief jobs
-- One job per (type, workspace, debounce bucket); due at the end of the bucket so a burst of events coalesces.
create or replace function mudar_app.brief_enqueue(p_ws uuid, p_type text, p_reason text, p_debounce_sec int default 120)
returns uuid language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare v_bucket bigint; v_due timestamptz;
begin
  if p_ws is null then return null; end if;
  if not exists (select 1 from mudar.workspace w where w.id = p_ws and w.status = 'active') then return null; end if;
  v_bucket := floor(extract(epoch from now()) / greatest(p_debounce_sec, 1));
  v_due := to_timestamp((v_bucket + 1) * greatest(p_debounce_sec, 1));
  return mudar_app.enqueue_job(p_ws, p_type, jsonb_build_object('reason', p_reason, 'bucket', v_bucket), v_due,
    p_type || ':' || p_ws::text || ':' || v_bucket::text, 3);
end $$;
revoke all on function mudar_app.brief_enqueue(uuid, text, text, int) from public, anon, authenticated;

-- statement-level trigger functions (transition tables) so bulk imports enqueue once per workspace
create or replace function mudar_app.brief_tg_replan_ins() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct workspace_id from new_rows loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.replan', tg_table_name || ' ' || lower(tg_op), 120);
  end loop;
  return null;
end $$;

create or replace function mudar_app.brief_tg_task_upd() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct n.workspace_id from new_rows n join old_rows o on o.id = n.id
           where (n.status, n.due_at, n.depends_on, n.snoozed_until, n.assigned_user_id, n.priority)
                 is distinct from (o.status, o.due_at, o.depends_on, o.snoozed_until, o.assigned_user_id, o.priority) loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.replan', 'task state/due changed', 120);
  end loop;
  return null;
end $$;

create or replace function mudar_app.brief_tg_inbound_interaction() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct workspace_id from new_rows where direction = 'inbound' loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.replan', 'new inbound reply', 120);
  end loop;
  for r in select distinct workspace_id from new_rows where promises is not null and jsonb_typeof(promises) = 'array' and jsonb_array_length(promises) > 0 loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.caretaker', 'interaction promises recorded', 120);
  end loop;
  return null;
end $$;

create or replace function mudar_app.brief_tg_interaction_upd() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct n.workspace_id from new_rows n join old_rows o on o.id = n.id where n.promises is distinct from o.promises loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.caretaker', 'interaction promises changed', 120);
  end loop;
  return null;
end $$;

create or replace function mudar_app.brief_tg_change_upd() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct n.workspace_id from new_rows n join old_rows o on o.id = n.id
           where n.state in ('approved','applied') and n.state is distinct from o.state loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.replan', 'material change approved', 120);
  end loop;
  return null;
end $$;

create or replace function mudar_app.brief_tg_milestone_upd() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct n.workspace_id from new_rows n join old_rows o on o.id = n.id
           where (n.status, n.due_date, n.depends_on) is distinct from (o.status, o.due_date, o.depends_on) loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.replan', 'deal milestone changed', 120);
  end loop;
  return null;
end $$;

-- lease radar: any lease / non-calculated lease_event change, or a lease document/clause import
create or replace function mudar_app.brief_tg_radar() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  if tg_table_name = 'lease_event' then
    if tg_op = 'DELETE' then
      for r in select distinct workspace_id from old_rows where calc_key is null loop
        perform mudar_app.brief_enqueue(r.workspace_id, 'brief.radar', 'lease_event delete', 60);
      end loop;
    else
      for r in select distinct workspace_id from new_rows where calc_key is null loop
        perform mudar_app.brief_enqueue(r.workspace_id, 'brief.radar', 'lease_event ' || lower(tg_op), 60);
      end loop;
    end if;
  elsif tg_table_name = 'clause_extract' then
    for r in select distinct workspace_id from new_rows where clause_type in ('escalation','term','lock_in','notice','termination') loop
      perform mudar_app.brief_enqueue(r.workspace_id, 'brief.radar', 'lease clause extracted', 60);
    end loop;
  elsif tg_op = 'DELETE' then
    for r in select distinct workspace_id from old_rows loop
      perform mudar_app.brief_enqueue(r.workspace_id, 'brief.radar', tg_table_name || ' delete', 60);
    end loop;
  else
    for r in select distinct workspace_id from new_rows loop
      perform mudar_app.brief_enqueue(r.workspace_id, 'brief.radar', tg_table_name || ' ' || lower(tg_op), 60);
    end loop;
  end if;
  return null;
end $$;

create or replace function mudar_app.brief_tg_caretaker() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct workspace_id from new_rows loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.caretaker', tg_table_name || ' ' || lower(tg_op), 120);
  end loop;
  return null;
end $$;

create or replace function mudar_app.brief_tg_opp_upd() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in select distinct n.workspace_id from new_rows n join old_rows o on o.id = n.id
           where (n.outcome, n.stage) is distinct from (o.outcome, o.stage) loop
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.caretaker', 'opportunity outcome/stage changed', 120);
    perform mudar_app.brief_enqueue(r.workspace_id, 'brief.replan', 'opportunity changed', 120);
  end loop;
  return null;
end $$;

do $$
begin
  -- task
  drop trigger if exists brief_replan_task_ins on mudar.task;
  create trigger brief_replan_task_ins after insert on mudar.task referencing new table as new_rows for each statement execute function mudar_app.brief_tg_replan_ins();
  drop trigger if exists brief_replan_task_upd on mudar.task;
  create trigger brief_replan_task_upd after update on mudar.task referencing new table as new_rows old table as old_rows for each statement execute function mudar_app.brief_tg_task_upd();
  -- inbound replies
  drop trigger if exists brief_replan_inbound_ins on mudar.inbound_message;
  create trigger brief_replan_inbound_ins after insert on mudar.inbound_message referencing new table as new_rows for each statement execute function mudar_app.brief_tg_replan_ins();
  drop trigger if exists brief_interaction_ins on mudar.interaction;
  create trigger brief_interaction_ins after insert on mudar.interaction referencing new table as new_rows for each statement execute function mudar_app.brief_tg_inbound_interaction();
  drop trigger if exists brief_interaction_upd on mudar.interaction;
  create trigger brief_interaction_upd after update on mudar.interaction referencing new table as new_rows old table as old_rows for each statement execute function mudar_app.brief_tg_interaction_upd();
  -- approved material changes
  drop trigger if exists brief_replan_change_upd on mudar.change_proposal;
  create trigger brief_replan_change_upd after update on mudar.change_proposal referencing new table as new_rows old table as old_rows for each statement execute function mudar_app.brief_tg_change_upd();
  -- deal milestones (dependencies / due dates)
  if to_regclass('mudar.deal_milestone') is not null then
    drop trigger if exists brief_replan_milestone_upd on mudar.deal_milestone;
    create trigger brief_replan_milestone_upd after update on mudar.deal_milestone referencing new table as new_rows old table as old_rows for each statement execute function mudar_app.brief_tg_milestone_upd();
  end if;
  -- lease radar
  drop trigger if exists brief_radar_lease_ins on mudar.lease;
  create trigger brief_radar_lease_ins after insert on mudar.lease referencing new table as new_rows for each statement execute function mudar_app.brief_tg_radar();
  drop trigger if exists brief_radar_lease_upd on mudar.lease;
  create trigger brief_radar_lease_upd after update on mudar.lease referencing new table as new_rows for each statement execute function mudar_app.brief_tg_radar();
  drop trigger if exists brief_radar_lease_del on mudar.lease;
  create trigger brief_radar_lease_del after delete on mudar.lease referencing old table as old_rows for each statement execute function mudar_app.brief_tg_radar();
  drop trigger if exists brief_radar_event_ins on mudar.lease_event;
  create trigger brief_radar_event_ins after insert on mudar.lease_event referencing new table as new_rows for each statement execute function mudar_app.brief_tg_radar();
  drop trigger if exists brief_radar_event_upd on mudar.lease_event;
  create trigger brief_radar_event_upd after update on mudar.lease_event referencing new table as new_rows for each statement execute function mudar_app.brief_tg_radar();
  drop trigger if exists brief_radar_event_del on mudar.lease_event;
  create trigger brief_radar_event_del after delete on mudar.lease_event referencing old table as old_rows for each statement execute function mudar_app.brief_tg_radar();
  if to_regclass('mudar.legal_document') is not null then
    drop trigger if exists brief_radar_legal_ins on mudar.legal_document;
    create trigger brief_radar_legal_ins after insert on mudar.legal_document referencing new table as new_rows for each statement execute function mudar_app.brief_tg_radar();
  end if;
  if to_regclass('mudar.clause_extract') is not null then
    drop trigger if exists brief_radar_clause_ins on mudar.clause_extract;
    create trigger brief_radar_clause_ins after insert on mudar.clause_extract referencing new table as new_rows for each statement execute function mudar_app.brief_tg_radar();
  end if;
  -- relationship caretaker
  if to_regclass('mudar.visit_feedback') is not null then
    drop trigger if exists brief_caretaker_feedback_ins on mudar.visit_feedback;
    create trigger brief_caretaker_feedback_ins after insert on mudar.visit_feedback referencing new table as new_rows for each statement execute function mudar_app.brief_tg_caretaker();
    drop trigger if exists brief_caretaker_feedback_upd on mudar.visit_feedback;
    create trigger brief_caretaker_feedback_upd after update on mudar.visit_feedback referencing new table as new_rows for each statement execute function mudar_app.brief_tg_caretaker();
  end if;
  drop trigger if exists brief_caretaker_opp_upd on mudar.opportunity;
  create trigger brief_caretaker_opp_upd after update on mudar.opportunity referencing new table as new_rows old table as old_rows for each statement execute function mudar_app.brief_tg_opp_upd();
end $$;

-- jobs (service role) call brief_enqueue for the hourly 48-hour deadline watch
grant execute on function mudar_app.brief_enqueue(uuid, text, text, int) to service_role;

-- trigger functions are only invoked by triggers: no direct EXECUTE for API roles
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'mudar_app' and (p.proname like 'brief\_tg\_%' or p.proname in ('brief_task_done_guard', 'brief_calc_event_guard')) loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
