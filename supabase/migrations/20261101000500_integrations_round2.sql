set search_path = mudar, mudar_app, public, extensions;
-- CRE OS integrations, round 2 (workflows 04 Inbox Triage, 13 Outreach Editor, 14 Calendar and Visits).
--  * inbound_thread: thread-level summaries (refreshed when the thread's message set changes)
--  * inbound_message: evidence-backed org / opportunity links + ambiguous-link suggestions + extracted commitments
--  * push_subscription / webhook_receipt: Microsoft Graph change notifications and Gmail Pub/Sub push (dedupe)
--  * sequence_enrollment.pause_detail: recorded reason for contrary-info / negotiation pauses
--  * visit_checklist_item: per-visit checklist, tickable from a phone
-- Re-runnable: only adds columns / creates objects if missing; never drops data.

-- ---------------------------------------------------------------- inbound_message: links + commitments
alter table mudar.inbound_message add column if not exists matched_org_ids uuid[] not null default '{}';
alter table mudar.inbound_message add column if not exists matched_opportunity_ids uuid[] not null default '{}';
alter table mudar.inbound_message add column if not exists link_evidence jsonb not null default '[]';     -- [{entity_type, entity_id, basis, evidence}]
alter table mudar.inbound_message add column if not exists link_suggestions jsonb not null default '[]';  -- [{entity_type, entity_id, label, reason}] (ambiguous: NOT linked)
alter table mudar.inbound_message add column if not exists commitments jsonb not null default '[]';      -- [{kind, who, what, due_text, due_date|null, evidence, task_id}]
create index if not exists inbound_message_thread_idx on mudar.inbound_message(workspace_id, thread_id);

-- ---------------------------------------------------------------- thread summaries
do $$ begin
  if to_regclass('mudar.inbound_thread') is null then
    create table mudar.inbound_thread (
      id uuid primary key default gen_random_uuid(),
      thread_key text not null,                    -- provider thread id (Graph conversationId / Gmail threadId / References root)
      subject text,
      message_count int not null default 0,
      first_message_at timestamptz,
      last_message_at timestamptz,
      participants text[] not null default '{}',
      summary text,                                -- thread-level summary (model proposal from sanitised evidence, or deterministic mock)
      key_points jsonb not null default '[]',
      open_commitments jsonb not null default '[]',
      latest_category text,
      basis_hash text,                             -- sha256 of the ordered message keys the summary was built from
      summarised_at timestamptz,
      summary_status text not null default 'pending' check (summary_status in ('pending','summarised','failed')),
      summary_error text,
      matched_person_ids uuid[] not null default '{}',
      matched_org_ids uuid[] not null default '{}',
      matched_opportunity_ids uuid[] not null default '{}'
    );
    perform mudar_app.make_business_table('inbound_thread');
    create unique index inbound_thread_uq on mudar.inbound_thread(workspace_id, thread_key);
    create index inbound_thread_recent_idx on mudar.inbound_thread(workspace_id, last_message_at desc);
  end if;
end $$;

-- ---------------------------------------------------------------- push sync (Graph subscriptions / Gmail watch)
do $$ begin
  if to_regclass('mudar.push_subscription') is null then
    create table mudar.push_subscription (
      id uuid primary key default gen_random_uuid(),
      connector_account_id uuid not null references mudar.connector_account(id) on delete cascade,
      provider text not null check (provider in ('microsoft','google')),
      resource text not null check (resource in ('inbox','calendar')),
      external_id text,                            -- Graph subscription id; Gmail: watch has no id (null)
      client_state_hash text,                      -- sha256(clientState); the raw secret is only sent to Graph
      expires_at timestamptz,
      history_id text,                             -- Gmail watch historyId at registration
      status text not null default 'active' check (status in ('active','expired','removed','failed')),
      last_notification_at timestamptz,
      last_renewed_at timestamptz,
      last_error text
    );
    perform mudar_app.make_business_table('push_subscription', false);
    create unique index push_subscription_uq on mudar.push_subscription(connector_account_id, resource);
    create index push_subscription_ext_idx on mudar.push_subscription(provider, external_id);
  end if;
end $$;
-- members may read status (settings page); only the service role writes
revoke insert, update, delete on mudar.push_subscription from authenticated;

do $$ begin
  if to_regclass('mudar.webhook_receipt') is null then
    create table mudar.webhook_receipt (
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null references mudar.workspace(id) on delete cascade,
      connector_account_id uuid references mudar.connector_account(id) on delete cascade,
      provider text not null,
      dedupe_key text not null,                    -- Graph: subscription|resource|changeType ; Gmail: Pub/Sub messageId
      kind text not null default 'change',
      job_id uuid,
      received_at timestamptz not null default now()
    );
    create unique index webhook_receipt_uq on mudar.webhook_receipt(workspace_id, provider, dedupe_key);
    create index webhook_receipt_recent_idx on mudar.webhook_receipt(received_at);
    alter table mudar.webhook_receipt enable row level security;
    revoke all on mudar.webhook_receipt from authenticated, anon;
    grant all on mudar.webhook_receipt to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------- outreach: recorded pause reason
alter table mudar.sequence_enrollment add column if not exists pause_detail text;

-- ---------------------------------------------------------------- visit checklist
do $$ begin
  if to_regclass('mudar.visit_checklist_item') is null then
    create table mudar.visit_checklist_item (
      id uuid primary key default gen_random_uuid(),
      meeting_visit_id uuid not null references mudar.meeting_visit(id) on delete cascade,
      item_key text not null,                      -- default item key, or custom:<hash>
      label text not null,
      position int not null default 100,
      done boolean not null default false,
      done_at timestamptz,
      done_by uuid references auth.users(id)
    );
    perform mudar_app.make_business_table('visit_checklist_item', false);
    create unique index visit_checklist_item_uq on mudar.visit_checklist_item(workspace_id, meeting_visit_id, item_key);
  end if;
end $$;

notify pgrst, 'reload schema';
