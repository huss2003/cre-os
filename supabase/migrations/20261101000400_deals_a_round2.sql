set search_path = mudar, mudar_app, public, extensions;
-- Deals-A round 2 (workflows 08 Requirement Analyst, 09 Property Adviser, 11 Financial Analyst).
-- Re-runnable: create-if-not-exists / create or replace / drop trigger if exists. Touches only deals-A objects.
--  * deals.rematch: statement-level triggers on availability / space / asset (+ requirement hard-constraint edits)
--    enqueue at most one QUEUED re-match job per active requirement (dedupe) — handled in src/modules/deals/jobs.ts.
--  * deals.req_tasks: requirement changes applied through approved change proposals refresh the follow-up tasks.
--  * finance_scenario: version chain, explicit rounding rule, cost gaps + gap acknowledgement recorded with approval.
--  * finance_assumption: assumptions register (source + approval per assumption; approval drops when the value changes).
--  * hard filters / spec sources on a client-confirmed requirement change only through approved proposals.

-- ================================================================ re-match on inventory changes
create or replace function mudar_app.deals_enqueue_rematch(p_ws uuid, p_reason text, p_requirement uuid default null)
returns int language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record; n int := 0;
begin
  for r in
    select q.id from mudar.requirement q
     where q.workspace_id = p_ws and q.archived_at is null
       and (p_requirement is null or q.id = p_requirement)
       and q.status in ('estimated', 'client_confirmed')
       and (q.status = 'client_confirmed' or exists (select 1 from mudar.shortlist_version s where s.requirement_id = q.id and s.workspace_id = p_ws))
       and not exists (select 1 from mudar.job j where j.job_type = 'deals.rematch' and j.state = 'queued' and j.workspace_id = p_ws
                         and j.payload->>'requirement_id' = q.id::text)
  loop
    -- dedupe: at most one queued job per requirement (checked above); the key is unique per enqueue so a change that
    -- arrives while a job is already running still gets its own follow-up run.
    perform mudar_app.enqueue_job(p_ws, 'deals.rematch', jsonb_build_object('requirement_id', r.id, 'reason', p_reason),
                                  now() + interval '1 minute', format('deals.rematch:%s:%s', r.id, (extract(epoch from clock_timestamp()) * 1000000)::bigint), 3);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function mudar_app.deals_enqueue_rematch(uuid, text, uuid) from public, anon, authenticated;

create or replace function mudar_app.deals_inventory_changed() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare w uuid;
begin
  for w in select distinct workspace_id from new_rows loop
    perform mudar_app.deals_enqueue_rematch(w, format('%s %s', tg_table_name, lower(tg_op)));
  end loop;
  return null;
end $$;
revoke all on function mudar_app.deals_inventory_changed() from public, anon, authenticated;

do $$
declare t text; op text;
begin
  foreach t in array array['availability', 'space', 'asset'] loop
    foreach op in array array['insert', 'update'] loop
      execute format('drop trigger if exists %1$s_deals_rematch_%2$s on mudar.%1$I', t, op);
      execute format('create trigger %1$s_deals_rematch_%2$s after %2$s on mudar.%1$I referencing new table as new_rows for each statement execute function mudar_app.deals_inventory_changed()', t, op);
    end loop;
  end loop;
end $$;

-- requirement: confirmation or a hard-constraint / matching-config edit → re-match; changes applied through approved
-- proposals (apply_change) → refresh the follow-up tasks (the service refreshes them itself for direct edits).
create or replace function mudar_app.deals_requirement_changed() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if new.archived_at is not null then return null; end if;
  if (new.status = 'client_confirmed' and old.status is distinct from 'client_confirmed')
     or new.constraints is distinct from old.constraints or new.area_min_sf is distinct from old.area_min_sf
     or new.area_max_sf is distinct from old.area_max_sf or new.area_target_sf is distinct from old.area_target_sf
     or new.area_basis is distinct from old.area_basis or new.budget_max is distinct from old.budget_max
     or new.budget_basis is distinct from old.budget_basis or new.occupation_date is distinct from old.occupation_date
     or new.preferred_geography_ids is distinct from old.preferred_geography_ids
     or new.excluded_geography_ids is distinct from old.excluded_geography_ids or new.seats_min is distinct from old.seats_min then
    perform mudar_app.deals_enqueue_rematch(new.workspace_id, 'requirement updated', new.id);
  end if;
  if coalesce(current_setting('mudar_app.change_proposal_id', true), '') <> '' then
    perform mudar_app.enqueue_job(new.workspace_id, 'deals.req_tasks', jsonb_build_object('requirement_id', new.id),
                                  now(), format('deals.req_tasks:%s:%s', new.id, new.row_version), 3);
  end if;
  return null;
