set search_path = mudar, mudar_app, public, extensions;
-- Record-aware storage access (security review: storage.test "files of records they cannot see").
-- A file referenced by a record the caller cannot read (capture, document_version, source_object, template_asset)
-- is not readable/writable through the API, even by direct object path. Unreferenced files keep path-area rules.
create or replace function mudar_app.storage_can(name text, action text) returns boolean
language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
#variable_conflict use_variable
declare
  parts text[] := storage.foldername(name);
  ws uuid;
  area text := coalesce(parts[2], '');
  full_ref text := 'mudar-workspace-files/' || name;
  store_ref text := 'storage://mudar-workspace-files/' || name;
begin
  begin
    ws := parts[1]::uuid;
  exception when others then
    return false;
  end;
  if not mudar_app.is_member(ws) then return false; end if;
  if area = 'backups' then return mudar_app.has_role(ws, 'admin'); end if;
  if area = 'private' then return mudar_app.has_role(ws, 'owner'); end if;

  -- record-level ACL for referenced files
  if exists (select 1 from mudar.capture c where c.workspace_id = ws and name = any(c.storage_paths)
             and not mudar_app.can_read(c.workspace_id, c.classification, c.owner_user_id, 'capture', c.id))
  or exists (select 1 from mudar.document_version d where d.workspace_id = ws and d.uri in (name, full_ref, store_ref)
             and not mudar_app.can_read(d.workspace_id, d.classification, d.owner_user_id, 'document_version', d.id))
  or exists (select 1 from mudar.source_object s where s.workspace_id = ws and s.uri in (name, full_ref, store_ref)
             and not mudar_app.can_read(s.workspace_id, s.classification, s.owner_user_id, 'source_object', s.id))
  or exists (select 1 from mudar.template_asset t where t.workspace_id = ws and t.storage_path in (name, full_ref, store_ref)
             and not mudar_app.can_read(t.workspace_id, t.classification, t.owner_user_id, 'template_asset', t.id))
  then
    return false;
  end if;

  if action = 'read' then return true; end if;
  if action = 'delete' then return mudar_app.has_role(ws, 'admin'); end if;
  return mudar_app.has_role(ws, 'editor');
end $$;
revoke execute on function mudar_app.storage_can(text, text) from public, anon;
grant execute on function mudar_app.storage_can(text, text) to authenticated;

-- Workspace deletion: skip audit rows for children removed by the workspace cascade (FK would fail).
create or replace function mudar_app.audit_row() returns trigger
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  b jsonb; a jsonb; ws uuid; eid uuid; cls mudar.classification;
begin
  if tg_op in ('UPDATE','DELETE') then b := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then a := to_jsonb(new); end if;
  ws  := coalesce((a->>'workspace_id')::uuid, (b->>'workspace_id')::uuid);
  if tg_op = 'DELETE' and not exists (select 1 from mudar.workspace where id = ws) then
    return old;
  end if;
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
revoke execute on function mudar_app.audit_row() from public, anon, authenticated;
