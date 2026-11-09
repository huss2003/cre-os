-- Module 3 — Scoring Engine. Reuses: lead_score (brief v1, untouched), shortlist_option (property matching, match-v1),
-- signal (Module 2 signal priority), job queue (recalculation), audit via make_business_table. Re-runnable.
drop table if exists mudar.score_feedback cascade;
drop table if exists mudar.score_override cascade;
drop table if exists mudar.score_result cascade;
drop table if exists mudar.scoring_model_version cascade;
drop table if exists mudar.scoring_model cascade;

-- A scoring model per purpose (company, lead, contact, requirement, opportunity, relationship).
create table mudar.scoring_model (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key in ('company','lead','contact','requirement','opportunity','relationship')),
  name text not null,
  purpose text not null,
  active boolean not null default true,
  active_version_id uuid
);
select mudar_app.make_business_table('scoring_model');
create unique index scoring_model_key_uq on mudar.scoring_model(workspace_id, key);

-- Immutable versions: factors [{key,label,weight,unknown:'exclude'|'neutral'|'zero',description}], bands [{min,label}],
-- config {industry_weights, focus_cities, mandatory[], disqualify[]}. Old versions are kept so past scores reproduce.
create table mudar.scoring_model_version (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references mudar.scoring_model(id) on delete cascade,
  version int not null,
  factors jsonb not null,
  bands jsonb not null,
  config jsonb not null default '{}',
  note text
);
select mudar_app.make_business_table('scoring_model_version');
create unique index scoring_model_version_uq on mudar.scoring_model_version(model_id, version);
alter table mudar.scoring_model add constraint scoring_model_active_version_fk foreign key (active_version_id) references mudar.scoring_model_version(id);

-- Every calculation is a row (history). Exactly one current row per (model, entity).
create table mudar.score_result (
  id uuid primary key default gen_random_uuid(),
  model_key text not null,
  model_version_id uuid not null references mudar.scoring_model_version(id),
  entity_type text not null,
  entity_id uuid not null,
  score int not null check (score between 0 and 100),
  band text not null,
  disqualified boolean not null default false,
  confidence text not null check (confidence in ('high','medium','low','insufficient')),
  completeness int not null check (completeness between 0 and 100),
  factors jsonb not null,                 -- [{key,label,weight,value,points,max,known,explanation,evidence:[{type,id,label,url}]}]
  extra jsonb not null default '{}',      -- model-specific outputs (role class, requirement sub-scores, risks...)
  missing text[] not null default '{}',
  recommended_action text,
  inputs_hash text not null,
  trigger text not null default 'manual',
  previous_score int,
  change_reason text,
  is_current boolean not null default true,
  calculated_at timestamptz not null default now()
);
select mudar_app.make_business_table('score_result');
create unique index score_result_current_uq on mudar.score_result(workspace_id, model_key, entity_id) where is_current;
create index score_result_rank on mudar.score_result(workspace_id, model_key, score desc) where is_current;
create index score_result_hist on mudar.score_result(workspace_id, entity_id, calculated_at desc);

-- Manual priority overrides and relationship assessments: never overwrite the calculated score.
create table mudar.score_override (
  id uuid primary key default gen_random_uuid(),
  model_key text not null,
  entity_id uuid not null,
  kind text not null default 'priority' check (kind in ('priority','relationship_assessment')),
  original_score int,
  value text not null,                    -- band label (priority) or strong/active/developing/weak/none (assessment)
  reason text not null check (length(btrim(reason)) >= 3),
  active boolean not null default true
);
select mudar_app.make_business_table('score_override');
create index on mudar.score_override(workspace_id, model_key, entity_id) where active;

create table mudar.score_feedback (
  id uuid primary key default gen_random_uuid(),
  score_result_id uuid not null references mudar.score_result(id) on delete cascade,
  kind text not null check (kind in ('accurate','too_high','too_low','wrong_company','missing_evidence','incorrect_requirement','incorrect_contact','incorrect_match')),
  comment text,
  status text not null default 'new' check (status in ('new','accepted','rejected'))
);
select mudar_app.make_business_table('score_feedback');

-- Event-triggered recalculation: data changes enqueue a deduplicated job (one per entity per minute).
create or replace function mudar_app.scoring_enqueue() returns trigger language plpgsql security definer
set search_path = mudar, mudar_app, public as $$
declare r record; org uuid; ent uuid; et text;
begin
  r := coalesce(new, old);
  et := tg_table_name;
  ent := r.id;
  org := case tg_table_name
    when 'signal' then r.org_id when 'requirement' then r.org_id when 'opportunity' then r.org_id
    when 'employment' then r.org_id else null end;
  if tg_table_name = 'lease_event' then
    select l.tenant_org_id into org from mudar.lease l where l.id = r.lease_id;
  elsif tg_table_name = 'lease' then org := r.tenant_org_id;
  end if;
  if tg_table_name = 'employment' then et := 'person'; ent := r.person_id; end if;
  perform mudar_app.enqueue_job(r.workspace_id, 'scoring.recalc',
    jsonb_build_object('entity_type', et, 'entity_id', ent, 'org_id', org, 'trigger', tg_table_name || '.' || lower(tg_op)),
    now() + interval '20 seconds', 'scoring.recalc:' || coalesce(org, ent)::text || ':' || to_char(now(), 'YYYYMMDDHH24MI'), 3);
  return null;
exception when others then return null;   -- never block the business write
end $$;

do $$ declare t text; begin
  foreach t in array array['signal','lease','lease_event','requirement','opportunity','employment'] loop
    execute format('drop trigger if exists scoring_enqueue on mudar.%I', t);
    execute format('create trigger scoring_enqueue after insert or update on mudar.%I for each row execute function mudar_app.scoring_enqueue()', t);
  end loop;
end $$;
notify pgrst, 'reload schema';
