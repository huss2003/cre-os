-- New interactions (linked to a company or a current employee) trigger scoring recalculation for that company.
create or replace function mudar_app.scoring_enqueue_interaction() returns trigger language plpgsql security definer
set search_path = mudar, mudar_app, public as $$
declare org uuid;
begin
  if new.entity_type = 'organisation' then org := new.entity_id;
  elsif new.entity_type = 'person' then
    select e.org_id into org from mudar.employment e where e.person_id = new.entity_id and e.is_current and e.archived_at is null limit 1;
  end if;
  if org is null then return null; end if;
  perform mudar_app.enqueue_job(new.workspace_id, 'scoring.recalc',
    jsonb_build_object('entity_type', 'organisation', 'entity_id', org, 'org_id', org, 'trigger', 'interaction.insert'),
    now() + interval '20 seconds', 'scoring.recalc:' || org::text || ':' || to_char(now(), 'YYYYMMDDHH24MI'), 3);
  return null;
exception when others then return null;
end $$;
drop trigger if exists scoring_enqueue on mudar.interaction_link;
create trigger scoring_enqueue after insert on mudar.interaction_link for each row execute function mudar_app.scoring_enqueue_interaction();
