-- Module 5: Outreach Engine. Reuses mudar.draft (hash-bound approval, suppression guard, no send route),
-- interaction, task, consent_permission and change_proposal. Adds outreach planning, immutable versions and events.
create table if not exists mudar.outreach_item (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references mudar.person(id),
  org_id uuid references mudar.organisation(id),
  opportunity_id uuid references mudar.opportunity(id),
  requirement_id uuid references mudar.requirement(id),
  signal_id uuid references mudar.signal(id),
  plan_key text not null,                         -- groups one conversation thread (initial + follow-ups)
  step int not null default 1,
  scenario text not null check (scenario in ('lease_renewal','expansion','consolidation','relocation','managed_office','gcc','reconnect','meeting_followup')),
  channel text not null check (channel in ('email','whatsapp','linkedin','call','introduction','meeting_followup')),
  reason text not null,                           -- why now (from records)
  value_prop text,
  facts jsonb not null default '[]',              -- [{text, source_type, source_id}] the context the draft may use
  assumptions jsonb not null default '[]',
  questions jsonb not null default '[]',
  script jsonb,                                   -- call script / intro context (no draft row)
  draft_id uuid references mudar.draft(id),
  language text not null default 'en' check (language in ('en','hi','hinglish')),
  status text not null default 'draft' check (status in ('planned','draft','pending_approval','approved','sent','replied','meeting','declined','no_response','paused','closed')),
  assigned_user_id uuid references auth.users(id),
  planned_on date,
  pause_reason text,
  intro_via_person_id uuid references mudar.person(id),
  response jsonb,
  sent_at timestamptz, sent_evidence text,         -- 'user_assertion' | 'provider:<id>'
  responded_at timestamptz,
  prep_seconds int
);
select mudar_app.make_business_table('outreach_item');
create index if not exists outreach_item_person on mudar.outreach_item(workspace_id, person_id, status);
create index if not exists outreach_item_plan on mudar.outreach_item(workspace_id, plan_key, step);
create unique index if not exists outreach_item_plan_step_uq on mudar.outreach_item(workspace_id, plan_key, step, channel) where archived_at is null;

create table if not exists mudar.outreach_version (    -- immutable history of every generated/edited text
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references mudar.outreach_item(id) on delete cascade,
  version int not null,
  kind text not null check (kind in ('generated','regenerated','ai_edit','user_edit')),
  op text,
  subject text, body text not null,
  learn boolean not null default false              -- user chose "use as my style" (feedback, not automatic)
);
select mudar_app.make_business_table('outreach_version', false);
create unique index if not exists outreach_version_uq on mudar.outreach_version(item_id, version);
create or replace function mudar_app.outreach_version_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.body is distinct from old.body or new.subject is distinct from old.subject or new.version <> old.version) then
    raise exception 'outreach versions are immutable';
  end if;
  return new;
end $$;
drop trigger if exists outreach_version_immutable on mudar.outreach_version;
create trigger outreach_version_immutable before update on mudar.outreach_version for each row execute function mudar_app.outreach_version_immutable();

create table if not exists mudar.outreach_event (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references mudar.outreach_item(id) on delete cascade,
  event text not null,                            -- drafted, edited, approval_requested, approved, approval_invalidated, sent_manual, sent_provider, response, meeting, declined, paused, resumed, closed, duplicate_warning_ack
  actor_user_id uuid references auth.users(id),
  detail jsonb not null default '{}'
);
select mudar_app.make_business_table('outreach_event', false);
create index if not exists outreach_event_item on mudar.outreach_event(item_id, created_at);
