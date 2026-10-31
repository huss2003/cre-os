set search_path = mudar, mudar_app, public, extensions;
-- CRE OS imports module (spec Part I §6 "Import and identity resolution", Part III "Import adapters and reconciliation",
-- Part V "Import acceptance rules").
-- Pipeline: read-only source > hashed import > row-level staging > schema mapping > type checks > candidate matching >
-- exception queue > validated upserts > reconciliation.
-- Re-runnable during development: drops only this module's own objects.

drop table if exists mudar.identity_match_candidate cascade;
drop table if exists mudar.import_exception cascade;
drop table if exists mudar.staged_row cascade;
drop table if exists mudar.asset_observation cascade;
drop table if exists mudar.import_entity_key cascade;
drop table if exists mudar.import_batch cascade;
drop table if exists mudar.adapter_mapping cascade;

-- ---------------------------------------------------------------- per-workspace saved column maps
-- An unknown schema signature is never silently remapped: a human approves a mapping (approved=true) first.
create table mudar.adapter_mapping (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  adapter text not null,                       -- e.g. asset_list_v1
  sheet_role text not null,                    -- e.g. assets_headerless, lease, lockin
  schema_signature text not null,              -- header fingerprint (or headerless shape fingerprint)
  header_row int not null default 0,           -- 1-based header row; 0 = headerless (first row is data)
  positional boolean not null default false,
  column_map jsonb not null,                   -- {canonical_field: column_index (0-based)}
  sample_headers jsonb not null default '[]',
  version int not null default 1,
  approved boolean not null default false,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  note text
);
select mudar_app.make_business_table('adapter_mapping');
create unique index adapter_mapping_sig_uq on mudar.adapter_mapping(workspace_id, schema_signature, version);

