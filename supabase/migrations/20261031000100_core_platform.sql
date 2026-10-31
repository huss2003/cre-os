-- CRE OS lives in its own schemas (mudar = tables/types/views, mudar_app = functions) so it can share a Supabase project.
create schema if not exists mudar;
create schema if not exists mudar_app;
grant usage on schema mudar to authenticated, service_role;
set search_path = mudar, mudar_app, public, extensions;
-- CRE OS core platform: tenancy, access helpers, standard business-table scaffolding.
-- Spec: Part III "Canonical schema specification". All business tables carry
-- id, workspace_id, classification, owner_user_id, created_at, updated_at, row_version, archived_at.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;

create schema if not exists mudar_app;
grant usage on schema mudar_app to authenticated, service_role, anon;

-- ---------------------------------------------------------------- enums
create type mudar.classification as enum ('public','permitted_personal','corporate_confidential','licensed_restricted');
create type mudar.member_role    as enum ('owner','admin','editor','viewer');
create type mudar.fact_status    as enum ('historical_observed','currently_confirmed','reported','ai_inference','unknown');
create type mudar.date_precision as enum ('day','month','quarter','year','unknown');
create type mudar.risk_level     as enum ('routine_internal','material_fact','identity_merge','external_message','high_value');

-- ---------------------------------------------------------------- tenancy
create table mudar.workspace (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null unique,
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  status text not null default 'active' check (status in ('active','paused','suspended','archived')),
  ai_paused boolean not null default false,            -- kill switch: suspend external ingestion/AI calls
  monthly_ai_budget_inr numeric(12,2) not null default 3000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table mudar.platform_admin (            -- agency staff who onboard tenants
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table mudar.membership (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role mudar.member_role not null default 'viewer',
  allowed_classifications mudar.classification[] not null
    default array['public','permitted_personal']::mudar.classification[],
  see_all_accounts boolean not null default false,     -- owner/admin implicitly true
  display_name text,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index on mudar.membership(user_id);

-- explicit sharing of a record (account assignment) with a colleague
create table mudar.record_share (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, user_id)
);
create index on mudar.record_share(user_id, entity_type);

-- ---------------------------------------------------------------- access helpers
create or replace function mudar_app.uid() returns uuid language sql stable as $$ select auth.uid() $$;

create or replace function mudar_app.is_platform_admin() returns boolean
language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (select 1 from mudar.platform_admin where user_id = auth.uid())
$$;

create or replace function mudar_app.member_role(ws uuid) returns mudar.member_role
language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select role from mudar.membership where workspace_id = ws and user_id = auth.uid()
$$;

create or replace function mudar_app.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (select 1 from mudar.membership where workspace_id = ws and user_id = auth.uid())
$$;

create or replace function mudar_app.has_role(ws uuid, min_role mudar.member_role) returns boolean
language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (
    select 1 from mudar.membership m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and array_position(array['viewer','editor','admin','owner']::mudar.member_role[], m.role)
          >= array_position(array['viewer','editor','admin','owner']::mudar.member_role[], min_role)
  )
$$;

-- Row read check: member + classification allowed + (sees all accounts | owns row | shared with user)
create or replace function mudar_app.can_read(ws uuid, cls mudar.classification, owner uuid, etype text, eid uuid)
returns boolean language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (
    select 1 from mudar.membership m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and cls = any(m.allowed_classifications)
      and ( m.role in ('owner','admin') or m.see_all_accounts or owner = auth.uid()
            or exists (select 1 from mudar.record_share s
                       where s.entity_type = etype and s.entity_id = eid and s.user_id = auth.uid()) )
  )
$$;

create or replace function mudar_app.can_write(ws uuid, cls mudar.classification, owner uuid, etype text, eid uuid)
returns boolean language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select mudar_app.can_read(ws, cls, owner, etype, eid) and mudar_app.has_role(ws, 'editor')
$$;

-- ---------------------------------------------------------------- standard triggers
create or replace function mudar_app.touch_row() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.row_version is distinct from old.row_version and new.row_version <> old.row_version + 1 then
      raise exception 'row_version conflict on %.%: expected %, got %', tg_table_schema, tg_table_name, old.row_version + 1, new.row_version
        using errcode = '40001';
    end if;
    new.row_version := old.row_version + 1;
    new.updated_at := now();
    if new.workspace_id <> old.workspace_id then
      raise exception 'workspace_id is immutable';
    end if;
  end if;
  return new;
end $$;

-- audit_event is created in this file; generic audit trigger writes before/after for every business table
create table mudar.audit_event (
  id bigserial primary key,
  workspace_id uuid not null references mudar.workspace(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user','job','system','model')),
  action text not null,                    -- insert/update/delete/approve/apply/reverse/merge/send_marked/...
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  before_hash text,
  after_hash text,
  request_id text,
  job_id uuid,
  model text,
  change_proposal_id uuid,
  reversal_of bigint references mudar.audit_event(id),
  classification mudar.classification not null default 'corporate_confidential'
);
create index on mudar.audit_event(workspace_id, entity_type, entity_id, occurred_at desc);

create or replace function mudar_app.audit_row() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  b jsonb; a jsonb; ws uuid; eid uuid; cls mudar.classification;
begin
  if tg_op in ('UPDATE','DELETE') then b := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then a := to_jsonb(new); end if;
  ws  := coalesce((a->>'workspace_id')::uuid, (b->>'workspace_id')::uuid);
  eid := coalesce((a->>'id')::uuid, (b->>'id')::uuid);
  cls := coalesce((a->>'classification')::mudar.classification, (b->>'classification')::mudar.classification, 'corporate_confidential');
  insert into mudar.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id,
                                 before, after, before_hash, after_hash, request_id, change_proposal_id, classification)
  values (ws, auth.uid(),
          coalesce(nullif(current_setting('mudar_app.actor_kind', true), ''), case when auth.uid() is null then 'system' else 'user' end),
          lower(tg_op), tg_table_name, eid, b, a,
          case when b is null then null else encode(extensions.digest(b::text,'sha256'),'hex') end,
          case when a is null then null else encode(extensions.digest(a::text,'sha256'),'hex') end,
          nullif(current_setting('mudar_app.request_id', true), ''),
          nullif(current_setting('mudar_app.change_proposal_id', true), '')::uuid,
          cls);
  return coalesce(new, old);
end $$;

-- Turn a table into a standard business table: columns, triggers, RLS policies, grants.
-- etype = the entity_type string used in record_share / audit (defaults to table name).
create or replace function mudar_app.make_business_table(tbl text, audited boolean default true) returns void
language plpgsql as $$
begin
  execute format($f$
    alter table mudar.%1$I
      add column if not exists workspace_id uuid not null references mudar.workspace(id) on delete cascade,
      add column if not exists classification mudar.classification not null default 'corporate_confidential',
      add column if not exists owner_user_id uuid references auth.users(id),
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now(),
      add column if not exists row_version bigint not null default 1,
      add column if not exists archived_at timestamptz;
    create index if not exists %1$s_ws_idx on mudar.%1$I(workspace_id);
    create trigger %1$s_touch before update on mudar.%1$I for each row execute function mudar_app.touch_row();
    alter table mudar.%1$I enable row level security;
    create policy %1$s_sel on mudar.%1$I for select to authenticated
      using (mudar_app.can_read(workspace_id, classification, owner_user_id, %2$L, id));
    create policy %1$s_ins on mudar.%1$I for insert to authenticated
      with check (mudar_app.has_role(workspace_id, 'editor') and mudar_app.can_read(workspace_id, classification, coalesce(owner_user_id, auth.uid()), %2$L, id));
    create policy %1$s_upd on mudar.%1$I for update to authenticated
      using (mudar_app.can_write(workspace_id, classification, owner_user_id, %2$L, id))
      with check (mudar_app.can_write(workspace_id, classification, owner_user_id, %2$L, id));
    create policy %1$s_del on mudar.%1$I for delete to authenticated
      using (mudar_app.has_role(workspace_id, 'admin'));
    grant select, insert, update, delete on mudar.%1$I to authenticated;
    grant all on mudar.%1$I to service_role;
  $f$, tbl, tbl);
  if audited then
    execute format('create trigger %1$s_audit after insert or update or delete on mudar.%1$I for each row execute function mudar_app.audit_row();', tbl);
  end if;
end $$;

-- Simple workspace-scoped (non-entity) tables: member read, editor write.
create or replace function mudar_app.make_workspace_table(tbl text, write_role mudar.member_role default 'editor') returns void
language plpgsql as $$
begin
  execute format($f$
    alter table mudar.%1$I enable row level security;
    create index if not exists %1$s_ws_idx on mudar.%1$I(workspace_id);
    create policy %1$s_sel on mudar.%1$I for select to authenticated using (mudar_app.is_member(workspace_id));
    create policy %1$s_mod on mudar.%1$I for all to authenticated
      using (mudar_app.has_role(workspace_id, %2$L)) with check (mudar_app.has_role(workspace_id, %2$L));
    grant select, insert, update, delete on mudar.%1$I to authenticated;
    grant all on mudar.%1$I to service_role;
  $f$, tbl, write_role);
end $$;

-- ---------------------------------------------------------------- tenancy RLS
alter table mudar.workspace enable row level security;
create policy workspace_sel on mudar.workspace for select to authenticated using (mudar_app.is_member(id) or mudar_app.is_platform_admin());
create policy workspace_upd on mudar.workspace for update to authenticated using (mudar_app.has_role(id,'owner')) with check (mudar_app.has_role(id,'owner'));
grant select, update on mudar.workspace to authenticated;
grant all on mudar.workspace to service_role;

alter table mudar.membership enable row level security;
create policy membership_sel on mudar.membership for select to authenticated using (user_id = auth.uid() or mudar_app.has_role(workspace_id,'admin'));
create policy membership_mod on mudar.membership for all to authenticated using (mudar_app.has_role(workspace_id,'owner')) with check (mudar_app.has_role(workspace_id,'owner'));
grant select, insert, update, delete on mudar.membership to authenticated;
grant all on mudar.membership to service_role;

alter table mudar.platform_admin enable row level security;
create policy platform_admin_sel on mudar.platform_admin for select to authenticated using (user_id = auth.uid());
grant select on mudar.platform_admin to authenticated;
grant all on mudar.platform_admin to service_role;

alter table mudar.record_share enable row level security;
create policy record_share_sel on mudar.record_share for select to authenticated using (user_id = auth.uid() or mudar_app.has_role(workspace_id,'admin'));
create policy record_share_mod on mudar.record_share for all to authenticated using (mudar_app.has_role(workspace_id,'admin')) with check (mudar_app.has_role(workspace_id,'admin'));
grant select, insert, update, delete on mudar.record_share to authenticated;
grant all on mudar.record_share to service_role;

-- audit_event: append-only for application roles; readable by admins (restricted classes need membership allowance)
alter table mudar.audit_event enable row level security;
create policy audit_sel on mudar.audit_event for select to authenticated
  using (mudar_app.has_role(workspace_id,'admin') and mudar_app.can_read(workspace_id, classification, null, 'audit_event', null));
revoke update, delete on mudar.audit_event from authenticated, anon;
grant select on mudar.audit_event to authenticated;
grant select, insert on mudar.audit_event to service_role;
grant usage on sequence mudar.audit_event_id_seq to service_role, authenticated;

-- convenience: current user's workspaces
create or replace view mudar.my_workspaces with (security_invoker = true) as
  select w.id, w.name, w.slug, w.timezone, w.status, m.role, m.allowed_classifications
  from mudar.workspace w join mudar.membership m on m.workspace_id = w.id and m.user_id = auth.uid();
grant select on mudar.my_workspaces to authenticated;
