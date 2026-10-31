set search_path = mudar, mudar_app, public, extensions;
-- Core hardening from docs/security-review.md (H1, H2, M1, M8, Low findings). Re-runnable.

-- H2: record_share must belong to the same workspace as the row being read.
create or replace function mudar_app.can_read(ws uuid, cls mudar.classification, owner uuid, etype text, eid uuid)
returns boolean language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (
    select 1 from mudar.membership m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and cls = any(m.allowed_classifications)
      and ( m.role in ('owner','admin') or m.see_all_accounts or owner = auth.uid()
            or exists (select 1 from mudar.record_share s
                       where s.workspace_id = ws and s.entity_type = etype and s.entity_id = eid and s.user_id = auth.uid()) )
  )
$$;

-- record_share rows may only point at a member of the same workspace
create or replace function mudar_app.record_share_check() returns trigger language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if not exists (select 1 from mudar.membership where workspace_id = new.workspace_id and user_id = new.user_id) then
    raise exception 'record_share user is not a member of the workspace';
  end if;
  return new;
end $$;
drop trigger if exists record_share_check on mudar.record_share;
create trigger record_share_check before insert or update on mudar.record_share for each row execute function mudar_app.record_share_check();

-- M1: workspace status and AI budget are platform-admin (or service role) only; owners may toggle ai_paused (kill switch) and name/timezone.
create or replace function mudar_app.workspace_guard() returns trigger language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
begin
  if auth.uid() is not null and not mudar_app.is_platform_admin() then
    if new.status is distinct from old.status or new.monthly_ai_budget_inr is distinct from old.monthly_ai_budget_inr
       or new.slug is distinct from old.slug or new.id is distinct from old.id then
      raise exception 'only platform administrators can change workspace status, slug or AI budget' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists workspace_guard on mudar.workspace;
create trigger workspace_guard before update on mudar.workspace for each row execute function mudar_app.workspace_guard();

-- Suspended/archived workspaces: members lose access to business data (checked in can_read/has_role/is_member).
create or replace function mudar_app.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (select 1 from mudar.membership m join mudar.workspace w on w.id = m.workspace_id
                 where m.workspace_id = ws and m.user_id = auth.uid() and w.status in ('active','paused'))
$$;

-- H1: storage paths. <ws>/backups/** admin-only, <ws>/private/** owner-only, everything else members (read) / editors (write).
drop policy if exists "ws files read" on storage.objects;
drop policy if exists "ws files write" on storage.objects;
drop policy if exists "ws files update" on storage.objects;
drop policy if exists "ws files delete" on storage.objects;

create or replace function mudar_app.storage_can(name text, action text) returns boolean
language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  parts text[] := storage.foldername(name);
  ws uuid;
  area text := coalesce(parts[2], '');
begin
  begin
    ws := parts[1]::uuid;
  exception when others then
    return false;
  end;
  if not mudar_app.is_member(ws) then return false; end if;
  if area = 'backups' then return mudar_app.has_role(ws, 'admin'); end if;
  if area = 'private' then return mudar_app.has_role(ws, 'owner'); end if;
  if action = 'read' then return true; end if;
  if action = 'delete' then return mudar_app.has_role(ws, 'admin'); end if;
  return mudar_app.has_role(ws, 'editor');
end $$;

create policy "ws files read" on storage.objects for select to authenticated
  using (bucket_id = 'mudar-workspace-files' and mudar_app.storage_can(name, 'read'));
create policy "ws files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'mudar-workspace-files' and mudar_app.storage_can(name, 'write'));
create policy "ws files update" on storage.objects for update to authenticated
  using (bucket_id = 'mudar-workspace-files' and mudar_app.storage_can(name, 'write'))
  with check (bucket_id = 'mudar-workspace-files' and mudar_app.storage_can(name, 'write'));
create policy "ws files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'mudar-workspace-files' and mudar_app.storage_can(name, 'delete'));

-- M8: idempotency keys for mutating API routes (route() helper stores the response and replays it).
create table if not exists mudar.idempotency_key (
  workspace_id uuid,
  user_id uuid not null,
  key text not null,
  route text not null,
  request_hash text not null,
  status int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, route, key)
);
alter table mudar.idempotency_key enable row level security;
drop policy if exists idem_own on mudar.idempotency_key;
create policy idem_own on mudar.idempotency_key for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on mudar.idempotency_key to authenticated;
grant all on mudar.idempotency_key to service_role;

-- Low: no anonymous access to application tables/views; audit_event cannot be truncated by app roles.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'mudar' loop
    execute format('revoke all on mudar.%I from anon', r.tablename);
  end loop;
  for r in select viewname from pg_views where schemaname = 'mudar' loop
    execute format('revoke all on mudar.%I from anon', r.viewname);
  end loop;
end $$;
revoke truncate, references, trigger on mudar.audit_event from authenticated;
alter default privileges in schema mudar revoke all on tables from anon;

-- Low: DDL / internal helpers are not callable through the API.
revoke execute on function mudar_app.make_business_table(text, boolean) from public, anon, authenticated;
revoke execute on function mudar_app.make_workspace_table(text, mudar.member_role) from public, anon, authenticated;
revoke execute on function mudar_app.audit_row() from public, anon, authenticated;
revoke execute on function mudar_app.touch_row() from public, anon, authenticated;
revoke execute on function mudar_app.storage_can(text, text) from anon;
revoke usage on schema mudar_app from anon;

-- Trigger/helper functions added above are not API-callable by anon.
revoke execute on function mudar_app.record_share_check() from public, anon, authenticated;
revoke execute on function mudar_app.workspace_guard() from public, anon, authenticated;
revoke execute on function mudar_app.storage_can(text, text) from public, anon;
grant execute on function mudar_app.storage_can(text, text) to authenticated;
