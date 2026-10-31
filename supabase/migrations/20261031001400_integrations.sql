set search_path = mudar, mudar_app, public, extensions;
-- CRE OS integrations module: Microsoft 365 / Google read-only connectors, inbox triage, calendar & visits,
-- draft queue + outreach sequences, account touch calendar, consent & rights operations.
-- Spec: Part I §7 (urgent alerts), §8 (Inbox triage, Outreach, Calendar and visits, Account saturation, Consent and rights),
-- §14 (Security), Part III "Integration contracts". Re-runnable: drops only this module's objects first.

-- ---------------------------------------------------------------- re-run safety (only our own objects)
drop function if exists mudar.integrations_touch_collisions(uuid, uuid, uuid, timestamptz);
drop trigger if exists integrations_draft_guard on mudar.draft;
drop function if exists mudar_app.integrations_draft_guard();
drop table if exists mudar.draft_event cascade;
drop table if exists mudar.visit_feedback cascade;
drop table if exists mudar.calendar_event cascade;
drop table if exists mudar.account_touch cascade;
drop table if exists mudar.sequence_enrollment cascade;
drop table if exists mudar.outreach_sequence cascade;
drop table if exists mudar.suppression_tombstone cascade;
drop table if exists mudar.inbound_message cascade;
drop table if exists mudar.oauth_state cascade;

-- ---------------------------------------------------------------- OAuth state (authorization code + PKCE)
-- Server-only: bound to user + workspace + provider, single use, 10 minute expiry. No authenticated access.
create table mudar.oauth_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('microsoft','google')),
  state_hash text not null unique,              -- sha256(state); raw state only travels in the redirect
  code_verifier_ciphertext text not null,       -- PKCE verifier, AES-GCM encrypted
  redirect_to text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index on mudar.oauth_state(expires_at);
alter table mudar.oauth_state enable row level security;
revoke all on mudar.oauth_state from authenticated, anon;
grant all on mudar.oauth_state to service_role;

-- ---------------------------------------------------------------- inbound / sent messages (evidence, sanitised)
create table mudar.inbound_message (
  id uuid primary key default gen_random_uuid(),
  connector_account_id uuid references mudar.connector_account(id) on delete set null,
  provider text not null check (provider in ('microsoft','google','manual','mock')),
  provider_message_id text not null,            -- Graph id / Gmail id / sha of .eml for manual import
  internet_message_id text,                     -- RFC 5322 Message-ID (cross-source dedupe)
  thread_id text,
  folder text not null default 'inbox' check (folder in ('inbox','sent')),
  import_method text not null default 'sync' check (import_method in ('sync','webhook','backfill','manual_import')),
  from_address citext,
  from_name text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text,
  received_at timestamptz not null,
  body_excerpt text,                            -- sanitised plain text (active content stripped), max 4000 chars
  attachments jsonb not null default '[]',      -- [{name, content_type, size}] metadata only, never executed
  is_backfill boolean not null default false,   -- backfilled history never re-triggers sequences or hot alerts
  matched_person_ids uuid[] not null default '{}',
  triage jsonb,                                 -- {summary, category, buying_signals, next_actions, urgency, ...}
  triage_status text not null default 'pending' check (triage_status in ('pending','triaged','skipped','failed')),
  triage_error text,
  interaction_id uuid references mudar.interaction(id) on delete set null,
  source_object_id uuid references mudar.source_object(id)
);
select mudar_app.make_business_table('inbound_message');
create unique index inbound_message_dedupe_uq on mudar.inbound_message(workspace_id, provider, provider_message_id);
create index inbound_message_imid_idx on mudar.inbound_message(workspace_id, internet_message_id);
create index inbound_message_recv_idx on mudar.inbound_message(workspace_id, folder, received_at desc);

-- ---------------------------------------------------------------- suppression tombstones (survive deletion/erasure)
create table mudar.suppression_tombstone (
  id uuid primary key default gen_random_uuid(),
  value_hash text not null,                     -- sha256(lower(trim(value))) — same as contact_method.value_hash
  method_type text not null check (method_type in ('email','phone','whatsapp','linkedin','other')),
  reason text not null check (reason in ('opt_out','erasure','wrong_contact','legal','other')),
  person_id uuid references mudar.person(id) on delete set null,
  note text
);
select mudar_app.make_business_table('suppression_tombstone');
create unique index suppression_tombstone_uq on mudar.suppression_tombstone(workspace_id, method_type, value_hash);

-- ---------------------------------------------------------------- outreach sequences
create table mudar.outreach_sequence (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  persona text,                                 -- e.g. cfo, head_of_admin, real_estate_head, hr_head
  steps jsonb not null,                         -- [{step, day_offset, channel, purpose}] default 3 touches / 21 days
  caps jsonb not null default '{}',             -- {email:{max,per_days}, whatsapp:{...}, linkedin:{...}, account_per_week}
  status text not null default 'active' check (status in ('active','retired'))
);
select mudar_app.make_business_table('outreach_sequence');

