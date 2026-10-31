set search_path = mudar, mudar_app, public, extensions;
-- Deals-B round 2: Design Studio (document lineage + immediate staleness), Closing Coordinator (dependencies, owners,
-- auto checklist at LOI) and Revenue Controller (separate fee statuses, close-date history, finance reconciliation).
-- Re-runnable: columns use "if not exists", functions "create or replace", triggers are dropped first, tables are
-- created once and made business tables inside guards.

-- ================================================================ 12 Design Studio — version lineage
alter table mudar.document_version add column if not exists family_id uuid;
alter table mudar.document_version add column if not exists parent_id uuid references mudar.document_version(id);
alter table mudar.document_version add column if not exists version_no int;
alter table mudar.document_version add column if not exists stale_reasons jsonb not null default '[]'::jsonb;
alter table mudar.document_version add column if not exists stale_at timestamptz;
alter table mudar.document_version add column if not exists released_at timestamptz;
create unique index if not exists document_version_family_ver_uq on mudar.document_version(family_id, version_no) where family_id is not null;
create index if not exists document_version_family_idx on mudar.document_version(family_id);

-- backfill: one family per (workspace, purpose, linked entity), versions in creation order
with f as (
  select id, first_value(id) over w as fam, row_number() over w as rn, lag(id) over w as par
    from mudar.document_version where family_id is null
  window w as (partition by workspace_id, purpose, linked_entity_type, linked_entity_id order by created_at, id))
update mudar.document_version d set family_id = f.fam, version_no = f.rn, parent_id = f.par from f where d.id = f.id;
update mudar.document_version set released_at = (input_versions->>'released_at')::timestamptz
 where released_at is null and input_versions ? 'released_at';

-- new rows join the family of earlier versions of the same document (purpose + linked entity): computed in SQL so a
-- user who cannot see every earlier version still gets the next number; an advisory lock serialises concurrent inserts.
create or replace function mudar_app.deals_document_lineage_set() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare prev mudar.document_version;
begin
  if new.family_id is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtext(concat_ws('|', 'deals.doc', new.workspace_id, new.purpose, new.linked_entity_type, new.linked_entity_id)));
  select * into prev from mudar.document_version
   where workspace_id = new.workspace_id and purpose is not distinct from new.purpose
     and linked_entity_type is not distinct from new.linked_entity_type and linked_entity_id is not distinct from new.linked_entity_id
     and family_id is not null
   order by version_no desc limit 1;
  if found then
    new.family_id := prev.family_id; new.parent_id := prev.id; new.version_no := prev.version_no + 1;
  else
    new.family_id := new.id; new.parent_id := null; new.version_no := 1;
  end if;
  return new;
end $$;
revoke execute on function mudar_app.deals_document_lineage_set() from public, anon, authenticated;
drop trigger if exists document_version_a_lineage_set on mudar.document_version;
create trigger document_version_a_lineage_set before insert on mudar.document_version for each row execute function mudar_app.deals_document_lineage_set();

-- lineage is immutable once written; released_at only set together with status = released
create or replace function mudar_app.deals_document_lineage_guard() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
begin
  if (old.family_id is not null and new.family_id is distinct from old.family_id)
     or (old.version_no is not null and new.version_no is distinct from old.version_no)
     or (old.parent_id is not null and new.parent_id is distinct from old.parent_id) then
    raise exception 'document lineage is immutable: generate a new version instead' using errcode = '42501';
  end if;
  if new.released_at is distinct from old.released_at and old.released_at is not null then
    raise exception 'release time is recorded once' using errcode = '42501';
  end if;
  if new.status = 'released' and old.status <> 'released' and new.released_at is null then new.released_at := now(); end if;
  return new;
end $$;
drop trigger if exists document_version_lineage_guard on mudar.document_version;
create trigger document_version_lineage_guard before update on mudar.document_version for each row execute function mudar_app.deals_document_lineage_guard();
drop trigger if exists document_version_deals_same_ws on mudar.document_version;
create trigger document_version_deals_same_ws before insert or update on mudar.document_version for each row execute function mudar_app.deals_same_ws('parent_id:document_version');

