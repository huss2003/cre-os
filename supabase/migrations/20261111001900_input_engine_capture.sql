-- Module 10 Input Engine (capture module): structured observations with fact class, source traceability,
-- conflict / repeat detection, and an append-only history of user corrections.
-- Owner: capture module. Re-runnable (creates only its own objects; no SECURITY DEFINER functions).

-- ---------------------------------------------------------------- capture_observation
-- One row per extracted item (fact, commercial term, task, commitment, preference, hypothesis, objection, signal).
-- Previous values are never overwritten: a different value for the same subject+field is a NEW row
-- (version+1, conflict_with -> the earlier row). Raw wording is always kept next to the normalised value.
create table if not exists mudar.capture_observation (
  id uuid primary key default gen_random_uuid(),
  obs_key text not null,                                 -- idempotency: cap:<capture>:<kind>:<n> | doc:<document>:term:<n>
  capture_id uuid references mudar.capture(id) on delete cascade,
  capture_document_id uuid references mudar.capture_document(id) on delete cascade,
  intent text not null,                                  -- §4.4 category
  fact_class text not null check (fact_class in ('confirmed','estimate','assumption','hypothesis','commitment','task','preference')),
  field text not null,                                   -- area | budget | rent_psf | cam | lock_in | occupation_target | task | ...
  raw_text text not null,                                -- original wording (never rewritten)
  value_json jsonb,                                      -- normalised value; null = unknown (never coerced to 0)
  unit text,                                             -- null = unknown
  pricing_basis text,                                    -- per_sf_month | per_seat_month | total_month | null (unknown)
  area_basis text check (area_basis is null or area_basis in ('carpet','chargeable','super_built_up','unknown')),
  cam_treatment text check (cam_treatment is null or cam_treatment in ('included','extra','unknown')),
  date_class text check (date_class is null or date_class in ('confirmed','estimated','informal')),
  missing text[] not null default '{}',                  -- e.g. {unit,pricing_basis,cam}
  subject_type text,                                     -- requirement | organisation | person | asset | quote | task
  subject_id uuid,
  links jsonb not null default '[]'::jsonb,              -- [{type,id,label,confidence: high|medium|low|none}]
  match_confidence text check (match_confidence is null or match_confidence in ('high','medium','low','none')),
  confidence numeric,                                    -- extraction confidence 0..1 where applicable
  source_type text not null,                             -- typed_note | voice_note | image | business_card | document | recording | spreadsheet
  source_ref jsonb not null default '{}'::jsonb,         -- {locator, page, timestamp, start, end, sheet, cell, file_name}
  source_hash text not null,                             -- hash of the underlying source content (repeat detection)
  content_hash text not null,                            -- hash of field + normalised value (+ subject)
  observed_at timestamptz not null,
  extracted_at timestamptz not null default now(),
  verification text not null default 'unverified'
    check (verification in ('unverified','user_stated','page_verified','user_confirmed','needs_clarification','rejected')),
  independent boolean not null default true,             -- false = repeat of the same underlying source
  repeat_of uuid references mudar.capture_observation(id) on delete set null,
  corroborates uuid references mudar.capture_observation(id) on delete set null,
  conflict_with uuid references mudar.capture_observation(id) on delete set null,
  version integer not null default 1,                    -- per subject+field
  review_category text check (review_category is null or review_category in (
    'uncertain_company_match','uncertain_contact_match','potential_duplicate','conflicting_commercial_value',
    'missing_units_or_dates','unverified_lease_details','material_change_approval')),
  status text not null default 'pending_review'
    check (status in ('auto_saved','pending_review','confirmed','rejected','corrected')),
  proposal_id uuid references mudar.change_proposal(id) on delete set null,
  task_id uuid references mudar.task(id) on delete set null
);
select mudar_app.make_business_table('capture_observation')
 where not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'capture_observation');
create unique index if not exists capture_observation_key_uq on mudar.capture_observation(workspace_id, obs_key);
create index if not exists capture_observation_subject_idx on mudar.capture_observation(workspace_id, subject_type, subject_id, field, created_at desc);
create index if not exists capture_observation_capture_idx on mudar.capture_observation(workspace_id, capture_id);
create index if not exists capture_observation_doc_idx on mudar.capture_observation(workspace_id, capture_document_id);
create index if not exists capture_observation_review_idx on mudar.capture_observation(workspace_id, review_category) where review_category is not null and status = 'pending_review';
create index if not exists capture_observation_content_idx on mudar.capture_observation(workspace_id, content_hash);

-- ---------------------------------------------------------------- capture_correction (append-only)
create table if not exists mudar.capture_correction (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid references mudar.capture(id) on delete cascade,
  observation_id uuid references mudar.capture_observation(id) on delete cascade,
  target text not null,                                  -- value | transcript | association | status
  before jsonb,
  after jsonb,
  note text,
  corrected_by uuid
);
select mudar_app.make_business_table('capture_correction')
 where not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'capture_correction');
create index if not exists capture_correction_capture_idx on mudar.capture_correction(workspace_id, capture_id, created_at desc);
create index if not exists capture_correction_obs_idx on mudar.capture_correction(workspace_id, observation_id, created_at desc);
-- history is never edited or removed by app roles
revoke update, delete, truncate on mudar.capture_correction from authenticated, anon;

-- capture_document: PPT/PPTX/DOC (legacy office) are first-class families now (detection unchanged).
