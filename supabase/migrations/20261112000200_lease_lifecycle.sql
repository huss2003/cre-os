-- Module 15 — Lease Lifecycle Management (docs/lease-lifecycle/SPEC.md, CONTRACT.md, GAP.md).
-- Extends mudar.lease with nullable columns (no existing semantics change; `status` stays the import/radar status,
-- the 14-step lifecycle lives in `lifecycle_status`). New tables use make_business_table (RLS + audit).
-- Idempotent and non-destructive: IF NOT EXISTS everywhere, guarded DO blocks for constraints/policies/triggers. No SECURITY DEFINER functions.

alter table mudar.lease add column if not exists reference text;
alter table mudar.lease add column if not exists category text not null default 'conventional_office';
alter table mudar.lease add column if not exists lifecycle_status text not null default 'draft';
alter table mudar.lease add column if not exists floor text;
alter table mudar.lease add column if not exists unit text;
alter table mudar.lease add column if not exists micro_market text;
alter table mudar.lease add column if not exists execution_date date;
alter table mudar.lease add column if not exists possession_date date;
alter table mudar.lease add column if not exists rent_commencement_date date;
alter table mudar.lease add column if not exists renewal_status text;
alter table mudar.lease add column if not exists termination_status text;
alter table mudar.lease add column if not exists transaction_id uuid;
alter table mudar.lease add column if not exists assigned_user_id uuid references auth.users(id);
alter table mudar.lease add column if not exists contact_person_ids uuid[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lease_category_chk' and conrelid = 'mudar.lease'::regclass) then
    alter table mudar.lease add constraint lease_category_chk check (category in
  ('conventional_office','managed_office','coworking','commercial_office','retail','industrial_warehouse','other'));
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lease_lifecycle_status_chk' and conrelid = 'mudar.lease'::regclass) then
    alter table mudar.lease add constraint lease_lifecycle_status_chk check (lifecycle_status in
  ('draft','under_negotiation','awaiting_approval','awaiting_execution','executed','active','renewal_under_discussion',
   'renewal_agreed','termination_notice_served','expiring','expired','terminated','surrendered','closed'));
  end if;
end $$;
create unique index if not exists lease_transaction_uq on mudar.lease(workspace_id, transaction_id) where transaction_id is not null and archived_at is null;
create index if not exists lease_lifecycle_idx on mudar.lease(workspace_id, lifecycle_status);


create table if not exists mudar.lease_document (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  title text not null,
  doc_type text not null check (doc_type in ('loi','term_sheet','lease_agreement','leave_and_licence','mou','commercial_proposal',
    'rent_quotation','lease_amendment','renewal_agreement','termination_notice','handover','possession','security_deposit','other')),
  execution_state text not null check (execution_state in ('draft','unsigned_proposal','signed','executed','superseded','amendment','supporting')),
  version int not null default 1,
  supersedes_id uuid references mudar.lease_document(id) on delete set null,
  pages jsonb not null default '[]',
  extracted jsonb not null default '{}',
  extraction_source text,
  source_object_id uuid,
  storage_path text,
  content_sha text,
  uploaded_by uuid references auth.users(id)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_document') then perform mudar_app.make_business_table('lease_document'); end if; end $$;
create index if not exists lease_document_lease_idx on mudar.lease_document(lease_id);
create unique index if not exists lease_document_sha_uq on mudar.lease_document(lease_id, content_sha) where content_sha is not null and archived_at is null;

create table if not exists mudar.lease_term_version (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  version int not null,
  source text not null check (source in ('original','amendment','renewal','transaction','manual','extracted')),
  status text not null default 'proposed' check (status in ('proposed','current','superseded','rejected')),
  effective_from date,
  terms jsonb not null default '{}',
  document_id uuid references mudar.lease_document(id) on delete set null,
  note text,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  unique (lease_id, version)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_term_version') then perform mudar_app.make_business_table('lease_term_version'); end if; end $$;

create table if not exists mudar.lease_date (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  date_type text not null check (date_type in ('execution','possession','commencement','rent_commencement','rent_free_end','lockin_end',
    'escalation','renewal_option','renewal_notice_deadline','break_option','termination_notice_deadline','expiry',
    'deposit_refund_deadline','handover','other')),
  label text,
  calculated_date date,
  alternatives jsonb not null default '[]',
  method text,
  convention jsonb not null default '{}',
  clause_text text,
  document_id uuid references mudar.lease_document(id) on delete set null,
  page int,
  verification_status text not null default 'extracted' check (verification_status in ('extracted','calculated','needs_review','confirmed','conflicting')),
  review_reason text,
  origin text not null default 'extracted' check (origin in ('extracted','calculated','manual','transaction')),
  base_date_id uuid references mudar.lease_date(id) on delete set null,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  superseded_by uuid references mudar.lease_date(id) on delete set null,
  lease_event_id uuid,
  dedupe_key text
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_date') then perform mudar_app.make_business_table('lease_date'); end if; end $$;
create index if not exists lease_date_lease_idx on mudar.lease_date(lease_id, date_type);
create index if not exists lease_date_when_idx on mudar.lease_date(workspace_id, calculated_date) where archived_at is null;
create unique index if not exists lease_date_dedupe_uq on mudar.lease_date(workspace_id, dedupe_key) where dedupe_key is not null and archived_at is null;

create table if not exists mudar.lease_obligation (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  category text not null,
  description text not null,
  responsible text not null default 'unclear' check (responsible in ('tenant','landlord','shared','unclear')),
  deadline date,
  status text not null default 'open' check (status in ('open','in_progress','done','waived')),
  clause_text text,
  document_id uuid references mudar.lease_document(id) on delete set null,
  page int,
  assigned_user_id uuid references auth.users(id),
  evidence_note text,
  completed_at timestamptz,
  origin text not null default 'manual' check (origin in ('manual','extracted'))
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_obligation') then perform mudar_app.make_business_table('lease_obligation'); end if; end $$;
create index if not exists lease_obligation_lease_idx on mudar.lease_obligation(lease_id);

create table if not exists mudar.lease_status_history (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  from_status text,
  to_status text not null,
  evidence jsonb not null default '{}',
  note text,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_status_history') then perform mudar_app.make_business_table('lease_status_history'); end if; end $$;
create index if not exists lease_status_history_lease_idx on mudar.lease_status_history(lease_id, changed_at);

create table if not exists mudar.lease_renewal (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  stage text not null default 'upcoming' check (stage in ('upcoming','discussion','proposal_pending','negotiation','approval_pending','agreed','completed','at_risk','declined')),
  proposed_terms jsonb not null default '{}',
  landlord_response text,
  tenant_response text,
  decision text check (decision is null or decision in ('renew','relocate','undecided')),
  log jsonb not null default '[]',
  decided_by uuid references auth.users(id),
  decided_at timestamptz
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_renewal') then perform mudar_app.make_business_table('lease_renewal'); end if; end $$;
create index if not exists lease_renewal_lease_idx on mudar.lease_renewal(lease_id);

create table if not exists mudar.lease_termination (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  reason text,
  initiated_on date,
  notice_date date,
  notice_period_text text,
  proposed_date date,
  confirmed_date date,
  outstanding jsonb not null default '[]',
  settlement_amount numeric(16,2),
  deposit_amount numeric(16,2),
  deposit_recovered numeric(16,2),
  deposit_status text not null default 'unknown' check (deposit_status in ('unknown','pending','partially_recovered','recovered','disputed')),
  status text not null default 'initiated' check (status in ('initiated','notice_served','in_settlement','completed','withdrawn'))
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_termination') then perform mudar_app.make_business_table('lease_termination'); end if; end $$;

create table if not exists mudar.lease_handover_item (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  label text not null,
  sort int not null default 0,
  status text not null default 'pending' check (status in ('pending','done','not_applicable')),
  evidence_note text,
  done_at timestamptz,
  done_by uuid references auth.users(id)
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_handover_item') then perform mudar_app.make_business_table('lease_handover_item'); end if; end $$;
create index if not exists lease_handover_lease_idx on mudar.lease_handover_item(lease_id, sort);

create table if not exists mudar.lease_financial_record (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  kind text not null check (kind in ('rent_payment','cam_payment','deposit_paid','deposit_adjustment','deposit_refund','settlement','actual_rent_after_escalation','other')),
  amount numeric(16,2) not null,
  on_date date,
  period text,
  source text not null check (source in ('user_verified','connected_system')),
  note text
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_financial_record') then perform mudar_app.make_business_table('lease_financial_record'); end if; end $$;

create table if not exists mudar.lease_reminder (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references mudar.lease(id) on delete cascade,
  lease_date_id uuid references mudar.lease_date(id) on delete set null,
  date_type text not null,
  target_date date not null,
  offset_days int not null,
  remind_on date not null,
  status text not null default 'scheduled' check (status in ('scheduled','sent','done','cancelled')),
  assigned_user_id uuid references auth.users(id),
  cancelled_reason text,
  outbox_id uuid,
  dedupe_key text not null
);
do $$ begin if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'lease_reminder') then perform mudar_app.make_business_table('lease_reminder'); end if; end $$;
create unique index if not exists lease_reminder_dedupe_uq on mudar.lease_reminder(workspace_id, dedupe_key) where status <> 'cancelled';
create index if not exists lease_reminder_due_idx on mudar.lease_reminder(workspace_id, remind_on) where status = 'scheduled';
