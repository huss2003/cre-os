-- Module 2 — Signal Engine. Reuses signal_claim (evidence atoms), research_source_registry (sources), task (actions),
-- lease_event (lease signals), change_proposal (opportunity proposals) and audit_event (via make_business_table trigger).
-- Adds only: signal (the grouped, reviewable event), signal_evidence (support / counter evidence links),
-- signal_review (append-only decision history). Re-runnable: drops only its own objects.

drop table if exists mudar.signal_review cascade;
drop table if exists mudar.signal_evidence cascade;
drop table if exists mudar.signal cascade;

create table mudar.signal (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('expansion','restructuring','lease','commercial','leadership','infrastructure','macro')),
  kind text not null,                       -- e.g. pune_expansion, gcc_plan, lease_expiry, lockin_end, job_move
  title text not null,
  summary text,                             -- what happened (traceable to evidence)
  cre_relevance text,                       -- why it could matter (labelled inference)
  org_id uuid references mudar.organisation(id),
  person_id uuid references mudar.person(id),
  asset_id uuid references mudar.asset(id),
  lease_id uuid references mudar.lease(id),
  lease_event_id uuid references mudar.lease_event(id),
  entity_name_raw text,                     -- name as found in the source when unresolved
  location_text text,
  event_date date,
  event_date_basis text,                    -- contractual / reported / estimated / unknown
  detected_at timestamptz not null default now(),
  latest_evidence_on date,
  verification text not null default 'hypothesis' check (verification in ('fact','inference','hypothesis','unknown')),
  confidence text not null default 'low' check (confidence in ('high','medium','low','insufficient')),
  confidence_reasons text[] not null default '{}',
  processing_status text not null default 'review_required' check (processing_status in
    ('discovered','retrieved','parsed','normalised','duplicate','entity_unresolved','evidence_extracted','signal_candidate',
     'assessment_pending','review_required','approved','rejected','converted_to_action','archived','failed')),
  status text not null default 'new' check (status in ('new','reviewing','approved','rejected','dismissed','snoozed','known','converted')),
  snoozed_until date,
  status_reason text,
  priority int not null default 0 check (priority between 0 and 100),
  priority_band text not null default 'low' check (priority_band in ('high','medium','low')),
  priority_reasons text[] not null default '{}',
  priority_override jsonb,                  -- {band, reason, user_id, at, review_on}
  recommended_action text,
  action_kind text,                         -- research / contact_verification / lease_event_verification / ...
  missing_info text[] not null default '{}',
  context_json jsonb not null default '{}', -- snapshot of Module 1 context used for the assessment
  assigned_user_id uuid references auth.users(id),
  opportunity_id uuid references mudar.opportunity(id),
  task_id uuid references mudar.task(id),
  dedupe_key text not null,
  rule_version text not null default 'signals-1'
);
select mudar_app.make_business_table('signal');
create unique index signal_dedupe_uq on mudar.signal(workspace_id, dedupe_key);
create index on mudar.signal(workspace_id, status, priority desc);
create index on mudar.signal(workspace_id, category);
create index on mudar.signal(org_id);

create table mudar.signal_evidence (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references mudar.signal(id) on delete cascade,
  role text not null default 'support' check (role in ('support','counter','context')),
  signal_claim_id uuid references mudar.signal_claim(id),
  lease_event_id uuid references mudar.lease_event(id),
  source_object_id uuid,
  source_name text,
  source_url text,
  excerpt text,
  evidence_tier text,
  fact_status text,                         -- reported / currently_confirmed / ai_inference / unknown
  published_on date,
  note text,
  dedupe_key text not null
);
select mudar_app.make_business_table('signal_evidence');
create unique index signal_evidence_uq on mudar.signal_evidence(workspace_id, signal_id, dedupe_key);

create table mudar.signal_review (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references mudar.signal(id) on delete cascade,
  action text not null,
  from_status text, to_status text,
  reason text,
  data jsonb not null default '{}',
  actor_user_id uuid references auth.users(id)
);
select mudar_app.make_business_table('signal_review');
create index on mudar.signal_review(signal_id, created_at);

-- Source registry: reuse research_source_registry; add pause + sync visibility.
alter table mudar.research_source_registry add column if not exists paused boolean not null default false;
alter table mudar.research_source_registry add column if not exists last_sync_at timestamptz;
alter table mudar.research_source_registry add column if not exists last_sync_status text;
alter table mudar.research_source_registry add column if not exists last_error text;

notify pgrst, 'reload schema';
