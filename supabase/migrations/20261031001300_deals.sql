-- Deals module (requirements, shortlist versions, quotes, closing coordinator, objections, concessions,
-- decision log, official-CRM export proposals, API idempotency).
-- Spec: Part I §6/§8/§11/§12, Part II §5/§6, Part III API + acceptance tests.
-- Re-runnable during development: drops only objects owned by this module.

drop table if exists public.deal_idempotency cascade;
drop table if exists public.crm_export cascade;
drop table if exists public.decision_log cascade;
drop table if exists public.concession_step cascade;
drop table if exists public.objection_log cascade;
drop table if exists public.deal_milestone cascade;
drop table if exists public.shortlist_version cascade;
drop table if exists public.requirement_version cascade;

-- ---------------------------------------------------------------- requirement history
-- Every material save of a requirement appends an immutable snapshot (column values + constraints.field_status).
create table public.requirement_version (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirement(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,                 -- full requirement row (domain columns) at this version
  field_status jsonb not null default '{}',-- {field: client_confirmed|estimated|unknown}
  change_reason text,
  change_proposal_id uuid references public.change_proposal(id),
  unique (requirement_id, version)
);
select app.make_business_table('requirement_version', false);

-- ---------------------------------------------------------------- shortlist runs (options live in shortlist_option)
create table public.shortlist_version (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirement(id) on delete cascade,
  version int not null,
  rubric_version text not null,
  weights jsonb not null,                  -- effective weights after per-requirement overrides
  requirement_row_version bigint,          -- requirement.row_version the run was based on
  as_of date not null,
  candidate_count int not null default 0,
  eligible_count int not null default 0,
  needs_verification_count int not null default 0,
  note text,
  unique (requirement_id, version)
);
select app.make_business_table('shortlist_version', false);
create index if not exists shortlist_option_req_ver_idx on public.shortlist_option(requirement_id, version);

-- ---------------------------------------------------------------- closing coordinator + move dependencies
create table public.deal_milestone (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity(id) on delete cascade,
  template_key text,                       -- stable key for seeded checklist items (idempotent seeding)
  kind text not null check (kind in ('dependency','document','approval','possession','fee','move_dependency','legal','other')),
  category text,                           -- e.g. fitout_approval, it_migration, handover, access, reinstatement, parallel_rent, business_interruption
  title text not null,
  required_for_stage text,                 -- stage that cannot be entered until this item is done
  depends_on uuid references public.deal_milestone(id),
  due_date date,
  status text not null default 'open' check (status in ('open','in_progress','done','blocked','waived','not_applicable')),
  proof_required boolean not null default false,
  proof_text text,                         -- evidence description (document name, email id, signed copy reference)
  proof_source_object_id uuid references public.source_object(id),
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  sort_order int not null default 0,
  check (status <> 'done' or not proof_required or proof_text is not null or proof_source_object_id is not null)
);
select app.make_business_table('deal_milestone');
create unique index deal_milestone_tpl_uq on public.deal_milestone(opportunity_id, template_key) where template_key is not null;

-- ---------------------------------------------------------------- objections (deal strategist / knowledge capture)
create table public.objection_log (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references public.opportunity(id) on delete cascade,
  requirement_id uuid references public.requirement(id) on delete cascade,
  interaction_id uuid references public.interaction(id),
  raised_by_person_id uuid references public.person(id),
  category text not null default 'other' check (category in ('price','location','timing','specification','terms','landlord','competitor','internal_approval','other')),
  objection text not null,
  response text,
  outcome text check (outcome in ('open','resolved','partially_resolved','unresolved','deal_lost')) default 'open',
  outcome_evidence text,
  raised_on date not null default current_date,
  check (opportunity_id is not null or requirement_id is not null)
);
select app.make_business_table('objection_log');

-- ---------------------------------------------------------------- concession ladder (bounded by quote approved floor/ceiling)
create table public.concession_step (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity(id) on delete cascade,
  quote_id uuid references public.quote(id),
  step_no int not null,
  concession_type text not null check (concession_type in ('rent','rent_free','capex_support','deposit','escalation','lockin','cam','parking','other')),
  ask text,                                -- what we ask the landlord / what client asks
  give text,                               -- what we can trade
  value_json jsonb not null default '{}',  -- typed parameters used by finance concession equivalence
  npv_equivalent numeric(16,2),            -- deterministic engine output (finance concession equivalence)
  engine_version text,
  within_approved_bounds boolean,
  status text not null default 'planned' check (status in ('planned','offered','accepted','rejected','withdrawn')),
  rationale text
);
select app.make_business_table('concession_step');

-- ---------------------------------------------------------------- decision log
create table public.decision_log (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid references public.requirement(id) on delete cascade,
  opportunity_id uuid references public.opportunity(id) on delete cascade,
  decided_on date not null default current_date,
  decision text not null,
  rationale text,
  decided_by_person_id uuid references public.person(id),
  evidence text,
  related_entity_type text, related_entity_id uuid,
  check (requirement_id is not null or opportunity_id is not null)
);
select app.make_business_table('decision_log');

-- ---------------------------------------------------------------- official CRM export proposals (CRM is source of truth)
create table public.crm_export (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('opportunity','organisation')),
  entity_id uuid not null,
  crm_external_id text,                    -- official CRM id; required before export
  proposed_fields jsonb not null,          -- local values proposed for the CRM
  base_snapshot jsonb not null default '{}',     -- CRM values as last known when proposal was created
  external_snapshot jsonb,                 -- latest CRM values recorded after (import/manual)
  conflict_fields jsonb not null default '[]',   -- [{field, base, local, external}]
  status text not null default 'proposed' check (status in ('needs_external_id','proposed','exported','conflict','reconciled','rejected','superseded')),
  exported_at timestamptz,
  exported_by uuid references auth.users(id),
  entity_row_version bigint,
  payload_hash text
);
select app.make_business_table('crm_export');
create index if not exists crm_export_entity_idx on public.crm_export(entity_type, entity_id);

