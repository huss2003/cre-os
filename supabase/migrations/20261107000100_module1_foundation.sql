-- Module 1 — Database & relational master: tables the Module 1 brief names that the core schema did not have yet.
-- Existing equivalents are kept (no renames, no drops):
--   organisation_alias  -> entity_alias            observation       -> market_observation / asset_observation (+ generic observation below)
--   cashflow            -> finance_cashflow        idempotency_record-> idempotency_key / deal_idempotency
--   integration_account -> connector_account       suppression       -> suppression_tombstone (+ suppression below)
--   classification      -> mudar.classification enum + membership.allowed_classifications
-- Every table: make_business_table (workspace_id, classification, owner, timestamps, row_version, archived_at, RLS, audit).
-- Child rows get a same-workspace guard so a foreign key can never point into another workspace.

-- ---------- same-workspace guard (composite workspace-aware FK, enforced by trigger) ----------
-- usage: create trigger ... execute function mudar_app.assert_same_workspace('fk_col','parent_table', 'fk_col2','parent_table2', ...)
create or replace function mudar_app.assert_same_workspace() returns trigger
language plpgsql security definer set search_path = mudar, pg_temp as $$
declare i int := 0; col text; tbl text; ref uuid; parent_ws uuid;
begin
  while i < tg_nargs loop
    col := tg_argv[i]; tbl := tg_argv[i+1]; i := i + 2;
    execute format('select ($1).%I', col) into ref using new;
    if ref is null then continue; end if;
    execute format('select workspace_id from mudar.%I where id = $1', tbl) into parent_ws using ref;
    if parent_ws is null then
      raise exception 'foreign key %.% -> %(%) not found', tg_table_name, col, tbl, ref using errcode = '23503';
    end if;
    if parent_ws <> new.workspace_id then
      raise exception 'cross-workspace reference %.% -> %', tg_table_name, col, tbl using errcode = '23503';
    end if;
  end loop;
  return new;
end $$;

-- ---------- A. Access ----------
create table if not exists mudar.entitlement (
  id uuid primary key default gen_random_uuid(),
  feature_key text not null,                         -- e.g. 'imports.pdf', 'ai.research', 'seats'
  enabled boolean not null default true,
  limit_value numeric(14,2),                         -- null = unlimited / not applicable
  valid_from date, valid_until date,
  note text,
  check (valid_until is null or valid_from is null or valid_from <= valid_until)
);
select mudar_app.make_business_table('entitlement');
create unique index if not exists entitlement_uq on mudar.entitlement(workspace_id, feature_key) where archived_at is null;

-- ---------- C. People ----------
create table if not exists mudar.relationship_context (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references mudar.person(id),
  org_id uuid references mudar.organisation(id),
  relationship_owner_user_id uuid references auth.users(id),
  strength text check (strength in ('unknown','cold','warm','strong','champion')) default 'unknown',
  context text not null,                             -- how we know them, business context
  last_verified_on date,
  source_object_id uuid references mudar.source_object(id)
);
select mudar_app.make_business_table('relationship_context');
create index if not exists relationship_context_person_idx on mudar.relationship_context(person_id);
drop trigger if exists relationship_context_ws on mudar.relationship_context;
create trigger relationship_context_ws before insert or update on mudar.relationship_context
  for each row execute function mudar_app.assert_same_workspace('person_id','person','org_id','organisation');

-- ---------- D. Property ----------
create table if not exists mudar.asset_spec (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references mudar.asset(id),
  spec_key text not null check (spec_key in ('parking_ratio','parking_slots','power_backup','power_load_kva','hvac','floor_plate_sf',
                                             'lifts_passenger','lifts_service','efficiency_pct','ceiling_height_m','fire_safety','other')),
  value_text text,                                   -- raw as stated
  value_num numeric(14,2),                           -- normalised number when one exists; null = unknown (never 0 for blank)
  unit text,
  as_of date,
  verification text not null default 'reported' check (verification in ('reported','verified','disputed')),
  source_object_id uuid references mudar.source_object(id),
  check (value_text is not null or value_num is not null)
);
select mudar_app.make_business_table('asset_spec');
create index if not exists asset_spec_asset_idx on mudar.asset_spec(asset_id, spec_key);
drop trigger if exists asset_spec_ws on mudar.asset_spec;
create trigger asset_spec_ws before insert or update on mudar.asset_spec
  for each row execute function mudar_app.assert_same_workspace('asset_id','asset');

