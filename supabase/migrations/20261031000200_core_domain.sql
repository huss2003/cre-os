-- CRE OS domain entities (spec Part I §6, Part III canonical schema).
-- Rules: never use row numbers/names as identity; store raw + normalised values; preserve unknown;
-- keep fact status (historical_observed / currently_confirmed / reported / ai_inference) distinct.

create or replace function app.join_text(a text[]) returns text language sql immutable as $$ select array_to_string(a,' ') $$;

-- ================================================================ tenant configuration (per-tenant, replaces Colliers hardcoding)
create table public.workspace_setting (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
);
select app.make_workspace_table('workspace_setting','admin');

create table public.partner (          -- e.g. fit-out finance partners (Jasfo for tenant #1), referral providers
  id uuid primary key default gen_random_uuid(),
  name text not null,
  partner_type text not null default 'fitout_finance' check (partner_type in ('fitout_finance','referral','landlord','operator','vendor','other')),
  terms_json jsonb not null default '{}',
  conflicts_note text,
  reliability_preference text,           -- recorded preference; alternatives must still be shown (partner neutrality)
  active boolean not null default true
);
select app.make_business_table('partner');

create table public.template_asset (   -- tenant Office templates (deck/proposal/market note/xlsx)
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('pptx','docx','xlsx')),
  purpose text not null,                 -- shortlist_deck, proposal, market_note, comparison_xlsx, ...
  storage_path text,                     -- storage bucket path; null => built-in default template
  version int not null default 1,
  brand_json jsonb not null default '{}', -- colours, fonts, logo path
  approved boolean not null default false
);
select app.make_business_table('template_asset');

create table public.licensed_source (  -- CRE Matrix etc.; purchase != replication rights
  id uuid primary key default gen_random_uuid(),
  name text not null,
  licence_identifier text,
  allowed_purposes text[] not null default '{}',
  user_count int,
  redistribution_limits text,
  retention_days int,
  permits_ai_processing boolean not null default false,
  permits_colleague_sharing boolean not null default false,
  expires_on date
);
select app.make_business_table('licensed_source');

create table public.data_lane (         -- personal/reference vs corporate-restricted processing lanes
  id uuid primary key default gen_random_uuid(),
  name text not null,
  allowed_classifications public.classification[] not null,
  approved_processors text[] not null default '{}',   -- e.g. {'openai','supabase'}
  approved_regions text[] not null default '{}',
  approval_evidence text,
  approved_at timestamptz
);
select app.make_business_table('data_lane');

-- ================================================================ geography & assets
create table public.geography (
  id uuid primary key default gen_random_uuid(),
  level text not null check (level in ('city','corridor','micro_market','locality')),
  name text not null,
  parent_id uuid references public.geography(id),
  aliases text[] not null default '{}',
  valid_from date, valid_to date,
  lat numeric(9,6), lon numeric(9,6)
);
select app.make_business_table('geography');
create index on public.geography using gin (name gin_trgm_ops);

create table public.organisation (
  id uuid primary key default gen_random_uuid(),
  legal_name text,
  display_name text not null,
  domain citext,
  cin text, gstin text,
  sector text,
  hq_country text,
  headcount_min int, headcount_max int,
  is_gcc boolean,
  source_confidence text,
  crm_external_id text,                  -- official CRM id (CRM owns account ownership)
  account_owner_note text,
  contact_restrictions text,
  search tsvector generated always as (to_tsvector('simple', coalesce(display_name,'')||' '||coalesce(legal_name,'')||' '||coalesce(domain::text,'')||' '||coalesce(sector,''))) stored
);
select app.make_business_table('organisation');
create index on public.organisation using gin(search);
create index on public.organisation using gin (display_name gin_trgm_ops);
create unique index organisation_cin_uq on public.organisation(workspace_id, cin) where cin is not null;

create table public.organisation_relation (
  id uuid primary key default gen_random_uuid(),
  from_org_id uuid not null references public.organisation(id) on delete cascade,
  to_org_id uuid not null references public.organisation(id) on delete cascade,
  relation_type text not null check (relation_type in ('parent_of','subsidiary_of','affiliate','operator_of','developer_of','owner_of','acquired')),
  valid_from date, valid_to date,
  check (from_org_id <> to_org_id)
);
select app.make_business_table('organisation_relation');