-- ---------------------------------------------------------------- DB-enforced guard: only admins approve schema mappings
-- (the API checks this too, but PostgREST is reachable directly with the user's JWT, so the database is the boundary)
create or replace function mudar_app.imports_mapping_guard() returns trigger language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if auth.uid() is not null and new.approved and (
       tg_op = 'INSERT' or not old.approved or new.column_map is distinct from old.column_map
       or new.schema_signature is distinct from old.schema_signature or new.adapter is distinct from old.adapter
       or new.sheet_role is distinct from old.sheet_role or new.header_row is distinct from old.header_row) then
    if not mudar_app.has_role(new.workspace_id, 'admin') then
      raise exception 'only workspace admins can approve import mappings' using errcode = '42501';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  return new;
end $$;
revoke execute on function mudar_app.imports_mapping_guard() from public, anon, authenticated;
create trigger adapter_mapping_guard before insert or update on mudar.adapter_mapping
  for each row execute function mudar_app.imports_mapping_guard();

-- ---------------------------------------------------------------- import batch (one processing run of one source_object version)
create table mudar.import_batch (
  id uuid primary key default gen_random_uuid(),
  source_object_id uuid not null references mudar.source_object(id) on delete cascade,
  previous_batch_id uuid references mudar.import_batch(id),
  file_name text not null,
  adapter text,                                -- resolved adapter(s), comma separated when sheets differ
  adapter_version text,
  mapping_version text,                        -- builtin:<adapter>@<v> or mapping:<id>@<version>
  status text not null default 'registered' check (status in
    ('registered','processing','needs_mapping','completed','completed_with_exceptions','failed')),
  options jsonb not null default '{}',         -- {as_of, period_year, classification}
  sheets jsonb not null default '[]',          -- per-sheet detection result
  counts jsonb not null default '{}',          -- reconciliation report
  diff jsonb,                                  -- field diff vs previous version of the same source name
  error text,
  created_by uuid references auth.users(id),
  processing_started_at timestamptz,
  finished_at timestamptz,
  attempt int not null default 0
);
select mudar_app.make_business_table('import_batch');
create index on mudar.import_batch(workspace_id, created_at desc);
create index on mudar.import_batch(source_object_id);

-- ---------------------------------------------------------------- staged rows (every non-empty source row, with locator)
create table mudar.staged_row (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references mudar.import_batch(id) on delete cascade,
  source_object_id uuid not null references mudar.source_object(id) on delete cascade,
  sheet text not null,
  row_number int not null,                     -- 1-based source row
  locator text not null,                       -- "sheet!row"
  raw_json jsonb not null,                     -- {"A": {"v": .., "f": "=.."}, ...} original cell values + formula text
  row_hash text not null,
  status text not null check (status in ('accepted','quarantined','excluded','duplicate')),
  reason text,
  flags text[] not null default '{}',
  mapped_json jsonb,                           -- {kind, identity_key, fields, ...}
  targets jsonb not null default '[]',         -- [{type, id, role, created, ...}]
  unique (batch_id, sheet, row_number)
);
select mudar_app.make_business_table('staged_row', false);
create index on mudar.staged_row(batch_id, status);

-- ---------------------------------------------------------------- exception queue
create table mudar.import_exception (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references mudar.import_batch(id) on delete cascade,
  staged_row_id uuid references mudar.staged_row(id) on delete cascade,
  sheet text,
  locator text,
  kind text not null,                          -- unknown_schema, missing_required, type_error, fractional_tenure, size_boundary, ...
  severity text not null default 'review' check (severity in ('info','review','blocking')),
  message text not null,
  details jsonb not null default '{}',
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution_note text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz
);
select mudar_app.make_business_table('import_exception');
create index on mudar.import_exception(batch_id, status);
create index on mudar.import_exception(workspace_id, status, kind);

-- ---------------------------------------------------------------- identity match candidates (review queue)
create table mudar.identity_match_candidate (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references mudar.import_batch(id) on delete set null,
  entity_type text not null check (entity_type in ('organisation','asset','person','geography')),
  left_id uuid not null,                       -- existing master
  right_id uuid,                               -- newly created master (kept separate until decided)
  right_raw jsonb not null default '{}',
  score numeric(5,4) not null,
  evidence jsonb not null default '{}',
  suggested text,                              -- link | review | relate_group | separate
  decision text not null default 'pending' check (decision in
    ('pending','auto_linked','merge_proposed','related','kept_separate')),
  change_proposal_id uuid references mudar.change_proposal(id),
  decided_by uuid references auth.users(id),
  decided_at timestamptz
);
select mudar_app.make_business_table('identity_match_candidate');
create index on mudar.identity_match_candidate(workspace_id, decision);
create unique index identity_match_pair_uq on mudar.identity_match_candidate(workspace_id, entity_type, left_id, right_id) where right_id is not null;

-- ---------------------------------------------------------------- natural-key index (idempotent re-import across versions)
create table mudar.import_entity_key (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  natural_key text not null,
  entity_id uuid not null,
  first_source_object_id uuid references mudar.source_object(id) on delete set null
);
select mudar_app.make_business_table('import_entity_key', false);
create unique index import_entity_key_uq on mudar.import_entity_key(workspace_id, entity_type, natural_key);
create index on mudar.import_entity_key(entity_type, entity_id);

-- ---------------------------------------------------------------- building observations (one building master, many source observations)
create table mudar.asset_observation (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references mudar.asset(id) on delete cascade,
  source_object_id uuid not null references mudar.source_object(id) on delete cascade,
  staged_row_id uuid,
  locator text not null,
  source_tab_label text,                       -- e.g. "existing", "upcoming_inventory_label", "ready_snapshot"
  building_name_raw text,
  locality_raw text,
  floor_size_text text,
  floor_size_min_sf numeric(12,2),
  floor_size_max_sf numeric(12,2),
  total_area_sf numeric(14,2),                 -- null = unknown
  total_area_source_zero boolean not null default false,
  floors_text text,
  status_raw text,
  transactions_count int,
  avg_rent numeric(10,2),
  rent_basis text,                             -- unknown unless the source states it
  as_of date,
  fact_status mudar.fact_status not null default 'historical_observed',
  extras jsonb not null default '{}'
);
select mudar_app.make_business_table('asset_observation', false);
create unique index asset_observation_src_uq on mudar.asset_observation(source_object_id, locator);
create index on mudar.asset_observation(asset_id);

notify pgrst, 'reload schema';
