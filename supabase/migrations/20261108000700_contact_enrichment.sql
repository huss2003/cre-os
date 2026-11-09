-- Module 4 — Contact Enrichment. Reuses person / employment (history) / contact_method / interaction / change_proposal
-- (merges, person moves) / score_result (Module 3 contact relevance). Adds jobs, per-candidate items with field-level
-- evidence, role assessments, manual reporting lines, and verification columns on contact_method. Re-runnable.

-- Field-level verification on existing contact channels (no new contact table).
alter table mudar.contact_method add column if not exists verify_status text
  check (verify_status in ('verified','likely_valid','unverified','invalid','risky','generic','unknown',
                           'published_business','switchboard','business_mobile','user_provided'));
alter table mudar.contact_method add column if not exists verify_evidence jsonb not null default '[]';
alter table mudar.contact_method add column if not exists source_name text;
alter table mudar.contact_method add column if not exists source_url text;
alter table mudar.contact_method add column if not exists observed_on date;
alter table mudar.contact_method add column if not exists last_checked_at timestamptz;
alter table mudar.person add column if not exists last_enriched_at timestamptz;
alter table mudar.person add column if not exists next_review_on date;
alter table mudar.person add column if not exists do_not_contact boolean not null default false;

drop table if exists mudar.enrichment_item cascade;
drop table if exists mudar.enrichment_job cascade;
drop table if exists mudar.contact_role_assessment cascade;
drop table if exists mudar.reporting_line cascade;

create table mudar.enrichment_job (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('company_discovery','contact_enrich','bulk','reverify','appointment_scan','linkedin_import')),
  org_id uuid references mudar.organisation(id) on delete set null,
  label text not null,
  status text not null default 'pending' check (status in ('pending','running','done','partial','failed','cancelled')),
  sources text[] not null default '{}',
  total int not null default 0,
  done int not null default 0,
  failed int not null default 0,
  usd numeric(10,4) not null default 0,
  queries text[] not null default '{}',
  sites jsonb not null default '[]',
  error text,
  idempotency_key text,
  started_at timestamptz,
  finished_at timestamptz
);
select mudar_app.make_business_table('enrichment_job');
create unique index enrichment_job_idem on mudar.enrichment_job(workspace_id, idempotency_key) where idempotency_key is not null;
create index on mudar.enrichment_job(workspace_id, created_at desc);

-- One row per discovered or enriched person. fields = [{field,value,status,source_name,source_url,observed_on,method,confidence}]
create table mudar.enrichment_item (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references mudar.enrichment_job(id) on delete cascade,
  org_id uuid references mudar.organisation(id) on delete set null,
  person_id uuid references mudar.person(id) on delete set null,
  full_name text not null,
  stage text not null default 'pending' check (stage in ('pending','researching','discovered','identity_matching','possible_duplicate',
    'employment_verification_pending','enrichment_pending','partially_enriched','verification_required','verified','rejected','failed')),
  match_kind text check (match_kind in ('new','existing','possible_duplicate','job_change')),
  match_reason text,
  match_candidates jsonb not null default '[]',
  fields jsonb not null default '[]',
  role_class text,
  department text,
  cre_relevance text check (cre_relevance in ('high','medium','low','none','unknown')),
  role_reason text,
  completeness int not null default 0,
  decision text not null default 'pending' check (decision in ('pending','approved','rejected')),
  decision_reason text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  proposal_ids uuid[] not null default '{}',
  company_raw text,                       -- company name as given by the source when not (yet) in records
  source_type text,                       -- company_site / press / news / regulatory_filing / conference / association / appointment_news / linkedin_export
  error text,
  attempts int not null default 0,
  dedupe_key text not null
);
select mudar_app.make_business_table('enrichment_item');
create unique index enrichment_item_dedupe on mudar.enrichment_item(workspace_id, job_id, dedupe_key);
create index on mudar.enrichment_item(workspace_id, stage);
create index on mudar.enrichment_item(person_id);

-- Role classification with reason + evidence; users can correct it (source='user'). Latest active row wins.
create table mudar.contact_role_assessment (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references mudar.person(id) on delete cascade,
  org_id uuid references mudar.organisation(id) on delete set null,
  role_class text not null check (role_class in ('decision_maker','economic_buyer','technical_evaluator','operational','influencer','gatekeeper','procurement','administrative','unknown')),
  department text,
  cre_relevance text not null check (cre_relevance in ('high','medium','low','none','unknown')),
  reason text not null,
  evidence jsonb not null default '[]',
  source text not null check (source in ('rules','ai','user')),
  active boolean not null default true
);
select mudar_app.make_business_table('contact_role_assessment');
create index on mudar.contact_role_assessment(person_id) where active;

-- Reporting relationships: manual only (never inferred from titles).
create table mudar.reporting_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references mudar.organisation(id) on delete cascade,
  person_id uuid not null references mudar.person(id) on delete cascade,
  manager_person_id uuid not null references mudar.person(id) on delete cascade,
  note text,
  check (person_id <> manager_person_id)
);
select mudar_app.make_business_table('reporting_line');
create unique index reporting_line_uq on mudar.reporting_line(workspace_id, org_id, person_id) where archived_at is null;

-- Role assessments / contact channel changes feed Module 3 recalculation (contact + company lead).
do $$ begin
  execute 'drop trigger if exists scoring_enqueue on mudar.contact_role_assessment';
  execute 'create trigger scoring_enqueue after insert or update on mudar.contact_role_assessment for each row execute function mudar_app.scoring_enqueue()';
end $$;
create or replace function mudar_app.scoring_enqueue() returns trigger language plpgsql security definer
set search_path = mudar, mudar_app, public as $$
declare r record; org uuid; ent uuid; et text;
begin
  r := coalesce(new, old);
  et := tg_table_name; ent := r.id;
  org := case tg_table_name
    when 'signal' then r.org_id when 'requirement' then r.org_id when 'opportunity' then r.org_id
    when 'employment' then r.org_id when 'contact_role_assessment' then r.org_id else null end;
  if tg_table_name = 'lease_event' then select l.tenant_org_id into org from mudar.lease l where l.id = r.lease_id;
  elsif tg_table_name = 'lease' then org := r.tenant_org_id; end if;
  if tg_table_name in ('employment','contact_role_assessment') then et := 'person'; ent := r.person_id; end if;
  perform mudar_app.enqueue_job(r.workspace_id, 'scoring.recalc',
    jsonb_build_object('entity_type', et, 'entity_id', ent, 'org_id', org, 'trigger', tg_table_name || '.' || lower(tg_op)),
    now() + interval '20 seconds', 'scoring.recalc:' || coalesce(org, ent)::text || ':' || to_char(now(), 'YYYYMMDDHH24MI'), 3);
  return null;
exception when others then return null;
end $$;
notify pgrst, 'reload schema';