create table public.entity_alias (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  raw_alias text not null,
  canonical_alias text not null,
  source_object_id uuid
);
select app.make_business_table('entity_alias', false);
create index on public.entity_alias using gin (canonical_alias gin_trgm_ops);
create index on public.entity_alias(entity_type, entity_id);

create table public.asset (                -- campus/project > building/tower
  id uuid primary key default gen_random_uuid(),
  parent_asset_id uuid references public.asset(id),
  asset_kind text not null default 'building' check (asset_kind in ('campus','project','building','tower')),
  name text not null,
  locality_id uuid references public.geography(id),
  micro_market_id uuid references public.geography(id),
  address text,
  lat numeric(9,6), lon numeric(9,6), coord_accuracy text,
  developer_org_id uuid references public.organisation(id),
  owner_org_id uuid references public.organisation(id),
  operator_org_id uuid references public.organisation(id),
  status text,                           -- ready / under_construction / planned (source wording kept in raw)
  completion_date date, completion_precision public.date_precision default 'unknown',
  total_area_sf numeric(14,2),           -- null = unknown; 0 kept only as source_zero flag
  total_area_source_zero boolean not null default false,
  floor_size_min_sf numeric(12,2), floor_size_max_sf numeric(12,2), floor_size_text text,
  floors int,
  grade text,
  certifications jsonb not null default '[]',  -- [{name, level, verified_on}]
  specs jsonb not null default '{}',           -- power, parking, efficiency, etc.
  natural_key text,                            -- normalised building|locality key used by import matching
  search tsvector generated always as (to_tsvector('simple', coalesce(name,'')||' '||coalesce(address,''))) stored
);
select app.make_business_table('asset');
create index on public.asset using gin(search);
create index on public.asset using gin (name gin_trgm_ops);
create index on public.asset(workspace_id, natural_key);

create table public.space (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset(id) on delete cascade,
  floor_text text, unit text,
  carpet_sf numeric(12,2) check (carpet_sf is null or carpet_sf > 0),
  chargeable_sf numeric(12,2) check (chargeable_sf is null or chargeable_sf > 0),
  efficiency numeric(5,4),
  seats int,
  contiguous_group text,
  configuration text                     -- bare_shell / warm_shell / fitted / managed
);
select app.make_business_table('space');

create table public.availability (       -- append-only snapshots, never overwrite history
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.space(id) on delete cascade,
  as_of date not null,
  status text not null check (status in ('available','under_offer','leased','unverified','withdrawn')),
  available_from date,
  quote_id uuid,
  asking_rent_min numeric(10,2), asking_rent_max numeric(10,2),
  rent_basis text check (rent_basis in ('carpet','chargeable','seat')),
  fitout_basis text check (fitout_basis in ('bare','warm_shell','fitted','managed')),
  contact_person_id uuid,
  source_object_id uuid,
  valid_until date,
  fact_status public.fact_status not null default 'reported'
);
select app.make_business_table('availability');
create index on public.availability(space_id, as_of desc);

-- ================================================================ people & relationships
create table public.person (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  aliases text[] not null default '{}',
  public_profile_url text,
  preferred_language text,                -- en/hi/hinglish/mr
  preferred_channel text,
  contact_restrictions text,
  personal_notes text,                   -- only voluntarily shared / appropriate; no sensitive profiling
  search tsvector generated always as (to_tsvector('simple', coalesce(full_name,'')||' '||app.join_text(aliases))) stored
);
select app.make_business_table('person');
create index on public.person using gin(search);
create index on public.person using gin (full_name gin_trgm_ops);

create table public.contact_method (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.person(id) on delete cascade,
  method_type text not null check (method_type in ('email','phone','whatsapp','linkedin','other')),
  value text not null,                   -- TODO(prod): pgsodium/vault encryption; value_hash for matching
  value_hash text generated always as (encode(extensions.digest(lower(trim(value)),'sha256'),'hex')) stored,
  verified_on date,
  preferred boolean not null default false,
  suppressed boolean not null default false
);
select app.make_business_table('contact_method');
create index on public.contact_method(workspace_id, value_hash);