-- ================================================================ 12 Design Studio — immediate staleness (incl. released)
-- Marks every non-stale document whose input_versions->p_key references one of p_ids. Released documents are flagged
-- too (they must be re-reviewed before sharing again); the previous status is kept in stale_reasons[].was.
create or replace function mudar_app.deals_mark_docs_stale(p_ws uuid, p_key text, p_ids text[], p_reason text) returns int
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  update mudar.document_version
     set stale_reasons = coalesce(stale_reasons, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('reason', p_reason, 'at', now(), 'was', status)),
         stale_at = coalesce(stale_at, now()),
         status = 'stale'
   where workspace_id = p_ws and status in ('draft','in_review','approved','released')
     and (input_versions->p_key) ?| p_ids;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function mudar_app.deals_mark_docs_stale(uuid, text, text[], text) from public, anon, authenticated;

-- quote superseded (redefinition of the round-1 function: now also stales released documents with a reason)
create or replace function mudar_app.deals_quote_invalidate() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if new.superseded_by is not null and old.superseded_by is null then
    update mudar.finance_scenario set approved_at = null
     where workspace_id = new.workspace_id and new.id = any(quote_ids) and approved_at is not null;
    perform mudar_app.deals_mark_docs_stale(new.workspace_id, 'quotes', array[new.id::text], format('quote v%s superseded', new.version));
    update mudar.concession_step set within_approved_bounds = null
     where workspace_id = new.workspace_id and quote_id = new.id;
  end if;
  return null;
end $$;

create or replace function mudar_app.deals_scenario_guard() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if new.output_hash is distinct from old.output_hash or new.input_json is distinct from old.input_json then
    new.approved_at := null;
    perform mudar_app.deals_mark_docs_stale(new.workspace_id, 'scenarios', array[new.id::text], format('finance scenario "%s" recalculated', new.name));
  end if;
  return new;
end $$;

-- requirement edited → documents built on it are stale immediately
create or replace function mudar_app.deals_requirement_docs_stale() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if (to_jsonb(new) - array['updated_at','row_version']) is distinct from (to_jsonb(old) - array['updated_at','row_version']) then
    perform mudar_app.deals_mark_docs_stale(new.workspace_id, 'requirement', array[new.id::text], format('requirement edited (now v%s)', new.row_version));
  end if;
  return null;
end $$;
revoke execute on function mudar_app.deals_requirement_docs_stale() from public, anon, authenticated;
drop trigger if exists requirement_deals_docs_stale on mudar.requirement;
create trigger requirement_deals_docs_stale after update on mudar.requirement for each row execute function mudar_app.deals_requirement_docs_stale();

-- availability changed or a new snapshot for the same space → documents using that space's availability are stale
create or replace function mudar_app.deals_availability_docs_stale() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare ids text[];
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['updated_at','row_version']) is not distinct from (to_jsonb(old) - array['updated_at','row_version']) then
    return null;
  end if;
  select array_agg(id::text) into ids from mudar.availability where workspace_id = new.workspace_id and space_id = new.space_id;
  perform mudar_app.deals_mark_docs_stale(new.workspace_id, 'availability', ids,
    case when tg_op = 'INSERT' then format('new availability snapshot for an option (%s, as of %s)', new.status, new.as_of)
         else format('availability changed for an option (%s, as of %s)', new.status, new.as_of) end);
  return null;
end $$;
revoke execute on function mudar_app.deals_availability_docs_stale() from public, anon, authenticated;
drop trigger if exists availability_deals_docs_stale on mudar.availability;
create trigger availability_deals_docs_stale after insert or update on mudar.availability for each row execute function mudar_app.deals_availability_docs_stale();

-- ================================================================ 17 Closing Coordinator
alter table mudar.deal_milestone add column if not exists assignee_user_id uuid references auth.users(id);
alter table mudar.deal_milestone add column if not exists owner_note text;     -- external owner, e.g. "client legal", "landlord"
create index if not exists deal_milestone_opp_idx on mudar.deal_milestone(opportunity_id);

