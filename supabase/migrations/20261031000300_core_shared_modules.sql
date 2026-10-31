-- Shared cross-module tables: capture, draft, brief, lead_score, notification preferences.

create table public.capture (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('text','audio','image','mixed')),
  raw_text text,
  storage_paths text[] not null default '{}',   -- workspace-files/<ws>/captures/...
  source_at timestamptz not null default now(), -- when the note/call happened
  language_hint text,                            -- en/hi/hinglish
  consent_reference text,                        -- call-recording permission/notice reference
  transcript text,
  transcript_confidence numeric(4,3),
  extraction jsonb,                              -- schema_version 1 contract (facts/tasks/ambiguities/drafts)
  status text not null default 'received' check (status in ('received','transcribing','extracting','needs_review','reviewed','failed')),
  error text,
  idempotency_key text
);
select app.make_business_table('capture');
create unique index capture_idem_uq on public.capture(workspace_id, idempotency_key) where idempotency_key is not null;

create table public.draft (                -- external message drafts; NO send route exists anywhere
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email','whatsapp','linkedin','calendar_invite','introduction','market_note','post')),
  recipient_person_id uuid references public.person(id),
  recipient_display text,
  recipient_address text,
  subject text,
  body text not null,
  attachment_document_ids uuid[] not null default '{}',
  opportunity_id uuid references public.opportunity(id),
  org_id uuid references public.organisation(id),
  sequence_key text, sequence_step int,
  purpose text,
  content_hash text not null,                -- sha256 of recipient+subject+body+attachments; approval binds to it
  state text not null default 'drafted' check (state in ('drafted','approved','opened_for_send','marked_sent','reconciled_sent','discarded','paused')),
  pause_reason text,
  approved_hash text,
  approved_by uuid references auth.users(id), approved_at timestamptz,
  marked_sent_at timestamptz, marked_sent_by uuid references auth.users(id),
  sent_evidence text,                        -- 'user_assertion' | 'sent_items:<message-id>'
  created_by_kind text not null default 'user' check (created_by_kind in ('user','job','model'))
);
select app.make_business_table('draft');

create table public.brief (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  brief_date date not null,
  kind text not null default 'daily' check (kind in ('daily','pre_meeting','weekly','reconciliation')),
  subject_key text not null default '',     -- meeting version key for pre_meeting
  version int not null default 1,
  generated_at timestamptz not null default now(),
  content jsonb not null,                    -- structured sections
  synthesis_status text not null default 'ok' check (synthesis_status in ('ok','fallback_no_ai','partial')),
  source_health jsonb not null default '{}', -- {source: {last_success_at, stale:boolean, error}}
  delivered_at timestamptz
);
select app.make_business_table('brief', false);
create unique index brief_uq on public.brief(workspace_id, user_id, brief_date, kind, subject_key, version);

create table public.lead_score (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null default 'organisation' check (subject_type in ('organisation','opportunity','requirement')),
  subject_id uuid not null,
  score_version text not null,
  total numeric(6,2) not null,
  components jsonb not null,                 -- {timing:{points,max,evidence,verified_on}, fit:..., trigger:..., relationship:..., engagement:..., budget:...}
  evidence_confidence text,
  warmth text,
  tier text check (tier in ('act_this_week','validate_nurture','enrich_or_park','suppressed')),
  overrides text[] not null default '{}',
  computed_at timestamptz not null default now(),
  is_current boolean not null default true
);
select app.make_business_table('lead_score', false);
create index on public.lead_score(workspace_id, subject_type, subject_id) where is_current;

create table public.user_preference (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  prefs jsonb not null default '{}',          -- dnd window, urgent categories, brief time, debrief time, weekend mode, capacity
  primary key (workspace_id, user_id)
);
alter table public.user_preference enable row level security;
create policy user_pref_own on public.user_preference for all to authenticated
  using (user_id = auth.uid() and app.is_member(workspace_id)) with check (user_id = auth.uid() and app.is_member(workspace_id));
grant select, insert, update, delete on public.user_preference to authenticated;
grant all on public.user_preference to service_role;
