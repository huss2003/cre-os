-- CRE OS core platform: tenancy, access helpers, standard business-table scaffolding.
-- Spec: Part III "Canonical schema specification". All business tables carry
-- id, workspace_id, classification, owner_user_id, created_at, updated_at, row_version, archived_at.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists citext;

create schema if not exists app;
grant usage on schema app to authenticated, service_role, anon;

-- ---------------------------------------------------------------- enums
create type public.classification as enum ('public','permitted_personal','corporate_confidential','licensed_restricted');
create type public.member_role    as enum ('owner','admin','editor','viewer');
create type public.fact_status    as enum ('historical_observed','currently_confirmed','reported','ai_inference','unknown');
create type public.date_precision as enum ('day','month','quarter','year','unknown');
create type public.risk_level     as enum ('routine_internal','material_fact','identity_merge','external_message','high_value');

-- ---------------------------------------------------------------- tenancy
create table public.workspace (
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

create table public.platform_admin (            -- agency staff who onboard tenants
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.membership (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'viewer',
  allowed_classifications public.classification[] not null
    default array['public','permitted_personal']::public.classification[],
  see_all_accounts boolean not null default false,     -- owner/admin implicitly true
  display_name text,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index on public.membership(user_id);

-- explicit sharing of a record (account assignment) with a colleague
create table public.record_share (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, user_id)
);
create index on public.record_share(user_id, entity_type);

-- ---------------------------------------------------------------- access helpers
create or replace function app.uid() returns uuid language sql stable as $$ select auth.uid() $$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admin where user_id = auth.uid())
$$;

create or replace function app.member_role(ws uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  select role from public.membership where workspace_id = ws and user_id = auth.uid()
$$;

create or replace function app.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.membership where workspace_id = ws and user_id = auth.uid())
$$;

create or replace function app.has_role(ws uuid, min_role public.member_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.membership m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and array_position(array['viewer','editor','admin','owner']::public.member_role[], m.role)
          >= array_position(array['viewer','editor','admin','owner']::public.member_role[], min_role)
  )
$$;

-- Row read check: member + classification allowed + (sees all accounts | owns row | shared with user)
create or replace function app.can_read(ws uuid, cls public.classification, owner uuid, etype text, eid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.membership m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and cls = any(m.allowed_classifications)
      and ( m.role in ('owner','admin') or m.see_all_accounts or owner = auth.uid()
            or exists (select 1 from public.record_share s
                       where s.entity_type = etype and s.entity_id = eid and s.user_id = auth.uid()) )
  )
$$;

create or replace function app.can_write(ws uuid, cls public.classification, owner uuid, etype text, eid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select app.can_read(ws, cls, owner, etype, eid) and app.has_role(ws, 'editor')
$$;

-- ---------------------------------------------------------------- standard triggers
create or replace function app.touch_row() returns trigger language plpgsql as $$
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
create table public.audit_event (
  id bigserial primary key,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
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
  reversal_of bigint references public.audit_event(id),
  classification public.classification not null default 'corporate_confidential'
);
create index on public.audit_event(workspace_id, entity_type, entity_id, occurred_at desc);

create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  b jsonb; a jsonb; ws uuid; eid uuid; cls public.classification;
begin
  if tg_op in ('UPDATE','DELETE') then b := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then a := to_jsonb(new); end if;
  ws  := coalesce((a->>'workspace_id')::uuid, (b->>'workspace_id')::uuid);
  eid := coalesce((a->>'id')::uuid, (b->>'id')::uuid);
  cls := coalesce((a->>'classification')::public.classification, (b->>'classification')::public.classification, 'corporate_confidential');
  insert into public.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id,
                                 before, after, before_hash, after_hash, request_id, change_proposal_id, classification)
  values (ws, auth.uid(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), case when auth.uid() is null then 'system' else 'user' end),
          lower(tg_op), tg_table_name, eid, b, a,
          case when b is null then null else encode(extensions.digest(b::text,'sha256'),'hex') end,
          case when a is null then null else encode(extensions.digest(a::text,'sha256'),'hex') end,
          nullif(current_setting('app.request_id', true), ''),
          nullif(current_setting('app.change_proposal_id', true), '')::uuid,
          cls);
  return coalesce(new, old);
end $$;

