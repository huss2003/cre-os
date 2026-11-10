-- Module 7 additions: structured per-property site-visit feedback; uploaded meeting materials (mime);
-- auto-brief bookkeeping. Re-runnable.
create table if not exists mudar.meeting_property_feedback (
  id uuid primary key default gen_random_uuid(),
  prep_id uuid not null references mudar.meeting_prep(id) on delete cascade,
  asset_id uuid not null references mudar.asset(id),
  fields jsonb not null default '{}'
);
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'mudar' and table_name = 'meeting_property_feedback' and column_name = 'workspace_id') then
    perform mudar_app.make_business_table('meeting_property_feedback', false);
  end if;
end $$;
create unique index if not exists meeting_property_feedback_uq on mudar.meeting_property_feedback(prep_id, asset_id) where archived_at is null;

alter table mudar.meeting_material add column if not exists mime text;
alter table mudar.meeting_material add column if not exists storage_object boolean not null default false;
alter table mudar.meeting_prep add column if not exists auto_brief_for timestamptz;
notify pgrst, 'reload schema';