-- Checklist template (mirrored by CLOSING_TEMPLATE in src/modules/deals/pipeline/stages.ts; a test keeps them equal).
create or replace function mudar_app.deals_closing_template() returns jsonb language sql immutable as $$
  select '[
    {"key":"loi_signed","kind":"document","category":"loi","title":"LOI / term sheet signed by both parties","required_for_stage":"documentation","proof_required":true,"depends_on":null},
    {"key":"title_due_diligence","kind":"legal","category":"legal","title":"Title, approvals and occupation certificate checked","required_for_stage":"signed","proof_required":true,"depends_on":"loi_signed"},
    {"key":"lease_draft_review","kind":"legal","category":"legal","title":"Lease draft reviewed by client legal","required_for_stage":"signed","proof_required":true,"depends_on":"loi_signed"},
    {"key":"internal_approval","kind":"approval","category":"approval","title":"Client internal / board approval","required_for_stage":"signed","proof_required":true,"depends_on":"lease_draft_review"},
    {"key":"stamp_registration","kind":"document","category":"legal","title":"Stamp duty and registration completed","required_for_stage":"possession","proof_required":true,"depends_on":"internal_approval"},
    {"key":"fitout_approval","kind":"move_dependency","category":"fitout_approval","title":"Fit-out drawings approved by landlord / authorities","required_for_stage":"possession","proof_required":true,"depends_on":"loi_signed"},
    {"key":"handover","kind":"possession","category":"handover","title":"Handover inspection and snag list signed","required_for_stage":"possession","proof_required":true,"depends_on":"stamp_registration"},
    {"key":"access","kind":"move_dependency","category":"access","title":"Access cards, parking allocation and signage","required_for_stage":null,"proof_required":false,"depends_on":"handover"},
    {"key":"it_migration","kind":"move_dependency","category":"it_migration","title":"IT / connectivity migration plan","required_for_stage":null,"proof_required":false,"depends_on":"fitout_approval"},
    {"key":"parallel_rent","kind":"move_dependency","category":"parallel_rent","title":"Parallel rent window agreed with old landlord","required_for_stage":null,"proof_required":false,"depends_on":null},
    {"key":"reinstatement","kind":"move_dependency","category":"reinstatement","title":"Reinstatement obligations on the old premises","required_for_stage":null,"proof_required":false,"depends_on":null},
    {"key":"business_interruption","kind":"move_dependency","category":"business_interruption","title":"Business-interruption / cut-over plan","required_for_stage":null,"proof_required":false,"depends_on":"it_migration"},
    {"key":"fee_invoice_prereqs","kind":"fee","category":"fee","title":"Fee invoice prerequisites (signed lease copy, PO / engagement letter)","required_for_stage":"invoiced","proof_required":true,"depends_on":"stamp_registration"}
  ]'::jsonb
$$;

-- Idempotent seeding (unique opportunity_id+template_key). Dependencies are resolved by template key and only filled
-- where the user has not set their own.
create or replace function mudar_app.deals_seed_closing(p_opp uuid) returns int
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare o mudar.opportunity; ids uuid[];
begin
  select * into o from mudar.opportunity where id = p_opp;
  if not found then return 0; end if;
  with ins as (
    insert into mudar.deal_milestone(workspace_id, classification, owner_user_id, opportunity_id, template_key, kind, category, title,
                                     required_for_stage, proof_required, sort_order)
    select o.workspace_id, o.classification, o.owner_user_id, o.id, t->>'key', t->>'kind', t->>'category', t->>'title',
           t->>'required_for_stage', (t->>'proof_required')::boolean, (ord - 1)::int
      from jsonb_array_elements(mudar_app.deals_closing_template()) with ordinality as x(t, ord)
    on conflict (opportunity_id, template_key) where template_key is not null do nothing
    returning id)
  select coalesce(array_agg(id), '{}') into ids from ins;
  -- dependencies only for the rows created now (a dependency the user removed is not re-added)
  update mudar.deal_milestone m set depends_on = d.id
    from jsonb_array_elements(mudar_app.deals_closing_template()) t, mudar.deal_milestone d
   where m.id = any(ids) and m.template_key = t->>'key' and m.depends_on is null
     and t->>'depends_on' is not null and d.opportunity_id = o.id and d.template_key = t->>'depends_on';
  return cardinality(ids);
end $$;
revoke execute on function mudar_app.deals_seed_closing(uuid) from public, anon, authenticated;

