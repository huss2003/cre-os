-- DB-385: selecting the canonical value among conflicting observations goes through Approvals.
create or replace function mudar_app.cx_allowed_tables() returns text[] language sql immutable as $$
  select array['organisation','organisation_relation','person','contact_method','employment','relationship_edge',
               'geography','asset','space','availability','lease','lease_event','market_transaction','market_observation',
               'requirement','stakeholder','opportunity','quote','shortlist_option','fee_milestone','interaction',
               'interaction_link','task','meeting_visit','signal_claim','entity_alias','source_object','observation']
$$;