end $$;
revoke all on function mudar_app.deals_requirement_changed() from public, anon, authenticated;
drop trigger if exists requirement_deals_a_changed on mudar.requirement;
create trigger requirement_deals_a_changed after update on mudar.requirement for each row execute function mudar_app.deals_requirement_changed();

-- hard filters / spec provenance of a client-confirmed requirement are hard constraints too (required_specs is
-- already locked by requirement_deals_guard).
create or replace function mudar_app.deals_a_requirement_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
begin
  if mudar_app.deals_via_proposal() then return new; end if;
  if old.status = 'client_confirmed' and (
       (old.constraints->'hard_filters') is distinct from (new.constraints->'hard_filters')
    or (old.constraints->'spec_sources') is distinct from (new.constraints->'spec_sources')) then
    raise exception 'requirement is client-confirmed: hard filters change only through an approved change proposal' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists requirement_deals_a_guard on mudar.requirement;
create trigger requirement_deals_a_guard before update on mudar.requirement for each row execute function mudar_app.deals_a_requirement_guard();

-- ================================================================ finance: versions, rounding rule, gaps
alter table mudar.finance_scenario add column if not exists version int not null default 1;
alter table mudar.finance_scenario add column if not exists previous_id uuid references mudar.finance_scenario(id);
alter table mudar.finance_scenario add column if not exists rounding_rule jsonb;
alter table mudar.finance_scenario add column if not exists gaps jsonb not null default '[]'::jsonb;
alter table mudar.finance_scenario add column if not exists gaps_acknowledged jsonb;   -- {by, at, gaps:[...], note}
create index if not exists finance_scenario_prev_idx on mudar.finance_scenario(previous_id);

-- ================================================================ assumptions register
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'mudar' and tablename = 'finance_assumption') then
    create table mudar.finance_assumption (
      id uuid primary key default gen_random_uuid(),
      scenario_id uuid not null references mudar.finance_scenario(id) on delete cascade,
      key text not null,
      label text not null,
      value jsonb,
      value_hash text not null,
      source text not null,                          -- e.g. "quote <id> v2", "user input", "engine default"
      approval_state text not null default 'unapproved' check (approval_state in ('unapproved', 'approved')),
      approved_by uuid references auth.users(id),
      approved_at timestamptz,
      approval_note text,
      unique (scenario_id, key)
    );
    perform mudar_app.make_business_table('finance_assumption');
  end if;
end $$;

drop trigger if exists finance_assumption_deals_same_ws on mudar.finance_assumption;
create trigger finance_assumption_deals_same_ws before insert or update on mudar.finance_assumption
  for each row execute function mudar_app.deals_same_ws('scenario_id:finance_scenario');

-- value changes always drop the approval; API users can never write an approval directly (only the functions below).
create or replace function mudar_app.deals_assumption_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
begin
  if tg_op = 'UPDATE' and (new.value_hash is distinct from old.value_hash or new.value is distinct from old.value) then
    new.approval_state := 'unapproved'; new.approved_by := null; new.approved_at := null; new.approval_note := null;
  end if;
  if current_user in ('authenticated', 'anon') and new.approval_state = 'approved'
     and (tg_op = 'INSERT' or old.approval_state is distinct from 'approved' or new.approved_by is distinct from old.approved_by) then
    raise exception 'assumptions are approved only through deals_approve_assumptions' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists finance_assumption_deals_guard on mudar.finance_assumption;
