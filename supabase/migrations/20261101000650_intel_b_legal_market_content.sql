set search_path = mudar, mudar_app, public, extensions;
-- intel-B round 2: legal desk uploads/locators/family guard, market analysis runs + release trigger,
-- content fact-check / brand confirmation / publishing calendar. Re-runnable.

-- ================================================================ legal desk
alter table mudar.legal_document add column if not exists file_kind text not null default 'text';
alter table mudar.legal_document add column if not exists page_count int;
alter table mudar.legal_document add column if not exists ocr_status text not null default 'not_needed';
alter table mudar.legal_document add column if not exists extraction_notes jsonb not null default '[]';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'legal_document_file_kind_chk') then
    alter table mudar.legal_document add constraint legal_document_file_kind_chk check (file_kind in ('text','pdf','docx'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'legal_document_ocr_status_chk') then
    alter table mudar.legal_document add constraint legal_document_ocr_status_chk check (ocr_status in ('not_needed','ocr_needed','ocr_unverified','ocr_verified'));
  end if;
end $$;

alter table mudar.clause_extract add column if not exists validation jsonb not null default '{}';

alter table mudar.clause_comparison add column if not exists base_version int;
alter table mudar.clause_comparison add column if not exists compare_version int;
alter table mudar.clause_comparison add column if not exists same_family boolean not null default true;
alter table mudar.clause_comparison add column if not exists cross_family_confirmed boolean not null default false;
alter table mudar.clause_comparison add column if not exists full_redline jsonb not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'clause_comparison_family_chk') then
    -- different families can only be compared after explicit confirmation
    alter table mudar.clause_comparison add constraint clause_comparison_family_chk check (same_family or cross_family_confirmed);
  end if;
end $$;

-- ================================================================ market analyst
alter table mudar.market_note add column if not exists sources jsonb not null default '[]';      -- [{source_object_id,name,release_date,licensed_source_id,licensed_name,permits_publication}]
alter table mudar.market_note add column if not exists sample_size int;
alter table mudar.market_note add column if not exists caveats jsonb not null default '[]';
alter table mudar.market_note add column if not exists has_forecast boolean not null default false;
alter table mudar.market_note add column if not exists unit text;

do $$ begin
  if to_regclass('mudar.market_analysis') is null then
    create table mudar.market_analysis (
      id uuid primary key default gen_random_uuid(),
      trigger_kind text not null default 'release' check (trigger_kind in ('release','scheduled','manual')),
      trigger_key text,
      observation_count int not null default 0,
      series_count int not null default 0,
      excluded_count int not null default 0,
      sources jsonb not null default '[]',
      flags jsonb not null default '[]',      -- [{kind,severity,series,detail}]
      summary jsonb not null default '{}',     -- per-series latest point (deterministic)
      ran_at timestamptz not null default now()
    );
    perform mudar_app.make_business_table('market_analysis');
    create index market_analysis_ws_ran_idx on mudar.market_analysis(workspace_id, ran_at desc);
  end if;
end $$;

-- A new release / batch of observations => one deduped analysis job per (workspace, source, release date).
-- Chunked inserts of the same release coalesce because the job is due a minute later and the dedupe key is stable.
create or replace function mudar_app.intel_market_release_enqueue() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  for r in
    select n.workspace_id,
           md5(string_agg(distinct coalesce(n.source_object_id::text, n.source_version, 'unsourced') || '@' || coalesce(n.release_date::text, 'undated'), ',')) as k,
           count(*) as cnt,
           (array_agg(n.owner_user_id) filter (where n.owner_user_id is not null))[1] as owner_id
    from new_rows n
    group by n.workspace_id
  loop
    perform mudar_app.enqueue_job(
      r.workspace_id, 'intelligence.market_analysis',
      jsonb_build_object('trigger', 'release', 'release_key', r.k, 'rows', r.cnt, 'owner_user_id', r.owner_id),
      now() + interval '1 minute',
      'intelligence.market_analysis:' || r.workspace_id || ':release:' || r.k,
      3);
  end loop;
  return null;
end $$;
revoke execute on function mudar_app.intel_market_release_enqueue() from public, anon, authenticated;

drop trigger if exists market_observation_release_enqueue on mudar.market_observation;
create trigger market_observation_release_enqueue
  after insert on mudar.market_observation
  referencing new table as new_rows
  for each statement execute function mudar_app.intel_market_release_enqueue();

-- ================================================================ content editor
alter table mudar.content_post add column if not exists planned_publish_on date;
alter table mudar.content_post add column if not exists fact_check jsonb not null default '{}';
alter table mudar.content_post add column if not exists private_version text;
alter table mudar.content_post add column if not exists content_flags jsonb not null default '[]';   -- confidential / licensed flags
alter table mudar.content_post add column if not exists brand_confirmed_sha256 text;               -- manual brand review bound to the body hash
create index if not exists content_post_planned_idx on mudar.content_post(workspace_id, planned_publish_on);

-- Legal desk ↔ lease radar linkage: uploads pick the related lease / company / building (org_id + asset_id are set,
-- derived from the lease when one is chosen) so lease radar can match legal clauses to leases.
alter table mudar.legal_document add column if not exists lease_id uuid references mudar.lease(id) on delete set null;
create index if not exists legal_document_links_idx on mudar.legal_document(workspace_id, org_id, asset_id);