-- ---------------------------------------------------------------- API idempotency store (S8)
create table public.deal_idempotency (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  idem_key text not null,
  scope text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, scope, idem_key)
);
select app.make_workspace_table('deal_idempotency', 'editor');

-- shortlist/quote lookup helpers
create index if not exists quote_req_idx on public.quote(requirement_id, space_id);
create index if not exists finance_scenario_req_idx on public.finance_scenario(requirement_id);
create index if not exists document_version_link_idx on public.document_version(linked_entity_type, linked_entity_id);
create index if not exists fee_milestone_opp_idx on public.fee_milestone(opportunity_id);

-- ================================================================ security hardening (docs/security-review.md M3, M4)
-- M4: references between deals rows must stay inside one workspace. Generic check: TG_ARGV = 'column:table' pairs.
create or replace function app.deals_same_ws() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a text; col text; tbl text; ref uuid; ref_ws uuid;
  j jsonb := to_jsonb(new);
begin
  foreach a in array tg_argv loop
    col := split_part(a, ':', 1); tbl := split_part(a, ':', 2);
    ref := nullif(j->>col, '')::uuid;
    if ref is null then continue; end if;
    if tg_op = 'UPDATE' and (to_jsonb(old)->>col) is not distinct from (j->>col) and old.workspace_id = new.workspace_id then continue; end if;
    execute format('select workspace_id from public.%I where id = $1', tbl) into ref_ws using ref;
    if ref_ws is distinct from new.workspace_id then
      raise exception '%.% must reference a % row in the same workspace', tg_table_name, col, tbl using errcode = '23503';
    end if;
  end loop;
  return new;
end $$;
revoke execute on function app.deals_same_ws() from public, anon, authenticated;

do $$
declare r record;
begin
  for r in select * from (values
    ('requirement',               array['org_id:organisation','confirmed_by_person_id:person']),
    ('stakeholder',               array['requirement_id:requirement','person_id:person','employment_id:employment']),
    ('opportunity',               array['requirement_id:requirement','org_id:organisation']),
    ('opportunity_stage_history', array['opportunity_id:opportunity']),
    ('quote',                     array['counterparty_org_id:organisation','space_id:space','requirement_id:requirement','superseded_by:quote']),
    ('shortlist_option',          array['requirement_id:requirement','space_id:space','asset_id:asset','availability_id:availability']),
    ('finance_scenario',          array['requirement_id:requirement','option_id:shortlist_option']),
    ('finance_cashflow',          array['scenario_id:finance_scenario']),
    ('fee_milestone',             array['opportunity_id:opportunity']),
    ('requirement_version',       array['requirement_id:requirement','change_proposal_id:change_proposal']),
    ('shortlist_version',         array['requirement_id:requirement']),
    ('deal_milestone',            array['opportunity_id:opportunity','depends_on:deal_milestone','proof_source_object_id:source_object']),
    ('objection_log',             array['opportunity_id:opportunity','requirement_id:requirement','interaction_id:interaction','raised_by_person_id:person']),
    ('concession_step',           array['opportunity_id:opportunity','quote_id:quote']),
    ('decision_log',              array['requirement_id:requirement','opportunity_id:opportunity','decided_by_person_id:person'])
  ) as t(tbl, refs) loop
    execute format('drop trigger if exists %1$s_deals_same_ws on public.%1$I', r.tbl);
    execute format('create trigger %1$s_deals_same_ws before insert or update on public.%1$I for each row execute function app.deals_same_ws(%2$s)',
                   r.tbl, (select string_agg(quote_literal(x), ',') from unnest(r.refs) x));
  end loop;
