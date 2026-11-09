alter table mudar.research_run add column if not exists assessment jsonb;
alter table mudar.research_run drop constraint if exists research_run_kind_check;
alter table mudar.research_run add constraint research_run_kind_check check (kind in ('company','discover','assess'));
notify pgrst, 'reload schema';
