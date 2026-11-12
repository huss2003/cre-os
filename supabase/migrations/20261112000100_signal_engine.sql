-- Module 2 — Signal Engine v2 (docs/signal-engine/SPEC.md). Extends 20261108000100_signal_engine.sql; backward compatible.
-- Adds: per-source-item pipeline (signal_source_item), sync runs (source_sync_run), versioned rules (signal_rule_version),
-- assessment history (signal_assessment); new signal / signal_evidence / registry columns. Idempotent, non-destructive:
-- IF NOT EXISTS + guarded DO blocks only. No new SECURITY DEFINER functions.

-- ---------------------------------------------------------------- signal: grouping, labels, derived fields
alter table mudar.signal add column if not exists sub_type text;
alter table mudar.signal add column if not exists derived jsonb not null default '{}';
alter table mudar.signal add column if not exists labels jsonb not null default '{}';
alter table mudar.signal add column if not exists independent_evidence_count int not null default 0;
alter table mudar.signal add column if not exists contradictory_count int not null default 0;
alter table mudar.signal add column if not exists last_confirmed_on date;
alter table mudar.signal add column if not exists entity_candidates jsonb not null default '[]';
alter table mudar.signal add column if not exists entity_resolution jsonb;
alter table mudar.signal add column if not exists priority_review_on date;
alter table mudar.signal add column if not exists contextual_summary text;
alter table mudar.signal add column if not exists source_names text[] not null default '{}';
alter table mudar.signal add column if not exists micro_market text;
alter table mudar.signal add column if not exists rule_version_id uuid;
create index if not exists signal_sub_type_idx on mudar.signal(workspace_id, sub_type);
create index if not exists signal_source_names_idx on mudar.signal using gin (source_names);

alter table mudar.signal_evidence add column if not exists independence_key text;
alter table mudar.signal_evidence add column if not exists source_item_id uuid;
alter table mudar.signal_evidence add column if not exists label text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'signal_evidence_label_chk' and conrelid = 'mudar.signal_evidence'::regclass) then
    alter table mudar.signal_evidence add constraint signal_evidence_label_chk check (label is null or label in ('fact','inference','hypothesis','unknown'));
  end if;
end $$;

-- ---------------------------------------------------------------- source registry (reuses research_source_registry)
alter table mudar.research_source_registry add column if not exists adapter text;
alter table mudar.research_source_registry add column if not exists permission_status text not null default 'permitted';
alter table mudar.research_source_registry add column if not exists permitted_purposes text[] not null default '{signal_detection}';
alter table mudar.research_source_registry add column if not exists retention_days int;
alter table mudar.research_source_registry add column if not exists connection_status text not null default 'connected';
alter table mudar.research_source_registry add column if not exists usage_count int not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rsr_permission_status_chk' and conrelid = 'mudar.research_source_registry'::regclass) then
    alter table mudar.research_source_registry add constraint rsr_permission_status_chk check (permission_status in ('permitted','pending','denied','unavailable'));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rsr_connection_status_chk' and conrelid = 'mudar.research_source_registry'::regclass) then
    alter table mudar.research_source_registry add constraint rsr_connection_status_chk check (connection_status in ('connected','paused','unavailable','error','needs_access'));
  end if;
end $$;
create unique index if not exists rsr_adapter_uq on mudar.research_source_registry(workspace_id, adapter) where adapter is not null and archived_at is null;

-- ---------------------------------------------------------------- new tables (own objects only)

create table if not exists mudar.source_sync_run (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid references mudar.research_source_registry(id) on delete set null,
  adapter text not null,
  trigger text not null default 'manual' check (trigger in ('manual','scheduled','event','retry')),
  status text not null default 'running' check (status in ('running','done','partial','failed','skipped')),
  org_id uuid references mudar.organisation(id) on delete set null,
  items_seen int not null default 0,
  items_new int not null default 0,
  items_failed int not null default 0,
  error text,
  dedupe_key text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'source_sync_run') then perform mudar_app.make_business_table('source_sync_run'); end if; end $$;
create unique index if not exists source_sync_run_dedupe_uq on mudar.source_sync_run(workspace_id, dedupe_key) where dedupe_key is not null;

create table if not exists mudar.signal_source_item (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid references mudar.research_source_registry(id) on delete set null,
  sync_run_id uuid references mudar.source_sync_run(id) on delete set null,
  adapter text not null,
  idempotency_key text not null,
  status text not null default 'discovered' check (status in
    ('discovered','retrieved','parsed','normalised','duplicate','entity_unresolved','evidence_extracted','signal_candidate',
     'assessment_pending','review_required','approved','rejected','converted_to_action','archived','failed')),
  status_history jsonb not null default '[]',
  source_object_id uuid references mudar.source_object(id) on delete set null,
  capture_id uuid,
  title text,
  source_name text,
  url text,
  published_on date,
  raw_text text,                -- original material (untrusted evidence, never executed)
  content_hash text,
  parsed jsonb not null default '{}',
  resolution jsonb,
  signal_ids uuid[] not null default '{}',
  duplicate_of uuid references mudar.signal_source_item(id) on delete set null,
  error text,
  attempts int not null default 0
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'signal_source_item') then perform mudar_app.make_business_table('signal_source_item'); end if; end $$;
create unique index if not exists signal_source_item_idem_uq on mudar.signal_source_item(workspace_id, idempotency_key);
create index if not exists signal_source_item_status_idx on mudar.signal_source_item(workspace_id, status);
create index if not exists signal_source_item_hash_idx on mudar.signal_source_item(workspace_id, content_hash);

create table if not exists mudar.signal_rule_version (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  version text not null,
  rules jsonb not null default '{}',
  active boolean not null default false,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'signal_rule_version') then perform mudar_app.make_workspace_table('signal_rule_version', 'admin'); end if; end $$;
create unique index if not exists signal_rule_version_uq on mudar.signal_rule_version(workspace_id, version);
create unique index if not exists signal_rule_version_active_uq on mudar.signal_rule_version(workspace_id) where active;

create table if not exists mudar.signal_assessment (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references mudar.signal(id) on delete cascade,
  rule_version text not null,
  confidence text not null,
  priority int not null,
  priority_band text not null,
  reasons jsonb not null default '{}',
  derived jsonb not null default '{}',
  fingerprint text not null
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'signal_assessment') then perform mudar_app.make_business_table('signal_assessment'); end if; end $$;
create index if not exists signal_assessment_sig_idx on mudar.signal_assessment(signal_id, created_at);

notify pgrst, 'reload schema';