create table public.employment (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.person(id) on delete cascade,
  org_id uuid not null references public.organisation(id) on delete cascade,
  title text, function text, seniority text,
  start_date date, start_precision public.date_precision not null default 'unknown',
  end_date date,   end_precision public.date_precision not null default 'unknown',
  is_current boolean not null default true,
  fact_status public.fact_status not null default 'reported',
  source_object_id uuid
);
select app.make_business_table('employment');
create index on public.employment(person_id); create index on public.employment(org_id);

create table public.relationship_edge (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid references auth.users(id),
  from_person_id uuid references public.person(id) on delete cascade,
  to_person_id uuid not null references public.person(id) on delete cascade,
  edge_type text not null,               -- worked_with, client_of, friend, introduced_by, colleague_relationship
  warmth text check (warmth in ('cold','warm','hot','trusted')),
  strength_basis text,
  intro_permission boolean not null default false,  -- never set automatically
  last_meaningful_contact date,
  relationship_owner_user_id uuid references auth.users(id),
  valid_from date, valid_to date,
  check (from_user_id is not null or from_person_id is not null)
);
select app.make_business_table('relationship_edge');

-- ================================================================ leases & market
create table public.lease (
  id uuid primary key default gen_random_uuid(),
  tenant_org_id uuid references public.organisation(id),
  tenant_name_raw text,
  landlord_org_id uuid references public.organisation(id),
  asset_id uuid references public.asset(id),
  space_id uuid references public.space(id),
  area_sf numeric(12,2), area_basis text,
  rent_per_sf numeric(10,2), rent_basis text,
  registration_ref text,
  registration_date date,
  start_date date, start_precision public.date_precision not null default 'unknown',
  tenure_months_raw numeric(8,2),
  lockin_months_raw numeric(8,2),
  contractual_expiry date,
  status text not null default 'unknown',
  fact_status public.fact_status not null default 'historical_observed',
  amends_lease_id uuid references public.lease(id),
  source_object_id uuid
);
select app.make_business_table('lease');
create unique index lease_reg_uq on public.lease(workspace_id, registration_ref) where registration_ref is not null;

create table public.lease_event (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references public.lease(id) on delete cascade,
  event_type text not null check (event_type in ('expiry','lockin_end','notice_deadline','break','escalation','option')),
  event_date date,
  date_basis text not null check (date_basis in ('contractual','calculated_from_source_tenure','source_formula_cached','reported','estimated')),
  formula_raw text,
  notice_days int, notice_day_rule text, -- business/calendar
  confirmed boolean not null default false,
  needs_review boolean not null default false,
  review_reason text,
  engine_version text,
  source_object_id uuid
);
select app.make_business_table('lease_event');
create index on public.lease_event(workspace_id, event_type, event_date);

create table public.market_transaction (
  id uuid primary key default gen_random_uuid(),
  tenant_org_id uuid references public.organisation(id),
  tenant_name_raw text,
  asset_id uuid references public.asset(id),
  space_id uuid references public.space(id),
  deal_type text,                        -- conventional/managed/coworking/renewal/expansion/...
  period_start date, period_end date, period_precision public.date_precision not null default 'month',
  area_sf numeric(12,2), seats int,
  rent_min numeric(10,2), rent_max numeric(10,2), rent_basis text,
  broker_org_id uuid references public.organisation(id), broker_name_raw text,
  inclusions text,
  source_object_id uuid,
  extras jsonb not null default '{}'
);
select app.make_business_table('market_transaction');

create table public.market_observation (
  id uuid primary key default gen_random_uuid(),
  metric text not null,                  -- stock, absorption, rent, supply, vacancy
  geography_id uuid references public.geography(id),
  geography_raw text,
  period_start date, period_end date,
  period_type text not null check (period_type in ('full_year','ytd','quarter','month','forecast','snapshot')),
  unit text not null,
  value numeric(16,4),
  definition text,                       -- gross/net etc.
  release_date date,
  source_object_id uuid,
  source_version text
);
select app.make_business_table('market_observation');
create unique index market_obs_uq on public.market_observation(workspace_id, coalesce(source_version,''), metric, coalesce(geography_raw,''), period_start, period_type);

