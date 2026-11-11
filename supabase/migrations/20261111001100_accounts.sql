-- Accounts module: account/contact workspaces.
-- 1) account_view: last time each user looked at a company (drives "What changed since you last looked").
-- 2) contact_relationship_level: spec 2.3 relationship level, manual + history (append-only; latest row = current).
--    No relationship-level field existed on person / relationship_edge / relationship_context.
-- Re-runnable: tables use IF NOT EXISTS; make_business_table only runs when RLS policies are not yet present.

create table if not exists mudar.account_view (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references mudar.organisation(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  viewed_at timestamptz not null default now()
);

create table if not exists mudar.contact_relationship_level (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references mudar.person(id) on delete cascade,
  level text not null check (level in ('not_interacted','spoke_on_call','met_once','met_few','good','not_interested')),
  reason text,
  basis text not null default 'manual' check (basis in ('manual','accepted_suggestion')),
  set_by_user_id uuid references auth.users(id),
  set_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'account_view') then
    perform mudar_app.make_business_table('account_view', false);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'contact_relationship_level') then
    perform mudar_app.make_business_table('contact_relationship_level');
  end if;
end $$;

create unique index if not exists account_view_user_org_uq on mudar.account_view(workspace_id, org_id, user_id);
create index if not exists contact_relationship_level_person_idx on mudar.contact_relationship_level(workspace_id, person_id, set_at desc);