end $$;

-- M3: material fields of deals records cannot be changed directly by API users once they are confirmed / set.
-- Writes coming from app.apply_change / app.reverse_change carry app.change_proposal_id and pass.
create or replace function app.deals_via_proposal() returns boolean language sql stable as $$
  select coalesce(current_setting('app.change_proposal_id', true), '') <> '' or auth.uid() is null
$$;

-- requirement contract keys stored in columns (mirror of src/modules/deals/requirements/contract.ts)
create or replace function app.deals_requirement_field_columns() returns jsonb language sql immutable as $$
  select '{"objective":["objective"],"transaction_kinds":["transaction_kinds"],"decision_date":["decision_date"],
           "occupation_date":["occupation_date"],"area":["area_min_sf","area_target_sf","area_max_sf"],"area_basis":["area_basis"],
           "seats":["seats_min","seats_target","seats_max"],"budget":["budget_min","budget_max"],"budget_basis":["budget_basis"],
           "preferred_locations":["preferred_geography_ids"],"forbidden_locations":["excluded_geography_ids"],
           "mandate_status":["mandate_status"],"conflict_status":["conflict_status"]}'::jsonb
$$;

create or replace function app.deals_requirement_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  map jsonb := app.deals_requirement_field_columns();
  o jsonb := to_jsonb(old); n jsonb := to_jsonb(new);
  fs jsonb := coalesce(old.constraints->'field_status', '{}'::jsonb);
  all_locked boolean := old.status = 'client_confirmed';
  k text; c text; keys text[];
begin
  if app.deals_via_proposal() then return new; end if;
  if all_locked then
    if new.status is distinct from old.status and new.status <> 'closed' then
      raise exception 'requirement is client-confirmed: status change needs an approved change proposal' using errcode = '42501';
    end if;
    if new.org_id is distinct from old.org_id or new.confirmed_by_person_id is distinct from old.confirmed_by_person_id
       or new.confirmed_at is distinct from old.confirmed_at then
      raise exception 'requirement is client-confirmed: confirmation fields change only through an approved change proposal' using errcode = '42501';
    end if;
  end if;
  -- column-backed contract fields
  for k in select jsonb_object_keys(map) loop
    if all_locked or fs->>k = 'client_confirmed' then
      for c in select jsonb_array_elements_text(map->k) loop
        if (o->c) is distinct from (n->c) then
          raise exception 'confirmed requirement field "%" changes only through an approved change proposal', k using errcode = '42501';
        end if;
      end loop;
    end if;
  end loop;
  -- constraints.values keys + field_status downgrades
  select array_agg(distinct x) into keys from (
    select jsonb_object_keys(coalesce(old.constraints->'values','{}'::jsonb)) x
    union select jsonb_object_keys(coalesce(new.constraints->'values','{}'::jsonb))
    union select jsonb_object_keys(fs)) s;
  foreach k in array coalesce(keys, '{}'::text[]) loop
    if all_locked or fs->>k = 'client_confirmed' then
      if (old.constraints->'values'->k) is distinct from (new.constraints->'values'->k) then
        raise exception 'confirmed requirement field "%" changes only through an approved change proposal', k using errcode = '42501';
      end if;
      if fs->>k = 'client_confirmed' and coalesce(new.constraints->'field_status'->>k, '') <> 'client_confirmed' then
        raise exception 'confirmed requirement field "%" cannot be downgraded directly', k using errcode = '42501';
      end if;
    end if;
  end loop;
  if all_locked and (old.constraints->'required_specs') is distinct from (new.constraints->'required_specs') then
    raise exception 'requirement is client-confirmed: hard constraints change only through an approved change proposal' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists requirement_deals_guard on public.requirement;
