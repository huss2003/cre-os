-- Module 7: Meeting Preparation. The meeting itself is mudar.meeting_visit (shared with calendar sync);
-- these tables hold the preparation, attendees, brief versions, materials, notes and outcome.
create table if not exists mudar.meeting_prep (
  id uuid primary key default gen_random_uuid(),
  meeting_visit_id uuid not null references mudar.meeting_visit(id) on delete cascade,
  meeting_type text not null default 'discovery',
  purpose text,
  org_id uuid references mudar.organisation(id),
  opportunity_id uuid references mudar.opportunity(id),
  requirement_id uuid references mudar.requirement(id),
  asset_ids uuid[] not null default '{}',
  status text not null default 'preparation_pending' check (status in ('scheduled','preparation_pending','researching','brief_ready','reviewed','completed','cancelled','rescheduled')),
  readiness int, readiness_detail jsonb not null default '{}',
  brief jsonb, brief_version int not null default 0, brief_model text, brief_error text,
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  checklist jsonb not null default '{}',
  remind_at timestamptz,
  outcome jsonb,
  source text not null default 'manual' check (source in ('manual','calendar','ics_import')),
  source_raw jsonb
);
select mudar_app.make_business_table('meeting_prep');
create unique index if not exists meeting_prep_mv_uq on mudar.meeting_prep(meeting_visit_id) where archived_at is null;

create table if not exists mudar.meeting_prep_attendee (
  id uuid primary key default gen_random_uuid(),
  prep_id uuid not null references mudar.meeting_prep(id) on delete cascade,
  person_id uuid references mudar.person(id),
  raw_name text, raw_email text,
  side text not null default 'external' check (side in ('external','internal')),
  match_status text not null default 'unresolved' check (match_status in ('matched','suggested','unresolved','manual')),
  match_reason text
);
select mudar_app.make_business_table('meeting_prep_attendee', false);

create table if not exists mudar.meeting_brief_version (
  id uuid primary key default gen_random_uuid(),
  prep_id uuid not null references mudar.meeting_prep(id) on delete cascade,
  version int not null,
  kind text not null check (kind in ('generated','regenerated','edited')),
  content jsonb not null,
  model text, readiness int, inputs jsonb not null default '{}'
);
select mudar_app.make_business_table('meeting_brief_version', false);
create unique index if not exists meeting_brief_version_uq on mudar.meeting_brief_version(prep_id, version);

create table if not exists mudar.meeting_material (
  id uuid primary key default gen_random_uuid(),
  prep_id uuid not null references mudar.meeting_prep(id) on delete cascade,
  title text not null, url text, document_version_id uuid references mudar.document_version(id),
  internal_only boolean not null default true
);
select mudar_app.make_business_table('meeting_material', false);

create table if not exists mudar.meeting_note (
  id uuid primary key default gen_random_uuid(),
  prep_id uuid not null references mudar.meeting_prep(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note','action','feedback','commitment')),
  text text not null
);
select mudar_app.make_business_table('meeting_note', false);
