-- Module 12 round 2 (outputs): per-user writing-style profile built from the user's own outbound messages
-- (or approved drafts). Private to its owner. Re-runnable.
create table if not exists mudar.assistant_style_profile (
  id uuid primary key default gen_random_uuid(),
  enabled boolean not null default true,
  source text not null default 'none' check (source in ('sent_messages','approved_drafts','none')),
  sample_count int not null default 0,
  stats jsonb not null default '{}',
  summary text,
  summary_mocked boolean not null default false,
  built_at timestamptz
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_style_profile' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_style_profile', false);
  end if;
end $$;
alter table mudar.assistant_style_profile alter column classification set default 'permitted_personal';
create unique index if not exists assistant_style_profile_owner_uq on mudar.assistant_style_profile(workspace_id, owner_user_id);

-- Owner-only: a writing profile is personal even inside a shared workspace.
drop policy if exists assistant_style_profile_owner_only on mudar.assistant_style_profile;
create policy assistant_style_profile_owner_only on mudar.assistant_style_profile as restrictive for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