create trigger requirement_deals_guard before update on public.requirement for each row execute function app.deals_requirement_guard();

-- opportunity: fee/credit once set are high-value (admin or approved proposal); stage changes are logged automatically.
create or replace function app.deals_opportunity_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not app.deals_via_proposal() and not app.has_role(new.workspace_id, 'admin') then
    if (old.expected_fee is not null and new.expected_fee is distinct from old.expected_fee)
       or (old.credit_share is not null and new.credit_share is distinct from old.credit_share) then
      raise exception 'expected fee / credit share changes need an admin or an approved change proposal' using errcode = '42501';
    end if;
    if new.crm_external_id is distinct from old.crm_external_id and old.crm_external_id is not null then
      raise exception 'official CRM id cannot be overwritten directly' using errcode = '42501';
    end if;
  end if;
  if new.outcome = 'won' and old.outcome is distinct from 'won'
     and array_position(array['research','approach_attempted','engaged','qualified_discussion','requirement_confirmed','options_visits',
       'proposal_negotiation','loi','documentation','signed','possession','invoiced','recognised','collected'], new.stage) < 10 then
    raise exception 'outcome "won" requires stage signed or later' using errcode = '23514';
  end if;
  if new.stage is distinct from old.stage then new.stage_entered_at := now(); end if;
  return new;
end $$;
drop trigger if exists opportunity_deals_guard on public.opportunity;
create trigger opportunity_deals_guard before update on public.opportunity for each row execute function app.deals_opportunity_guard();

create or replace function app.deals_opportunity_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    insert into public.opportunity_stage_history(workspace_id, opportunity_id, from_stage, to_stage, evidence, owner_user_id, classification)
    values (new.workspace_id, new.id, case when tg_op = 'UPDATE' then old.stage end, new.stage,
            nullif(current_setting('app.stage_evidence', true), ''), coalesce(auth.uid(), new.owner_user_id), new.classification);
  end if;
  return null;
end $$;
revoke execute on function app.deals_opportunity_history() from public, anon, authenticated;
drop trigger if exists opportunity_deals_history on public.opportunity;
create trigger opportunity_deals_history after insert or update of stage on public.opportunity for each row execute function app.deals_opportunity_history();

-- fee_milestone: each money stage needs its date and evidence; amounts once recorded change only via admin/proposal.
create or replace function app.deals_fee_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.invoiced_amount is not null and new.invoiced_on is null) or (new.recognised_amount is not null and new.recognised_on is null)
     or (new.collected_amount is not null and new.collected_on is null) then
    raise exception 'invoiced / recognised / collected amounts need their dates' using errcode = '23514';
  end if;
  if (new.invoiced_amount is not null or new.recognised_amount is not null or new.collected_amount is not null)
     and coalesce(trim(new.evidence), '') = '' then
    raise exception 'fee milestones with invoiced / recognised / collected amounts need evidence' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and not app.deals_via_proposal() and not app.has_role(new.workspace_id, 'admin') then
    if (old.gross_fee is not null and new.gross_fee is distinct from old.gross_fee)
       or (old.credit_share is not null and new.credit_share is distinct from old.credit_share)
       or (old.invoiced_amount is not null and new.invoiced_amount is distinct from old.invoiced_amount)
       or (old.recognised_amount is not null and new.recognised_amount is distinct from old.recognised_amount)
       or (old.collected_amount is not null and new.collected_amount is distinct from old.collected_amount) then
      raise exception 'recorded fee amounts change only by an admin or an approved change proposal' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists fee_milestone_deals_guard on public.fee_milestone;
create trigger fee_milestone_deals_guard before insert or update on public.fee_milestone for each row execute function app.deals_fee_guard();

-- quote: versions are immutable (a revision is a new row); superseding invalidates dependent approvals and documents.
create or replace function app.deals_quote_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not app.deals_via_proposal() and (
       new.terms_json is distinct from old.terms_json or new.valid_until is distinct from old.valid_until
    or new.approved_floor is distinct from old.approved_floor or new.approved_ceiling is distinct from old.approved_ceiling
    or new.version is distinct from old.version or new.space_id is distinct from old.space_id
    or new.requirement_id is distinct from old.requirement_id) then
    raise exception 'quote versions are immutable: create a new version instead' using errcode = '42501';
  end if;
  if old.superseded_by is not null and new.superseded_by is distinct from old.superseded_by then
    raise exception 'a superseded quote cannot be re-pointed' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists quote_deals_guard on public.quote;