create trigger finance_assumption_deals_guard before insert or update on mudar.finance_assumption
  for each row execute function mudar_app.deals_assumption_guard();

create or replace function mudar.deals_approve_assumptions(p_scenario uuid, p_keys text[], p_note text default null)
returns int language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare s mudar.finance_scenario; n int;
begin
  select * into s from mudar.finance_scenario where id = p_scenario;
  if not found or not mudar_app.has_role(s.workspace_id, 'admin')
     or not mudar_app.can_write(s.workspace_id, s.classification, s.owner_user_id, 'finance_scenario', s.id) then
    raise exception 'scenario not found or assumptions not approvable by this user (admin required)' using errcode = '42501';
  end if;
  update mudar.finance_assumption set approval_state = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = p_note
   where scenario_id = p_scenario and workspace_id = s.workspace_id and key = any(p_keys) and approval_state = 'unapproved';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function mudar.deals_revoke_assumption(p_scenario uuid, p_key text, p_note text default null)
returns int language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare s mudar.finance_scenario; n int;
begin
  select * into s from mudar.finance_scenario where id = p_scenario;
  if not found or not mudar_app.has_role(s.workspace_id, 'admin')
     or not mudar_app.can_write(s.workspace_id, s.classification, s.owner_user_id, 'finance_scenario', s.id) then
    raise exception 'scenario not found or not writable (admin required)' using errcode = '42501';
  end if;
  update mudar.finance_assumption set approval_state = 'unapproved', approved_by = null, approved_at = null, approval_note = p_note
   where scenario_id = p_scenario and workspace_id = s.workspace_id and key = p_key;
  get diagnostics n = row_count;
  -- a scenario approval relied on this assumption
  update mudar.finance_scenario set approved_at = null where id = p_scenario and approved_at is not null;
  return n;
end $$;

-- A recalculated version carries an approval over ONLY for assumptions whose value is unchanged (same value_hash).
create or replace function mudar.deals_carry_assumption_approvals(p_new uuid, p_prev uuid)
returns int language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare a mudar.finance_scenario; b mudar.finance_scenario; n int;
begin
  select * into a from mudar.finance_scenario where id = p_new;
  select * into b from mudar.finance_scenario where id = p_prev;
  if a.id is null or b.id is null or a.workspace_id <> b.workspace_id or a.previous_id is distinct from b.id
     or not mudar_app.has_role(a.workspace_id, 'editor')
     or not mudar_app.can_write(a.workspace_id, a.classification, a.owner_user_id, 'finance_scenario', a.id)
     or not mudar_app.can_read(b.workspace_id, b.classification, b.owner_user_id, 'finance_scenario', b.id) then
    raise exception 'scenarios not found, not linked or not writable' using errcode = '42501';
  end if;
  update mudar.finance_assumption x set approval_state = 'approved', approved_by = p.approved_by, approved_at = p.approved_at,
         approval_note = coalesce(p.approval_note || ' · ', '') || format('carried from v%s (value unchanged)', b.version)
    from mudar.finance_assumption p
   where x.scenario_id = p_new and x.workspace_id = a.workspace_id and p.scenario_id = p_prev and p.workspace_id = a.workspace_id
     and p.key = x.key and p.value_hash = x.value_hash and p.approval_state = 'approved' and x.approval_state = 'unapproved';
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['deals_approve_assumptions(uuid, text[], text)', 'deals_revoke_assumption(uuid, text, text)', 'deals_carry_assumption_approvals(uuid, uuid)'] loop
    execute format('revoke all on function mudar.%s from public, anon', f);
    execute format('grant execute on function mudar.%s to authenticated, service_role', f);
  end loop;
end $$;