create table if not exists mudar.infrastructure (
  id uuid primary key default gen_random_uuid(),
  geography_id uuid references mudar.geography(id),
  name text not null,
  kind text not null check (kind in ('metro','rail','airport','highway','road','hospital','hotel','mall','school','other')),
  status text check (status in ('operational','under_construction','planned','unknown')) default 'unknown',
  lat numeric(9,6), lon numeric(9,6),
  expected_date date,
  source_object_id uuid references mudar.source_object(id)
);
select mudar_app.make_business_table('infrastructure');
create index if not exists infrastructure_geo_idx on mudar.infrastructure(geography_id);
drop trigger if exists infrastructure_ws on mudar.infrastructure;
create trigger infrastructure_ws before insert or update on mudar.infrastructure
  for each row execute function mudar_app.assert_same_workspace('geography_id','geography');

-- ---------- E. Lease ----------
create table if not exists mudar.lease_space (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  space_id uuid not null references mudar.space(id),
  area_sf numeric(12,2), area_basis text,
  unique (lease_id, space_id)
);
select mudar_app.make_business_table('lease_space');
create index if not exists lease_space_space_idx on mudar.lease_space(space_id);
drop trigger if exists lease_space_ws on mudar.lease_space;
create trigger lease_space_ws before insert or update on mudar.lease_space
  for each row execute function mudar_app.assert_same_workspace('lease_id','lease','space_id','space');

-- ---------- F. CRM ----------
create table if not exists mudar.requirement_location (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references mudar.requirement(id) on delete cascade,
  geography_id uuid not null references mudar.geography(id),
  preference text not null default 'preferred' check (preference in ('must','preferred','acceptable','excluded')),
  rank int,
  unique (requirement_id, geography_id)
);
select mudar_app.make_business_table('requirement_location');
drop trigger if exists requirement_location_ws on mudar.requirement_location;
create trigger requirement_location_ws before insert or update on mudar.requirement_location
  for each row execute function mudar_app.assert_same_workspace('requirement_id','requirement','geography_id','geography');

create table if not exists mudar.requirement_feature (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references mudar.requirement(id) on delete cascade,
  feature_key text not null,                         -- grade, power_backup, parking_ratio, certification, floor_plate...
  operator text not null default 'eq' check (operator in ('eq','gte','lte','in','has')),
  value_text text, value_num numeric(14,2), unit text,
  is_hard_constraint boolean not null default false,
  check (value_text is not null or value_num is not null)
);
select mudar_app.make_business_table('requirement_feature');
create index if not exists requirement_feature_req_idx on mudar.requirement_feature(requirement_id);
drop trigger if exists requirement_feature_ws on mudar.requirement_feature;
create trigger requirement_feature_ws before insert or update on mudar.requirement_feature
  for each row execute function mudar_app.assert_same_workspace('requirement_id','requirement');

-- ---------- G. Interaction ----------
create table if not exists mudar.interaction_participant (
  id uuid primary key default gen_random_uuid(),
  interaction_id uuid not null references mudar.interaction(id) on delete cascade,
  person_id uuid references mudar.person(id),
  user_id uuid references auth.users(id),
  display_name text,                                 -- kept when the person is not (yet) matched
  role text not null default 'attendee' check (role in ('organiser','attendee','sender','recipient','cc','mentioned')),
  check (person_id is not null or user_id is not null or display_name is not null)
);
select mudar_app.make_business_table('interaction_participant');
create index if not exists interaction_participant_int_idx on mudar.interaction_participant(interaction_id);
create index if not exists interaction_participant_person_idx on mudar.interaction_participant(person_id);
drop trigger if exists interaction_participant_ws on mudar.interaction_participant;
create trigger interaction_participant_ws before insert or update on mudar.interaction_participant
  for each row execute function mudar_app.assert_same_workspace('interaction_id','interaction','person_id','person');

