set search_path = mudar, mudar_app, public, extensions;
-- Round 2 — Intake Engineer / Database Steward / Daily Debrief (capture + imports module).
--  * import_source: workspace list of approved import sources (name + kind). Unknown source => batch quarantined
--    ('awaiting_source') until an admin approves the source (DB-enforced: only admins approve).
--  * field_conflict: source observation vs master value disagreements (with source locator), never auto-applied.
--  * record_freshness: freshness flag per record (stale-record detector) + link to the review task.
--  * task.related_entities: a follow-up task links to the interaction AND the person/company where known.
--  * mudar_app.steward_stale_candidates(): deterministic staleness query (service role only).
-- Re-runnable: guarded DDL, create or replace, drop trigger if exists.

-- ================================================================ approved import sources
create table if not exists mudar.import_source (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  name text not null,
  name_key text not null,
  kind text not null default 'other' check (kind in ('manual_upload','folder','export','connector','email','other')),
  location text,                               -- folder path / export description (informational)
  approved boolean not null default false,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  is_default boolean not null default false,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index if not exists import_source_name_uq on mudar.import_source(workspace_id, name_key);
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'mudar' and tablename = 'import_source') then
    perform mudar_app.make_workspace_table('import_source', 'editor');
  end if;
end $$;

-- Only admins may approve (or change an approved source's identity). SECURITY INVOKER on purpose: current_user is the
-- API role for PostgREST calls; definer functions (imports_default_source) and the service role pass.
create or replace function mudar_app.imports_source_guard() returns trigger language plpgsql security invoker
set search_path = mudar, mudar_app, public, extensions as $$
begin
  if current_user = 'authenticated' then
    if new.approved and (tg_op = 'INSERT' or not old.approved or new.name_key is distinct from old.name_key or new.kind is distinct from old.kind) then
      if not mudar_app.has_role(new.workspace_id, 'admin') then
        raise exception 'only workspace admins can approve import sources' using errcode = '42501';
      end if;
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
    if tg_op = 'UPDATE' and old.approved and not new.approved and not mudar_app.has_role(new.workspace_id, 'admin') then
      raise exception 'only workspace admins can revoke import sources' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.is_default is distinct from old.is_default then
      raise exception 'the default source flag is system-managed' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' then new.is_default := false; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function mudar_app.imports_source_guard() from public, anon;
drop trigger if exists import_source_guard on mudar.import_source;
create trigger import_source_guard before insert or update on mudar.import_source
  for each row execute function mudar_app.imports_source_guard();

-- The built-in "Manual upload" source (an editor uploading through the app). Approved by default; an admin may revoke
-- it, after which uploads without a named approved source are quarantined.
create or replace function mudar_app.imports_default_source(p_ws uuid) returns uuid language plpgsql security definer
set search_path = mudar, mudar_app, public, extensions as $$
declare v uuid;
begin
  if auth.uid() is not null and not mudar_app.has_role(p_ws, 'editor') then
    raise exception 'forbidden: requires editor' using errcode = '42501';
  end if;
  select id into v from mudar.import_source where workspace_id = p_ws and is_default;
  if v is null then
    insert into mudar.import_source(workspace_id, name, name_key, kind, approved, approved_at, is_default, note)
    values (p_ws, 'Manual upload', 'manual upload', 'manual_upload', true, now(), true,
            'Signed-in editors uploading through CRE OS. Revoke to require a named approved source for every import.')
    on conflict (workspace_id, name_key) do update set is_default = true
    returning id into v;
  end if;
  return v;
end $$;
revoke execute on function mudar_app.imports_default_source(uuid) from public, anon;
grant execute on function mudar_app.imports_default_source(uuid) to authenticated, service_role;

alter table mudar.import_batch add column if not exists import_source_id uuid references mudar.import_source(id);
create index if not exists import_batch_source_idx on mudar.import_batch(import_source_id);
alter table mudar.import_batch drop constraint if exists import_batch_status_check;
alter table mudar.import_batch add constraint import_batch_status_check check (status in
  ('registered','processing','needs_mapping','completed','completed_with_exceptions','failed','awaiting_source'));

-- ================================================================ field-level conflicts (source vs master)
do $$ begin
  if to_regclass('mudar.field_conflict') is null then
    create table mudar.field_conflict (
      id uuid primary key default gen_random_uuid(),   -- deterministic in code: (entity, field, source value)
      entity_type text not null,
      entity_id uuid not null,
      field text not null,
      master_value jsonb,                              -- master value when the conflict was detected
      source_value jsonb,                              -- what the source says (raw kept in the staged row)
      material boolean not null default false,         -- from MATERIAL_FIELDS (code), never the LLM
      source_object_id uuid,
      staged_row_id uuid,
      batch_id uuid,
      source_locator text,                             -- "<sheet>!R<row>" etc.
      source_label text,                               -- "<file>@v<version>"
      observed_at timestamptz not null default now(),
      status text not null default 'open' check (status in ('open','proposed','resolved','dismissed')),
      change_proposal_id uuid references mudar.change_proposal(id) on delete set null,
      resolution_note text,
      resolved_by uuid references auth.users(id),
      resolved_at timestamptz
    );
    perform mudar_app.make_business_table('field_conflict');
    create index field_conflict_entity_idx on mudar.field_conflict(workspace_id, entity_type, entity_id);
    create index field_conflict_status_idx on mudar.field_conflict(workspace_id, status);
  end if;
end $$;

-- ================================================================ freshness flags (stale-record detector)
do $$ begin
  if to_regclass('mudar.record_freshness') is null then
    create table mudar.record_freshness (
      id uuid primary key default gen_random_uuid(),
      entity_type text not null check (entity_type in ('organisation','person','asset','availability')),
      entity_id uuid not null,
      status text not null default 'fresh' check (status in ('fresh','stale')),
      last_verified_at timestamptz,
      basis text,                                      -- what counted as the last verification
      window_days int,
      stale_since timestamptz,
      task_id uuid references mudar.task(id) on delete set null,
      verified_by uuid references auth.users(id),
      verified_note text
    );
    perform mudar_app.make_business_table('record_freshness');
    create unique index record_freshness_uq on mudar.record_freshness(workspace_id, entity_type, entity_id);
  end if;
end $$;

-- ================================================================ task links (interaction + person/company)
alter table mudar.task add column if not exists related_entities jsonb not null default '[]';
create index if not exists task_related_entities_idx on mudar.task using gin (related_entities jsonb_path_ops);

-- ================================================================ stale-record candidates (deterministic)
-- Last verification = latest of: explicit "mark verified", an applied (human-approved) change to the record, and the
-- newest source observation (asset observations, contact verified_on, availability as_of). Falls back to created_at.
-- p_windows: {"organisation": days, "person": days, "asset": days, "availability": days}; <= 0 or missing disables a type.
create or replace function mudar_app.steward_stale_candidates(p_ws uuid, p_windows jsonb, p_now timestamptz default now(), p_limit int default 500)
returns table(entity_type text, entity_id uuid, label text, owner_user_id uuid, classification mudar.classification,
              last_verified_at timestamptz, basis text, window_days int)
language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare w_org int := nullif(coalesce((p_windows->>'organisation')::int, 0), 0);
        w_per int := nullif(coalesce((p_windows->>'person')::int, 0), 0);
        w_ast int := nullif(coalesce((p_windows->>'asset')::int, 0), 0);
        w_av  int := nullif(coalesce((p_windows->>'availability')::int, 0), 0);
begin
  p_limit := least(greatest(coalesce(p_limit, 500), 1), 5000);
  return query
  with ver as (
    select f.entity_type, f.entity_id, f.last_verified_at as at from mudar.record_freshness f
     where f.workspace_id = p_ws and f.verified_by is not null and f.archived_at is null
  ), appl as (
    select cp.target_type as entity_type, cp.target_id as entity_id, max(cp.updated_at) as at from mudar.change_proposal cp
     where cp.workspace_id = p_ws and cp.state = 'applied' and cp.target_id is not null and cp.reversal_of is null
       and cp.target_type in ('organisation','person','asset','availability')
     group by 1, 2
  ), org as (
    select 'organisation'::text et, o.id, o.display_name lbl, o.owner_user_id own, o.classification cls,
           o.created_at c, (select v.at from ver v where v.entity_type = 'organisation' and v.entity_id = o.id) v,
           (select a.at from appl a where a.entity_type = 'organisation' and a.entity_id = o.id) a, null::timestamptz obs, w_org w
      from mudar.organisation o where w_org is not null and o.workspace_id = p_ws and o.archived_at is null
  ), per as (
    select 'person'::text, p.id, p.full_name, p.owner_user_id, p.classification, p.created_at,
           (select v.at from ver v where v.entity_type = 'person' and v.entity_id = p.id),
           (select a.at from appl a where a.entity_type = 'person' and a.entity_id = p.id),
           (select max(cm.verified_on)::timestamptz from mudar.contact_method cm where cm.workspace_id = p_ws and cm.person_id = p.id and cm.archived_at is null),
           w_per
      from mudar.person p where w_per is not null and p.workspace_id = p_ws and p.archived_at is null
  ), ast as (
    select 'asset'::text, s.id, s.name, s.owner_user_id, s.classification, s.created_at,
           (select v.at from ver v where v.entity_type = 'asset' and v.entity_id = s.id),
           (select a.at from appl a where a.entity_type = 'asset' and a.entity_id = s.id),
           (select max(coalesce(ao.as_of::timestamptz, ao.created_at)) from mudar.asset_observation ao where ao.workspace_id = p_ws and ao.asset_id = s.id and ao.archived_at is null),
           w_ast
      from mudar.asset s where w_ast is not null and s.workspace_id = p_ws and s.archived_at is null
  ), av as (
    select 'availability'::text, x.id, coalesce(a2.name, 'Space') || coalesce(' · ' || sp.floor_text, '') || ' (' || x.status || ')',
           x.owner_user_id, x.classification, x.as_of::timestamptz,
           (select v.at from ver v where v.entity_type = 'availability' and v.entity_id = x.id),
           (select a.at from appl a where a.entity_type = 'availability' and a.entity_id = x.id), null::timestamptz, w_av
      from (select distinct on (av0.space_id) av0.* from mudar.availability av0
             where w_av is not null and av0.workspace_id = p_ws and av0.archived_at is null
             order by av0.space_id, av0.as_of desc, av0.created_at desc) x
      join mudar.space sp on sp.id = x.space_id
      left join mudar.asset a2 on a2.id = sp.asset_id
     where x.status in ('available','under_offer')
  ), allr as (
    select * from org union all select * from per union all select * from ast union all select * from av
  ), scored as (
    select r.*, greatest(r.c, coalesce(r.v, '-infinity'), coalesce(r.a, '-infinity'), coalesce(r.obs, '-infinity')) lv from allr r
  )
  select s.et, s.id, s.lbl, s.own, s.cls, s.lv,
         case when s.v is not null and s.v = s.lv then 'marked_verified'
              when s.a is not null and s.a = s.lv then 'approved_change'
              when s.obs is not null and s.obs = s.lv then case s.et when 'person' then 'contact_verified' else 'source_observation' end
              else case s.et when 'availability' then 'snapshot_as_of' else 'created' end end,
         s.w
    from scored s
   where s.lv < p_now - make_interval(days => s.w)
   order by s.lv asc
   limit p_limit;
end $$;
revoke execute on function mudar_app.steward_stale_candidates(uuid, jsonb, timestamptz, int) from public, anon, authenticated;
grant execute on function mudar_app.steward_stale_candidates(uuid, jsonb, timestamptz, int) to service_role;

-- ================================================================ capture spans for the new claim kinds
alter table mudar.capture_span drop constraint if exists capture_span_claim_kind_check;
alter table mudar.capture_span add constraint capture_span_claim_kind_check check (claim_kind in
  ('fact','task','ambiguity','draft','mention','interaction','promise','objection','stakeholder','detail'));