-- Scenario approval (API users): every assumption approved, and cost gaps either absent or acknowledged.
create or replace function mudar_app.deals_a_scenario_approval_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
declare pending int;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if new.approved_at is not null and old.approved_at is null then
    select count(*) into pending from mudar.finance_assumption where scenario_id = new.id and workspace_id = new.workspace_id and approval_state <> 'approved';
    if pending > 0 then
      raise exception 'scenario approval needs every assumption approved (% pending)', pending using errcode = '42501';
    end if;
    if jsonb_array_length(coalesce(new.gaps, '[]'::jsonb)) > 0 and new.gaps_acknowledged is null then
      raise exception 'scenario has unknown cost inputs: acknowledge the gaps explicitly to approve' using errcode = '42501';
    end if;
  end if;
  if new.gaps is distinct from old.gaps or new.rounding_rule is distinct from old.rounding_rule then
    raise exception 'gaps and rounding rule are engine output: recalculate a new version instead' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists finance_scenario_deals_a_guard on mudar.finance_scenario;
create trigger finance_scenario_deals_a_guard before update on mudar.finance_scenario for each row execute function mudar_app.deals_a_scenario_approval_guard();

notify pgrst, 'reload schema';

-- ================================================================ concession ladder NPV equivalent (deals.concession_npv)
-- concession_step rows (Deal Strategist) get npv_equivalent / engine_version from the finance engine in a job.
create or replace function mudar_app.deals_enqueue_concession_npv(p_ws uuid, p_step uuid) returns void
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if exists (select 1 from mudar.job j where j.job_type = 'deals.concession_npv' and j.state = 'queued' and j.workspace_id = p_ws
               and j.payload->>'step_id' = p_step::text) then return; end if;
  perform mudar_app.enqueue_job(p_ws, 'deals.concession_npv', jsonb_build_object('step_id', p_step), now(),
                                format('deals.concession_npv:%s:%s', p_step, (extract(epoch from clock_timestamp()) * 1000000)::bigint), 3);
end $$;
revoke all on function mudar_app.deals_enqueue_concession_npv(uuid, uuid) from public, anon, authenticated;

create or replace function mudar_app.deals_concession_step_changed() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if new.archived_at is not null then return null; end if;
  -- the job itself only writes npv_equivalent / engine_version / value_json.finance_equivalence → no loop
  if tg_op = 'INSERT' or new.quote_id is distinct from old.quote_id
     or (new.value_json->'finance_type') is distinct from (old.value_json->'finance_type')
     or (new.value_json->'finance_value') is distinct from (old.value_json->'finance_value') then
    perform mudar_app.deals_enqueue_concession_npv(new.workspace_id, new.id);
  end if;
  return null;
end $$;
revoke all on function mudar_app.deals_concession_step_changed() from public, anon, authenticated;
drop trigger if exists concession_step_deals_npv on mudar.concession_step;
create trigger concession_step_deals_npv after insert or update on mudar.concession_step for each row execute function mudar_app.deals_concession_step_changed();

-- a quote superseded (new version) or a scenario saved for a quote → re-price the steps on that quote chain
create or replace function mudar_app.deals_quote_reprice_steps() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record; ids uuid[];
begin
  if tg_table_name = 'quote' then
    if new.superseded_by is null or old.superseded_by is not null then return null; end if;
    ids := array[new.id];
  else
    ids := new.quote_ids;
  end if;
  if ids is null or cardinality(ids) = 0 then return null; end if;
  -- steps may point at any older version of the quote chain
  for r in
    with recursive chain(id) as (
      select unnest(ids)
      union select q.id from mudar.quote q join chain c on q.superseded_by = c.id where q.workspace_id = new.workspace_id)
    select s.id from mudar.concession_step s where s.workspace_id = new.workspace_id and s.archived_at is null and s.quote_id in (select id from chain)
  loop
    perform mudar_app.deals_enqueue_concession_npv(new.workspace_id, r.id);
  end loop;
  return null;
end $$;
revoke all on function mudar_app.deals_quote_reprice_steps() from public, anon, authenticated;
drop trigger if exists quote_deals_reprice_steps on mudar.quote;
create trigger quote_deals_reprice_steps after update of superseded_by on mudar.quote for each row execute function mudar_app.deals_quote_reprice_steps();
drop trigger if exists finance_scenario_deals_reprice_steps on mudar.finance_scenario;
create trigger finance_scenario_deals_reprice_steps after insert on mudar.finance_scenario for each row execute function mudar_app.deals_quote_reprice_steps();

notify pgrst, 'reload schema';