-- ================================================================ demand side
create table public.requirement (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisation(id),
  title text not null,
  objective text check (objective in ('new','relocation','expansion','consolidation','renewal','flex','other')),
  transaction_kinds text[] not null default '{}',     -- conventional/managed/coworking/gcc
  area_min_sf numeric(12,2), area_target_sf numeric(12,2), area_max_sf numeric(12,2),
  area_basis text,
  seats_min int, seats_target int, seats_max int,
  budget_min numeric(14,2), budget_max numeric(14,2), budget_basis text,
  preferred_geography_ids uuid[] not null default '{}',
  excluded_geography_ids uuid[] not null default '{}',
  decision_date date, occupation_date date,
  constraints jsonb not null default '{}', -- structured non-negotiables: power, parking, transit, certifications...
  status text not null default 'draft' check (status in ('draft','estimated','client_confirmed','closed')),
  confirmed_by_person_id uuid references public.person(id),
  confirmed_at timestamptz,
  mandate_status text,
  conflict_status text,
  check (area_min_sf is null or area_target_sf is null or area_min_sf <= area_target_sf),
  check (area_target_sf is null or area_max_sf is null or area_target_sf <= area_max_sf),
  search tsvector generated always as (to_tsvector('simple', coalesce(title,''))) stored
);
select app.make_business_table('requirement');
create index on public.requirement using gin(search);

create table public.stakeholder (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirement(id) on delete cascade,
  person_id uuid not null references public.person(id),
  employment_id uuid references public.employment(id),
  role text not null check (role in ('sponsor','user','finance','procurement','legal','technical','approver','influencer','other')),
  influence_basis text,
  access_status text
);
select app.make_business_table('stakeholder');

create table public.opportunity (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid references public.requirement(id),
  org_id uuid not null references public.organisation(id),
  name text not null,
  stage text not null default 'research' check (stage in (
    'research','approach_attempted','engaged','qualified_discussion','requirement_confirmed','options_visits',
    'proposal_negotiation','loi','documentation','signed','possession','invoiced','recognised','collected')),
  outcome text check (outcome in ('open','dormant','lost','disqualified','won')) default 'open',
  outcome_reason text,                   -- lost/no-decision learning: reason codes
  stage_entered_at timestamptz not null default now(),
  temperature text check (temperature in ('cold','warm','hot')),
  mandate_status text check (mandate_status in ('none','non_exclusive','exclusive','support','unknown')) default 'unknown',
  account_owner_user_id uuid references auth.users(id),
  expected_fee numeric(14,2),
  credit_share numeric(5,4) check (credit_share between 0 and 1),
  expected_close date,
  next_action text, next_action_due date,
  risks text,
  crm_external_id text
);
select app.make_business_table('opportunity');

create table public.opportunity_stage_history (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity(id) on delete cascade,
  from_stage text, to_stage text not null,
  changed_at timestamptz not null default now(),
  evidence text
);
select app.make_business_table('opportunity_stage_history', false);

create table public.quote (
  id uuid primary key default gen_random_uuid(),
  counterparty_org_id uuid references public.organisation(id),
  space_id uuid references public.space(id),
  requirement_id uuid references public.requirement(id),
  version int not null default 1,
  currency text not null default 'INR',
  valid_until date,
  terms_json jsonb not null default '{}', -- rent, basis, cam, escalation, deposit, rent_free, capex, lockin, tenure, taxes, inclusions
  approved_floor numeric(10,2), approved_ceiling numeric(10,2),
  evidence text,
  approved_at timestamptz,
  superseded_by uuid references public.quote(id)
);
select app.make_business_table('quote');

create table public.shortlist_option (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirement(id) on delete cascade,
  space_id uuid references public.space(id),
  asset_id uuid references public.asset(id),
  availability_id uuid references public.availability(id),
  version int not null default 1,
  eligible boolean not null,
  disqualifiers text[] not null default '{}',
  fit_score numeric(6,2),
  completeness_score numeric(6,2),
  score_breakdown jsonb not null default '{}',
  rubric_version text not null,
  option_status text not null default 'proposed' check (option_status in ('proposed','shortlisted','visited','rejected','selected'))
);
select app.make_business_table('shortlist_option');

