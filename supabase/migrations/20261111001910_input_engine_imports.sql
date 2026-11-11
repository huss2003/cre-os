-- Input Engine (Module 10) — spreadsheet engine + batch processing (spec §3, §10, §13C). Owner: imports module.
-- Re-runnable: creates only this module's objects (if not exists / or replace); never touches core tables except an
-- additive nullable column on import_batch.

-- ---------------------------------------------------------------- learned header aliases (remembered approved mapping patterns)
-- One row per (adapter, role, normalised header) approved by an admin. Detection uses them for FUTURE files with a
-- different layout (renamed/reordered columns), so a correction made once is remembered per workspace.
do $$ begin
  if to_regclass('mudar.import_header_alias') is null then
    create table mudar.import_header_alias (
      id uuid primary key default gen_random_uuid(),
      adapter text not null,
      sheet_role text not null,
      field_key text not null,
      header_norm text not null,
      header_raw text,
      mapping_id uuid references mudar.adapter_mapping(id) on delete set null,
      approved_by uuid references auth.users(id),
      approved_at timestamptz
    );
    perform mudar_app.make_business_table('import_header_alias');
  end if;
end $$;
create unique index if not exists import_header_alias_uq on mudar.import_header_alias(workspace_id, adapter, sheet_role, header_norm);

create or replace function mudar_app.imports_alias_guard() returns trigger language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if auth.uid() is not null and not mudar_app.has_role(new.workspace_id, 'admin') then
    raise exception 'only workspace admins can approve column mappings' using errcode = '42501';
  end if;
  if auth.uid() is not null then
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  return new;
end $$;
revoke execute on function mudar_app.imports_alias_guard() from public, anon, authenticated;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'import_header_alias_guard') then
    create trigger import_header_alias_guard before insert or update on mudar.import_header_alias
      for each row execute function mudar_app.imports_alias_guard();
  end if;
end $$;

-- ---------------------------------------------------------------- multi-file batch runs (spec §10)
do $$ begin
  if to_regclass('mudar.import_run') is null then
    create table mudar.import_run (
      id uuid primary key default gen_random_uuid(),
      label text,
      status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'completed_with_failures', 'failed')),
      file_count int not null default 0,
      report jsonb,
      idempotency_key text,
      created_by uuid references auth.users(id),
      finished_at timestamptz
    );
    perform mudar_app.make_business_table('import_run');
  end if;
  if to_regclass('mudar.import_run_item') is null then
    create table mudar.import_run_item (
      id uuid primary key default gen_random_uuid(),
      run_id uuid not null references mudar.import_run(id) on delete cascade,
      position int not null default 0,
      file_name text not null,
      size_bytes bigint,
      sha256 text,
      kind text not null check (kind in ('spreadsheet', 'document', 'unsupported')),
      batch_id uuid references mudar.import_batch(id) on delete set null,
      capture_id uuid,
      status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'partial', 'failed', 'duplicate')),
      error text,
      error_kind text check (error_kind in ('temporary', 'permanent')),
      attempts int not null default 0
    );
    perform mudar_app.make_business_table('import_run_item');
  end if;
end $$;
create unique index if not exists import_run_idem_uq on mudar.import_run(workspace_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists import_run_item_pos_uq on mudar.import_run_item(run_id, position);
create index if not exists import_run_item_batch_idx on mudar.import_run_item(workspace_id, batch_id);

alter table mudar.import_batch add column if not exists run_id uuid references mudar.import_run(id) on delete set null;
create index if not exists import_batch_run_idx on mudar.import_batch(workspace_id, run_id);
