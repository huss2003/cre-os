-- Module 14 — Property Supply and Matching (docs/integration/MASTER-SPEC.md, docs/property-supply/CONTRACT.md).
-- Additive, idempotent, non-destructive: IF NOT EXISTS + guarded DO blocks (pg_constraint/pg_policies). No SECURITY DEFINER functions, no triggers of its own (make_business_table adds the
-- standard RLS/audit/row_version machinery).

-- ---------------------------------------------------------------- A/B. hierarchy + categories
alter table mudar.asset add column if not exists category text;
alter table mudar.asset add column if not exists property_manager_org_id uuid references mudar.organisation(id) on delete set null;
-- Categories are configurable per tenant (workspace_setting 'supply.categories'); only shape is checked here.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'asset_category_chk' and conrelid = 'mudar.asset'::regclass) then
    alter table mudar.asset add constraint asset_category_chk check (category is null or category ~ '^[a-z][a-z0-9_]{1,40}$') not valid;
  end if;
end $$;
create index if not exists asset_category_idx on mudar.asset(workspace_id, category);

alter table mudar.space add column if not exists divisible boolean;              -- null = unknown
alter table mudar.space add column if not exists min_divisible_sf numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'space_divisible_chk' and conrelid = 'mudar.space'::regclass) then
    alter table mudar.space add constraint space_divisible_chk check (min_divisible_sf is null or min_divisible_sf > 0) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------- C/D/E. supply info, commercial terms, statuses
alter table mudar.availability add column if not exists supply_status text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'availability_supply_status_chk' and conrelid = 'mudar.availability'::regclass) then
    alter table mudar.availability add constraint availability_supply_status_chk check (supply_status is null or supply_status in (
  'immediately_available','future_available','under_negotiation','tentatively_held','under_offer','occupied','unconfirmed','withdrawn','leased')) not valid;
  end if;
end $$;
alter table mudar.availability add column if not exists last_verified_on date;       -- null = never verified
alter table mudar.availability add column if not exists source_label text;           -- e.g. "landlord email", "broker list"
alter table mudar.availability add column if not exists possession_conditions text;
alter table mudar.availability add column if not exists furnishing text;
alter table mudar.availability add column if not exists area_type text;
alter table mudar.availability add column if not exists lockin_months numeric;
alter table mudar.availability add column if not exists lease_term_months numeric;
alter table mudar.availability add column if not exists parking_charge_month numeric;
alter table mudar.availability add column if not exists fitout_cost_psf numeric;
alter table mudar.availability add column if not exists brokerage_terms text;
alter table mudar.availability add column if not exists other_charges jsonb;          -- [{label, amount, basis}]
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'availability_supply_terms_chk' and conrelid = 'mudar.availability'::regclass) then
    alter table mudar.availability add constraint availability_supply_terms_chk check (
  (lockin_months is null or lockin_months >= 0) and (lease_term_months is null or lease_term_months > 0)
  and (parking_charge_month is null or parking_charge_month >= 0) and (fitout_cost_psf is null or fitout_cost_psf >= 0)
  and (area_type is null or area_type in ('carpet','chargeable','super_built_up','built_up','seats'))
  and (furnishing is null or furnishing in ('bare','warm_shell','semi_furnished','fully_furnished','plug_and_play'))) not valid;
  end if;
end $$;
create index if not exists availability_supply_status_idx on mudar.availability(workspace_id, supply_status);

-- ---------------------------------------------------------------- F. operator intelligence
create table if not exists mudar.operator_centre (
  id uuid primary key default gen_random_uuid(),
  operator_org_id uuid references mudar.organisation(id) on delete set null,
  operator_name text not null,
  centre_name text not null,
  category text not null default 'managed_office' check (category in ('managed_office','coworking')),
  asset_id uuid references mudar.asset(id) on delete set null,
  locality_id uuid references mudar.geography(id) on delete set null,
  micro_market_id uuid references mudar.geography(id) on delete set null,
  capacity_seats int check (capacity_seats is null or capacity_seats >= 0),
  seats_available int check (seats_available is null or seats_available >= 0),
  private_offices int check (private_offices is null or private_offices >= 0),
  price_per_seat_min numeric check (price_per_seat_min is null or price_per_seat_min >= 0),
  price_per_seat_max numeric check (price_per_seat_max is null or price_per_seat_max >= 0),
  pricing_notes text,
  services text[] not null default '{}',
  amenities text[] not null default '{}',
  contract_terms jsonb not null default '{}',     -- {min_term_months, lockin_months, notice_months, deposit_months, escalation_pct}
  additional_charges jsonb not null default '[]', -- [{label, amount, basis}]
  brokerage_conditions text,
  source_label text,
  source_object_id uuid references mudar.source_object(id) on delete set null,
  last_verified_on date,
  fact_status mudar.fact_status not null default 'reported'
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'operator_centre') then perform mudar_app.make_business_table('operator_centre'); end if; end $$;
create index if not exists operator_centre_ws_idx on mudar.operator_centre(workspace_id, operator_name);

-- ---------------------------------------------------------------- I. shortlist feedback / rejection reasons
create table if not exists mudar.shortlist_feedback (
  id uuid primary key default gen_random_uuid(),
  shortlist_option_id uuid not null references mudar.shortlist_option(id) on delete cascade,
  requirement_id uuid references mudar.requirement(id) on delete cascade,
  kind text not null check (kind in ('client_feedback','rejection')),
  reason_code text check (reason_code is null or reason_code in ('price','area','location','timing','specification','landlord','parking','availability','other')),
  comment text,
  sentiment text check (sentiment is null or sentiment in ('positive','neutral','negative'))
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'shortlist_feedback') then perform mudar_app.make_business_table('shortlist_feedback'); end if; end $$;
create index if not exists shortlist_feedback_opt_idx on mudar.shortlist_feedback(workspace_id, shortlist_option_id);
