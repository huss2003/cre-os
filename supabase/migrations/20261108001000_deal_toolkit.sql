-- Module 8: Deal Toolkit. Reuses requirement, quote (versioned), finance_scenario (fin-1.0), document_version.
-- One table for every workbench analysis + immutable versions (inputs, outputs, formula version) so any past
-- analysis is reproducible even after formulas change.
create table if not exists mudar.deal_analysis (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('brief','property_comparison','lease_economics','occupancy','conventional_vs_managed','renewal_vs_relocation','fitout','financing','negotiation','deliverable')),
  title text not null,
  org_id uuid references mudar.organisation(id),
  requirement_id uuid references mudar.requirement(id),
  opportunity_id uuid references mudar.opportunity(id),
  asset_ids uuid[] not null default '{}',
  quote_refs jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft','needs_info','ready','approved','archived')),
  current_version int not null default 0,
  inputs jsonb not null default '{}',
  outputs jsonb not null default '{}',
  formula_version text,
  missing jsonb not null default '[]',
  approved_by uuid references auth.users(id), approved_at timestamptz
);
select mudar_app.make_business_table('deal_analysis');
create index if not exists deal_analysis_kind on mudar.deal_analysis(workspace_id, kind, updated_at desc);
create index if not exists deal_analysis_req on mudar.deal_analysis(workspace_id, requirement_id);

create table if not exists mudar.deal_analysis_version (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references mudar.deal_analysis(id) on delete cascade,
  version int not null,
  inputs jsonb not null, outputs jsonb not null, formula_version text not null,
  note text
);
select mudar_app.make_business_table('deal_analysis_version', false);
create unique index if not exists deal_analysis_version_uq on mudar.deal_analysis_version(analysis_id, version);
create or replace function mudar_app.deal_analysis_version_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.inputs is distinct from old.inputs or new.outputs is distinct from old.outputs or new.formula_version is distinct from old.formula_version or new.version <> old.version) then
    raise exception 'analysis versions are immutable';
  end if;
  return new;
end $$;
drop trigger if exists deal_analysis_version_immutable on mudar.deal_analysis_version;
create trigger deal_analysis_version_immutable before update on mudar.deal_analysis_version for each row execute function mudar_app.deal_analysis_version_immutable();

-- Configurable property-rating models (weights, mandatory and disqualifying conditions), versioned.
create table if not exists mudar.property_rating_model (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version int not null default 1,
  is_default boolean not null default false,
  factors jsonb not null,          -- [{key,label,weight}] weights sum to 100
  rules jsonb not null default '[]' -- [{kind:'mandatory'|'disqualify', field, op, value, label}]
);
select mudar_app.make_business_table('property_rating_model');
