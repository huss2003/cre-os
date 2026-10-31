set search_path = mudar, mudar_app, public, extensions;
-- CRE OS intelligence module (spec Part I §8 P1 workflows, §9 research tiers, §13 KPIs; Part II §3-4).
-- Prospect researcher, network intelligence, legal desk, deal strategist, market analyst, content editor, insights.
-- Re-runnable in development: drops ONLY this module's own objects first.

drop table if exists mudar.experiment_subject cascade;
drop table if exists mudar.experiment cascade;
drop table if exists mudar.playbook_item cascade;
drop table if exists mudar.content_post cascade;
drop table if exists mudar.market_note cascade;
drop table if exists mudar.concession_item cascade;
drop table if exists mudar.negotiation_log cascade;
drop table if exists mudar.clause_comparison cascade;
drop table if exists mudar.clause_extract cascade;
drop table if exists mudar.legal_document cascade;
drop table if exists mudar.evidence_finding cascade;
drop table if exists mudar.watchlist cascade;
drop table if exists mudar.research_source_registry cascade;
drop table if exists mudar.research_dossier cascade;

-- ================================================================ research
-- Versioned, cited company dossier. sections = [{key,title,status,claims:[{text,status,evidence_tier,source{kind,id,url,locator},
-- observed_on,published_on,expires_on,expired}],note}]. Unknown sections stay status 'unknown' with no claims.
create table mudar.research_dossier (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references mudar.organisation(id) on delete cascade,
  tier text not null default 'universe' check (tier in ('critical','active','universe')),
  refresh_cadence_days int not null default 90 check (refresh_cadence_days > 0),
  version int not null default 1,
  is_current boolean not null default true,
  sections jsonb not null default '[]',
  falsification_questions jsonb not null default '[]',   -- "what evidence would invalidate this hypothesis?"
  evidence_fingerprint text not null,                    -- hash of evidence ids+versions; unchanged => no re-run
  evidence_count int not null default 0,
  expired_claim_count int not null default 0,
  synthesis_status text not null default 'ok' check (synthesis_status in ('ok','fallback_no_ai','partial')),
  degraded_reason text,
  model text,
  generated_at timestamptz not null default now(),
  next_refresh_at timestamptz not null
);
select mudar_app.make_business_table('research_dossier');
create unique index research_dossier_ver_uq on mudar.research_dossier(workspace_id, org_id, version);
create unique index research_dossier_current_uq on mudar.research_dossier(workspace_id, org_id) where is_current;  -- one current version per company

-- Allowed feeds/sites per workspace with licence / rate limits (spec Part II §3 adapter registry).
create table mudar.research_source_registry (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'website' check (kind in ('website','feed','filing','press','careers','licensed','export','native_alert','manual')),
  base_url text,
  acquisition_method text not null default 'manual_paste' check (acquisition_method in
    ('manual_paste','official_api','rss','licensed_export','native_alert','user_export','gateway_web_search')),
  licence text,
  licensed_source_id uuid references mudar.licensed_source(id),
  rate_limit_per_day int check (rate_limit_per_day is null or rate_limit_per_day >= 0),
  refresh_cadence_days int,
  storage_rights text,
  reuse_rights text,
  credentials_owner text,
  failure_policy text,
  source_owner text,
  allowed boolean not null default true,
  prohibited_methods text[] not null default array['scraping','session_automation','captcha_bypass','paywall_bypass','fake_accounts'],
  last_success_at timestamptz,
  last_error text,
  calls_today int not null default 0,
  calls_day date
);
select mudar_app.make_business_table('research_source_registry');

create table mudar.watchlist (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references mudar.organisation(id) on delete cascade,
  tier text not null default 'universe' check (tier in ('critical','active','universe')),
  reason text,
  refresh_cadence_days int not null default 90 check (refresh_cadence_days > 0),
  last_researched_at timestamptz,
  next_due_at timestamptz not null default now(),
  active boolean not null default true
);
select mudar_app.make_business_table('watchlist');
create unique index watchlist_org_uq on mudar.watchlist(workspace_id, org_id);

-- Evidence conflict & expiry patrol output (one row per finding; dedupe_key stops repeats).
create table mudar.evidence_finding (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('claim_conflict','claim_expired','quote_vs_listing','former_contact','completion_changed','availability_expired','dossier_stale')),
  subject_type text not null,
  subject_id uuid,
  detail text not null,
  refs jsonb not null default '[]',      -- [{type,id}]
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  dedupe_key text not null,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);
select mudar_app.make_business_table('evidence_finding', false);
create unique index evidence_finding_dedupe_uq on mudar.evidence_finding(workspace_id, dedupe_key);

-- ================================================================ legal desk
create table mudar.legal_document (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  doc_kind text not null default 'loi' check (doc_kind in ('loi','term_sheet','lease','amendment','other')),
  family_key text not null,              -- groups versions of the same document
  version int not null default 1,
  opportunity_id uuid references mudar.opportunity(id),
  org_id uuid references mudar.organisation(id),
  asset_id uuid references mudar.asset(id),
  text_content text not null,
  text_sha256 text not null,
  source_object_id uuid references mudar.source_object(id),
  ocr_unverified boolean not null default false,  -- scanned clauses require OCR verification
  legal_owns_advice boolean not null default true check (legal_owns_advice),
  status text not null default 'draft' check (status in ('draft','in_review','reviewed_by_legal','superseded')),
  reviewer_note text
);
select mudar_app.make_business_table('legal_document');
create unique index legal_document_ver_uq on mudar.legal_document(workspace_id, family_key, version);

