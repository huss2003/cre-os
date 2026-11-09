-- Records that exist but have no current score yet ("unranked"), per score type, with a few examples.
create or replace function mudar_app.scoring_unranked(p_workspace uuid)
returns table(kind text, total bigint, unranked bigint, examples jsonb)
language sql stable security invoker set search_path = mudar, public as $$
  with s as (select model_key, entity_id from mudar.score_result where workspace_id = p_workspace and is_current),
  o as (select id, display_name as name from mudar.organisation where workspace_id = p_workspace and archived_at is null),
  c as (select distinct p.id, p.full_name as name from mudar.person p join mudar.employment e on e.person_id = p.id and e.is_current and e.archived_at is null
        where p.workspace_id = p_workspace and p.archived_at is null),
  r as (select id, title as name from mudar.requirement where workspace_id = p_workspace and archived_at is null and status <> 'closed'),
  op as (select id, name from mudar.opportunity where workspace_id = p_workspace and archived_at is null)
  select 'company', (select count(*) from o), count(*) filter (where s.entity_id is null),
         coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name)) filter (where s.entity_id is null), '[]')
    from o left join s on s.entity_id = o.id and s.model_key = 'company'
  union all
  select 'contact', (select count(*) from c), count(*) filter (where s.entity_id is null),
         coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)) filter (where s.entity_id is null), '[]')
    from c left join s on s.entity_id = c.id and s.model_key = 'contact'
  union all
  select 'requirement', (select count(*) from r), count(*) filter (where s.entity_id is null),
         coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name)) filter (where s.entity_id is null), '[]')
    from r left join s on s.entity_id = r.id and s.model_key = 'requirement'
  union all
  select 'opportunity', (select count(*) from op), count(*) filter (where s.entity_id is null),
         coalesce(jsonb_agg(jsonb_build_object('id', op.id, 'name', op.name)) filter (where s.entity_id is null), '[]')
    from op left join s on s.entity_id = op.id and s.model_key = 'opportunity'
$$;
grant execute on function mudar_app.scoring_unranked(uuid) to authenticated, service_role;
