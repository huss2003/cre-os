-- Module 16 — Transaction Execution & Negotiation (docs/transactions/SPEC.md, GAP.md).
-- Idempotent and non-destructive: create-if-not-exists / guarded DO blocks only. All tables via make_business_table (RLS + audit).
-- Reuses requirement / opportunity / quote / stakeholder / person / organisation / task / draft / document_version.
-- Standard owned/shared visibility. Approvals are owned by the assigned reviewer. Two guard trigger fns are SECURITY DEFINER
-- (workspace check + exact-version hash check must see the subject); execute revoked from app roles.


-- ---------------------------------------------------------------- configurable stage templates (§3.2)
create table if not exists mudar.tx_stage_template (
  id uuid primary key default gen_random_uuid(),
  tx_type text not null,
  name text not null,
  stages jsonb not null, -- [{key,title}]
  is_default boolean not null default false
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_stage_template') then perform mudar_app.make_business_table('tx_stage_template'); end if; end $$;

-- ---------------------------------------------------------------- transaction (§2.1)
create table if not exists mudar.tx_transaction (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  tx_type text not null,
  status text not null default 'active' check (status in ('active','on_hold','completed','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  requirement_id uuid references mudar.requirement(id) on delete set null,
  opportunity_id uuid references mudar.opportunity(id) on delete set null,
  client_org_id uuid references mudar.organisation(id) on delete set null,
  space_ids uuid[] not null default '{}',
  property_labels text[] not null default '{}',
  contact_person_ids uuid[] not null default '{}',
  tx_owner_user_id uuid references auth.users(id),
  template_id uuid references mudar.tx_stage_template(id) on delete set null,
  current_stage text,
  expected_completion date,
  completed_at timestamptz,
  lease_handoff jsonb
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_transaction') then perform mudar_app.make_business_table('tx_transaction'); end if; end $$;
create unique index if not exists tx_transaction_code_uq on mudar.tx_transaction(workspace_id, code);
create index if not exists tx_transaction_opp_idx on mudar.tx_transaction(opportunity_id);

create table if not exists mudar.tx_stage (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  key text not null,
  title text not null,
  sort_order int not null,
  status text not null default 'pending' check (status in ('pending','in_progress','done','skipped')),
  completed_at timestamptz,
  unique (transaction_id, key)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_stage') then perform mudar_app.make_business_table('tx_stage'); end if; end $$;

-- ---------------------------------------------------------------- timeline / history (append-only)
create table if not exists mudar.tx_event (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  kind text not null,
  subject_type text,
  subject_id uuid,
  summary text not null,
  payload jsonb not null default '{}',
  source text,
  occurred_at timestamptz not null default now()
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_event') then perform mudar_app.make_business_table('tx_event', false); end if; end $$;
create index if not exists tx_event_tx_idx on mudar.tx_event(transaction_id, occurred_at);

-- ---------------------------------------------------------------- stakeholders (§9)
create table if not exists mudar.tx_stakeholder (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  person_id uuid references mudar.person(id) on delete set null,
  user_id uuid references auth.users(id),
  name text not null,
  organisation text,
  designation text,
  category text not null check (category in ('client','client_decision_maker','client_finance','client_procurement','client_legal','landlord','developer',
    'asset_manager','property_manager','leasing_representative','operator','legal_adviser','procurement_adviser','finance_representative',
    'fitout_contractor','technical_consultant','internal_team')),
  role text,
  contact text,
  responsibilities text,
  decision_authority text not null default 'none' check (decision_authority in ('none','influencer','recommender','approver','signatory')),
  is_internal boolean not null default false
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_stakeholder') then perform mudar_app.make_business_table('tx_stakeholder'); end if; end $$;

-- ---------------------------------------------------------------- offers / counteroffers (§4) — immutable versions
create table if not exists mudar.tx_offer (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  version_no int not null,
  parent_offer_id uuid references mudar.tx_offer(id),
  kind text not null check (kind in ('offer','counteroffer','revised','final','agreed')),
  offering_party text not null check (offering_party in ('client','landlord','developer','operator','adviser','other')),
  receiving_party text not null,
  space_id uuid references mudar.space(id) on delete set null,
  property_label text,
  quote_id uuid references mudar.quote(id) on delete set null,
  offer_date date not null,
  valid_until date,
  terms jsonb not null,
  reason text,
  source_document text,
  submitted_by uuid references auth.users(id) default auth.uid(),
  content_hash text not null,
  response_status text not null default 'pending' check (response_status in ('pending','accepted','rejected','countered','withdrawn','expired')),
  responded_at timestamptz,
  response_note text,
  unique (transaction_id, version_no)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_offer') then perform mudar_app.make_business_table('tx_offer'); end if; end $$;

-- ---------------------------------------------------------------- three separate positions (§6)
create table if not exists mudar.tx_position (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  position_kind text not null check (position_kind in ('client_requirement','adviser_recommendation','counterparty_proposal')),
  term_key text not null,
  value text,
  source text not null,
  offer_id uuid references mudar.tx_offer(id) on delete set null,
  note text
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_position') then perform mudar_app.make_business_table('tx_position'); end if; end $$;

-- ---------------------------------------------------------------- commercial point tracker (§10.3)
create table if not exists mudar.tx_commercial_point (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  term_key text not null,
  label text not null,
  value text,
  status text not null default 'proposed' check (status in ('proposed','under_negotiation','agreed','rejected','pending_clarification','subject_to_approval','documented','verified_executed')),
  source_offer_id uuid references mudar.tx_offer(id) on delete set null,
  supersedes_id uuid references mudar.tx_commercial_point(id),
  superseded_at timestamptz,
  agreed_evidence text,
  documented_in uuid,
  verified_in uuid,
  is_material boolean not null default true
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_commercial_point') then perform mudar_app.make_business_table('tx_commercial_point'); end if; end $$;

-- ---------------------------------------------------------------- live issues (§7)
create table if not exists mudar.tx_issue (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  title text not null,
  description text,
  category text not null check (category in ('commercial','technical','legal','financial','documentation','property','approval','possession','fitout','handover','other')),
  responsible_party text,
  stakeholder_id uuid references mudar.tx_stakeholder(id) on delete set null,
  internal_owner_user_id uuid not null references auth.users(id),
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  identified_on date not null default current_date,
  due_date date,
  no_due_reason text,
  status text not null default 'open' check (status in ('open','under_review','awaiting_client','awaiting_landlord','awaiting_operator','awaiting_legal','awaiting_finance','awaiting_approval','resolved','closed')),
  decision_required text,
  next_action text,
  blocking boolean not null default false,
  depends_on uuid[] not null default '{}',
  supporting_docs text[] not null default '{}',
  resolution text,
  resolved_at timestamptz,
  task_id uuid references mudar.task(id) on delete set null,
  constraint tx_issue_due_chk check (due_date is not null or nullif(btrim(no_due_reason), '') is not null),
  constraint tx_issue_next_chk check (status in ('resolved','closed') or nullif(btrim(next_action), '') is not null),
  constraint tx_issue_resolution_chk check (status not in ('resolved','closed') or nullif(btrim(resolution), '') is not null)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_issue') then perform mudar_app.make_business_table('tx_issue'); end if; end $$;

-- ---------------------------------------------------------------- inspections, clarifications, document requests (§8)
create table if not exists mudar.tx_inspection (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  space_id uuid references mudar.space(id) on delete set null,
  property_label text,
  inspection_date date not null,
  inspection_type text not null,
  participants text[] not null default '{}',
  findings text,
  observations text,
  outstanding_concerns text,
  photos jsonb not null default '[]',
  report_ref text,
  responsible_party text,
  status text not null default 'open' check (status in ('scheduled','waiting_access','open','resolved'))
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_inspection') then perform mudar_app.make_business_table('tx_inspection'); end if; end $$;

create table if not exists mudar.tx_clarification (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  topic text not null check (topic in ('hvac','electrical_capacity','power_backup','floor_loading','fire_safety','lift_capacity','internet','parking','building_access','fitout_conditions','other')),
  question text not null,
  required_value text,
  required_numeric numeric,
  responsible_party text,
  response text,
  response_numeric numeric,
  responded_at timestamptz,
  attachments text[] not null default '{}',
  status text not null default 'requested' check (status in ('requested','responded','accepted','discrepancy','closed'))
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_clarification') then perform mudar_app.make_business_table('tx_clarification'); end if; end $$;

create table if not exists mudar.tx_doc_request (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  doc_type text not null,
  title text not null,
  requested_on date not null default current_date,
  responsible_party text,
  due_date date,
  status text not null default 'requested' check (status in ('requested','received','under_review','verified','rejected')),
  received_on date,
  file_ref text,
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  verification_note text,
  constraint tx_doc_verified_chk check (status <> 'verified' or (verified_by is not null and verified_at is not null and received_on is not null and nullif(btrim(verification_note),'') is not null))
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_doc_request') then perform mudar_app.make_business_table('tx_doc_request'); end if; end $$;

-- ---------------------------------------------------------------- LOI / term sheet / agreement versions (§10, §11)
create table if not exists mudar.tx_document (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  doc_kind text not null check (doc_kind in ('loi','term_sheet','agreement','executed_agreement','handover','other')),
  family text not null,
  version_no int not null,
  previous_id uuid references mudar.tx_document(id),
  title text not null,
  body text not null,
  sha256 text not null,
  file_ref text,
  status text not null default 'draft' check (status in ('draft','submitted','client_review','counterparty_review','agreed','superseded','signed','executed')),
  signing_status text not null default 'unsigned' check (signing_status in ('unsigned','partially_signed','signed')),
  executed_on date,
  diff_report jsonb,
  reconciliation jsonb,
  source text,
  unique (transaction_id, family, version_no)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_document') then perform mudar_app.make_business_table('tx_document'); end if; end $$;

-- ---------------------------------------------------------------- approvals (§12) — bound to exact version hash
create table if not exists mudar.tx_approval (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  category text not null check (category in ('client_commercial','internal_adviser','landlord','operator','financial','legal','technical','management')),
  subject_type text not null check (subject_type in ('offer','document','commercial_position','deposit','transaction','other')),
  subject_id uuid not null,
  subject_hash text not null,
  version_label text not null,
  requested_by uuid references auth.users(id) default auth.uid(),
  reviewer_user_id uuid references auth.users(id),
  reviewer_stakeholder_id uuid references mudar.tx_stakeholder(id) on delete set null,
  requested_on date not null default current_date,
  deadline date,
  supporting text[] not null default '{}',
  status text not null default 'pending' check (status in ('not_required','pending','under_review','approved','rejected','changes_requested','withdrawn')),
  decided_by uuid references auth.users(id),
  decided_by_kind text check (decided_by_kind in ('user','external_recorded')),
  decision_on timestamptz,
  comments text,
  invalidated_at timestamptz,
  invalidated_reason text,
  reassessment_of uuid references mudar.tx_approval(id)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_approval') then perform mudar_app.make_business_table('tx_approval'); end if; end $$;

-- ---------------------------------------------------------------- deposits (§13) — each stage separately evidenced
create table if not exists mudar.tx_deposit (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  deposit_type text not null,
  amount numeric,
  currency text not null default 'INR',
  responsible_party text,
  proposed_on date,
  approved_on date,
  approval_id uuid references mudar.tx_approval(id) on delete set null,
  due_date date,
  paid_on date,
  payment_evidence text,
  acknowledged_on date,
  receipt_ref text,
  refundable boolean,
  refund_conditions text,
  refunded_on date,
  refund_evidence text,
  constraint tx_dep_paid_chk check (paid_on is null or nullif(btrim(payment_evidence),'') is not null),
  constraint tx_dep_ack_chk check (acknowledged_on is null or (paid_on is not null and nullif(btrim(receipt_ref),'') is not null)),
  constraint tx_dep_refund_chk check (refunded_on is null or (paid_on is not null and nullif(btrim(refund_evidence),'') is not null))
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_deposit') then perform mudar_app.make_business_table('tx_deposit'); end if; end $$;

-- ---------------------------------------------------------------- distinct milestones (§13.2, §14, §16)
create table if not exists mudar.tx_milestone (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  kind text not null check (kind in ('commercially_agreed','legally_approved','signed','executed','possession_completed','fitout_completed','occupied','handover_completed')),
  expected_on date,
  achieved_on date,
  evidence text,
  document_id uuid references mudar.tx_document(id) on delete set null,
  conditions text,
  outstanding_conditions text,
  details jsonb not null default '{}',
  unique (transaction_id, kind),
  constraint tx_ms_evidence_chk check (achieved_on is null or nullif(btrim(evidence),'') is not null)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_milestone') then perform mudar_app.make_business_table('tx_milestone'); end if; end $$;

create table if not exists mudar.tx_fitout (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  scope text,
  requirements text,
  approvals_status text not null default 'pending' check (approvals_status in ('pending','approved','rejected')),
  contractor text,
  start_date date,
  target_completion date,
  progress_pct numeric check (progress_pct is null or (progress_pct >= 0 and progress_pct <= 100)),
  delays text,
  outstanding_work text,
  final_inspection_on date,
  final_inspection_notes text
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_fitout') then perform mudar_app.make_business_table('tx_fitout'); end if; end $$;

create table if not exists mudar.tx_handover_item (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  item_kind text not null check (item_kind in ('checklist','defect','incomplete_work','observation')),
  description text not null,
  responsible_party text,
  resolution_deadline date,
  status text not null default 'open' check (status in ('open','done','waived')),
  evidence text,
  photos jsonb not null default '[]',
  acknowledged_by text,
  constraint tx_ho_done_chk check (status = 'open' or nullif(btrim(evidence),'') is not null)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_handover_item') then perform mudar_app.make_business_table('tx_handover_item'); end if; end $$;

-- ---------------------------------------------------------------- input-engine intake held for review (§17 Module 10)
create table if not exists mudar.tx_intake (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references mudar.tx_transaction(id) on delete cascade,
  intake_kind text not null check (intake_kind in ('proposal','counteroffer','inspection_report','technical_document','loi','term_sheet','agreement_draft','executed_agreement','handover_document')),
  source_ref text,
  evidence_text text not null,
  extracted jsonb not null default '{}',
  mocked boolean not null default false,
  status text not null default 'pending_review' check (status in ('pending_review','accepted','rejected')),
  created_record_type text,
  created_record_id uuid,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'tx_intake') then perform mudar_app.make_business_table('tx_intake'); end if; end $$;

-- owner defaults + same-workspace parent check
do $$ declare t text; begin
  foreach t in array array['tx_stage_template','tx_transaction','tx_stage','tx_event','tx_stakeholder','tx_offer','tx_position','tx_commercial_point','tx_issue',
    'tx_inspection','tx_clarification','tx_doc_request','tx_document','tx_approval','tx_deposit','tx_milestone','tx_fitout','tx_handover_item','tx_intake'] loop
    execute format('alter table mudar.%I alter column owner_user_id set default auth.uid()', t);
  end loop;
end $$;

create or replace function mudar_app.tx_guard() returns trigger language plpgsql security definer set search_path = mudar, mudar_app, public as $$
declare w uuid;
begin
  select workspace_id into w from mudar.tx_transaction where id = new.transaction_id;
  if w is null or w <> new.workspace_id then raise exception 'tx: transaction belongs to another workspace' using errcode = '42501'; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['tx_stage','tx_event','tx_stakeholder','tx_offer','tx_position','tx_commercial_point','tx_issue','tx_inspection','tx_clarification',
    'tx_doc_request','tx_document','tx_approval','tx_deposit','tx_milestone','tx_fitout','tx_handover_item','tx_intake'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_tx_ws' and tgrelid = format('mudar.%I', t)::regclass) then
      execute format('create trigger %1$s_tx_ws before insert or update of transaction_id, workspace_id on mudar.%1$I for each row execute function mudar_app.tx_guard()', t);
    end if;
  end loop;
end $$;

-- timeline is append-only
create or replace function mudar_app.tx_event_guard() returns trigger language plpgsql as $$
begin raise exception 'tx_event is append-only' using errcode = '42501'; end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_event_immutable' and tgrelid = 'mudar.tx_event'::regclass) then
    create trigger tx_event_immutable before update or delete on mudar.tx_event for each row execute function mudar_app.tx_event_guard();
  end if;
end $$;

-- offers: never overwritten (only response fields / archive may change)
create or replace function mudar_app.tx_offer_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'tx: offers are never deleted' using errcode = '42501'; end if;
  if new.terms is distinct from old.terms or new.content_hash is distinct from old.content_hash or new.version_no is distinct from old.version_no
     or new.parent_offer_id is distinct from old.parent_offer_id or new.kind is distinct from old.kind or new.offering_party is distinct from old.offering_party
     or new.offer_date is distinct from old.offer_date or new.valid_until is distinct from old.valid_until then
    raise exception 'tx: offer versions are immutable — create a counteroffer/revision instead' using errcode = '42501';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_offer_immutable' and tgrelid = 'mudar.tx_offer'::regclass) then
    create trigger tx_offer_immutable before update or delete on mudar.tx_offer for each row execute function mudar_app.tx_offer_guard();
  end if;
end $$;

-- positions never change kind (no implicit conversion)
create or replace function mudar_app.tx_position_guard() returns trigger language plpgsql as $$
begin
  if new.position_kind is distinct from old.position_kind then raise exception 'tx: a position cannot be converted to another kind' using errcode = '42501'; end if;
  if new.value is distinct from old.value then raise exception 'tx: positions are versioned — record a new position' using errcode = '42501'; end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_position_immutable' and tgrelid = 'mudar.tx_position'::regclass) then
    create trigger tx_position_immutable before update on mudar.tx_position for each row execute function mudar_app.tx_position_guard();
  end if;
end $$;

-- commercial points: agreed values never overwritten
create or replace function mudar_app.tx_point_guard() returns trigger language plpgsql as $$
begin
  if new.value is distinct from old.value and old.status in ('agreed','subject_to_approval','documented','verified_executed') then
    raise exception 'tx: agreed commercial term cannot be overwritten — supersede it with a new point' using errcode = '42501';
  end if;
  if new.status = 'agreed' and old.status <> 'agreed' and nullif(btrim(new.agreed_evidence), '') is null then
    raise exception 'tx: agreeing a commercial point needs evidence (who agreed, where)' using errcode = '23514';
  end if;
  if new.status = 'verified_executed' and new.verified_in is null then
    raise exception 'tx: verification needs the executed agreement version' using errcode = '23514';
  end if;
  if new.status = 'documented' and new.documented_in is null then
    raise exception 'tx: documented needs the document version' using errcode = '23514';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_point_guard' and tgrelid = 'mudar.tx_commercial_point'::regclass) then
    create trigger tx_point_guard before update on mudar.tx_commercial_point for each row execute function mudar_app.tx_point_guard();
  end if;
end $$;

-- hash of the current commercial position (non-superseded points that are agreed or later)
create or replace function mudar_app.tx_position_hash(p_tx uuid) returns text language sql stable set search_path = mudar, public, extensions as $$
  select encode(extensions.digest(coalesce(string_agg(term_key || '=' || coalesce(value, '∅'), '|' order by term_key, id), ''), 'sha256'), 'hex')
  from mudar.tx_commercial_point
  where transaction_id = p_tx and superseded_at is null and archived_at is null
    and status in ('agreed','subject_to_approval','documented','verified_executed')
$$;

-- approvals: decision only by the assigned reviewer, on the exact current version; legal only by a legal reviewer
create or replace function mudar_app.tx_approval_guard() returns trigger language plpgsql security definer set search_path = mudar, mudar_app, public as $$
declare cur text; is_legal boolean;
begin
  if new.category = 'legal' and new.reviewer_user_id is not null then
    select exists(select 1 from mudar.tx_stakeholder s where s.transaction_id = new.transaction_id and s.user_id = new.reviewer_user_id
                  and s.category in ('legal_adviser','client_legal') and s.archived_at is null) into is_legal;
    if not is_legal then raise exception 'tx: legal approval must be assigned to a legal reviewer stakeholder' using errcode = '42501'; end if;
  end if;
  if new.status in ('approved','rejected','changes_requested') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if new.invalidated_at is not null then raise exception 'tx: approval was invalidated by a newer version' using errcode = '42501'; end if;
    if new.decided_by_kind is null then raise exception 'tx: decision needs a human decider' using errcode = '42501'; end if;
    if new.decided_by_kind = 'user' and (auth.uid() is null or new.reviewer_user_id is distinct from auth.uid() or new.decided_by is distinct from auth.uid()) then
      raise exception 'tx: only the assigned reviewer can decide this approval' using errcode = '42501';
    end if;
    if new.decided_by_kind = 'external_recorded' and (new.category in ('legal','internal_adviser','management') or nullif(btrim(new.comments),'') is null) then
      raise exception 'tx: external decisions can only be recorded for counterparty/client approvals, with evidence' using errcode = '42501';
    end if;
    if new.status = 'approved' then
      if new.subject_type = 'offer' then select content_hash into cur from mudar.tx_offer where id = new.subject_id;
      elsif new.subject_type = 'document' then
        select case when status = 'superseded' then null else sha256 end into cur from mudar.tx_document where id = new.subject_id;
      elsif new.subject_type = 'commercial_position' then cur := mudar_app.tx_position_hash(new.subject_id);
      else cur := new.subject_hash; end if;
      if cur is distinct from new.subject_hash then
        raise exception 'tx: the reviewed version (hash) is no longer current — reassess the latest version' using errcode = '40001';
      end if;
    end if;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_approval_guard' and tgrelid = 'mudar.tx_approval'::regclass) then
    create trigger tx_approval_guard before insert or update on mudar.tx_approval for each row execute function mudar_app.tx_approval_guard();
  end if;
end $$;

-- a new document version supersedes the previous one and invalidates its approvals (reassessment)
create or replace function mudar_app.tx_document_after() returns trigger language plpgsql set search_path = mudar, public as $$
begin
  if new.previous_id is not null then
    update mudar.tx_document set status = 'superseded' where id = new.previous_id and status not in ('signed','executed');
    update mudar.tx_approval set invalidated_at = now(), invalidated_reason = 'superseded by version ' || new.version_no
      where subject_type = 'document' and subject_id = new.previous_id and invalidated_at is null;
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_document_after' and tgrelid = 'mudar.tx_document'::regclass) then
    create trigger tx_document_after after insert on mudar.tx_document for each row execute function mudar_app.tx_document_after();
  end if;
end $$;

create or replace function mudar_app.tx_document_guard() returns trigger language plpgsql as $$
begin
  if new.body is distinct from old.body or new.sha256 is distinct from old.sha256 or new.version_no is distinct from old.version_no then
    raise exception 'tx: document versions are immutable — upload a new version' using errcode = '42501';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_document_immutable' and tgrelid = 'mudar.tx_document'::regclass) then
    create trigger tx_document_immutable before update on mudar.tx_document for each row execute function mudar_app.tx_document_guard();
  end if;
end $$;

-- a changed commercial position invalidates live approvals of the old position
create or replace function mudar_app.tx_offer_after() returns trigger language plpgsql set search_path = mudar, mudar_app, public as $$
declare h text;
begin
  h := mudar_app.tx_position_hash(coalesce(new.transaction_id, old.transaction_id));
  update mudar.tx_approval set invalidated_at = now(), invalidated_reason = 'commercial position changed'
   where subject_type = 'commercial_position' and subject_id = coalesce(new.transaction_id, old.transaction_id)
     and invalidated_at is null and subject_hash is distinct from h and status in ('pending','under_review','approved');
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_point_after' and tgrelid = 'mudar.tx_commercial_point'::regclass) then
    create trigger tx_point_after after insert or update on mudar.tx_commercial_point for each row execute function mudar_app.tx_offer_after();
  end if;
end $$;

-- closure blockers (§16, rule 18)
create or replace function mudar_app.tx_closure_blockers(p_tx uuid) returns text[] language sql stable set search_path = mudar, public as $$
  select array_remove(array[
    (select 'open issues: ' || count(*) from mudar.tx_issue where transaction_id = p_tx and archived_at is null and status not in ('resolved','closed') having count(*) > 0),
    (select 'pending approvals: ' || count(*) from mudar.tx_approval where transaction_id = p_tx and archived_at is null and invalidated_at is null and status in ('pending','under_review','changes_requested') having count(*) > 0),
    (select 'documents not verified: ' || count(*) from mudar.tx_doc_request where transaction_id = p_tx and archived_at is null and status not in ('verified') having count(*) > 0),
    (select 'open handover items: ' || count(*) from mudar.tx_handover_item where transaction_id = p_tx and archived_at is null and status = 'open' having count(*) > 0),
    (select 'deposits due but not evidenced as paid: ' || count(*) from mudar.tx_deposit where transaction_id = p_tx and archived_at is null and due_date is not null and paid_on is null having count(*) > 0),
    (case when not exists (select 1 from mudar.tx_milestone where transaction_id = p_tx and kind = 'executed' and achieved_on is not null) then 'agreement not executed' end),
    (case when not exists (select 1 from mudar.tx_milestone where transaction_id = p_tx and kind = 'handover_completed' and achieved_on is not null) then 'handover not completed' end)
  ], null)
$$;
grant execute on function mudar_app.tx_closure_blockers(uuid) to authenticated;
grant execute on function mudar_app.tx_position_hash(uuid) to authenticated;

create or replace function mudar_app.tx_transaction_guard() returns trigger language plpgsql set search_path = mudar, mudar_app, public as $$
declare b text[];
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    b := mudar_app.tx_closure_blockers(new.id);
    if coalesce(array_length(b, 1), 0) > 0 then
      raise exception 'tx: cannot complete — %', array_to_string(b, '; ') using errcode = '23514';
    end if;
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'tx_transaction_guard' and tgrelid = 'mudar.tx_transaction'::regclass) then
    create trigger tx_transaction_guard before update on mudar.tx_transaction for each row execute function mudar_app.tx_transaction_guard();
  end if;
end $$;

-- trigger functions are not callable directly
revoke execute on function mudar_app.tx_guard(), mudar_app.tx_event_guard(), mudar_app.tx_offer_guard(), mudar_app.tx_position_guard(),
  mudar_app.tx_point_guard(), mudar_app.tx_approval_guard(), mudar_app.tx_document_after(), mudar_app.tx_document_guard(),
  mudar_app.tx_offer_after(), mudar_app.tx_transaction_guard() from public, anon, authenticated;
