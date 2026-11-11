-- Capture: one drop zone for any file (PDF, DOCX, images, spreadsheets, audio) + recording transcripts.
-- Owner: capture module. Re-runnable (drops only its own objects).

-- ---------------------------------------------------------------- capture_document: one row per uploaded file (idempotent on sha256)
create table if not exists mudar.capture_document (
  id uuid primary key default gen_random_uuid(),
  sha256 text not null,
  file_name text not null,
  mime text,
  size_bytes bigint not null default 0,
  storage_path text,                                   -- original file, always preserved
  detected_type text not null default 'unknown'
    check (detected_type in ('quotation','lease','loi','meeting_notes','business_card','property_photo','layout','spreadsheet','audio','unknown')),
  detection jsonb not null default '{}'::jsonb,        -- {method: rules|model|user, confidence, signals[]}
  status text not null default 'received'
    check (status in ('received','processing','needs_review','done','failed','unsupported','needs_input')),
  error text,
  links jsonb not null default '{}'::jsonb,            -- {organisation_id, person_id, asset_id, requirement_id, meeting_prep_id}
  result jsonb not null default '{}'::jsonb,           -- {proposal_ids[], capture_id, quote_intake_id, import_batch_id, card, terms, attachments}
  page_count integer,
  idempotency_key text
);
select mudar_app.make_business_table('capture_document')
 where not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'capture_document');
create unique index if not exists capture_document_ws_sha_uq on mudar.capture_document(workspace_id, sha256) where archived_at is null;
create index if not exists capture_document_status_idx on mudar.capture_document(workspace_id, status, created_at desc);

-- ---------------------------------------------------------------- capture_transcript: recording transcripts (timestamps when the provider returns them)
create table if not exists mudar.capture_transcript (
  id uuid primary key default gen_random_uuid(),
  capture_document_id uuid references mudar.capture_document(id) on delete cascade,
  meeting_prep_id uuid references mudar.meeting_prep(id) on delete set null,
  language text,                                        -- en | hi | hinglish | null (unknown)
  text text not null,
  -- [{start: seconds|null, end: seconds|null, text, speaker: null, speaker_certain: false}]
  segments jsonb not null default '[]'::jsonb,
  has_timestamps boolean not null default false,
  diarised boolean not null default false,              -- false => speaker attribution is uncertain
  model text,
  mocked boolean not null default false,
  consent_reference text
);
select mudar_app.make_business_table('capture_transcript')
 where not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'capture_transcript');
create unique index if not exists capture_transcript_doc_uq on mudar.capture_transcript(capture_document_id) where archived_at is null;
create index if not exists capture_transcript_meeting_idx on mudar.capture_transcript(workspace_id, meeting_prep_id);