create trigger quote_deals_guard before update on public.quote for each row execute function app.deals_quote_guard();

create or replace function app.deals_quote_invalidate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.superseded_by is not null and old.superseded_by is null then
    update public.finance_scenario set approved_at = null
     where workspace_id = new.workspace_id and new.id = any(quote_ids) and approved_at is not null;
    update public.document_version set status = 'stale'
     where workspace_id = new.workspace_id and status in ('draft','in_review','approved')
       and (input_versions->'quotes') ? new.id::text;
    update public.concession_step set within_approved_bounds = null
     where workspace_id = new.workspace_id and quote_id = new.id;
  end if;
  return null;
end $$;
revoke execute on function app.deals_quote_invalidate() from public, anon, authenticated;
drop trigger if exists quote_deals_invalidate on public.quote;
create trigger quote_deals_invalidate after update of superseded_by on public.quote for each row execute function app.deals_quote_invalidate();

-- finance_scenario: result is engine output; changing inputs/results drops approval and stales documents built on it.
create or replace function app.deals_scenario_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.output_hash is distinct from old.output_hash or new.input_json is distinct from old.input_json then
    new.approved_at := null;
    update public.document_version set status = 'stale'
     where workspace_id = new.workspace_id and status in ('draft','in_review','approved')
       and (input_versions->'scenarios') ? new.id::text;
  end if;
  return new;
end $$;
revoke execute on function app.deals_scenario_guard() from public, anon, authenticated;
drop trigger if exists finance_scenario_deals_guard on public.finance_scenario;
create trigger finance_scenario_deals_guard before update on public.finance_scenario for each row execute function app.deals_scenario_guard();

-- document_version: stale documents can never become client-ready; release requires the approved hash to match.
create or replace function app.deals_document_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'stale' and new.status in ('approved','released','in_review') then
    raise exception 'document is stale: regenerate it from current inputs' using errcode = '42501';
  end if;
  if new.status = 'released' and (new.approved_hash is null or new.approved_hash is distinct from new.sha256) then
    raise exception 'release requires an approval bound to the current file hash' using errcode = '42501';
  end if;
  if new.sha256 is distinct from old.sha256 and old.sha256 is not null then
    raise exception 'document files are immutable: generate a new version' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists document_version_deals_guard on public.document_version;
create trigger document_version_deals_guard before update on public.document_version for each row execute function app.deals_document_guard();

-- ================================================================ controlled write paths (M3)
-- app.cx_material_guard (changes module) blocks direct API updates of material columns on requirement / opportunity /
-- quote / fee_milestone. User edits that are NOT model/connector-originated go through these SECURITY DEFINER functions,
-- which re-check membership, role, row access (can_write), optimistic version and the deals business rules in SQL.
-- The deals guards above still run (auth.uid() is preserved), so confirmed requirement fields stay locked here too.

create or replace function app.deals_requirement_mandatory() returns text[] language sql immutable as $$
  select array['objective','decision_date','occupation_date','area','area_basis','budget','budget_basis','budget_inclusions',
               'preferred_locations','fitout_standard','tenure_months','legal_entity','commercial_authority','procurement_process',
               'current_lease_notice','mandate_status','conflict_status']
$$;

create or replace function app.deals_requirement_value_present(r public.requirement, k text) returns boolean
language plpgsql immutable as $$
declare map jsonb := app.deals_requirement_field_columns(); j jsonb := to_jsonb(r); c text; v jsonb;
begin
  if map ? k then
    for c in select jsonb_array_elements_text(map->k) loop
      v := j->c;
      if v is not null and v <> 'null'::jsonb and v <> '[]'::jsonb and v <> '""'::jsonb
         and not (k = 'mandate_status' and v = '"unknown"') and not (k = 'conflict_status' and v = '"not_checked"') then
        return true;
      end if;
    end loop;
    return false;
  end if;
  v := r.constraints->'values'->k;
  return v is not null and v <> 'null'::jsonb and v <> '[]'::jsonb and v <> '""'::jsonb;
end $$;