-- Turn a table into a standard business table: columns, triggers, RLS policies, grants.
-- etype = the entity_type string used in record_share / audit (defaults to table name).
create or replace function app.make_business_table(tbl text, audited boolean default true) returns void
language plpgsql as $$
begin
  execute format($f$
    alter table public.%1$I
      add column if not exists workspace_id uuid not null references public.workspace(id) on delete cascade,
      add column if not exists classification public.classification not null default 'corporate_confidential',
      add column if not exists owner_user_id uuid references auth.users(id),
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now(),
      add column if not exists row_version bigint not null default 1,
      add column if not exists archived_at timestamptz;
    create index if not exists %1$s_ws_idx on public.%1$I(workspace_id);
    create trigger %1$s_touch before update on public.%1$I for each row execute function app.touch_row();
    alter table public.%1$I enable row level security;
    create policy %1$s_sel on public.%1$I for select to authenticated
      using (app.can_read(workspace_id, classification, owner_user_id, %2$L, id));
    create policy %1$s_ins on public.%1$I for insert to authenticated
      with check (app.has_role(workspace_id, 'editor') and app.can_read(workspace_id, classification, coalesce(owner_user_id, auth.uid()), %2$L, id));
    create policy %1$s_upd on public.%1$I for update to authenticated
      using (app.can_write(workspace_id, classification, owner_user_id, %2$L, id))
      with check (app.can_write(workspace_id, classification, owner_user_id, %2$L, id));
    create policy %1$s_del on public.%1$I for delete to authenticated
      using (app.has_role(workspace_id, 'admin'));
    grant select, insert, update, delete on public.%1$I to authenticated;
    grant all on public.%1$I to service_role;
  $f$, tbl, tbl);
  if audited then
    execute format('create trigger %1$s_audit after insert or update or delete on public.%1$I for each row execute function app.audit_row();', tbl);
  end if;
end $$;

-- Simple workspace-scoped (non-entity) tables: member read, editor write.
create or replace function app.make_workspace_table(tbl text, write_role public.member_role default 'editor') returns void
language plpgsql as $$
begin
  execute format($f$
    alter table public.%1$I enable row level security;
    create index if not exists %1$s_ws_idx on public.%1$I(workspace_id);
    create policy %1$s_sel on public.%1$I for select to authenticated using (app.is_member(workspace_id));
    create policy %1$s_mod on public.%1$I for all to authenticated
      using (app.has_role(workspace_id, %2$L)) with check (app.has_role(workspace_id, %2$L));
    grant select, insert, update, delete on public.%1$I to authenticated;
    grant all on public.%1$I to service_role;
  $f$, tbl, write_role);
end $$;

-- ---------------------------------------------------------------- tenancy RLS
alter table public.workspace enable row level security;
create policy workspace_sel on public.workspace for select to authenticated using (app.is_member(id) or app.is_platform_admin());
create policy workspace_upd on public.workspace for update to authenticated using (app.has_role(id,'owner')) with check (app.has_role(id,'owner'));
grant select, update on public.workspace to authenticated;
grant all on public.workspace to service_role;

alter table public.membership enable row level security;
create policy membership_sel on public.membership for select to authenticated using (user_id = auth.uid() or app.has_role(workspace_id,'admin'));
create policy membership_mod on public.membership for all to authenticated using (app.has_role(workspace_id,'owner')) with check (app.has_role(workspace_id,'owner'));
grant select, insert, update, delete on public.membership to authenticated;
grant all on public.membership to service_role;

alter table public.platform_admin enable row level security;
create policy platform_admin_sel on public.platform_admin for select to authenticated using (user_id = auth.uid());
grant select on public.platform_admin to authenticated;
grant all on public.platform_admin to service_role;

alter table public.record_share enable row level security;
create policy record_share_sel on public.record_share for select to authenticated using (user_id = auth.uid() or app.has_role(workspace_id,'admin'));
create policy record_share_mod on public.record_share for all to authenticated using (app.has_role(workspace_id,'admin')) with check (app.has_role(workspace_id,'admin'));
grant select, insert, update, delete on public.record_share to authenticated;
grant all on public.record_share to service_role;

-- audit_event: append-only for application roles; readable by admins (restricted classes need membership allowance)
alter table public.audit_event enable row level security;
create policy audit_sel on public.audit_event for select to authenticated
  using (app.has_role(workspace_id,'admin') and app.can_read(workspace_id, classification, null, 'audit_event', null));
revoke update, delete on public.audit_event from authenticated, anon;
grant select on public.audit_event to authenticated;
grant select, insert on public.audit_event to service_role;
grant usage on sequence public.audit_event_id_seq to service_role, authenticated;

-- convenience: current user's workspaces
create or replace view public.my_workspaces with (security_invoker = true) as
  select w.id, w.name, w.slug, w.timezone, w.status, m.role, m.allowed_classifications
  from public.workspace w join public.membership m on m.workspace_id = w.id and m.user_id = auth.uid();
grant select on public.my_workspaces to authenticated;