create table mudar.sequence_enrollment (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references mudar.outreach_sequence(id) on delete cascade,
  person_id uuid not null references mudar.person(id) on delete cascade,
  org_id uuid references mudar.organisation(id),
  opportunity_id uuid references mudar.opportunity(id),
  status text not null default 'proposed' check (status in ('proposed','active','paused','completed','cancelled')),
  current_step int not null default 0,          -- last step actually sent (marked/reconciled)
  next_due_at timestamptz,
  enrolled_at timestamptz not null default now(),
  activated_at timestamptz,
  pause_reason text check (pause_reason in ('reply','opt_out','wrong_contact','active_negotiation','contrary_info','suppressed','collision','manual')),
  paused_at timestamptz,
  completed_at timestamptz,
  value_proposition text                        -- user-approved one-line proposition for this target
);
select mudar_app.make_business_table('sequence_enrollment');
create unique index sequence_enrollment_live_uq on mudar.sequence_enrollment(workspace_id, sequence_id, person_id)
  where status in ('proposed','active','paused');
create index on mudar.sequence_enrollment(workspace_id, person_id);
create index on mudar.sequence_enrollment(workspace_id, status, next_due_at);

-- ---------------------------------------------------------------- account-level touch calendar (saturation / collision)
create table mudar.account_touch (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references mudar.organisation(id) on delete cascade,
  person_id uuid references mudar.person(id) on delete set null,
  user_id uuid references auth.users(id),       -- colleague responsible for the touch
  channel text not null check (channel in ('email','whatsapp','linkedin','call','meeting','visit','calendar_invite','introduction','other')),
  touch_kind text not null check (touch_kind in ('planned','drafted','sent','inbound','meeting')),
  at timestamptz not null,
  draft_id uuid references mudar.draft(id) on delete set null,
  enrollment_id uuid references mudar.sequence_enrollment(id) on delete set null,
  interaction_id uuid references mudar.interaction(id) on delete set null,
  dedupe_key text,
  note text
);
select mudar_app.make_business_table('account_touch');
create unique index account_touch_dedupe_uq on mudar.account_touch(workspace_id, dedupe_key) where dedupe_key is not null;
create index on mudar.account_touch(workspace_id, org_id, at desc);
create index on mudar.account_touch(workspace_id, person_id, at desc);

-- Collision check across colleagues without exposing their records: returns minimal touch facts for an account/person.
create or replace function mudar.integrations_touch_collisions(p_ws uuid, p_org uuid, p_person uuid, p_since timestamptz)
returns table (user_id uuid, display_name text, channel text, touch_kind text, at timestamptz)
language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select t.user_id, m.display_name, t.channel, t.touch_kind, t.at
  from mudar.account_touch t
  left join mudar.membership m on m.workspace_id = t.workspace_id and m.user_id = t.user_id
  where mudar_app.is_member(p_ws)
    and t.workspace_id = p_ws
    and t.archived_at is null
    and t.at >= p_since
    and ((p_org is not null and t.org_id = p_org) or (p_person is not null and t.person_id = p_person))
  order by t.at desc
  limit 200
$$;
revoke all on function mudar.integrations_touch_collisions(uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function mudar.integrations_touch_collisions(uuid, uuid, uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------- calendar event metadata (provider side of meeting_visit)
create table mudar.calendar_event (
  id uuid primary key default gen_random_uuid(),
  meeting_visit_id uuid not null references mudar.meeting_visit(id) on delete cascade,
  connector_account_id uuid references mudar.connector_account(id) on delete set null,
  provider text not null,
  external_id text not null,
  ical_uid text,
  organizer text,
  attendees jsonb not null default '[]',        -- [{address, name, response}]
  is_online boolean not null default false,
  change_key text,
  locality text,                                -- matched geography name (provisional route clustering)
  last_synced_at timestamptz not null default now(),
  previous_start_at timestamptz,
  reschedule_count int not null default 0
);
select mudar_app.make_business_table('calendar_event');
create unique index calendar_event_uq on mudar.calendar_event(workspace_id, provider, external_id);
create unique index calendar_event_mv_uq on mudar.calendar_event(meeting_visit_id);

-- ---------------------------------------------------------------- visit feedback form
create table mudar.visit_feedback (
  id uuid primary key default gen_random_uuid(),
  meeting_visit_id uuid not null references mudar.meeting_visit(id) on delete cascade,
  attended boolean,
  client_rating int check (client_rating between 1 and 5),
  liked text,
  concerns text,
  dealbreakers text,
  next_step text,
  follow_up_due date,
  submitted_by uuid references auth.users(id)
);
select mudar_app.make_business_table('visit_feedback');
create unique index visit_feedback_uq on mudar.visit_feedback(workspace_id, meeting_visit_id);

-- ---------------------------------------------------------------- draft lifecycle events (drafted / approved / sent separately)
create table mudar.draft_event (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references mudar.draft(id) on delete cascade,
  event text not null check (event in ('drafted','edited','approval_invalidated','approved','opened_for_send','marked_sent',
                                       'reconciled_sent','discarded','paused','resumed','blocked_suppressed')),
  actor_user_id uuid references auth.users(id),
  actor_kind text not null default 'user' check (actor_kind in ('user','job','system')),
  content_hash text,
  evidence text,
  occurred_at timestamptz not null default now()
);
select mudar_app.make_business_table('draft_event', false);
create index on mudar.draft_event(workspace_id, draft_id, occurred_at);
-- append-only for application users
drop policy if exists draft_event_upd on mudar.draft_event;
drop policy if exists draft_event_del on mudar.draft_event;
revoke update, delete on mudar.draft_event from authenticated;

-- ---------------------------------------------------------------- draft guard
-- The draft guard (server-side content_hash, definer-only approval/sent transitions, column grants) lives in
-- 20261031001410_integrations_draft_security.sql (security review M2), so it can be re-applied without dropping data.

-- refresh PostgREST schema cache
notify pgrst, 'reload schema';
