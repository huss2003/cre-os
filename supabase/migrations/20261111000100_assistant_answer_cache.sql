-- Module 12 round 2 (engine): answer cache for repeated questions. Re-runnable.
create table if not exists mudar.assistant_answer_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null,
  request text not null,
  answer_text text not null,
  blocks jsonb not null default '[]',
  tables text[] not null default '{}',
  fingerprint text not null,
  source_run_id uuid,
  hits int not null default 0,
  expires_at timestamptz not null
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='mudar' and table_name='assistant_answer_cache' and column_name='workspace_id') then
    perform mudar_app.make_business_table('assistant_answer_cache', false);
  end if;
end $$;
create unique index if not exists assistant_answer_cache_key on mudar.assistant_answer_cache(workspace_id, owner_user_id, cache_key);