create or replace function public.deals_update_requirement(p_id uuid, p_expected_version bigint, p_patch jsonb)
returns public.requirement language plpgsql security definer set search_path = public as $$
declare
  r public.requirement; n public.requirement; k text;
  allowed text[] := array['title','objective','transaction_kinds','area_min_sf','area_target_sf','area_max_sf','area_basis','seats_min','seats_target',
                          'seats_max','budget_min','budget_max','budget_basis','preferred_geography_ids','excluded_geography_ids','decision_date',
                          'occupation_date','constraints','status','mandate_status','conflict_status'];
begin
  select * into r from public.requirement where id = p_id for update;
  if not found or not app.has_role(r.workspace_id, 'editor') or not app.can_write(r.workspace_id, r.classification, r.owner_user_id, 'requirement', r.id) then
    raise exception 'requirement not found or not writable' using errcode = '42501';
  end if;
  if r.row_version <> p_expected_version then raise exception 'stale_version' using errcode = '40001'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any(allowed)) then raise exception 'field % cannot be changed here', k using errcode = '42501'; end if;
  end loop;
  if p_patch ? 'status' and not (r.status in ('draft','estimated') and p_patch->>'status' in ('draft','estimated')) then
    raise exception 'status: confirm with deals_confirm_requirement or submit a change proposal' using errcode = '42501';
  end if;
  n := jsonb_populate_record(r, p_patch);
  update public.requirement set
    title = n.title, objective = n.objective, transaction_kinds = n.transaction_kinds, area_min_sf = n.area_min_sf, area_target_sf = n.area_target_sf,
    area_max_sf = n.area_max_sf, area_basis = n.area_basis, seats_min = n.seats_min, seats_target = n.seats_target, seats_max = n.seats_max,
    budget_min = n.budget_min, budget_max = n.budget_max, budget_basis = n.budget_basis, preferred_geography_ids = n.preferred_geography_ids,
    excluded_geography_ids = n.excluded_geography_ids, decision_date = n.decision_date, occupation_date = n.occupation_date,
    constraints = n.constraints, status = n.status, mandate_status = n.mandate_status, conflict_status = n.conflict_status
  where id = p_id returning * into n;
  return n;
end $$;

create or replace function public.deals_confirm_requirement(p_id uuid, p_expected_version bigint, p_evidence text, p_person uuid default null)
returns public.requirement language plpgsql security definer set search_path = public as $$
declare r public.requirement; k text; missing text[] := '{}'; na text[];
begin
  select * into r from public.requirement where id = p_id for update;
  if not found or not app.has_role(r.workspace_id, 'editor') or not app.can_write(r.workspace_id, r.classification, r.owner_user_id, 'requirement', r.id) then
    raise exception 'requirement not found or not writable' using errcode = '42501';
  end if;
  if r.row_version <> p_expected_version then raise exception 'stale_version' using errcode = '40001'; end if;
  if r.status = 'client_confirmed' then return r; end if;
  if coalesce(trim(p_evidence), '') = '' then raise exception 'evidence of client confirmation is required' using errcode = '23514'; end if;
  na := array(select jsonb_array_elements_text(coalesce(r.constraints->'not_applicable', '[]'::jsonb)));
  foreach k in array app.deals_requirement_mandatory() loop
    if k = any(na) then continue; end if;
    if not app.deals_requirement_value_present(r, k) or coalesce(r.constraints->'field_status'->>k, '') <> 'client_confirmed' then
      missing := missing || k;
    end if;
  end loop;
  if array_length(missing, 1) > 0 then
    raise exception 'cannot confirm: mandatory fields not client-confirmed: %', array_to_string(missing, ', ') using errcode = '23514';
  end if;
  update public.requirement set status = 'client_confirmed', confirmed_at = now(), confirmed_by_person_id = p_person,
    constraints = jsonb_set(coalesce(constraints, '{}'::jsonb), '{values,confirmation_evidence}', to_jsonb(trim(p_evidence)), true)
  where id = p_id returning * into r;
  return r;
end $$;

create or replace function app.deals_stage_idx(s text) returns int language sql immutable as $$
  select array_position(array['research','approach_attempted','engaged','qualified_discussion','requirement_confirmed','options_visits',
    'proposal_negotiation','loi','documentation','signed','possession','invoiced','recognised','collected'], s)
$$;