create table public.finance_scenario (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid references public.requirement(id),
  option_id uuid references public.shortlist_option(id),
  name text not null,
  input_json jsonb not null,
  quote_ids uuid[] not null default '{}',
  quote_versions int[] not null default '{}',
  engine_version text not null,
  result_json jsonb,
  output_hash text,
  approved_at timestamptz
);
select app.make_business_table('finance_scenario');

create table public.finance_cashflow (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references public.finance_scenario(id) on delete cascade,
  period_index int not null,
  period_date date not null,
  category text not null,
  amount numeric(16,2) not null
);
select app.make_business_table('finance_cashflow', false);

create table public.fee_milestone (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity(id) on delete cascade,
  gross_fee numeric(14,2),
  exclusions text,
  credit_share numeric(5,4) check (credit_share between 0 and 1),
  milestone text,
  invoiced_amount numeric(14,2), invoiced_on date,
  recognised_amount numeric(14,2), recognised_on date,
  collected_amount numeric(14,2), collected_on date,
  currency text not null default 'INR',
  tax_basis text,
  evidence text
);
select app.make_business_table('fee_milestone');

-- ================================================================ activity
create table public.interaction (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null,
  channel text not null check (channel in ('email','call','meeting','visit','whatsapp','linkedin','note','other')),
  direction text check (direction in ('inbound','outbound','internal')),
  subject text,
  summary text,
  promises jsonb not null default '[]',
  objections jsonb not null default '[]',
  source_message_id text,                -- external id; dedupe
  source_object_id uuid,
  capture_id uuid,
  recording_uri text, transcript_uri text,
  opportunity_id uuid references public.opportunity(id),
  is_meaningful boolean not null default false
);
select app.make_business_table('interaction');
create unique index interaction_src_uq on public.interaction(workspace_id, source_message_id) where source_message_id is not null;

create table public.interaction_link (
  id uuid primary key default gen_random_uuid(),
  interaction_id uuid not null references public.interaction(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  role text                               -- participant/from/to/cc/mentioned
);
select app.make_business_table('interaction_link', false);
create index on public.interaction_link(entity_type, entity_id);

create table public.task (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open','snoozed','done','cancelled','stale')),
  snoozed_until timestamptz,
  priority int not null default 50,
  assigned_user_id uuid references auth.users(id),
  linked_entity_type text, linked_entity_id uuid,
  depends_on uuid references public.task(id),
  completion_evidence text,
  completed_at timestamptz,
  source text,                            -- capture/brief/workflow/manual
  idempotency_key text
);
select app.make_business_table('task');
create unique index task_idem_uq on public.task(workspace_id, idempotency_key) where idempotency_key is not null;

create table public.meeting_visit (
  id uuid primary key default gen_random_uuid(),
  external_calendar_id text,
  provider text,                          -- microsoft/google/manual
  title text,
  start_at timestamptz not null, end_at timestamptz not null,
  timezone text not null default 'Asia/Kolkata',
  location text, lat numeric(9,6), lon numeric(9,6),
  kind text not null default 'meeting' check (kind in ('meeting','site_visit','call','internal')),
  route_group text,
  status text not null default 'confirmed' check (status in ('provisional','confirmed','cancelled','completed')),
  opportunity_id uuid references public.opportunity(id),
  linked_entity_type text, linked_entity_id uuid,
  version_key text                        -- external id + start time; reschedule invalidates T-60 brief
);
select app.make_business_table('meeting_visit');
create unique index meeting_ext_uq on public.meeting_visit(workspace_id, provider, external_calendar_id) where external_calendar_id is not null;

create table public.signal_claim (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null, subject_id uuid not null,
  claim_type text not null,               -- hiring, funding, expansion, job_move, rto, gcc_plan, ...
  predicate text,
  value_json jsonb not null default '{}',
  status public.fact_status not null default 'reported',
  evidence_tier text check (evidence_tier in ('documentary_current','credible_reported','corroborated_public','single_unverified','inference')),
  evidence_excerpt text,
  source_url text, source_locator text, source_object_id uuid,
  published_on date, observed_on date, effective_on date, expires_on date,
  contradicts uuid[] not null default '{}',
  approved_canonical boolean not null default false
);
select app.make_business_table('signal_claim');
create index on public.signal_claim(subject_type, subject_id);

create table public.consent_permission (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references public.person(id) on delete cascade,
  source_label text,
  purpose text not null,
  channel text,
  legal_basis_as_advised text,
  evidence text,
  expires_on date,
  revoked_at timestamptz,
  suppressed boolean not null default false
);
select app.make_business_table('consent_permission');

-- ================================================================ sources, imports, documents
create table public.source_object (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('file','email','calendar','web','capture','export','manual')),
  uri text,
  file_name text,
  sha256 text,
  licensed_source_id uuid references public.licensed_source(id),
  licence_note text,
  version int not null default 1,
  previous_version_id uuid references public.source_object(id),
  retrieved_at timestamptz not null default now(),
  meta jsonb not null default '{}'
);
select app.make_business_table('source_object');
create index on public.source_object(workspace_id, sha256);