-- send_record: confirmation that a human sent a draft OUTSIDE CRE OS. CRE OS itself never sends (S3).
create table if not exists mudar.send_record (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references mudar.draft(id),
  sent_at timestamptz not null,
  confirmed_by uuid not null references auth.users(id),
  channel text not null,
  evidence text not null default 'user_assertion',   -- 'user_assertion' | 'sent_items:<message-id>'
  content_hash text not null,
  unique (draft_id)
);
select mudar_app.make_business_table('send_record');
drop trigger if exists send_record_ws on mudar.send_record;
create trigger send_record_ws before insert or update on mudar.send_record
  for each row execute function mudar_app.assert_same_workspace('draft_id','draft');

create table if not exists mudar.suppression (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references mudar.person(id),
  address_hash text,                                 -- sha256 of normalised email/phone; works after the person is erased
  channel text not null default 'all' check (channel in ('all','email','phone','whatsapp','linkedin')),
  reason text not null,
  until date,                                        -- null = permanent
  check (person_id is not null or address_hash is not null)
);
select mudar_app.make_business_table('suppression');
create index if not exists suppression_person_idx on mudar.suppression(person_id);
create index if not exists suppression_hash_idx on mudar.suppression(workspace_id, address_hash);
drop trigger if exists suppression_ws on mudar.suppression;
create trigger suppression_ws before insert or update on mudar.suppression
  for each row execute function mudar_app.assert_same_workspace('person_id','person');

-- ---------- H. Evidence ----------
-- Generic observation: one sourced value about any record field. Contradictions are kept side by side, never overwritten.
create table if not exists mudar.observation (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('organisation','person','asset','space','availability','lease','requirement','opportunity','geography')),
  entity_id uuid not null,
  field text not null,
  source_object_id uuid references mudar.source_object(id),
  staged_row_id uuid references mudar.staged_row(id),
  source_location text,                              -- 'Sheet1!R42C7', 'page 3', url fragment
  value_raw text,                                    -- exactly as in the source (blank stays blank)
  value_norm text,                                   -- normalised; null = unknown
  value_num numeric(18,4),
  unit text,
  observed_on date,
  effective_on date,
  confidence numeric(4,3) check (confidence between 0 and 1),
  verification text not null default 'reported' check (verification in ('reported','currently_confirmed','disputed','superseded','ai_inference')),
  obs_key text not null                              -- sha256(entity|field|source|location|raw) -> idempotent re-import
);
select mudar_app.make_business_table('observation');
create unique index if not exists observation_key_uq on mudar.observation(workspace_id, obs_key);
create index if not exists observation_entity_idx on mudar.observation(workspace_id, entity_type, entity_id, field);

-- field_provenance: which observation/approval currently backs a canonical field value.
create table if not exists mudar.field_provenance (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  field text not null,
  observation_id uuid references mudar.observation(id),
  change_proposal_id uuid references mudar.change_proposal(id),
  set_by uuid references auth.users(id),
  set_at timestamptz not null default now(),
  method text not null check (method in ('manual','import','approved_change','connector','migration')),
  is_current boolean not null default true
);
select mudar_app.make_business_table('field_provenance');
create unique index if not exists field_provenance_current_uq on mudar.field_provenance(workspace_id, entity_type, entity_id, field) where is_current;
drop trigger if exists field_provenance_ws on mudar.field_provenance;
create trigger field_provenance_ws before insert or update on mudar.field_provenance
  for each row execute function mudar_app.assert_same_workspace('observation_id','observation','change_proposal_id','change_proposal');