create or replace function public.deals_move_stage(p_id uuid, p_expected_version bigint, p_stage text, p_evidence text)
returns public.opportunity language plpgsql security definer set search_path = public as $$
declare o public.opportunity; fi int; ti int; req_status text; ev text := coalesce(trim(p_evidence), ''); blocking text;
begin
  select * into o from public.opportunity where id = p_id for update;
  if not found or not app.has_role(o.workspace_id, 'editor') or not app.can_write(o.workspace_id, o.classification, o.owner_user_id, 'opportunity', o.id) then
    raise exception 'opportunity not found or not writable' using errcode = '42501';
  end if;
  if o.row_version <> p_expected_version then raise exception 'stale_version' using errcode = '40001'; end if;
  fi := app.deals_stage_idx(o.stage); ti := app.deals_stage_idx(p_stage);
  if ti is null then raise exception 'unknown stage %', p_stage using errcode = '23514'; end if;
  if ti = fi then return o; end if;
  if coalesce(o.outcome, 'open') not in ('open','won') then raise exception 'opportunity is %: reopen it first', o.outcome using errcode = '23514'; end if;
  if ti < fi and ev = '' then raise exception 'moving backwards needs a reason' using errcode = '23514'; end if;
  if ti > fi then
    if ev = '' and exists (select 1 from unnest(array['qualified_discussion','requirement_confirmed','loi','signed','possession','invoiced','recognised','collected']) s
                           where app.deals_stage_idx(s) > fi and app.deals_stage_idx(s) <= ti) then
      raise exception 'this stage needs evidence' using errcode = '23514';
    end if;
    if ti >= app.deals_stage_idx('requirement_confirmed') then
      select status into req_status from public.requirement where id = o.requirement_id and workspace_id = o.workspace_id;
      if coalesce(req_status, '') <> 'client_confirmed' then raise exception 'the linked requirement must be client-confirmed first' using errcode = '23514'; end if;
    end if;
    select title into blocking from public.deal_milestone
     where opportunity_id = o.id and workspace_id = o.workspace_id and required_for_stage is not null
       and app.deals_stage_idx(required_for_stage) <= ti and status not in ('done','waived','not_applicable') limit 1;
    if blocking is not null then raise exception 'closing item open: %', blocking using errcode = '23514'; end if;
    if ti >= app.deals_stage_idx('invoiced') and not exists (select 1 from public.fee_milestone where opportunity_id = o.id and invoiced_amount is not null) then
      raise exception 'record the invoice in Fees first' using errcode = '23514'; end if;
    if ti >= app.deals_stage_idx('recognised') and not exists (select 1 from public.fee_milestone where opportunity_id = o.id and recognised_amount is not null) then
      raise exception 'record revenue recognition in Fees first' using errcode = '23514'; end if;
    if ti >= app.deals_stage_idx('collected') and not exists (select 1 from public.fee_milestone where opportunity_id = o.id and collected_amount is not null) then
      raise exception 'record the collection in Fees first' using errcode = '23514'; end if;
  end if;
  perform set_config('app.stage_evidence', ev, true);
  update public.opportunity set stage = p_stage where id = p_id returning * into o;
  perform set_config('app.stage_evidence', '', true);
  return o;
end $$;

create or replace function public.deals_set_outcome(p_id uuid, p_expected_version bigint, p_outcome text, p_reason text default null)
returns public.opportunity language plpgsql security definer set search_path = public as $$
declare o public.opportunity;
begin
  select * into o from public.opportunity where id = p_id for update;
  if not found or not app.has_role(o.workspace_id, 'editor') or not app.can_write(o.workspace_id, o.classification, o.owner_user_id, 'opportunity', o.id) then
    raise exception 'opportunity not found or not writable' using errcode = '42501';
  end if;
  if o.row_version <> p_expected_version then raise exception 'stale_version' using errcode = '40001'; end if;
  if p_outcome not in ('open','dormant','lost','disqualified','won') then raise exception 'unknown outcome' using errcode = '23514'; end if;
  if p_outcome in ('lost','disqualified') and coalesce(p_reason, '') not in ('competitor_broker','direct_deal','renewal_in_place','no_move','budget','timing',
       'requirement_cancelled','landlord_rejected','option_not_available','internal_approval_failed','disqualified_fit','other') then
    raise exception 'a lost/disqualified reason code is required' using errcode = '23514';
  end if;
  update public.opportunity set outcome = p_outcome, outcome_reason = case when p_outcome = 'open' then null else p_reason end
  where id = p_id returning * into o;
  return o;
end $$;

