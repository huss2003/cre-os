set search_path = mudar, mudar_app, public, extensions;
-- CRE OS intelligence round 2 (intel-A): workflows 05 Prospect Researcher, 06 Network Intelligence, 15 Deal Strategist.
-- Re-runnable: create-if-not-exists / create or replace / drop trigger if exists. Touches only intelligence objects plus
-- AFTER triggers (that only enqueue jobs) on opportunity / quote / objection_log / signal_claim.

-- ================================================================ 06: introduction consent
-- Who agreed to make (or receive) an introduction, recorded by whom (owner_user_id) and when (created_at / given_on).
-- relationship_edge.intro_permission is only ever set from an active row here (never automatically).
do $$ begin
  if to_regclass('mudar.introduction_consent') is null then
    create table mudar.introduction_consent (
      id uuid primary key default gen_random_uuid(),
      edge_id uuid not null references mudar.relationship_edge(id) on delete cascade,
      introducer_person_id uuid references mudar.person(id) on delete cascade,
      introducer_user_id uuid references auth.users(id),
      target_person_id uuid not null references mudar.person(id) on delete cascade,
      given_by text not null check (given_by in ('introducer','target','both')),
      given_on date not null,
      method text not null default 'conversation' check (method in ('conversation','email','message','meeting','call','other')),
      evidence text,
      scope text,                                  -- e.g. "intro re Pune office search"
      expires_on date,
      revoked_at timestamptz,
      revoked_reason text,
      consent_permission_id uuid references mudar.consent_permission(id),
      check (introducer_person_id is not null or introducer_user_id is not null)
    );
    perform mudar_app.make_business_table('introduction_consent');
    create index introduction_consent_edge_idx on mudar.introduction_consent(edge_id);
    create index introduction_consent_target_idx on mudar.introduction_consent(target_person_id);
  end if;
end $$;

-- ================================================================ 05: source registry hygiene
create unique index if not exists research_source_registry_name_uq
  on mudar.research_source_registry(workspace_id, lower(name)) where archived_at is null;

-- ================================================================ 15: strategist
-- evidence-gap snapshots in the negotiation log
alter table mudar.negotiation_log drop constraint if exists negotiation_log_kind_check;
alter table mudar.negotiation_log add constraint negotiation_log_kind_check
  check (kind in ('health_check','batna_questions','concession_ladder','stakeholder_gaps','risks','note','evidence_gaps'));

comment on table mudar.concession_item is
  'DEPRECATED (round 2): the concession ladder lives in mudar.concession_step (deals; NPV linkage). Nothing writes here any more; kept for history only.';

-- Re-run the strategist snapshot when deal facts change. Each event has its own dedupe key (replays are no-ops);
-- the handler itself skips when the deal fingerprint is unchanged. Suggestion-only: the job never moves stages.
create or replace function mudar_app.intel_enqueue_strategy(p_ws uuid, p_opp uuid, p_reason text, p_ref text)
returns void language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  perform mudar_app.enqueue_job(p_ws, 'intelligence.strategy',
    jsonb_build_object('opportunity_id', p_opp, 'reason', p_reason, 'ref', p_ref),
    now(), format('intelligence.strategy:%s:%s:%s:%s', p_ws, p_opp, p_reason, p_ref), 3);
end $$;
revoke execute on function mudar_app.intel_enqueue_strategy(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function mudar_app.intel_opp_stage_changed() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if new.stage is distinct from old.stage and coalesce(new.outcome, 'open') = 'open' and new.archived_at is null then
    perform mudar_app.intel_enqueue_strategy(new.workspace_id, new.id, 'stage', new.stage || '@' || new.row_version::text);
  end if;
  return null;
end $$;
revoke execute on function mudar_app.intel_opp_stage_changed() from public, anon, authenticated;
drop trigger if exists intel_strategy_on_stage on mudar.opportunity;
create trigger intel_strategy_on_stage after update of stage on mudar.opportunity
  for each row execute function mudar_app.intel_opp_stage_changed();

create or replace function mudar_app.intel_quote_changed() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  if new.requirement_id is null then return null; end if;
  for r in select id from mudar.opportunity
            where workspace_id = new.workspace_id and requirement_id = new.requirement_id
              and coalesce(outcome, 'open') = 'open' and archived_at is null loop
    perform mudar_app.intel_enqueue_strategy(new.workspace_id, r.id, 'quote', new.id::text);
  end loop;
  return null;
end $$;
revoke execute on function mudar_app.intel_quote_changed() from public, anon, authenticated;
drop trigger if exists intel_strategy_on_quote on mudar.quote;
create trigger intel_strategy_on_quote after insert on mudar.quote
  for each row execute function mudar_app.intel_quote_changed();

create or replace function mudar_app.intel_objection_logged() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r record;
begin
  if new.opportunity_id is not null then
    perform mudar_app.intel_enqueue_strategy(new.workspace_id, new.opportunity_id, 'objection', new.id::text);
  elsif new.requirement_id is not null then
    for r in select id from mudar.opportunity
              where workspace_id = new.workspace_id and requirement_id = new.requirement_id
                and coalesce(outcome, 'open') = 'open' and archived_at is null loop
      perform mudar_app.intel_enqueue_strategy(new.workspace_id, r.id, 'objection', new.id::text);
    end loop;
  end if;
  return null;
end $$;
revoke execute on function mudar_app.intel_objection_logged() from public, anon, authenticated;
drop trigger if exists intel_strategy_on_objection on mudar.objection_log;
create trigger intel_strategy_on_objection after insert on mudar.objection_log
  for each row execute function mudar_app.intel_objection_logged();

-- ================================================================ 05: detected signals refresh the dossier
-- A rule-detected signal hypothesis (value_json.detected_by = 'rule') on a company with an ACTIVE watchlist entry
-- enqueues one dossier refresh per source evidence item (deduped).
create or replace function mudar_app.intel_signal_detected() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare v_src text;
begin
  if new.subject_type <> 'organisation' or coalesce(new.value_json->>'detected_by', '') <> 'rule' then return null; end if;
  if not exists (select 1 from mudar.watchlist w where w.workspace_id = new.workspace_id and w.org_id = new.subject_id
                   and w.active and w.archived_at is null) then
    return null;
  end if;
  v_src := coalesce(new.value_json->>'source_claim_id', new.id::text);
  perform mudar_app.enqueue_job(new.workspace_id, 'intelligence.research_org',
    jsonb_build_object('org_id', new.subject_id, 'signal_claim_id', new.id, 'source_claim_id', v_src),
    now(), format('intelligence.research_org:%s:%s:%s', new.workspace_id, new.subject_id, v_src), 3);
  return null;
end $$;
revoke execute on function mudar_app.intel_signal_detected() from public, anon, authenticated;
drop trigger if exists intel_research_on_signal on mudar.signal_claim;
create trigger intel_research_on_signal after insert on mudar.signal_claim
  for each row execute function mudar_app.intel_signal_detected();