-- user entry point (Create checklist button); same rules as the other deals RPCs
create or replace function mudar.deals_seed_closing_checklist(p_id uuid) returns int
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare o mudar.opportunity;
begin
  select * into o from mudar.opportunity where id = p_id;
  if not found or not mudar_app.has_role(o.workspace_id, 'editor') or not mudar_app.can_write(o.workspace_id, o.classification, o.owner_user_id, 'opportunity', o.id) then
    raise exception 'opportunity not found or not writable' using errcode = '42501';
  end if;
  return mudar_app.deals_seed_closing(p_id);
end $$;
revoke all on function mudar.deals_seed_closing_checklist(uuid) from public, anon;
grant execute on function mudar.deals_seed_closing_checklist(uuid) to authenticated, service_role;

-- auto-create at LOI (covers every path that changes the stage, incl. approved change proposals)
create or replace function mudar_app.deals_opportunity_loi_checklist() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if mudar_app.deals_stage_idx(new.stage) >= mudar_app.deals_stage_idx('loi')
     and (tg_op = 'INSERT' or coalesce(mudar_app.deals_stage_idx(old.stage), 0) < mudar_app.deals_stage_idx('loi')) then
    perform mudar_app.deals_seed_closing(new.id);
  end if;
  return null;
end $$;
revoke execute on function mudar_app.deals_opportunity_loi_checklist() from public, anon, authenticated;
drop trigger if exists opportunity_deals_loi_checklist on mudar.opportunity;
create trigger opportunity_deals_loi_checklist after insert or update of stage on mudar.opportunity for each row execute function mudar_app.deals_opportunity_loi_checklist();

-- milestone integrity: dependency inside the same deal, no cycles, "done" only after the dependency is cleared,
-- assignee must be a workspace member.
create or replace function mudar_app.deals_milestone_guard() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare cur uuid; hops int := 0; dep mudar.deal_milestone;
begin
  if new.depends_on is not null then
    if new.depends_on = new.id then raise exception 'a checklist item cannot depend on itself' using errcode = '23514'; end if;
    select * into dep from mudar.deal_milestone where id = new.depends_on;
    if not found or dep.opportunity_id <> new.opportunity_id then
      raise exception 'dependency must be an item of the same deal' using errcode = '23514';
    end if;
    cur := dep.depends_on;
    while cur is not null loop
      hops := hops + 1;
      if cur = new.id or hops > 200 then raise exception 'dependency would create a cycle' using errcode = '23514'; end if;
      select depends_on into cur from mudar.deal_milestone where id = cur;
    end loop;
    if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') and dep.status not in ('done','waived','not_applicable') then
      raise exception 'blocked: waiting on "%"', dep.title using errcode = '23514';
    end if;
  end if;
  if new.assignee_user_id is not null and (tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id)
     and not exists (select 1 from mudar.membership where workspace_id = new.workspace_id and user_id = new.assignee_user_id) then
    raise exception 'assignee must be a member of this workspace' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function mudar_app.deals_milestone_guard() from public, anon, authenticated;
drop trigger if exists deal_milestone_deals_guard on mudar.deal_milestone;
create trigger deal_milestone_deals_guard before insert or update on mudar.deal_milestone for each row execute function mudar_app.deals_milestone_guard();