-- Labels are independent of stage. Fee / credit / CRM id can be SET once here; changing a recorded value needs a proposal.
create or replace function public.deals_update_opportunity(p_id uuid, p_expected_version bigint, p_patch jsonb)
returns public.opportunity language plpgsql security definer set search_path = public as $$
declare o public.opportunity; n public.opportunity; k text;
  allowed text[] := array['name','temperature','mandate_status','next_action','next_action_due','expected_close','risks','expected_fee','credit_share','crm_external_id'];
begin
  select * into o from public.opportunity where id = p_id for update;
  if not found or not app.has_role(o.workspace_id, 'editor') or not app.can_write(o.workspace_id, o.classification, o.owner_user_id, 'opportunity', o.id) then
    raise exception 'opportunity not found or not writable' using errcode = '42501';
  end if;
  if o.row_version <> p_expected_version then raise exception 'stale_version' using errcode = '40001'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any(allowed)) then raise exception 'field % cannot be changed here', k using errcode = '42501'; end if;
  end loop;
  n := jsonb_populate_record(o, p_patch);
  if (o.expected_fee is not null and n.expected_fee is distinct from o.expected_fee) or (o.credit_share is not null and n.credit_share is distinct from o.credit_share)
     or (o.crm_external_id is not null and n.crm_external_id is distinct from o.crm_external_id) then
    raise exception 'recorded fee / credit share / CRM id change only through an approved change proposal' using errcode = '42501';
  end if;
  update public.opportunity set name = n.name, temperature = n.temperature, mandate_status = n.mandate_status, next_action = n.next_action,
    next_action_due = n.next_action_due, expected_close = n.expected_close, risks = n.risks, expected_fee = n.expected_fee,
    credit_share = n.credit_share, crm_external_id = n.crm_external_id
  where id = p_id returning * into n;
  return n;
end $$;

-- Fee events append: an amount may be filled once (with date + evidence, checked by fee_milestone_deals_guard);
-- corrections of recorded amounts go through a change proposal (high_value).
create or replace function public.deals_update_fee(p_id uuid, p_patch jsonb)
returns public.fee_milestone language plpgsql security definer set search_path = public as $$
declare f public.fee_milestone; n public.fee_milestone; k text; j jsonb; nj jsonb;
  allowed text[] := array['gross_fee','credit_share','invoiced_amount','invoiced_on','recognised_amount','recognised_on','collected_amount','collected_on',
                          'evidence','milestone','tax_basis','exclusions'];
  once text[] := array['gross_fee','credit_share','invoiced_amount','invoiced_on','recognised_amount','recognised_on','collected_amount','collected_on'];
begin
  select * into f from public.fee_milestone where id = p_id for update;
  if not found or not app.has_role(f.workspace_id, 'editor') or not app.can_write(f.workspace_id, f.classification, f.owner_user_id, 'fee_milestone', f.id) then
    raise exception 'fee milestone not found or not writable' using errcode = '42501';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any(allowed)) then raise exception 'field % cannot be changed here', k using errcode = '42501'; end if;
  end loop;
  n := jsonb_populate_record(f, p_patch);
  j := to_jsonb(f); nj := to_jsonb(n);
  foreach k in array once loop
    if j->>k is not null and (nj->k) is distinct from (j->k) then
      raise exception 'recorded %: corrections need an approved change proposal', k using errcode = '42501';
    end if;
  end loop;
  if f.evidence is not null and n.evidence is distinct from f.evidence then
    n.evidence := f.evidence || E'\n' || coalesce(p_patch->>'evidence', '');   -- evidence is appended, never replaced
  end if;
  update public.fee_milestone set gross_fee = n.gross_fee, credit_share = n.credit_share, invoiced_amount = n.invoiced_amount, invoiced_on = n.invoiced_on,
    recognised_amount = n.recognised_amount, recognised_on = n.recognised_on, collected_amount = n.collected_amount, collected_on = n.collected_on,
    evidence = n.evidence, milestone = n.milestone, tax_basis = n.tax_basis, exclusions = n.exclusions
  where id = p_id returning * into n;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['deals_update_requirement(uuid, bigint, jsonb)','deals_confirm_requirement(uuid, bigint, text, uuid)',
    'deals_move_stage(uuid, bigint, text, text)','deals_set_outcome(uuid, bigint, text, text)','deals_update_opportunity(uuid, bigint, jsonb)',
    'deals_update_fee(uuid, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function app.deals_requirement_value_present(public.requirement, text) from public, anon;