-- ---------- I. Finance (foundation only, no calculations) ----------
create table if not exists mudar.quote_line (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references mudar.quote(id) on delete cascade,
  line_kind text not null check (line_kind in ('rent','cam','parking','fitout','deposit','rent_free','escalation','capex','tax','other')),
  amount numeric(16,2),                              -- null = not quoted (never 0 for blank)
  amount_basis text,                                 -- per_sf_month, lump_sum, months, pct...
  currency text not null default 'INR',
  note text
);
select mudar_app.make_business_table('quote_line');
create index if not exists quote_line_quote_idx on mudar.quote_line(quote_id);
drop trigger if exists quote_line_ws on mudar.quote_line;
create trigger quote_line_ws before insert or update on mudar.quote_line
  for each row execute function mudar_app.assert_same_workspace('quote_id','quote');

create table if not exists mudar.fee_allocation (
  id uuid primary key default gen_random_uuid(),
  fee_milestone_id uuid not null references mudar.fee_milestone(id) on delete cascade,
  user_id uuid references auth.users(id),
  partner_org_id uuid references mudar.organisation(id),
  share numeric(5,4) not null check (share > 0 and share <= 1),
  note text,
  check (user_id is not null or partner_org_id is not null)
);
select mudar_app.make_business_table('fee_allocation');
drop trigger if exists fee_allocation_ws on mudar.fee_allocation;
create trigger fee_allocation_ws before insert or update on mudar.fee_allocation
  for each row execute function mudar_app.assert_same_workspace('fee_milestone_id','fee_milestone','partner_org_id','organisation');

-- ---------- J. Control ----------
create table if not exists mudar.configuration_version (
  id uuid primary key default gen_random_uuid(),
  config_key text not null,                          -- 'import.mapping.<name>', 'scoring.weights', ...
  version int not null,
  body jsonb not null,
  is_active boolean not null default false,
  change_note text
);
select mudar_app.make_business_table('configuration_version');
create unique index if not exists configuration_version_uq on mudar.configuration_version(workspace_id, config_key, version);
create unique index if not exists configuration_version_active_uq on mudar.configuration_version(workspace_id, config_key) where is_active;

-- ---------- Database overview (one round-trip for the Database screen) ----------
create or replace function mudar_app.database_overview(ws uuid) returns jsonb
language sql stable security invoker set search_path = mudar, pg_temp as $$
  select jsonb_build_object(
    'organisations', (select count(*) from mudar.organisation where workspace_id = ws and archived_at is null),
    'people',        (select count(*) from mudar.person where workspace_id = ws and archived_at is null),
    'buildings',     (select count(*) from mudar.asset where workspace_id = ws and archived_at is null),
    'spaces',        (select count(*) from mudar.space where workspace_id = ws and archived_at is null),
    'requirements',  (select count(*) from mudar.requirement where workspace_id = ws and archived_at is null),
    'opportunities', (select count(*) from mudar.opportunity where workspace_id = ws and archived_at is null),
    'leases',        (select count(*) from mudar.lease where workspace_id = ws and archived_at is null),
    'interactions',  (select count(*) from mudar.interaction where workspace_id = ws and archived_at is null),
    'sources',       (select count(*) from mudar.source_object where workspace_id = ws and archived_at is null),
    'pending_imports', (select count(*) from mudar.import_batch where workspace_id = ws and archived_at is null
                          and status in ('registered','processing','needs_mapping')),
    'identity_reviews', (select count(*) from mudar.identity_match_candidate where workspace_id = ws and archived_at is null and decision = 'pending'),
    'change_reviews',   (select count(*) from mudar.change_proposal where workspace_id = ws and archived_at is null and state in ('proposed','clarify','conflict')),
    'conflicts',        (select count(*) from mudar.field_conflict where workspace_id = ws and archived_at is null and status = 'open'),
    'import_exceptions',(select count(*) from mudar.import_exception where workspace_id = ws and archived_at is null and status = 'open')
  )
$$;
grant execute on function mudar_app.database_overview(uuid) to authenticated;
notify pgrst, 'reload schema';