create table public.document_version (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('pptx','docx','xlsx','pdf','other')),
  purpose text,
  uri text,
  sha256 text,
  template_asset_id uuid references public.template_asset(id),
  template_version int,
  input_versions jsonb not null default '{}',  -- {quote_id: version, scenario_id: output_hash, ...}
  status text not null default 'draft' check (status in ('draft','in_review','approved','stale','released')),
  approved_hash text,
  linked_entity_type text, linked_entity_id uuid,
  expires_at timestamptz
);
select app.make_business_table('document_version');

-- ================================================================ change / approval
create table public.change_proposal (
  id uuid primary key default gen_random_uuid(),
  target_type text not null,
  target_id uuid,                         -- null for create
  operation text not null default 'update' check (operation in ('create','update','archive','merge','link')),
  expected_version bigint,
  patch jsonb not null,                   -- RFC6902-style [{op,path,value}]
  before jsonb,
  reason text,
  evidence_ids uuid[] not null default '{}',
  risk public.risk_level not null,
  approval_required boolean not null,
  state text not null default 'proposed' check (state in ('proposed','approved','rejected','applied','reversed','conflict','expired','clarify')),
  proposed_by_kind text not null default 'user' check (proposed_by_kind in ('user','job','model')),
  model text,
  idempotency_key text,
  capture_id uuid,
  applied_audit_id bigint,
  reversal_of uuid references public.change_proposal(id),
  decided_by uuid references auth.users(id),
  decided_at timestamptz
);
select app.make_business_table('change_proposal');
create unique index change_idem_uq on public.change_proposal(workspace_id, idempotency_key) where idempotency_key is not null;

create table public.approval (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('change_proposal','draft','document_version','quote','finance_scenario')),
  subject_id uuid not null,
  approver_user_id uuid not null references auth.users(id),
  approved_hash text not null,           -- hash must match at use
  decision text not null check (decision in ('approved','rejected','clarify')),
  note text,
  expires_at timestamptz
);
select app.make_business_table('approval');

-- ================================================================ jobs, outbox, connectors, usage
create table public.job (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspace(id) on delete cascade,  -- null = platform job
  job_type text not null,
  payload jsonb not null default '{}',
  due_at timestamptz not null default now(),
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','dead','cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  lease_until timestamptz,
  locked_by text,
  dedupe_key text,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index job_dedupe_uq on public.job(dedupe_key) where dedupe_key is not null and state in ('queued','running','succeeded');
create index job_due_idx on public.job(state, due_at);
alter table public.job enable row level security;
create policy job_sel on public.job for select to authenticated using (workspace_id is not null and app.has_role(workspace_id,'admin'));
grant select on public.job to authenticated;
grant all on public.job to service_role;

create table public.outbox (              -- private notifications etc., at-least-once with dedupe
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid references auth.users(id),
  kind text not null,                     -- notification/brief_ready/urgent_alert
  payload jsonb not null default '{}',
  dedupe_key text not null,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key)
);
select app.make_workspace_table('outbox','admin');
create policy outbox_own on public.outbox for select to authenticated using (user_id = auth.uid());

