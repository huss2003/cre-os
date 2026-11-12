-- Integration pass (master spec Part 4.2): every event carries the full contract.
-- Adds source module, actor, correlation id and permission context (classification) to mudar.event_outbox.
-- Re-runnable. No SECURITY DEFINER functions are created here (trigger fn is invoker; RLS on event_outbox unchanged).

alter table mudar.event_outbox add column if not exists source_module text;
alter table mudar.event_outbox add column if not exists actor_user_id uuid;
alter table mudar.event_outbox add column if not exists correlation_id uuid;
alter table mudar.event_outbox add column if not exists classification text not null default 'corporate_confidential';

create index if not exists event_outbox_correlation_idx on mudar.event_outbox(workspace_id, correlation_id);

create or replace function mudar_app.event_contract_fill() returns trigger
language plpgsql security invoker set search_path = mudar, mudar_app, public as $$
begin
  -- source module: explicit payload value, else the event-type prefix (transaction.executed -> transaction)
  new.source_module := coalesce(new.source_module, nullif(new.payload->>'source_module', ''), split_part(new.event_type, '.', 1));
  -- actor: the signed-in user who caused the write (null for jobs / triggers run by the service role)
  new.actor_user_id := coalesce(new.actor_user_id, case when (new.payload->>'actor_user_id') ~* '^[0-9a-f-]{36}$' then (new.payload->>'actor_user_id')::uuid end, auth.uid());
  -- correlation: chains of events share the id of the first one; a root event correlates to itself
  new.correlation_id := coalesce(new.correlation_id,
    case when (new.payload->>'correlation_id') ~* '^[0-9a-f-]{36}$' then (new.payload->>'correlation_id')::uuid end, new.id);
  if new.payload ? 'classification' and new.payload->>'classification' in ('public','permitted_personal','corporate_confidential','licensed_restricted') then
    new.classification := new.payload->>'classification';
  end if;
  return new;
end $$;
revoke all on function mudar_app.event_contract_fill() from public, anon;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'event_contract_fill' and tgrelid = 'mudar.event_outbox'::regclass) then
    create trigger event_contract_fill before insert on mudar.event_outbox for each row execute function mudar_app.event_contract_fill();
  end if;
end $$;

-- backfill existing rows (idempotent)
update mudar.event_outbox set source_module = split_part(event_type, '.', 1) where source_module is null;
update mudar.event_outbox set correlation_id = id where correlation_id is null;

-- G17: mirror a HUMAN-confirmed Module 15 expiry to lease.contractual_expiry so column-based modules see it.
-- Only for a lease_date that is confirmed, by the caller, of type expiry; caller must be an editor that can see the lease.
-- Runs as owner to pass cx_material_guard; the lease audit trigger keeps the previous value (old → new) with auth.uid().
create or replace function mudar_app.lease_mirror_confirmed_expiry(p_date_id uuid) returns jsonb
language plpgsql security definer set search_path = mudar, mudar_app, public as $$
declare d record; l record;
begin
  select * into d from mudar.lease_date where id = p_date_id;
  if d is null then raise exception 'not_found' using errcode = '42704'; end if;
  if d.date_type <> 'expiry' or d.verification_status <> 'confirmed' or d.superseded_by is not null or d.archived_at is not null then
    raise exception 'only a current, confirmed expiry date can be mirrored' using errcode = '22023'; end if;
  if d.confirmed_by is distinct from auth.uid() then raise exception 'only the confirming reviewer can mirror this date' using errcode = '42501'; end if;
  if not mudar_app.has_role(d.workspace_id, 'editor') then raise exception 'editor role required' using errcode = '42501'; end if;
  select id, contractual_expiry into l from mudar.lease where id = d.lease_id and workspace_id = d.workspace_id;
  if l is null then raise exception 'lease not found' using errcode = '42704'; end if;
  if l.contractual_expiry is not distinct from d.calculated_date then return jsonb_build_object('changed', false, 'previous', l.contractual_expiry); end if;
  update mudar.lease set contractual_expiry = d.calculated_date where id = l.id;
  return jsonb_build_object('changed', true, 'previous', l.contractual_expiry, 'new', d.calculated_date);
end $$;
revoke all on function mudar_app.lease_mirror_confirmed_expiry(uuid) from public, anon;
grant execute on function mudar_app.lease_mirror_confirmed_expiry(uuid) to authenticated;