create table mudar.clause_extract (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references mudar.legal_document(id) on delete cascade,
  clause_type text not null,
  heading text,
  clause_text text not null,
  locator jsonb not null default '{}',   -- {line_start,line_end,char_start,char_end,page}
  extracted_values jsonb not null default '{}',
  extraction_method text not null default 'heuristic' check (extraction_method in ('heuristic','model')),
  needs_review boolean not null default true
);
select mudar_app.make_business_table('clause_extract', false);
create index on mudar.clause_extract(document_id);

create table mudar.clause_comparison (
  id uuid primary key default gen_random_uuid(),
  base_document_id uuid not null references mudar.legal_document(id) on delete cascade,
  compare_document_id uuid not null references mudar.legal_document(id) on delete cascade,
  diff jsonb not null default '[]',              -- per clause: added/removed/changed/unchanged + word ops + value changes
  exposure_checklist jsonb not null default '[]',-- [{clause_type,locator,excerpt,exposure,question,alternative,reviewer_status}]
  disclaimer text not null default 'For review by the tenant''s legal team — not legal advice.',
  legal_owns_advice boolean not null default true check (legal_owns_advice),
  reviewer_status text not null default 'pending_legal_review' check (reviewer_status in ('pending_legal_review','in_review','legal_reviewed')),
  engine_version text not null
);
select mudar_app.make_business_table('clause_comparison');
create unique index clause_comparison_uq on mudar.clause_comparison(workspace_id, base_document_id, compare_document_id, engine_version);

-- ================================================================ deal strategist (suggestions only)
create table mudar.negotiation_log (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references mudar.opportunity(id) on delete cascade,
  kind text not null check (kind in ('health_check','batna_questions','concession_ladder','stakeholder_gaps','risks','note')),
  content jsonb not null default '{}',
  generated_by text not null default 'rule' check (generated_by in ('user','rule','model')),
  decision_owner_note text not null default 'Suggestions only — price and negotiation decisions stay with the adviser.'
);
select mudar_app.make_business_table('negotiation_log');
create index on mudar.negotiation_log(opportunity_id, created_at desc);

create table mudar.concession_item (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references mudar.opportunity(id) on delete cascade,
  rank int not null default 0,
  party text not null default 'landlord' check (party in ('landlord','tenant')),
  item text not null,                    -- rent_free, capex, deposit, escalation, lockin, cam, fitout_period, ...
  ask text,
  give text,
  value_basis text,                      -- e.g. "compare via finance scenario <id>" — no LLM arithmetic
  status text not null default 'proposed' check (status in ('proposed','offered','accepted','rejected','withdrawn'))
);
select mudar_app.make_business_table('concession_item');

-- ================================================================ market analyst & content editor
create table mudar.market_note (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  geography_raw text,
  metric text,
  period_label text,
  body text not null,
  facts jsonb not null default '[]',     -- deterministic computed facts with observation refs
  commentary text,
  commentary_label text not null default 'AI-drafted commentary — descriptive only, not a forecast. Verify before sharing.',
  audience text,
  status text not null default 'draft' check (status in ('draft','in_review','approved','published_manually','discarded')),
  confidentiality_checked boolean not null default false
);
select mudar_app.make_business_table('market_note');

create table mudar.content_post (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  audience text not null default 'general' check (audience in ('occupier_leadership','hr_admin','finance_procurement','landlords','general')),
  channel text not null default 'linkedin' check (channel in ('linkedin','market_note','newsletter')),
  topic text not null,
  body text,
  evidence_refs jsonb not null default '[]',
  review_checklist jsonb not null default '[]',
  status text not null default 'idea' check (status in ('idea','drafted','in_review','approved','published_manually','discarded')),
  published_url text,
  published_at timestamptz,
  draft_id uuid references mudar.draft(id),
  market_note_id uuid references mudar.market_note(id)
);
select mudar_app.make_business_table('content_post');
create index on mudar.content_post(workspace_id, week_start);

-- Knowledge capture: anonymised questions/objections/answers with source rights.
create table mudar.playbook_item (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('question','objection','answer','talk_track')),
  prompt_text text not null,
  response_text text,
  persona text,
  stage text,
  tags text[] not null default '{}',
  source_rights text not null check (source_rights in ('own_experience','client_permitted','public_source','internal_only')),
  anonymised boolean not null default false check (anonymised),
  outcome_evidence text,
  source_interaction_id uuid references mudar.interaction(id) on delete set null
);
select mudar_app.make_business_table('playbook_item');

-- Experiment design: compare triggers/personas with sufficient samples and identical outcome windows.
create table mudar.experiment (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hypothesis text not null,
  dimension text not null check (dimension in ('trigger','persona','channel','message','cohort')),
  variants jsonb not null default '[]',  -- [{key,label}]
  outcome_metric text not null default 'qualified_discussion',
  outcome_window_days int not null check (outcome_window_days between 1 and 365),
  min_sample_per_variant int not null default 30 check (min_sample_per_variant >= 1),
  start_date date,
  end_date date,
  status text not null default 'design' check (status in ('design','running','analysing','closed'))
);
select mudar_app.make_business_table('experiment');

create table mudar.experiment_subject (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references mudar.experiment(id) on delete cascade,
  variant_key text not null,
  org_id uuid references mudar.organisation(id),
  opportunity_id uuid references mudar.opportunity(id),
  exposed_at timestamptz not null,
  outcome_at timestamptz,               -- null = not (yet) observed
  outcome_note text
);
select mudar_app.make_business_table('experiment_subject', false);
create index on mudar.experiment_subject(experiment_id);
