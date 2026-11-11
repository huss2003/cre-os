-- Module 13 Intelligence Layer — historical & change memory, recommendations, lifecycle corrections.
-- Owner: intelligence memory (changes/consolidate/recommend/quality/integrate). Re-runnable; mudar schema only.
-- No SECURITY DEFINER functions are created here (nothing to revoke). RLS via make_business_table (audited).

-- ---------------------------------------------------------------- memory_change (§6.1 / §6.2)
-- One row per detected change. Previous and latest values are both kept; nothing canonical is rewritten.
create table if not exists mudar.memory_change (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,                         -- idempotency: <kind>:<entity>:<field>:<source version/ids>
  change_kind text not null check (change_kind in (
    'employer_change','promotion','designation_change','office_location_change','expansion','reduction',
    'rent_change','cam_change','inventory_change','lease_expiry_approaching','requirement_area_change',
    'requirement_budget_change','requirement_location_change','requirement_timeline_change','requirement_other_change',
    'decision_maker_change','opportunity_inactive','rejected_property_relevant')),
  entity_type text not null,                        -- person | organisation | asset | space | requirement | opportunity | lease
  entity_id uuid not null,
  field text,
  previous_value jsonb,                             -- null = unknown / not recorded (never coerced)
  latest_value jsonb,
  difference jsonb not null default '{}'::jsonb,    -- {delta, pct, added, removed, text}
  changed_at timestamptz,                           -- when the change happened (source date), null = unknown
  source_ref jsonb not null default '{}'::jsonb,    -- {type,id,label,href}
  verification text not null default 'unverified' check (verification in ('verified','reported','estimated','inferred','unverified','unknown')),
  affected_records jsonb not null default '[]'::jsonb,       -- [{type,id,label}]
  affected_opportunity_ids uuid[] not null default '{}',
  modules text[] not null default '{}',             -- downstream modules to notify
  material boolean not null default false,
  impact jsonb not null default '{}'::jsonb,        -- change impact analysis (§6.3)
  state text not null default 'open' check (state in ('open','acknowledged','dismissed')),
  notified_at timestamptz
);
select mudar_app.make_business_table('memory_change')
 where not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'memory_change');
create unique index if not exists memory_change_key_uq on mudar.memory_change(workspace_id, dedupe_key);
create index if not exists memory_change_entity_idx on mudar.memory_change(workspace_id, entity_type, entity_id, created_at desc);
create index if not exists memory_change_open_idx on mudar.memory_change(workspace_id, change_kind) where state = 'open';

-- ---------------------------------------------------------------- memory_recommendation (§9)
-- Persisted recommendations (emitted on events). Never executed automatically; the user acts or dismisses.
create table if not exists mudar.memory_recommendation (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  kind text not null,
  entity_type text,
  entity_id uuid,
  title text not null,                              -- what was identified
  why text not null,                                -- why it matters
  supporting jsonb not null default '[]'::jsonb,    -- supporting information lines
  source_refs jsonb not null default '[]'::jsonb,   -- [{type,id,label,href}]
  confidence text not null check (confidence in ('high','medium','low')),
  next_action text not null,
  href text,
  change_id uuid references mudar.memory_change(id) on delete set null,
  state text not null default 'open' check (state in ('open','done','dismissed')),
  decided_at timestamptz
);
select mudar_app.make_business_table('memory_recommendation')
 where not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'memory_recommendation');
create unique index if not exists memory_recommendation_key_uq on mudar.memory_recommendation(workspace_id, dedupe_key);
create index if not exists memory_recommendation_open_idx on mudar.memory_recommendation(workspace_id, created_at desc) where state = 'open';

-- ---------------------------------------------------------------- memory_lifecycle (§13 manual corrections)
-- Append-only: each correction is a new row (the audit trigger records it); the latest row per item wins.
create table if not exists mudar.memory_lifecycle (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  category text not null,
  item_key text not null,                           -- stable key of the memory item (e.g. "employment:<id>")
  status text not null check (status in ('current','historical','superseded','unverified','conflicting')),
  previous_status text,
  note text not null,
  corrected_by uuid
);
select mudar_app.make_business_table('memory_lifecycle')
 where not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'memory_lifecycle');
create index if not exists memory_lifecycle_item_idx on mudar.memory_lifecycle(workspace_id, entity_type, entity_id, item_key, created_at desc);