-- Stage move (redefinition of the round-1 RPC): crossing LOI seeds the checklist BEFORE the blocking check, so skipping
-- past LOI cannot dodge the closing items.
create or replace function mudar.deals_move_stage(p_id uuid, p_expected_version bigint, p_stage text, p_evidence text)
returns mudar.opportunity language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare o mudar.opportunity; fi int; ti int; req_status text; ev text := coalesce(trim(p_evidence), ''); blocking text;
begin
  select * into o from mudar.opportunity where id = p_id for update;
  if not found or not mudar_app.has_role(o.workspace_id, 'editor') or not mudar_app.can_write(o.workspace_id, o.classification, o.owner_user_id, 'opportunity', o.id) then
    raise exception 'opportunity not found or not writable' using errcode = '42501';
  end if;
  if o.row_version <> p_expected_version then raise exception 'stale_version' using errcode = '40001'; end if;
  fi := mudar_app.deals_stage_idx(o.stage); ti := mudar_app.deals_stage_idx(p_stage);
  if ti is null then raise exception 'unknown stage %', p_stage using errcode = '23514'; end if;
  if ti = fi then return o; end if;
  if coalesce(o.outcome, 'open') not in ('open','won') then raise exception 'opportunity is %: reopen it first', o.outcome using errcode = '23514'; end if;
  if ti < fi and ev = '' then raise exception 'moving backwards needs a reason' using errcode = '23514'; end if;
  if ti > fi then
    if ev = '' and exists (select 1 from unnest(array['qualified_discussion','requirement_confirmed','loi','signed','possession','invoiced','recognised','collected']) s
                           where mudar_app.deals_stage_idx(s) > fi and mudar_app.deals_stage_idx(s) <= ti) then
      raise exception 'this stage needs evidence' using errcode = '23514';
    end if;
    if ti >= mudar_app.deals_stage_idx('requirement_confirmed') then
      select status into req_status from mudar.requirement where id = o.requirement_id and workspace_id = o.workspace_id;
      if coalesce(req_status, '') <> 'client_confirmed' then raise exception 'the linked requirement must be client-confirmed first' using errcode = '23514'; end if;
    end if;
    if ti > mudar_app.deals_stage_idx('loi') then perform mudar_app.deals_seed_closing(o.id); end if;
    select title into blocking from mudar.deal_milestone
     where opportunity_id = o.id and workspace_id = o.workspace_id and required_for_stage is not null
       and mudar_app.deals_stage_idx(required_for_stage) <= ti and status not in ('done','waived','not_applicable') order by sort_order limit 1;
    if blocking is not null then raise exception 'closing item open: %', blocking using errcode = '23514'; end if;
    if ti >= mudar_app.deals_stage_idx('invoiced') and not exists (select 1 from mudar.fee_milestone where opportunity_id = o.id and invoiced_amount is not null) then
      raise exception 'record the invoice in Fees first' using errcode = '23514'; end if;
    if ti >= mudar_app.deals_stage_idx('recognised') and not exists (select 1 from mudar.fee_milestone where opportunity_id = o.id and recognised_amount is not null) then
      raise exception 'record revenue recognition in Fees first' using errcode = '23514'; end if;
    if ti >= mudar_app.deals_stage_idx('collected') and not exists (select 1 from mudar.fee_milestone where opportunity_id = o.id and collected_amount is not null) then
      raise exception 'record the collection in Fees first' using errcode = '23514'; end if;
  end if;
  perform set_config('mudar_app.stage_evidence', ev, true);
  update mudar.opportunity set stage = p_stage where id = p_id returning * into o;
  perform set_config('mudar_app.stage_evidence', '', true);
  return o;
end $$;
revoke all on function mudar.deals_move_stage(uuid, bigint, text, text) from public, anon;
grant execute on function mudar.deals_move_stage(uuid, bigint, text, text) to authenticated, service_role;

-- ================================================================ 21 Revenue Controller — expected_close history (slippage)
do $$ begin
  if to_regclass('mudar.opportunity_close_history') is null then
    create table mudar.opportunity_close_history (
      id uuid primary key default gen_random_uuid(),
      opportunity_id uuid not null references mudar.opportunity(id) on delete cascade,
      old_expected_close date,
      new_expected_close date,
      stage text,
      changed_at timestamptz not null default now(),
      changed_by uuid references auth.users(id)
    );
    perform mudar_app.make_business_table('opportunity_close_history', false);
    create index opportunity_close_history_opp_idx on mudar.opportunity_close_history(opportunity_id, changed_at);
  end if;
end $$;

create or replace function mudar_app.deals_opportunity_close_history() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if (tg_op = 'INSERT' and new.expected_close is not null) or (tg_op = 'UPDATE' and new.expected_close is distinct from old.expected_close) then
    insert into mudar.opportunity_close_history(workspace_id, classification, owner_user_id, opportunity_id, old_expected_close, new_expected_close, stage, changed_by)
    values (new.workspace_id, new.classification, new.owner_user_id, new.id, case when tg_op = 'UPDATE' then old.expected_close end, new.expected_close, new.stage, auth.uid());
  end if;
  return null;
