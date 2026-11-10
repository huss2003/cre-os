-- Module 8 extras: evidence attachments on deal analyses + quotation intake drafts. Re-runnable.
create table if not exists mudar.deal_evidence (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references mudar.deal_analysis(id) on delete cascade,
  kind text not null default 'other' check (kind in ('quote','brochure','floor_plan','photo','email','note','other')),
  title text not null,
  storage_path text,
  url text,
  source_date date,
  verification text not null default 'unverified' check (verification in ('verified','unverified','conflicting')),
  note text
);
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'deal_evidence_touch') then perform mudar_app.make_business_table('deal_evidence'); end if;
end $$;
create index if not exists deal_evidence_analysis on mudar.deal_evidence(workspace_id, analysis_id);

-- Quote intake: uploaded/pasted quote text + AI (or mock) extraction, reviewed by a user before it becomes a quote version.
create table if not exists mudar.quote_intake (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid references mudar.requirement(id),
  quote_id uuid references mudar.quote(id),            -- latest existing version being compared against (nullable = new quote)
  party_kind text not null default 'landlord' check (party_kind in ('landlord','managed_operator','fitout_partner','other')),
  storage_path text,
  file_name text,
  source_text text not null default '',
  extracted jsonb not null default '{}',
  extraction_model text,
  notes jsonb not null default '[]',
  status text not null default 'review' check (status in ('review','saved','proposed','discarded')),
  result_quote_id uuid references mudar.quote(id),
  change_proposal_id uuid
);
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'quote_intake_touch') then perform mudar_app.make_business_table('quote_intake'); end if;
end $$;
create index if not exists quote_intake_ws on mudar.quote_intake(workspace_id, updated_at desc);
alter table mudar.quote_intake add column if not exists space_id uuid references mudar.space(id);  -- building/space for a NEW quote