create table public.connector_account (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('microsoft','google')),
  scopes text[] not null default '{}',
  account_email text,
  status text not null default 'connected' check (status in ('connected','expired','revoked','error','mock')),
  token_ciphertext text,                  -- AES-GCM encrypted server-side (TOKEN_ENCRYPTION_KEY); never sent to browser
  token_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, provider)
);
alter table public.connector_account enable row level security;
create policy connector_own on public.connector_account for select to authenticated using (user_id = auth.uid() or app.has_role(workspace_id,'admin'));
revoke all on public.connector_account from authenticated;
grant select (id, workspace_id, user_id, provider, scopes, account_email, status, token_expires_at, last_error, created_at, updated_at) on public.connector_account to authenticated;
grant all on public.connector_account to service_role;

create table public.connector_cursor (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  connector_account_id uuid not null references public.connector_account(id) on delete cascade,
  resource text not null,                 -- inbox/calendar/sent
  cursor text,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  primary key (connector_account_id, resource)
);
select app.make_workspace_table('connector_cursor','admin');

create table public.model_usage (
  id bigserial primary key,
  workspace_id uuid references public.workspace(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  workflow text not null,
  provider text not null default 'openai',
  model text not null,
  mode text,                              -- responses/transcribe/web_search
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  audio_seconds numeric(10,2) not null default 0,
  search_calls int not null default 0,
  estimated_usd numeric(12,6) not null default 0,
  pricing_version text not null,
  request_id text,
  ok boolean not null default true,
  error text
);
alter table public.model_usage enable row level security;
create policy model_usage_sel on public.model_usage for select to authenticated using (app.has_role(workspace_id,'admin'));
grant select on public.model_usage to authenticated;
grant all on public.model_usage to service_role;
grant usage on sequence public.model_usage_id_seq to service_role;

-- ================================================================ job queue functions (durable, FOR UPDATE SKIP LOCKED)
create or replace function app.enqueue_job(p_workspace uuid, p_type text, p_payload jsonb default '{}',
                                           p_due timestamptz default now(), p_dedupe text default null, p_max_attempts int default 5)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.job(workspace_id, job_type, payload, due_at, dedupe_key, max_attempts)
  values (p_workspace, p_type, p_payload, p_due, p_dedupe, p_max_attempts)
  on conflict (dedupe_key) where dedupe_key is not null and state in ('queued','running','succeeded') do nothing
  returning id into v_id;
  if v_id is null then select id into v_id from public.job where dedupe_key = p_dedupe and state in ('queued','running','succeeded') limit 1; end if;
  return v_id;
end $$;

create or replace function app.claim_jobs(p_worker text, p_limit int default 5, p_lease_seconds int default 300, p_types text[] default null)
returns setof public.job language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.job j set state = 'running', attempts = j.attempts + 1, locked_by = p_worker,
         lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where j.id in (
    select id from public.job
    where ((state = 'queued' and due_at <= now()) or (state = 'running' and lease_until < now()))
      and (p_types is null or job_type = any(p_types))
    order by due_at
    for update skip locked
    limit p_limit)
  returning j.*;
end $$;

create or replace function app.complete_job(p_id uuid, p_result jsonb default null) returns void
language sql security definer set search_path = public as $$
  update public.job set state='succeeded', result=p_result, lease_until=null, updated_at=now() where id=p_id
$$;

create or replace function app.fail_job(p_id uuid, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.job set
    state = case when attempts >= max_attempts then 'dead' else 'queued' end,
    due_at = now() + make_interval(secs => least(3600, (power(2, attempts) * 30)::int)),  -- exponential backoff
    last_error = left(p_error, 4000), lease_until = null, updated_at = now()
  where id = p_id;
end $$;

revoke all on function app.enqueue_job, app.claim_jobs, app.complete_job, app.fail_job from public, authenticated, anon;
grant execute on function app.enqueue_job, app.claim_jobs, app.complete_job, app.fail_job to service_role;

-- storage bucket for originals, captures and generated outputs (path prefix = workspace_id/)
insert into storage.buckets (id, name, public) values ('workspace-files','workspace-files', false) on conflict do nothing;
create policy "ws files read" on storage.objects for select to authenticated
  using (bucket_id = 'workspace-files' and app.is_member(((storage.foldername(name))[1])::uuid));
create policy "ws files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'workspace-files' and app.has_role(((storage.foldername(name))[1])::uuid, 'editor'));