end $$;
revoke execute on function mudar_app.deals_opportunity_close_history() from public, anon, authenticated;
drop trigger if exists opportunity_deals_close_history on mudar.opportunity;
create trigger opportunity_deals_close_history after insert or update of expected_close on mudar.opportunity for each row execute function mudar_app.deals_opportunity_close_history();
-- history is append-only for users
drop policy if exists opportunity_close_history_upd on mudar.opportunity_close_history;
drop policy if exists opportunity_close_history_ins on mudar.opportunity_close_history;
insert into mudar.opportunity_close_history(workspace_id, classification, owner_user_id, opportunity_id, old_expected_close, new_expected_close, stage, changed_at)
select o.workspace_id, o.classification, o.owner_user_id, o.id, null, o.expected_close, o.stage, o.created_at
  from mudar.opportunity o
 where o.expected_close is not null and not exists (select 1 from mudar.opportunity_close_history h where h.opportunity_id = o.id);

-- ================================================================ 21 Revenue Controller — separate fee statuses
alter table mudar.fee_milestone add column if not exists contractual_amount numeric(14,2);  -- agreed fee terms (amount)
alter table mudar.fee_milestone add column if not exists contract_ref text;                 -- engagement letter / fee agreement reference
alter table mudar.fee_milestone add column if not exists attributed_on date;                -- credit allocation confirmed
alter table mudar.fee_milestone add column if not exists attribution_ref text;              -- credit memo / allocation reference
alter table mudar.fee_milestone add column if not exists invoice_no text;                   -- official finance invoice number
alter table mudar.fee_milestone add column if not exists invoice_due_on date;               -- for receivables aging
alter table mudar.fee_milestone add column if not exists deal_milestone_id uuid references mudar.deal_milestone(id); -- closing item it depends on
create index if not exists fee_milestone_invoice_no_idx on mudar.fee_milestone(workspace_id, invoice_no) where invoice_no is not null;

create or replace function mudar_app.deals_fee_guard_b() returns trigger
language plpgsql set search_path = mudar, mudar_app, public, extensions as $$
declare dm_opp uuid;
begin
  if new.contractual_amount is not null and coalesce(trim(new.contract_ref), '') = '' then
    raise exception 'a contractual fee needs the agreement reference (engagement letter / fee agreement)' using errcode = '23514';
  end if;
  if new.attributed_on is not null and coalesce(trim(new.attribution_ref), '') = '' then
    raise exception 'attribution needs a credit memo / allocation reference' using errcode = '23514';
  end if;
  if (new.invoice_no is not null or new.invoice_due_on is not null) and new.invoiced_amount is null then
    raise exception 'invoice number / due date need the invoiced amount' using errcode = '23514';
  end if;
  if new.deal_milestone_id is not null then
    select opportunity_id into dm_opp from mudar.deal_milestone where id = new.deal_milestone_id;
    if dm_opp is distinct from new.opportunity_id then raise exception 'linked closing item must belong to the same deal' using errcode = '23514'; end if;
  end if;
  if tg_op = 'UPDATE' and not mudar_app.deals_via_proposal() and not mudar_app.has_role(new.workspace_id, 'admin') then
    if (old.contractual_amount is not null and new.contractual_amount is distinct from old.contractual_amount)
       or (old.invoice_no is not null and new.invoice_no is distinct from old.invoice_no)
       or (old.invoice_due_on is not null and new.invoice_due_on is distinct from old.invoice_due_on)
       or (old.attributed_on is not null and new.attributed_on is distinct from old.attributed_on) then
      raise exception 'recorded contractual / attribution / invoice details change only by an admin or an approved change proposal' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists fee_milestone_deals_guard_b on mudar.fee_milestone;
create trigger fee_milestone_deals_guard_b before insert or update on mudar.fee_milestone for each row execute function mudar_app.deals_fee_guard_b();

-- user write path (redefinition): new fields fill once, evidence appended
create or replace function mudar.deals_update_fee(p_id uuid, p_patch jsonb)
returns mudar.fee_milestone language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare f mudar.fee_milestone; n mudar.fee_milestone; k text; j jsonb; nj jsonb;
  allowed text[] := array['gross_fee','credit_share','invoiced_amount','invoiced_on','recognised_amount','recognised_on','collected_amount','collected_on',
                          'evidence','milestone','tax_basis','exclusions','contractual_amount','contract_ref','attributed_on','attribution_ref',
                          'invoice_no','invoice_due_on','deal_milestone_id'];
  once text[] := array['gross_fee','credit_share','invoiced_amount','invoiced_on','recognised_amount','recognised_on','collected_amount','collected_on',
                       'contractual_amount','attributed_on','invoice_no','invoice_due_on'];
