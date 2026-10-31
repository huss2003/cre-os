-- CRE OS integrations: draft approval binding hardening (docs/security-review.md M2).
--  * content_hash is computed in SQL from recipient + subject + body + attachments: set on insert, and on update a
--    client-supplied hash that does not match the content is rejected (no forged hashes).
--  * approved / opened_for_send / marked_sent transitions and the approved_* / marked_sent_* / sent_evidence columns
--    can only be written through SECURITY DEFINER functions (app.approve_draft, app.open_draft_for_send,
--    app.mark_draft_sent) which check role, suppression, the approval row and the hash. Jobs (service_role) may
--    reconcile sent drafts from Sent Items evidence.
--  * column-level UPDATE grants: authenticated cannot write approval/sent columns at all.
--  * draft approvals in public.approval can only be created by app.approve_draft.
-- Re-runnable (create or replace / drop if exists; no data is dropped).

-- ---------------------------------------------------------------- canonical content hash
-- Must stay byte-identical with draftHash() in src/lib/services/drafts.ts:
--   sha256_hex("draft.v1|" + f(person) + "|" + f(address) + "|" + f(subject) + "|" + f(body) + "|" + f(attachments))
--   f(null) = "~", f(x) = <utf8 byte length> ":" x ; attachments = lower-case uuids sorted (C collation) joined by ","
create or replace function app.draft_hash_field(x text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case when x is null then '~' else octet_length(x)::text || ':' || x end
$$;

create or replace function app.draft_content_hash(p_person uuid, p_address text, p_subject text, p_body text, p_attachments uuid[])
returns text language sql immutable parallel safe set search_path = pg_catalog, app as $$
  select encode(sha256(convert_to(
    'draft.v1|' || app.draft_hash_field(p_person::text)
    || '|' || app.draft_hash_field(p_address)
    || '|' || app.draft_hash_field(p_subject)
    || '|' || app.draft_hash_field(p_body)
    || '|' || app.draft_hash_field(coalesce((select string_agg(a, ',' order by a collate "C")
                                             from (select lower(u::text) as a from unnest(p_attachments) u) s), '')),
    'UTF8')), 'hex')
$$;

-- Suppression / consent for a draft recipient (person-level and address-level, incl. erasure tombstones).
create or replace function app.draft_recipient_suppressed(p_ws uuid, p_person uuid, p_address text, p_channel text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select
    (p_person is not null and (
       exists (select 1 from public.consent_permission c where c.workspace_id = p_ws and c.person_id = p_person and c.archived_at is null
                 and (c.suppressed or (c.revoked_at is not null and (c.channel is null or c.channel = p_channel))))
    or exists (select 1 from public.contact_method m where m.workspace_id = p_ws and m.person_id = p_person and m.suppressed)
    or exists (select 1 from public.suppression_tombstone t where t.workspace_id = p_ws and t.person_id = p_person and t.archived_at is null)))
  or (coalesce(trim(p_address), '') <> '' and (
       exists (select 1 from public.suppression_tombstone t where t.workspace_id = p_ws and t.archived_at is null
                 and t.value_hash = encode(extensions.digest(lower(trim(p_address)), 'sha256'), 'hex'))
    or exists (select 1 from public.contact_method m where m.workspace_id = p_ws and m.suppressed
                 and m.value_hash = encode(extensions.digest(lower(trim(p_address)), 'sha256'), 'hex'))))
$$;
revoke all on function app.draft_recipient_suppressed(uuid, uuid, text, text) from public, anon;
grant execute on function app.draft_recipient_suppressed(uuid, uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------- guard trigger
-- "Privileged" = not an API end-user role: SECURITY DEFINER functions below (current_user = owner) and service_role jobs.
create or replace function app.integrations_draft_guard() returns trigger language plpgsql set search_path = public, app as $$
declare
  v_hash text := app.draft_content_hash(new.recipient_person_id, new.recipient_address, new.subject, new.body, new.attachment_document_ids);
  v_priv boolean := current_user not in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    new.content_hash := v_hash;               -- never trust a client hash on insert
    if not v_priv and (new.state not in ('drafted', 'paused')
        or new.approved_hash is not null or new.approved_by is not null or new.approved_at is not null
        or new.marked_sent_at is not null or new.marked_sent_by is not null or new.sent_evidence is not null) then
      raise exception 'drafts are created unapproved; approve via app.approve_draft' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if new.content_hash is distinct from v_hash then
    raise exception 'content_hash does not match draft content (recompute it from recipient, subject, body and attachments)' using errcode = '22023';
  end if;
  if new.channel is distinct from old.channel then
    raise exception 'draft channel cannot be changed; create a new draft' using errcode = '22023';
  end if;
  if old.state in ('marked_sent', 'reconciled_sent') then
    if new.state not in ('marked_sent', 'reconciled_sent') then
      raise exception 'sent drafts cannot be reopened' using errcode = '22023';
    end if;
    if new.content_hash is distinct from old.content_hash then
      raise exception 'sent drafts cannot be edited' using errcode = '22023';
    end if;
  end if;

  if not v_priv then
    if new.approved_hash is distinct from old.approved_hash or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at or new.marked_sent_at is distinct from old.marked_sent_at
       or new.marked_sent_by is distinct from old.marked_sent_by or new.sent_evidence is distinct from old.sent_evidence then
      raise exception 'approval and sent fields are set only by app.approve_draft / app.mark_draft_sent' using errcode = '42501';
    end if;
    if new.state is distinct from old.state and new.state not in ('drafted', 'paused', 'discarded') then
      raise exception 'state % is reached only through app.approve_draft / app.open_draft_for_send / app.mark_draft_sent', new.state using errcode = '22023';
    end if;
  end if;

  -- content change, pause, discard or explicit un-approve drops the approval
  if old.approved_hash is not null and old.state not in ('marked_sent', 'reconciled_sent')
     and (new.content_hash is distinct from old.content_hash
          or (new.state is distinct from old.state and new.state in ('drafted', 'paused', 'discarded'))) then
    new.approved_hash := null;
    new.approved_by := null;
    new.approved_at := null;
    if new.state in ('approved', 'opened_for_send') then new.state := 'drafted'; end if;
  end if;

  if new.state in ('approved', 'opened_for_send', 'marked_sent') and new.state is distinct from old.state
     and (new.approved_hash is null or new.approved_hash <> v_hash) then
    raise exception 'draft approval does not match current content (re-approve required)' using errcode = '22023';
  end if;
  if new.state = 'reconciled_sent' and old.state not in ('approved', 'opened_for_send', 'marked_sent', 'reconciled_sent') then
    raise exception 'only approved drafts can be reconciled as sent' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists integrations_draft_guard on public.draft;
create trigger integrations_draft_guard before insert or update on public.draft
  for each row execute function app.integrations_draft_guard();

-- Column grants: end users may edit content and park/discard, never approval/sent bookkeeping or channel.
revoke update on public.draft from authenticated;
grant update (recipient_person_id, recipient_display, recipient_address, subject, body, attachment_document_ids,
              opportunity_id, org_id, sequence_key, sequence_step, purpose, content_hash, state, pause_reason,
              classification, owner_user_id, archived_at, updated_at, row_version)
  on public.draft to authenticated;

-- ---------------------------------------------------------------- approval rows for drafts: definer-only
create or replace function app.integrations_draft_approval_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if (tg_op = 'INSERT' and new.subject_type = 'draft')
       or (tg_op = 'UPDATE' and (old.subject_type = 'draft' or new.subject_type = 'draft')) then
      raise exception 'draft approvals are recorded only by app.approve_draft' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists integrations_draft_approval_guard on public.approval;
create trigger integrations_draft_approval_guard before insert or update on public.approval
  for each row execute function app.integrations_draft_approval_guard();

-- ---------------------------------------------------------------- definer transitions
-- Load + authorise: caller must be an editor who can write this draft.
create or replace function app.draft_for_action(p_draft uuid) returns public.draft
language plpgsql stable security definer set search_path = public, app as $$
declare d public.draft;
begin
  select * into d from public.draft where id = p_draft;
  if not found or not app.can_read(d.workspace_id, d.classification, d.owner_user_id, 'draft', d.id) then
    raise exception 'draft not found' using errcode = 'P0002';
  end if;
  if not app.can_write(d.workspace_id, d.classification, d.owner_user_id, 'draft', d.id) then
    raise exception 'editor role required to approve or send drafts' using errcode = '42501';
  end if;
  return d;
end $$;
revoke all on function app.draft_for_action(uuid) from public, anon, authenticated;

create or replace function app.approve_draft(p_draft uuid, p_reviewed_hash text default null, p_note text default null, p_expected_version bigint default null)
returns public.draft language plpgsql security definer set search_path = public, app as $$
declare
  d public.draft := app.draft_for_action(p_draft);
  v_hash text;
  v_uid uuid := auth.uid();
begin
  perform 1 from public.draft where id = d.id for update;
  select * into d from public.draft where id = d.id;
  if d.state not in ('drafted', 'approved') then
    raise exception 'cannot approve a % draft', d.state using errcode = '22023';
  end if;
  if p_expected_version is not null and d.row_version <> p_expected_version then
    raise exception 'draft changed since it was loaded; reload and retry' using errcode = '40001';
  end if;
  v_hash := app.draft_content_hash(d.recipient_person_id, d.recipient_address, d.subject, d.body, d.attachment_document_ids);
  if d.content_hash <> v_hash then
    raise exception 'stored content hash does not match content' using errcode = '22023';
  end if;
  if p_reviewed_hash is not null and p_reviewed_hash <> v_hash then
    raise exception 'draft changed since you reviewed it' using errcode = '40001';
  end if;
  if app.draft_recipient_suppressed(d.workspace_id, d.recipient_person_id, d.recipient_address, d.channel) then
    raise exception 'recipient is suppressed or consent revoked' using errcode = 'CRSUP';
  end if;
  insert into public.approval(workspace_id, subject_type, subject_id, approver_user_id, approved_hash, decision, note, owner_user_id, classification)
  values (d.workspace_id, 'draft', d.id, v_uid, v_hash, 'approved', p_note, coalesce(d.owner_user_id, v_uid), d.classification);
  update public.draft set state = 'approved', approved_hash = v_hash, approved_by = v_uid, approved_at = now(), pause_reason = null
   where id = d.id returning * into d;
  insert into public.draft_event(workspace_id, draft_id, event, actor_user_id, actor_kind, content_hash, owner_user_id, classification)
  values (d.workspace_id, d.id, 'approved', v_uid, 'user', v_hash, d.owner_user_id, d.classification);
  return d;
end $$;

-- A live approval: draft fields bound to the current hash AND a matching approval row by the same approver.
create or replace function app.draft_approval_live(d public.draft) returns boolean
language sql stable security definer set search_path = public, app as $$
  select d.approved_hash is not null
     and d.approved_hash = app.draft_content_hash(d.recipient_person_id, d.recipient_address, d.subject, d.body, d.attachment_document_ids)
     and d.approved_hash = d.content_hash
     and exists (select 1 from public.approval a where a.workspace_id = d.workspace_id and a.subject_type = 'draft' and a.subject_id = d.id
                   and a.decision = 'approved' and a.approved_hash = d.approved_hash and a.approver_user_id = d.approved_by
                   and a.archived_at is null and (a.expires_at is null or a.expires_at > now()))
$$;
revoke all on function app.draft_approval_live(public.draft) from public, anon, authenticated;

-- "Open to send": NOT a send. Re-checks suppression; a suppressed recipient parks the draft (state paused) instead.
create or replace function app.open_draft_for_send(p_draft uuid) returns public.draft
language plpgsql security definer set search_path = public, app as $$
declare
  d public.draft := app.draft_for_action(p_draft);
  v_uid uuid := auth.uid();
begin
  select * into d from public.draft where id = d.id for update;
  if d.state not in ('approved', 'opened_for_send') then
    raise exception 'approve the draft before opening it to send' using errcode = '22023';
  end if;
  if not app.draft_approval_live(d) then
    raise exception 'approval no longer matches the content; re-approve' using errcode = '40001';
  end if;
  if app.draft_recipient_suppressed(d.workspace_id, d.recipient_person_id, d.recipient_address, d.channel) then
    update public.draft set state = 'paused', pause_reason = 'suppressed' where id = d.id returning * into d;
    insert into public.draft_event(workspace_id, draft_id, event, actor_user_id, actor_kind, content_hash, owner_user_id, classification)
    values (d.workspace_id, d.id, 'blocked_suppressed', v_uid, 'user', d.content_hash, d.owner_user_id, d.classification);
    return d;
  end if;
  if d.state <> 'opened_for_send' then
    update public.draft set state = 'opened_for_send' where id = d.id returning * into d;
    insert into public.draft_event(workspace_id, draft_id, event, actor_user_id, actor_kind, content_hash, owner_user_id, classification)
    values (d.workspace_id, d.id, 'opened_for_send', v_uid, 'user', d.content_hash, d.owner_user_id, d.classification);
  end if;
  return d;
end $$;

-- User asserts they sent it manually (sent_evidence = 'user_assertion'); idempotent.
create or replace function app.mark_draft_sent(p_draft uuid) returns public.draft
language plpgsql security definer set search_path = public, app as $$
declare
  d public.draft := app.draft_for_action(p_draft);
  v_uid uuid := auth.uid();
begin
  select * into d from public.draft where id = d.id for update;
  if d.state in ('marked_sent', 'reconciled_sent') then return d; end if;
  if d.state not in ('approved', 'opened_for_send') then
    raise exception 'only approved drafts can be marked sent' using errcode = '22023';
  end if;
  if not app.draft_approval_live(d) then
    raise exception 'approval no longer matches the content; re-approve' using errcode = '40001';
  end if;
  update public.draft set state = 'marked_sent', marked_sent_at = now(), marked_sent_by = v_uid, sent_evidence = 'user_assertion'
   where id = d.id returning * into d;
  insert into public.draft_event(workspace_id, draft_id, event, actor_user_id, actor_kind, content_hash, evidence, owner_user_id, classification)
  values (d.workspace_id, d.id, 'marked_sent', v_uid, 'user', d.content_hash, 'user_assertion', d.owner_user_id, d.classification);
  return d;
end $$;

revoke all on function app.approve_draft(uuid, text, text, bigint) from public, anon;
revoke all on function app.open_draft_for_send(uuid) from public, anon;
revoke all on function app.mark_draft_sent(uuid) from public, anon;
grant execute on function app.approve_draft(uuid, text, text, bigint) to authenticated, service_role;
grant execute on function app.open_draft_for_send(uuid) to authenticated, service_role;
grant execute on function app.mark_draft_sent(uuid) to authenticated, service_role;
grant execute on function app.draft_content_hash(uuid, text, text, text, uuid[]) to authenticated, service_role;
grant execute on function app.draft_hash_field(text) to authenticated, service_role;

-- ---------------------------------------------------------------- re-hash existing rows with the canonical SQL hash
-- (earlier rows used a client-side hash). Unsent approvals are not carried over: they must be re-approved.
alter table public.draft disable trigger integrations_draft_guard;
update public.draft d set
  content_hash = app.draft_content_hash(d.recipient_person_id, d.recipient_address, d.subject, d.body, d.attachment_document_ids),
  approved_hash = case when d.state in ('marked_sent', 'reconciled_sent') then d.approved_hash else null end,
  approved_by = case when d.state in ('marked_sent', 'reconciled_sent') then d.approved_by else null end,
  approved_at = case when d.state in ('marked_sent', 'reconciled_sent') then d.approved_at else null end,
  state = case when d.state in ('approved', 'opened_for_send') then 'drafted' else d.state end
where d.content_hash is distinct from app.draft_content_hash(d.recipient_person_id, d.recipient_address, d.subject, d.body, d.attachment_document_ids);
alter table public.draft enable trigger integrations_draft_guard;

notify pgrst, 'reload schema';