begin
  select * into f from mudar.fee_milestone where id = p_id for update;
  if not found or not mudar_app.has_role(f.workspace_id, 'editor') or not mudar_app.can_write(f.workspace_id, f.classification, f.owner_user_id, 'fee_milestone', f.id) then
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
    n.evidence := f.evidence || E'\n' || coalesce(p_patch->>'evidence', '');
  end if;
  update mudar.fee_milestone set gross_fee = n.gross_fee, credit_share = n.credit_share, invoiced_amount = n.invoiced_amount, invoiced_on = n.invoiced_on,
    recognised_amount = n.recognised_amount, recognised_on = n.recognised_on, collected_amount = n.collected_amount, collected_on = n.collected_on,
    evidence = n.evidence, milestone = n.milestone, tax_basis = n.tax_basis, exclusions = n.exclusions,
    contractual_amount = n.contractual_amount, contract_ref = coalesce(n.contract_ref, f.contract_ref), attributed_on = n.attributed_on,
    attribution_ref = coalesce(n.attribution_ref, f.attribution_ref), invoice_no = n.invoice_no, invoice_due_on = n.invoice_due_on,
    deal_milestone_id = n.deal_milestone_id
  where id = p_id returning * into n;
  return n;
end $$;
revoke all on function mudar.deals_update_fee(uuid, jsonb) from public, anon;
grant execute on function mudar.deals_update_fee(uuid, jsonb) to authenticated, service_role;

-- ================================================================ 21 Revenue Controller — official finance reconciliation
do $$ begin
  if to_regclass('mudar.fee_recon_import') is null then
    create table mudar.fee_recon_import (
      id uuid primary key default gen_random_uuid(),
      file_name text not null,
      sha256 text not null,
      source_system text,                       -- e.g. "Tally", "SAP" — free text, per tenant
      row_count int not null default 0,
      totals jsonb not null default '{}',       -- {official:{invoiced,collected}, recorded:{invoiced,collected}, reconciles:boolean}
      summary jsonb not null default '{}',      -- counts by status
      status text not null default 'processed' check (status in ('processed','failed')),
      error text
    );
    perform mudar_app.make_business_table('fee_recon_import');
    create unique index fee_recon_import_sha_uq on mudar.fee_recon_import(workspace_id, sha256);
  end if;
  if to_regclass('mudar.fee_recon_row') is null then
    create table mudar.fee_recon_row (
      id uuid primary key default gen_random_uuid(),
      import_id uuid not null references mudar.fee_recon_import(id) on delete cascade,
      row_no int not null,
      raw jsonb not null,                       -- untrusted import row, kept verbatim as evidence
      invoice_no text,
      deal_ref text,
      invoice_date date, invoice_amount numeric(14,2), due_date date,
      collected_amount numeric(14,2), collected_date date,
      currency text,
      fee_milestone_id uuid references mudar.fee_milestone(id),
      match_method text,                        -- invoice_no | fee_id | crm_id_amount | none
      status text not null check (status in ('matched','mismatch','missing_in_cre_os','unmatched','invalid')),
      exceptions jsonb not null default '[]',
      proposal_ids uuid[] not null default '{}',
      unique (import_id, row_no)
    );
    perform mudar_app.make_business_table('fee_recon_row', false);
    create index fee_recon_row_fee_idx on mudar.fee_recon_row(fee_milestone_id);
  end if;
end $$;
drop trigger if exists fee_recon_row_deals_same_ws on mudar.fee_recon_row;
create trigger fee_recon_row_deals_same_ws before insert or update on mudar.fee_recon_row for each row execute function mudar_app.deals_same_ws('import_id:fee_recon_import','fee_milestone_id:fee_milestone');
drop trigger if exists fee_milestone_deals_same_ws_b on mudar.fee_milestone;
create trigger fee_milestone_deals_same_ws_b before insert or update on mudar.fee_milestone for each row execute function mudar_app.deals_same_ws('deal_milestone_id:deal_milestone');
