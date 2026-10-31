set search_path = mudar, mudar_app, public, extensions;
-- CRE OS capture + approvals/changes module (owner: capture module).
-- Spec: Part I §10 "Approval and reversal mechanics"; Part III "Transactional update and reversal algorithm".
--
--  * mudar_app.apply_change(proposal, actor)        transactional, row-locked, version-checked, approval-hash-checked apply
--  * mudar_app.approve_change(proposal, decision)   hash-bound approval record (approved / rejected / clarify)
--  * mudar_app.reverse_change(proposal, actor, paths) compensating reversal; later independent edits are never rolled back
--  * mudar_app.preview_reverse(proposal, actor)     dependency preview for single/batch undo
--  * mudar_app.search_entity_candidates(...)        permission-scoped candidate retrieval for capture entity resolution
--  * helper tables capture_span (claim -> transcript span) and change_conflict (surfaced reversal/merge conflicts)
--
-- All functions are SECURITY DEFINER with explicit membership / role / row-visibility checks.
-- Role/permission/membership tables are never patchable.  Re-runnable (create or replace / guarded DDL).

-- ============================================================ helper tables
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'mudar' and tablename = 'capture_span') then
    create table mudar.capture_span (
      id uuid primary key default gen_random_uuid(),
      capture_id uuid not null references mudar.capture(id) on delete cascade,
      claim_kind text not null check (claim_kind in ('fact','task','ambiguity','draft','mention','interaction')),
      claim_index int not null,
      source_locator text not null,           -- "text:12-31" | "transcript:12-31" | "transcript:00:42-00:49"
      start_offset int,
      end_offset int,
      ts_start_seconds numeric(10,2),
      ts_end_seconds numeric(10,2),
      excerpt text,
      result_type text,                       -- change_proposal / task / draft / interaction
      result_id uuid,
      unique (capture_id, claim_kind, claim_index)
    );
    perform mudar_app.make_business_table('capture_span', false);
    create index capture_span_capture_idx on mudar.capture_span(capture_id);
  end if;

  if not exists (select 1 from pg_tables where schemaname = 'mudar' and tablename = 'change_conflict') then
    create table mudar.change_conflict (
      id uuid primary key default gen_random_uuid(),
      proposal_id uuid not null references mudar.change_proposal(id) on delete cascade,
      reversal_proposal_id uuid references mudar.change_proposal(id) on delete set null,
      kind text not null check (kind in ('field','merge_ref','create_modified','archive_modified','version')),
      path text,
      before_value jsonb,
      applied_value jsonb,
      current_value jsonb,
      detail jsonb not null default '{}',
      resolved_at timestamptz
    );
    perform mudar_app.make_business_table('change_conflict', false);
    create index change_conflict_proposal_idx on mudar.change_conflict(proposal_id);
  end if;
end $$;

-- ============================================================ internal helpers (not callable by API roles)
create or replace function mudar_app.cx_role_rank(r mudar.member_role) returns int language sql immutable as $$
  select array_position(array['viewer','editor','admin','owner']::mudar.member_role[], r)
$$;

create or replace function mudar_app.cx_role_at_least(p_ws uuid, p_user uuid, p_min mudar.member_role) returns boolean
language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (select 1 from mudar.membership m
                 where m.workspace_id = p_ws and m.user_id = p_user
                   and mudar_app.cx_role_rank(m.role) >= mudar_app.cx_role_rank(p_min))
$$;

-- mudar_app.can_read() for an explicit user (jobs run as service role, so auth.uid() is null there)
create or replace function mudar_app.cx_can_read(p_ws uuid, p_cls mudar.classification, p_owner uuid, p_etype text, p_eid uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select exists (
    select 1 from mudar.membership m
    where m.workspace_id = p_ws and m.user_id = p_user
      and p_cls = any(m.allowed_classifications)
      and ( m.role in ('owner','admin') or m.see_all_accounts or p_owner = p_user
            or exists (select 1 from mudar.record_share s
                       where s.workspace_id = p_ws and s.entity_type = p_etype and s.entity_id = p_eid and s.user_id = p_user) )
  )
$$;

-- can_write for an explicit user: readable row + editor role.
create or replace function mudar_app.cx_can_write(p_ws uuid, p_cls mudar.classification, p_owner uuid, p_etype text, p_eid uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
  select mudar_app.cx_can_read(p_ws, p_cls, p_owner, p_etype, p_eid, p_user) and mudar_app.cx_role_at_least(p_ws, p_user, 'editor')
$$;

create or replace function mudar_app.cx_actor(p_actor uuid) returns uuid language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is not null then
    if p_actor is not null and p_actor <> v then
      raise exception 'forbidden: actor mismatch' using errcode = '42501';
    end if;
    return v;
  end if;
  -- service-role (job) call: the acting user must be named explicitly and is checked like a user
  if p_actor is null then
    raise exception 'forbidden: actor required' using errcode = '42501';
  end if;
  return p_actor;
end $$;

-- Tables a change proposal may touch. Role/permission/membership/system tables are NEVER listed.
create or replace function mudar_app.cx_allowed_tables() returns text[] language sql immutable as $$
  select array['organisation','organisation_relation','person','contact_method','employment','relationship_edge',
               'geography','asset','space','availability','lease','lease_event','market_transaction','market_observation',
               'requirement','stakeholder','opportunity','quote','shortlist_option','fee_milestone','interaction',
               'interaction_link','task','meeting_visit','signal_claim','entity_alias','source_object']
$$;

create or replace function mudar_app.cx_denied_columns() returns text[] language sql immutable as $$
  select array['id','workspace_id','classification','owner_user_id','created_at','updated_at','row_version',
               'archived_at','search','value_hash']
$$;

-- Risk floor recomputed in SQL (mirror of classifyRisk in src/lib/services/changes.ts) so a forged
-- 'routine_internal' proposal cannot bypass approval.
create or replace function mudar_app.cx_material_fields(p_table text) returns text[] language sql immutable as $$
  select case p_table
    when 'requirement' then array['area_min_sf','area_target_sf','area_max_sf','budget_min','budget_max','budget_basis','area_basis',
                                  'seats_min','seats_target','seats_max','decision_date','occupation_date','status','constraints','org_id',
                                  'preferred_geography_ids','excluded_geography_ids','confirmed_by_person_id','confirmed_at']
    when 'opportunity' then array['stage','outcome','expected_fee','credit_share','mandate_status','account_owner_user_id','expected_close','org_id']
    when 'lease' then array['contractual_expiry','start_date','tenure_months_raw','lockin_months_raw','area_sf','rent_per_sf','tenant_org_id']
    when 'lease_event' then array['event_date','confirmed','date_basis']
    when 'employment' then array['end_date','is_current','org_id','person_id']
    when 'quote' then array['terms_json','valid_until','approved_floor','approved_ceiling']
    when 'fee_milestone' then array['gross_fee','credit_share','invoiced_amount','recognised_amount','collected_amount']
    when 'organisation' then array['legal_name','cin','gstin','domain','crm_external_id']
    when 'person' then array['full_name']
    when 'contact_method' then array['value','suppressed']
    when 'availability' then array['status','asking_rent_min','asking_rent_max','available_from']
    else array[]::text[] end
$$;

create or replace function mudar_app.cx_risk_floor(p_table text, p_op text, p_fields text[]) returns mudar.risk_level
language sql immutable as $$
  select case
    when p_op = 'merge' then 'identity_merge'::mudar.risk_level
    when p_table = 'fee_milestone' then 'high_value'
    when p_table = 'opportunity' and p_fields && array['expected_fee','credit_share','stage','outcome'] then 'high_value'
    when p_op = 'create' and p_table in ('requirement','opportunity','lease','quote','employment') then 'material_fact'
    when p_op = 'archive' and p_table in ('requirement','opportunity','lease','quote','employment','organisation','person','asset','fee_milestone') then 'material_fact'
    when p_fields && mudar_app.cx_material_fields(p_table) then 'material_fact'
    else 'routine_internal' end
$$;

create or replace function mudar_app.cx_risk_rank(r mudar.risk_level) returns int language sql immutable as $$
  select case r when 'routine_internal' then 0 when 'material_fact' then 1 when 'external_message' then 1
                when 'high_value' then 2 when 'identity_merge' then 2 end
$$;

create or replace function mudar_app.cx_required_role(r mudar.risk_level) returns mudar.member_role language sql immutable as $$
  select case when r = 'routine_internal' then 'editor'::mudar.member_role else 'admin'::mudar.member_role end
$$;

-- Validate an RFC6902-style patch of top-level fields for p_table; returns the field list.
create or replace function mudar_app.cx_patch_fields(p_table text, p_patch jsonb) returns text[]
language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare e jsonb; f text; res text[] := '{}';
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'array' or jsonb_array_length(p_patch) = 0 then
    raise exception 'invalid_patch: patch must be a non-empty array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_patch) > 60 or length(p_patch::text) > 100000 then
    raise exception 'invalid_patch: payload too large' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_patch) loop
    if coalesce(e->>'op','') not in ('add','replace','remove') then
      raise exception 'invalid_patch: unsupported op %', e->>'op' using errcode = '22023';
    end if;
    f := e->>'path';
    if f is null or f !~ '^/[a-z_][a-z0-9_]*$' then
      raise exception 'invalid_patch: only top-level field paths are allowed (%)', f using errcode = '22023';
    end if;
    f := substr(f, 2);
    if f = any(mudar_app.cx_denied_columns()) or not exists (
         select 1 from information_schema.columns c
         where c.table_schema = 'mudar' and c.table_name = p_table and c.column_name = f and c.is_generated = 'NEVER') then
      raise exception 'field_not_allowed: %.%', p_table, f using errcode = '42501';
    end if;
    if f = any(res) then
      raise exception 'invalid_patch: duplicate path %', f using errcode = '22023';
    end if;
    res := res || f;
  end loop;
  return res;
end $$;

create or replace function mudar_app.cx_patch_object(p_patch jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(substr(e->>'path', 2), case when e->>'op' = 'remove' then 'null'::jsonb else coalesce(e->'value','null'::jsonb) end), '{}'::jsonb)
  from jsonb_array_elements(p_patch) e
$$;

-- Non-raising list of top-level patch fields (used by the guard trigger to compute the risk floor).
create or replace function mudar_app.cx_fields_of(p_patch jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct substr(split_part(e->>'path', '/', 2), 1, 63)) filter (where e->>'path' like '/%'), '{}'::text[])
  from jsonb_array_elements(case when jsonb_typeof(p_patch) = 'array' then p_patch else '[]'::jsonb end) e
$$;

create or replace function mudar_app.cx_max_risk(a mudar.risk_level, b mudar.risk_level) returns mudar.risk_level language sql immutable as $$
  select case when a is null then b when b is null then a when mudar_app.cx_risk_rank(b) > mudar_app.cx_risk_rank(a) then b else a end
$$;

-- Hash an approval binds to: target, operation, expected row version and exact patch.
create or replace function mudar_app.change_hash(p mudar.change_proposal) returns text
language sql stable set search_path = mudar, mudar_app, public, extensions as $$
  select encode(extensions.digest(jsonb_build_object(
    'target_type', p.target_type, 'target_id', p.target_id, 'operation', p.operation,
    'expected_version', p.expected_version, 'patch', p.patch)::text, 'sha256'), 'hex')
$$;

create or replace function mudar_app.cx_load_row(p_table text, p_id uuid, p_ws uuid, p_lock boolean) returns jsonb
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare r jsonb;
begin
  execute format('select to_jsonb(t.*) from mudar.%I t where t.id = $1 and t.workspace_id = $2 %s',
                 p_table, case when p_lock then 'for update' else '' end)
    into r using p_id, p_ws;
  return r;
end $$;

create or replace function mudar_app.cx_update_fields(p_table text, p_id uuid, p_ws uuid, p_obj jsonb) returns jsonb
language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare cols text; r jsonb;
begin
  select string_agg(format('%I = r.%I', k, k), ', ') into cols from jsonb_object_keys(p_obj) k;
  execute format('update mudar.%I t set %s from jsonb_populate_record(null::mudar.%I, $1) r
                  where t.id = $2 and t.workspace_id = $3 returning to_jsonb(t.*)', p_table, cols, p_table)
    into r using p_obj, p_id, p_ws;
  return r;
end $$;

-- FK whitelist for identity merges: (table, column, polymorphic type column, type value)
create or replace function mudar_app.cx_merge_refs(p_entity text)
returns table(tbl text, col text, type_col text, type_val text) language sql immutable as $$
  select v.tbl, v.col, v.type_col, v.type_val from (values
    ('organisation','organisation_relation','from_org_id',null::text,null::text),
    ('organisation','organisation_relation','to_org_id',null,null),
    ('organisation','employment','org_id',null,null),
    ('organisation','requirement','org_id',null,null),
    ('organisation','opportunity','org_id',null,null),
    ('organisation','lease','tenant_org_id',null,null),
    ('organisation','lease','landlord_org_id',null,null),
    ('organisation','asset','developer_org_id',null,null),
    ('organisation','asset','owner_org_id',null,null),
    ('organisation','asset','operator_org_id',null,null),
    ('organisation','market_transaction','tenant_org_id',null,null),
    ('organisation','market_transaction','broker_org_id',null,null),
    ('organisation','quote','counterparty_org_id',null,null),
    ('organisation','draft','org_id',null,null),
    ('person','employment','person_id',null,null),
    ('person','contact_method','person_id',null,null),
    ('person','relationship_edge','from_person_id',null,null),
    ('person','relationship_edge','to_person_id',null,null),
    ('person','stakeholder','person_id',null,null),
    ('person','availability','contact_person_id',null,null),
    ('person','requirement','confirmed_by_person_id',null,null),
    ('person','consent_permission','person_id',null,null),     -- suppression/consent must follow the person
    ('person','draft','recipient_person_id',null,null),
    ('asset','asset','parent_asset_id',null,null),
    ('asset','space','asset_id',null,null),
    ('asset','lease','asset_id',null,null),
    ('asset','market_transaction','asset_id',null,null),
    ('asset','shortlist_option','asset_id',null,null)
  ) v(entity, tbl, col, type_col, type_val) where v.entity = p_entity
  union all
  select p.tbl, p.col, p.type_col, null::text from (values
    ('interaction_link','entity_id','entity_type'),
    ('task','linked_entity_id','linked_entity_type'),
    ('signal_claim','subject_id','subject_type'),
    ('entity_alias','entity_id','entity_type'),
    ('meeting_visit','linked_entity_id','linked_entity_type'),
    ('document_version','linked_entity_id','linked_entity_type')
  ) p(tbl, col, type_col) where p_entity in ('organisation','person','asset')
  -- NOTE: record_share / membership are deliberately absent: a merge never changes who can see what.
$$;

create or replace function mudar_app.cx_audit(p_ws uuid, p_actor uuid, p_action text, p_cp uuid, p_after jsonb, p_reversal_of bigint default null)
returns bigint language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare v_id bigint;
begin
  insert into mudar.audit_event(workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, after, change_proposal_id, reversal_of)
  values (p_ws, p_actor, case when auth.uid() is null then 'job' else 'user' end, p_action, 'change_proposal', p_cp, p_after, p_cp, p_reversal_of)
  returning id into v_id;
  return v_id;
end $$;

-- ============================================================ approve / reject / clarify
create or replace function mudar_app.approve_change(p_proposal uuid, p_decision text default 'approved', p_note text default null,
                                              p_ttl_hours int default 168, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  cp mudar.change_proposal; v_actor uuid; v_risk mudar.risk_level; v_fields text[]; v_hash text; v_appr uuid; v_row jsonb;
begin
  v_actor := mudar_app.cx_actor(p_actor);
  if p_decision not in ('approved','rejected','clarify') then
    raise exception 'invalid_parameter: decision %', p_decision using errcode = '22023';
  end if;
  select * into cp from mudar.change_proposal where id = p_proposal for update;
  if not found then raise exception 'not_found: change proposal' using errcode = 'P0002'; end if;
  if not mudar_app.cx_can_read(cp.workspace_id, cp.classification, cp.owner_user_id, 'change_proposal', cp.id, v_actor) then
    raise exception 'not_found: change proposal' using errcode = 'P0002';
  end if;
  if cp.risk = 'external_message' or cp.target_type = 'draft' then
    raise exception 'forbidden: external messages are approved in the draft queue and sent manually' using errcode = '42501';
  end if;
  if not (cp.target_type = any(mudar_app.cx_allowed_tables())) then
    raise exception 'forbidden: table % is not changeable through proposals', cp.target_type using errcode = '42501';
  end if;
  if cp.target_id is not null then
    v_row := mudar_app.cx_load_row(cp.target_type, cp.target_id, cp.workspace_id, false);
    if v_row is null or not mudar_app.cx_can_read(cp.workspace_id, (v_row->>'classification')::mudar.classification,
                                            (v_row->>'owner_user_id')::uuid, cp.target_type, cp.target_id, v_actor) then
      raise exception 'not_found: target' using errcode = 'P0002';
    end if;
  end if;
  v_fields := case when cp.operation in ('update','create','link') then mudar_app.cx_patch_fields(cp.target_type, cp.patch) else '{}'::text[] end;
  v_risk := mudar_app.cx_risk_floor(cp.target_type, cp.operation, v_fields);
  if mudar_app.cx_risk_rank(cp.risk) > mudar_app.cx_risk_rank(v_risk) then v_risk := cp.risk; end if;
  if not mudar_app.cx_role_at_least(cp.workspace_id, v_actor, mudar_app.cx_required_role(v_risk)) then
    raise exception 'forbidden: % changes require % role', v_risk, mudar_app.cx_required_role(v_risk) using errcode = '42501';
  end if;
  if cp.state not in ('proposed','approved','clarify','conflict') or (cp.state = 'conflict' and cp.applied_audit_id is not null) then
    raise exception 'invalid_state: proposal is %', cp.state using errcode = '22023';
  end if;
  v_hash := mudar_app.change_hash(cp);
  insert into mudar.approval(workspace_id, subject_type, subject_id, approver_user_id, approved_hash, decision, note,
                              expires_at, owner_user_id, classification)
  values (cp.workspace_id, 'change_proposal', cp.id, v_actor, v_hash, p_decision, p_note,
          case when p_decision = 'approved' then now() + make_interval(hours => greatest(1, least(coalesce(p_ttl_hours,168), 24*30))) end,
          v_actor, cp.classification)
  returning id into v_appr;
  update mudar.change_proposal
     set state = case p_decision when 'approved' then 'approved' when 'rejected' then 'rejected' else 'clarify' end,
         decided_by = v_actor, decided_at = now()
   where id = cp.id;
  return jsonb_build_object('approval_id', v_appr, 'approved_hash', v_hash, 'decision', p_decision,
                            'state', case p_decision when 'approved' then 'approved' when 'rejected' then 'rejected' else 'clarify' end);
end $$;

-- ============================================================ apply
create or replace function mudar_app.apply_change(p_proposal uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  cp mudar.change_proposal; v_actor uuid; v_risk mudar.risk_level; v_fields text[] := '{}'; v_obj jsonb;
  v_row jsonb; v_after jsonb; v_before jsonb; v_target uuid; v_appr mudar.approval; v_cur bigint; v_delta bigint;
  v_ok bigint; v_audit bigint; v_loser uuid; v_loser_row jsonb; ref record; v_ids uuid[]; v_repointed jsonb := '[]';
  v_arch_rel uuid[] := '{}'; v_alias uuid; v_alias_ids uuid[] := '{}'; v_stamp timestamptz := clock_timestamp(); v_name text;
  v_other text; v_extra text;
begin
  v_actor := mudar_app.cx_actor(p_actor);
  select * into cp from mudar.change_proposal where id = p_proposal for update;
  if not found then raise exception 'not_found: change proposal' using errcode = 'P0002'; end if;
  if not mudar_app.cx_can_read(cp.workspace_id, cp.classification, cp.owner_user_id, 'change_proposal', cp.id, v_actor) then
    raise exception 'not_found: change proposal' using errcode = 'P0002';
  end if;
  if not (cp.target_type = any(mudar_app.cx_allowed_tables())) then
    raise exception 'forbidden: table % is not changeable through proposals', cp.target_type using errcode = '42501';
  end if;
  if cp.state = 'applied' then
    return jsonb_build_object('status','already_applied','proposal_id',cp.id,'target_id',cp.target_id,'applied_audit_id',cp.applied_audit_id);
  end if;
  if cp.state not in ('proposed','approved') then
    raise exception 'invalid_state: proposal is %', cp.state using errcode = '22023';
  end if;
  if cp.risk = 'external_message' or cp.target_type = 'draft' then
    raise exception 'forbidden: external messages are never applied; drafts are sent manually' using errcode = '42501';
  end if;
  if not (cp.target_type = any(mudar_app.cx_allowed_tables())) then
    raise exception 'forbidden: table % is not changeable through proposals', cp.target_type using errcode = '42501';
  end if;

  -- 2. validate patch schema + field authority
  if cp.operation in ('update','create','link') then
    v_fields := mudar_app.cx_patch_fields(cp.target_type, cp.patch);
    v_obj := mudar_app.cx_patch_object(cp.patch);
  elsif cp.operation = 'merge' then
    if cp.target_type not in ('organisation','person','asset') then
      raise exception 'forbidden: merge not supported for %', cp.target_type using errcode = '42501';
    end if;
    v_obj := mudar_app.cx_patch_object(cp.patch);
    begin v_loser := (v_obj->>'loser_id')::uuid; exception when others then v_loser := null; end;
    if v_loser is null or v_loser = cp.target_id then
      raise exception 'invalid_patch: merge needs /loser_id different from target' using errcode = '22023';
    end if;
  elsif cp.operation <> 'archive' then
    raise exception 'invalid_patch: operation %', cp.operation using errcode = '22023';
  end if;
  if cp.operation = 'link' and cp.target_type not in ('interaction_link','entity_alias','stakeholder','organisation_relation','relationship_edge') then
    raise exception 'invalid_patch: link only creates link rows' using errcode = '22023';
  end if;

  -- 3. risk determined outside the LLM (never lower than the code-level floor) + role gate
  v_risk := mudar_app.cx_risk_floor(cp.target_type, cp.operation, v_fields);
  if mudar_app.cx_risk_rank(cp.risk) > mudar_app.cx_risk_rank(v_risk) then v_risk := cp.risk; end if;
  if not mudar_app.cx_role_at_least(cp.workspace_id, v_actor, mudar_app.cx_required_role(v_risk)) then
    raise exception 'forbidden: applying % changes requires % role', v_risk, mudar_app.cx_required_role(v_risk) using errcode = '42501';
  end if;

  -- 4. approval must match current content hash, be unexpired, unmodified and from an authorised approver
  if cp.approval_required or v_risk <> 'routine_internal' or cp.proposed_by_kind = 'model' then
    select * into v_appr from mudar.approval a
     where a.workspace_id = cp.workspace_id and a.subject_type = 'change_proposal' and a.subject_id = cp.id and a.archived_at is null
     order by a.created_at desc, a.id desc limit 1;
    if not found or v_appr.decision <> 'approved' or cp.state <> 'approved' then
      -- no live approval for the CURRENT content (never approved, rejected, or edited after approval)
      raise exception 'approval_invalid: % change needs a current approval before apply', v_risk using errcode = '42501';
    end if;
    if v_appr.approved_hash <> mudar_app.change_hash(cp) then
      raise exception 'approval_invalid: proposal changed after approval (hash mismatch)' using errcode = '42501';
    end if;
    if v_appr.expires_at is not null and v_appr.expires_at <= now() then
      raise exception 'approval_expired: approval expired at %', v_appr.expires_at using errcode = '42501';
    end if;
    if v_appr.row_version <> 1
       or not mudar_app.cx_role_at_least(cp.workspace_id, v_appr.approver_user_id, mudar_app.cx_required_role(v_risk))
       or not exists (select 1 from mudar.audit_event ae where ae.entity_type = 'approval' and ae.entity_id = v_appr.id
                        and ae.action = 'insert' and (ae.actor_user_id = v_appr.approver_user_id or ae.actor_user_id is null)) then
      raise exception 'approval_invalid: approval record not trustworthy' using errcode = '42501';
    end if;
  end if;

  perform set_config('mudar_app.change_proposal_id', cp.id::text, true);
  if auth.uid() is null then perform set_config('mudar_app.actor_kind', 'job', true); end if;

  -- 5. write
  if cp.operation in ('create','link') then
    if cp.target_id is not null then
      raise exception 'invalid_patch: create must not carry target_id' using errcode = '22023';
    end if;
    if not mudar_app.cx_can_write(cp.workspace_id, cp.classification, coalesce(cp.owner_user_id, v_actor), cp.target_type, null, v_actor) then
      raise exception 'forbidden: cannot create % rows with classification %', cp.target_type, cp.classification using errcode = '42501';
    end if;
    execute format('insert into mudar.%I as t (%s, workspace_id, owner_user_id, classification)
                    select %s, $2, $3, $4 from jsonb_populate_record(null::mudar.%I, $1) r returning to_jsonb(t.*)',
                   cp.target_type,
                   (select string_agg(quote_ident(f), ', ') from unnest(v_fields) f),
                   (select string_agg('r.' || quote_ident(f), ', ') from unnest(v_fields) f),
                   cp.target_type)
      into v_after using v_obj, cp.workspace_id, coalesce(cp.owner_user_id, v_actor), cp.classification;
    v_target := (v_after->>'id')::uuid;
    v_before := jsonb_build_object('kind','create','after_version',(v_after->>'row_version')::bigint,
                                   'after', (select jsonb_object_agg(f, v_after->f) from unnest(v_fields) f));
  else
    v_target := cp.target_id;
    v_row := mudar_app.cx_load_row(cp.target_type, v_target, cp.workspace_id, true);   -- lock row FOR UPDATE
    if v_row is null then raise exception 'not_found: target %.%', cp.target_type, v_target using errcode = 'P0002'; end if;
    if not mudar_app.cx_can_read(cp.workspace_id, (v_row->>'classification')::mudar.classification, (v_row->>'owner_user_id')::uuid,
                           cp.target_type, v_target, v_actor) then
      raise exception 'not_found: target' using errcode = 'P0002';
    end if;
    if v_row->>'archived_at' is not null and cp.operation <> 'archive' then
      raise exception 'invalid_state: target is archived' using errcode = '22023';
    end if;
    v_cur := (v_row->>'row_version')::bigint;
    if cp.expected_version is not null and v_cur <> cp.expected_version then
      -- tolerated only when every intervening update came from a sibling proposal of the same capture
      -- that touched different fields (per-fact proposals on one record); anything else is stale.
      v_delta := v_cur - cp.expected_version;
      select count(*) into v_ok from mudar.audit_event ae
       where ae.workspace_id = cp.workspace_id and ae.entity_type = cp.target_type and ae.entity_id = v_target
         and ae.action = 'update' and (ae.before->>'row_version')::bigint >= cp.expected_version
         and cp.capture_id is not null
         and exists (select 1 from mudar.change_proposal s where s.id = ae.change_proposal_id
                       and s.capture_id = cp.capture_id and s.id <> cp.id and s.reversal_of is null)
         and not exists (select 1 from unnest(v_fields) f where (ae.before->f) is distinct from (ae.after->f));
      if v_delta < 0 or v_ok <> v_delta then
        raise exception 'stale_version: %.% expected version %, current %', cp.target_type, v_target, cp.expected_version, v_cur
          using errcode = '40001';
      end if;
    end if;

    if cp.operation = 'update' then
      v_after := mudar_app.cx_update_fields(cp.target_type, v_target, cp.workspace_id, v_obj);
      v_before := jsonb_build_object('kind','update','before_version', v_cur, 'after_version', (v_after->>'row_version')::bigint,
                    'fields', (select jsonb_object_agg(f, v_row->f) from unnest(v_fields) f),
                    'after',  (select jsonb_object_agg(f, v_after->f) from unnest(v_fields) f),
                    'reversed', '[]'::jsonb);
    elsif cp.operation = 'archive' then
      execute format('update mudar.%I t set archived_at = $1 where t.id = $2 and t.workspace_id = $3 returning to_jsonb(t.*)', cp.target_type)
        into v_after using v_stamp, v_target, cp.workspace_id;
      v_before := jsonb_build_object('kind','archive','before_version', v_cur, 'after_version', (v_after->>'row_version')::bigint,
                                     'fields', jsonb_build_object('archived_at', v_row->'archived_at'),
                                     'after', jsonb_build_object('archived_at', v_after->'archived_at'), 'reversed','[]'::jsonb);
    else  -- merge: re-point whitelisted references from loser to winner, archive loser, keep aliases
      v_loser_row := mudar_app.cx_load_row(cp.target_type, v_loser, cp.workspace_id, true);
      if v_loser_row is null or v_loser_row->>'archived_at' is not null then
        raise exception 'not_found: merge source' using errcode = 'P0002';
      end if;
      if not mudar_app.cx_can_read(cp.workspace_id, (v_loser_row->>'classification')::mudar.classification,
                             (v_loser_row->>'owner_user_id')::uuid, cp.target_type, v_loser, v_actor) then
        raise exception 'not_found: merge source' using errcode = 'P0002';
      end if;
      if v_obj ? 'loser_version' and (v_obj->>'loser_version')::bigint <> (v_loser_row->>'row_version')::bigint then
        raise exception 'stale_version: merge source changed' using errcode = '40001';
      end if;
      if cp.target_type = 'organisation' then
        -- relations between the two orgs would become self-relations: archive instead of re-pointing
        update mudar.organisation_relation set archived_at = v_stamp
         where workspace_id = cp.workspace_id and archived_at is null
           and ((from_org_id = v_loser and to_org_id = v_target) or (from_org_id = v_target and to_org_id = v_loser));
        select coalesce(array_agg(id), '{}') into v_arch_rel from mudar.organisation_relation
         where workspace_id = cp.workspace_id and archived_at = v_stamp
           and ((from_org_id = v_loser and to_org_id = v_target) or (from_org_id = v_target and to_org_id = v_loser));
      end if;
      for ref in select * from mudar_app.cx_merge_refs(cp.target_type) loop
        v_extra := '';
        if ref.type_col is not null then v_extra := format(' and %I = %L', ref.type_col, cp.target_type); end if;
        if ref.tbl = 'organisation_relation' then
          v_other := case ref.col when 'from_org_id' then 'to_org_id' else 'from_org_id' end;
          v_extra := v_extra || format(' and %I <> %L', v_other, v_target);
        end if;
        execute format('with u as (update mudar.%I set %I = $1 where workspace_id = $3 and %I = $2%s returning id)
                        select coalesce(array_agg(id), ''{}'') from u', ref.tbl, ref.col, ref.col, v_extra)
          into v_ids using v_target, v_loser, cp.workspace_id;
        if cardinality(v_ids) > 0 then
          v_repointed := v_repointed || jsonb_build_object('table', ref.tbl, 'column', ref.col, 'ids', to_jsonb(v_ids));
        end if;
      end loop;
      v_name := coalesce(v_loser_row->>'display_name', v_loser_row->>'full_name', v_loser_row->>'name');
      if v_name is not null then
        insert into mudar.entity_alias(workspace_id, entity_type, entity_id, raw_alias, canonical_alias, owner_user_id, classification)
        values (cp.workspace_id, cp.target_type, v_target, v_name, lower(regexp_replace(trim(v_name), '\s+', ' ', 'g')),
                coalesce(cp.owner_user_id, v_actor), cp.classification)
        returning id into v_alias;
        v_alias_ids := v_alias_ids || v_alias;
      end if;
      execute format('update mudar.%I set archived_at = $1 where id = $2 and workspace_id = $3', cp.target_type)
        using v_stamp, v_loser, cp.workspace_id;
      v_before := jsonb_build_object('kind','merge','winner', v_target, 'loser', v_loser, 'stamp', v_stamp,
                                     'loser_before', v_loser_row, 'repointed', v_repointed,
                                     'archived_relations', to_jsonb(v_arch_rel), 'aliases_added', to_jsonb(v_alias_ids));
      v_after := mudar_app.cx_load_row(cp.target_type, v_target, cp.workspace_id, false);
    end if;
  end if;

  select max(id) into v_audit from mudar.audit_event
   where change_proposal_id = cp.id and entity_type = cp.target_type and entity_id = coalesce(v_loser, v_target);
  update mudar.change_proposal
     set state = 'applied', target_id = v_target, before = v_before, applied_audit_id = v_audit, risk = v_risk
   where id = cp.id;
  perform mudar_app.cx_audit(cp.workspace_id, v_actor, 'apply', cp.id, jsonb_build_object('target_type', cp.target_type, 'target_id', v_target));
  return jsonb_build_object('status','applied','proposal_id',cp.id,'target_id',v_target,'applied_audit_id',v_audit,
                            'row_version', (v_after->>'row_version')::bigint);
end $$;

-- ============================================================ verified applied state (C1/C2 defence)
-- Reversal never trusts change_proposal.before for WHAT to write or WHERE: the table must be allow-listed,
-- the proposal must have been applied by apply_change/reverse_change (applied_audit_id points at an audit row
-- of this proposal on the same entity), and before/after values are taken from that audit row.
create or replace function mudar_app.cx_verified_apply(p_cp uuid)
returns jsonb language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  cp mudar.change_proposal; ae mudar.audit_event; v_kind text; v_eid uuid; v_fields text[]; r jsonb;
  v_rep jsonb := '[]'; v_risk mudar.risk_level;
begin
  select * into cp from mudar.change_proposal where id = p_cp;
  if not found then raise exception 'not_found: change proposal' using errcode = 'P0002'; end if;
  if not (cp.target_type = any(mudar_app.cx_allowed_tables())) then
    raise exception 'forbidden: table % is not changeable through proposals', cp.target_type using errcode = '42501';
  end if;
  if cp.state not in ('applied','conflict') or cp.applied_audit_id is null or cp.before is null or cp.target_id is null then
    raise exception 'invalid_state: only applied proposals can be reversed (state %)', cp.state using errcode = '22023';
  end if;
  v_kind := case when cp.reversal_of is not null then 'update'
                 when cp.operation = 'update' then 'update' when cp.operation = 'archive' then 'archive'
                 when cp.operation = 'merge' then 'merge' else 'create' end;
  if coalesce(cp.before->>'kind','') <> v_kind and not (cp.reversal_of is not null and cp.before->>'kind' = 'reversal') then
    raise exception 'invalid_state: proposal was not applied by apply_change' using errcode = '22023';
  end if;
  v_eid := case when v_kind = 'merge' then (cp.before->>'loser')::uuid else cp.target_id end;
  select * into ae from mudar.audit_event a
   where a.id = cp.applied_audit_id and a.workspace_id = cp.workspace_id and a.change_proposal_id = cp.id
     and a.entity_type = cp.target_type and a.entity_id = v_eid
     and a.action = case when v_kind = 'create' then 'insert' else 'update' end;
  if not found then
    raise exception 'forbidden: proposal % was not applied by apply_change (no matching audit record)', cp.id using errcode = '42501';
  end if;

  if v_kind = 'update' then
    v_fields := mudar_app.cx_patch_fields(cp.target_type, cp.patch);       -- re-validates columns (denied columns rejected)
  elsif v_kind = 'archive' then
    v_fields := array['archived_at'];
  elsif v_kind = 'create' then
    v_fields := case when jsonb_typeof(cp.patch) = 'array' and jsonb_array_length(cp.patch) > 0
                     then mudar_app.cx_patch_fields(cp.target_type, cp.patch) else '{}'::text[] end;
  else
    v_fields := '{}';
    if cp.target_type not in ('organisation','person','asset') then
      raise exception 'forbidden: merge not supported for %', cp.target_type using errcode = '42501';
    end if;
    for r in select * from jsonb_array_elements(coalesce(cp.before->'repointed','[]')) loop
      if not exists (select 1 from mudar_app.cx_merge_refs(cp.target_type) m where m.tbl = r->>'table' and m.col = r->>'column') then
        raise exception 'forbidden: merge reference %.% is not allow-listed', r->>'table', r->>'column' using errcode = '42501';
      end if;
      v_rep := v_rep || jsonb_build_object('table', r->>'table', 'column', r->>'column', 'ids', coalesce(r->'ids','[]'));
    end loop;
    if (ae.after->>'archived_at') is null then
      raise exception 'forbidden: merge audit record does not archive the merged record' using errcode = '42501';
    end if;
  end if;
  v_risk := mudar_app.cx_max_risk(cp.risk, mudar_app.cx_risk_floor(cp.target_type, case when cp.reversal_of is not null then 'update' else cp.operation end, v_fields));
  return jsonb_build_object(
    'kind', v_kind, 'risk', v_risk, 'target_type', cp.target_type, 'target_id', cp.target_id, 'workspace_id', cp.workspace_id,
    'field_names', to_jsonb(v_fields),
    'fields', (select coalesce(jsonb_object_agg(f, ae.before->f), '{}') from unnest(v_fields) f),
    'after',  (select coalesce(jsonb_object_agg(f, ae.after->f), '{}') from unnest(v_fields) f),
    'after_version', ae.after->'row_version',
    'loser', case when v_kind = 'merge' then to_jsonb(v_eid) end,
    'stamp', case when v_kind = 'merge' then ae.after->'archived_at' end,
    'repointed', v_rep,
    'archived_relations', coalesce(cp.before->'archived_relations','[]'),
    'aliases_added', coalesce(cp.before->'aliases_added','[]'),
    'reversed', coalesce(cp.before->'reversed','[]'));
end $$;

-- ============================================================ reversal preview (dependencies)
create or replace function mudar_app.preview_reverse(p_proposal uuid, p_actor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  cp mudar.change_proposal; v_actor uuid; v_row jsonb; v_fields jsonb := '[]'; f text; v_rev jsonb; v jsonb;
  v_later jsonb; v_deps jsonb := '[]'; fk record; n bigint; v_kind text;
begin
  v_actor := mudar_app.cx_actor(p_actor);
  select * into cp from mudar.change_proposal where id = p_proposal;
  if not found or not mudar_app.cx_can_read(cp.workspace_id, cp.classification, cp.owner_user_id, 'change_proposal', cp.id, v_actor) then
    raise exception 'not_found: change proposal' using errcode = 'P0002';
  end if;
  if cp.state not in ('applied','conflict') or cp.before is null then
    return jsonb_build_object('proposal_id', cp.id, 'reversible', false, 'reason', 'proposal is ' || cp.state);
  end if;
  v := mudar_app.cx_verified_apply(cp.id);
  v_kind := v->>'kind';
  v_row := mudar_app.cx_load_row(cp.target_type, cp.target_id, cp.workspace_id, false);
  if v_row is null or not mudar_app.cx_can_read(cp.workspace_id, (v_row->>'classification')::mudar.classification,
                                          (v_row->>'owner_user_id')::uuid, cp.target_type, cp.target_id, v_actor) then
    raise exception 'not_found: target' using errcode = 'P0002';
  end if;
  v_rev := v->'reversed';
  if v_kind in ('update','archive') then
    for f in select jsonb_array_elements_text(v->'field_names') loop
      if v_rev ? f then continue; end if;
      v_fields := v_fields || jsonb_build_object('path', '/' || f, 'before', v->'fields'->f, 'applied', v->'after'->f,
                                                 'current', v_row->f, 'restorable', (v_row->f) is not distinct from (v->'after'->f));
    end loop;
  elsif v_kind = 'create' then
    v_fields := jsonb_build_array(jsonb_build_object('path','/archived_at','restorable',
                  (v_row->>'row_version')::bigint = (v->>'after_version')::bigint and v_row->>'archived_at' is null,
                  'current_version', v_row->'row_version', 'applied_version', v->'after_version'));
    for fk in select cl.relname as tbl, a.attname as col from pg_constraint c
                join pg_class cl on cl.oid = c.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
               where c.contype = 'f' and c.confrelid = ('public.' || cp.target_type)::regclass and ns.nspname = 'public'
                 and cardinality(c.conkey) = 1 loop
      execute format('select count(*) from mudar.%I where %I = $1', fk.tbl, fk.col) into n using cp.target_id;
      if n > 0 then v_deps := v_deps || jsonb_build_object('table', fk.tbl, 'column', fk.col, 'count', n); end if;
    end loop;
  elsif v_kind = 'merge' then
    v_fields := (select coalesce(jsonb_agg(jsonb_build_object('table', r->>'table', 'column', r->>'column',
                   'count', jsonb_array_length(r->'ids'))), '[]') from jsonb_array_elements(v->'repointed') r);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('audit_id', ae.id, 'at', ae.occurred_at, 'actor_user_id', ae.actor_user_id,
           'change_proposal_id', ae.change_proposal_id,
           'fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(coalesce(ae.after,'{}')) k
                       where k not in ('row_version','updated_at') and (ae.before->k) is distinct from (ae.after->k)))
           order by ae.id), '[]')
    into v_later
    from mudar.audit_event ae
   where ae.workspace_id = cp.workspace_id and ae.entity_type = cp.target_type and ae.entity_id = cp.target_id
     and ae.id > cp.applied_audit_id and ae.action = 'update'
     and ae.change_proposal_id is distinct from cp.id;
  return jsonb_build_object('proposal_id', cp.id, 'reversible', true, 'kind', v_kind, 'risk', v->'risk', 'target_type', cp.target_type,
                            'target_id', cp.target_id, 'fields', v_fields, 'later_changes', v_later, 'dependents', v_deps,
                            'external_effects', 'none (database undo cannot unsend messages; drafts are never sent automatically)');
end $$;

-- ============================================================ reverse
create or replace function mudar_app.reverse_change(p_proposal uuid, p_actor uuid default null, p_paths text[] default null)
returns jsonb language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  cp mudar.change_proposal; v_actor uuid; v_row jsonb; v_kind text; f text; v_rev jsonb; v_restore jsonb := '{}';
  v_conflicts jsonb := '[]'; v_rp uuid; v_after jsonb; v_audit bigint; v_patch jsonb := '[]'; v_remaining int := 0;
  r jsonb; v_ids uuid[]; v_done uuid[]; c jsonb; v_status text; v_n int; v jsonb; v_risk mudar.risk_level; v_loser uuid;
  v_lrow jsonb;
begin
  v_actor := mudar_app.cx_actor(p_actor);
  select * into cp from mudar.change_proposal where id = p_proposal for update;
  if not found or not mudar_app.cx_can_read(cp.workspace_id, cp.classification, cp.owner_user_id, 'change_proposal', cp.id, v_actor) then
    raise exception 'not_found: change proposal' using errcode = 'P0002';
  end if;
  v := mudar_app.cx_verified_apply(cp.id);                       -- allow-list + audit-verified before/after (raises otherwise)
  v_kind := v->>'kind';
  v_risk := (v->>'risk')::mudar.risk_level;                -- recomputed; never lower than the code-level floor
  if not mudar_app.cx_role_at_least(cp.workspace_id, v_actor, mudar_app.cx_required_role(v_risk)) then
    raise exception 'forbidden: reversing % changes requires % role', v_risk, mudar_app.cx_required_role(v_risk) using errcode = '42501';
  end if;
  v_rev := v->'reversed';

  if v_kind = 'merge' then
    if cp.before ? 'reversed_at' then
      raise exception 'invalid_state: merge already reversed' using errcode = '22023';
    end if;
    v_loser := (v->>'loser')::uuid;
    v_lrow := mudar_app.cx_load_row(cp.target_type, v_loser, cp.workspace_id, true);
    v_row := mudar_app.cx_load_row(cp.target_type, cp.target_id, cp.workspace_id, true);
    if v_row is null or v_lrow is null
       or not mudar_app.cx_can_write(cp.workspace_id, (v_row->>'classification')::mudar.classification, (v_row->>'owner_user_id')::uuid, cp.target_type, cp.target_id, v_actor)
       or not mudar_app.cx_can_write(cp.workspace_id, (v_lrow->>'classification')::mudar.classification, (v_lrow->>'owner_user_id')::uuid, cp.target_type, v_loser, v_actor) then
      raise exception 'not_found: target' using errcode = 'P0002';
    end if;
    insert into mudar.change_proposal(workspace_id, target_type, target_id, operation, patch, reason, risk, approval_required,
                                       state, proposed_by_kind, reversal_of, decided_by, decided_at, owner_user_id, classification)
    values (cp.workspace_id, cp.target_type, cp.target_id, 'update', jsonb_build_array(jsonb_build_object('op','replace','path','/unmerge','value', to_jsonb(v_loser))),
            'Reversal of merge ' || cp.id, v_risk, false, 'applied', 'user', cp.id, v_actor, now(), coalesce(cp.owner_user_id, v_actor), cp.classification)
    returning id into v_rp;
    perform set_config('mudar_app.change_proposal_id', v_rp::text, true);
    for r in select * from jsonb_array_elements(v->'repointed') loop
      select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(r->'ids') x;
      execute format('with u as (update mudar.%I set %I = $1 where workspace_id = $3 and id = any($4) and %I = $2 returning id)
                      select coalesce(array_agg(id), ''{}'') from u', r->>'table', r->>'column', r->>'column')
        into v_done using v_loser, cp.target_id, cp.workspace_id, v_ids;
      if cardinality(v_done) < cardinality(v_ids) then
        v_conflicts := v_conflicts || jsonb_build_object('kind','merge_ref','path', (r->>'table') || '.' || (r->>'column'),
                         'detail', jsonb_build_object('not_restored', (select to_jsonb(array_agg(i)) from unnest(v_ids) i where not (i = any(v_done))),
                                                      'reason','row was re-linked or edited after the merge'));
      end if;
    end loop;
    update mudar.organisation_relation set archived_at = null
     where workspace_id = cp.workspace_id and id in (select x::uuid from jsonb_array_elements_text(v->'archived_relations') x)
       and archived_at = (v->>'stamp')::timestamptz;
    update mudar.entity_alias set archived_at = now()
     where workspace_id = cp.workspace_id and entity_type = cp.target_type and entity_id = cp.target_id
       and id in (select x::uuid from jsonb_array_elements_text(v->'aliases_added') x);
    execute format('update mudar.%I set archived_at = null where id = $1 and workspace_id = $2 and archived_at = $3', cp.target_type)
      using v_loser, cp.workspace_id, (v->>'stamp')::timestamptz;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      v_conflicts := v_conflicts || jsonb_build_object('kind','archive_modified','path','/archived_at',
                       'detail', jsonb_build_object('entity_id', v_loser, 'reason','merged record was changed after the merge'));
    end if;
    v_status := case when jsonb_array_length(v_conflicts) = 0 then 'reversed' else 'partial' end;
  else
    v_row := mudar_app.cx_load_row(cp.target_type, cp.target_id, cp.workspace_id, true);
    if v_row is null or not mudar_app.cx_can_write(cp.workspace_id, (v_row->>'classification')::mudar.classification,
                                             (v_row->>'owner_user_id')::uuid, cp.target_type, cp.target_id, v_actor) then
      raise exception 'not_found: target' using errcode = 'P0002';
    end if;
    if v_kind = 'create' then
      if v_rev ? 'archived_at' then
        raise exception 'invalid_state: create already reversed' using errcode = '22023';
      end if;
      if (v_row->>'row_version')::bigint = (v->>'after_version')::bigint and v_row->>'archived_at' is null then
        v_restore := jsonb_build_object('archived_at', to_jsonb(now()));
      else
        v_conflicts := v_conflicts || jsonb_build_object('kind','create_modified','path','/archived_at', 'current', v_row->'row_version',
                         'applied', v->'after_version',
                         'detail', jsonb_build_object('reason','record was edited after it was created; archive it manually if still intended'));
      end if;
    else
      for f in select jsonb_array_elements_text(v->'field_names') loop
        if v_rev ? f then continue; end if;
        if p_paths is not null and not (('/' || f) = any(p_paths) or f = any(p_paths)) then v_remaining := v_remaining + 1; continue; end if;
        if (v_row->f) is not distinct from (v->'after'->f) then
          v_restore := v_restore || jsonb_build_object(f, v->'fields'->f);
        else
          v_conflicts := v_conflicts || jsonb_build_object('kind','field','path','/' || f, 'before', v->'fields'->f,
                           'applied', v->'after'->f, 'current', v_row->f,
                           'detail', jsonb_build_object('reason','field was edited after this change; newer value kept'));
        end if;
      end loop;
    end if;
    if v_restore <> '{}'::jsonb then
      select jsonb_agg(jsonb_build_object('op','replace','path','/' || k, 'value', v_restore->k)) into v_patch from jsonb_object_keys(v_restore) k;
      insert into mudar.change_proposal(workspace_id, target_type, target_id, operation, expected_version, patch, before, reason,
                                         risk, approval_required, state, proposed_by_kind, reversal_of, decided_by, decided_at,
                                         owner_user_id, classification)
      values (cp.workspace_id, cp.target_type, cp.target_id, 'update', (v_row->>'row_version')::bigint, v_patch,
              jsonb_build_object('kind','reversal','fields', (select jsonb_object_agg(k, v_row->k) from jsonb_object_keys(v_restore) k)),
              'Reversal of change ' || cp.id, v_risk, false, 'applied', 'user', cp.id, v_actor, now(),
              coalesce(cp.owner_user_id, v_actor), cp.classification)
      returning id into v_rp;
      perform set_config('mudar_app.change_proposal_id', v_rp::text, true);
      v_after := mudar_app.cx_update_fields(cp.target_type, cp.target_id, cp.workspace_id, v_restore);
      select max(id) into v_audit from mudar.audit_event where change_proposal_id = v_rp and entity_type = cp.target_type and entity_id = cp.target_id;
      update mudar.change_proposal set applied_audit_id = v_audit where id = v_rp;
      v_rev := v_rev || (select jsonb_agg(k) from jsonb_object_keys(v_restore) k);
    end if;
    if v_kind = 'create' then
      v_status := case when v_restore <> '{}'::jsonb then 'reversed' else 'conflict' end;
    else
      v_status := case when jsonb_array_length(v_conflicts) = 0 and v_remaining = 0 then 'reversed'
                       when v_restore = '{}'::jsonb then 'conflict' else 'partial' end;
    end if;
  end if;

  for c in select * from jsonb_array_elements(v_conflicts) loop
    insert into mudar.change_conflict(workspace_id, proposal_id, reversal_proposal_id, kind, path, before_value, applied_value,
                                       current_value, detail, owner_user_id, classification)
    values (cp.workspace_id, cp.id, v_rp, c->>'kind', c->>'path', c->'before', c->'applied', c->'current', coalesce(c->'detail','{}'),
            coalesce(cp.owner_user_id, v_actor), cp.classification);
  end loop;
  update mudar.change_conflict set resolved_at = now()
   where proposal_id = cp.id and resolved_at is null and kind = 'field' and v_rev ? substr(path, 2);

  perform set_config('mudar_app.change_proposal_id', cp.id::text, true);
  update mudar.change_proposal
     set state = case when v_status = 'reversed' then 'reversed' when v_remaining > 0 and jsonb_array_length(v_conflicts) = 0 then state else 'conflict' end,
         before = case when v_kind = 'merge' then before || jsonb_build_object('reversed_at', now()) else jsonb_set(before, '{reversed}', v_rev) end
   where id = cp.id;
  perform mudar_app.cx_audit(cp.workspace_id, v_actor, 'reverse', cp.id,
                       jsonb_build_object('status', v_status, 'reversal_proposal_id', v_rp, 'conflicts', v_conflicts), cp.applied_audit_id);
  return jsonb_build_object('status', v_status, 'proposal_id', cp.id, 'reversal_proposal_id', v_rp,
                            'restored', (select coalesce(jsonb_agg('/' || k), '[]') from jsonb_object_keys(v_restore) k),
                            'conflicts', v_conflicts);
end $$;

-- ============================================================ candidate retrieval (permission-scoped)
-- Capture entity resolution may only use IDs returned here (the model never invents IDs).
create or replace function mudar_app.search_entity_candidates(p_workspace uuid, p_entity_type text, p_query text,
                                                        p_user uuid default null, p_org uuid default null, p_limit int default 8)
returns table(id uuid, entity_type text, label text, detail jsonb, score real)
language plpgsql stable security definer set search_path = mudar, mudar_app, public, extensions as $$
declare v_user uuid; q text := lower(trim(coalesce(p_query, '')));
begin
  v_user := mudar_app.cx_actor(p_user);
  if not mudar_app.cx_role_at_least(p_workspace, v_user, 'viewer') then
    raise exception 'forbidden: not a member' using errcode = '42501';
  end if;
  p_limit := least(greatest(coalesce(p_limit, 8), 1), 25);
  if p_entity_type = 'organisation' then
    return query
      select o.id, 'organisation'::text, o.display_name,
             jsonb_build_object('legal_name', o.legal_name, 'domain', o.domain, 'row_version', o.row_version),
             greatest(similarity(lower(o.display_name), q), similarity(lower(coalesce(o.legal_name,'')), q),
                      coalesce((select max(similarity(a.canonical_alias, q)) from mudar.entity_alias a
                                 where a.workspace_id = p_workspace and a.entity_type = 'organisation' and a.entity_id = o.id and a.archived_at is null), 0))::real as s
        from mudar.organisation o
       where o.workspace_id = p_workspace and o.archived_at is null and length(q) >= 2
         and mudar_app.cx_can_read(o.workspace_id, o.classification, o.owner_user_id, 'organisation', o.id, v_user)
         and (lower(o.display_name) like q || '%' or lower(coalesce(o.legal_name,'')) like q || '%' or similarity(lower(o.display_name), q) > 0.35
              or exists (select 1 from mudar.entity_alias a where a.workspace_id = p_workspace and a.entity_type = 'organisation'
                           and a.entity_id = o.id and a.archived_at is null and (a.canonical_alias like q || '%' or similarity(a.canonical_alias, q) > 0.4)))
       order by s desc, o.display_name limit p_limit;
  elsif p_entity_type = 'person' then
    return query
      select p.id, 'person'::text, p.full_name,
             jsonb_build_object('row_version', p.row_version, 'current_orgs',
               (select coalesce(jsonb_agg(jsonb_build_object('employment_id', e.id, 'org_id', e.org_id, 'org_name', o.display_name, 'title', e.title,
                                                             'row_version', e.row_version)), '[]')
                  from mudar.employment e join mudar.organisation o on o.id = e.org_id
                 where e.person_id = p.id and e.is_current and e.archived_at is null and e.workspace_id = p_workspace)),
             greatest(similarity(lower(p.full_name), q),
                      case when lower(p.full_name) like q || ' %' or lower(p.full_name) = q then 0.9 else 0 end)::real as s
        from mudar.person p
       where p.workspace_id = p_workspace and p.archived_at is null and length(q) >= 2
         and mudar_app.cx_can_read(p.workspace_id, p.classification, p.owner_user_id, 'person', p.id, v_user)
         and (lower(p.full_name) = q or lower(p.full_name) like q || ' %' or lower(p.full_name) like '% ' || q
              or similarity(lower(p.full_name), q) > 0.45
              or exists (select 1 from unnest(p.aliases) al where lower(al) = q))
       order by s desc, p.full_name limit p_limit;
  elsif p_entity_type = 'requirement' then
    return query
      select r.id, 'requirement'::text, r.title,
             jsonb_build_object('org_id', r.org_id, 'status', r.status, 'row_version', r.row_version,
                                'area_target_sf', r.area_target_sf, 'constraints', r.constraints,
                                'preferred_geography_ids', r.preferred_geography_ids),
             1::real
        from mudar.requirement r
       where r.workspace_id = p_workspace and r.archived_at is null and r.status <> 'closed'
         and (p_org is null or r.org_id = p_org)
         and (p_org is not null or (length(q) >= 2 and lower(r.title) like '%' || q || '%'))
         and mudar_app.cx_can_read(r.workspace_id, r.classification, r.owner_user_id, 'requirement', r.id, v_user)
       order by r.updated_at desc limit p_limit;
  elsif p_entity_type = 'asset' then
    return query
      select a.id, 'asset'::text, a.name, jsonb_build_object('asset_kind', a.asset_kind, 'row_version', a.row_version),
             similarity(lower(a.name), q)::real as s
        from mudar.asset a
       where a.workspace_id = p_workspace and a.archived_at is null and length(q) >= 3
         and mudar_app.cx_can_read(a.workspace_id, a.classification, a.owner_user_id, 'asset', a.id, v_user)
         and (lower(a.name) like q || '%' or similarity(lower(a.name), q) > 0.45)
       order by s desc limit p_limit;
  elsif p_entity_type = 'geography' then
    return query
      select g.id, 'geography'::text, g.name, jsonb_build_object('level', g.level),
             greatest(similarity(lower(g.name), q), case when exists (select 1 from unnest(g.aliases) al where lower(al) = q) then 1 else 0 end)::real as s
        from mudar.geography g
       where g.workspace_id = p_workspace and g.archived_at is null and length(q) >= 3
         and mudar_app.cx_can_read(g.workspace_id, g.classification, g.owner_user_id, 'geography', g.id, v_user)
         and (lower(g.name) = q or lower(g.name) like q || '%' or exists (select 1 from unnest(g.aliases) al where lower(al) = q))
       order by s desc limit p_limit;
  else
    raise exception 'invalid_parameter: entity type %', p_entity_type using errcode = '22023';
  end if;
end $$;

-- ============================================================ grants
revoke all on function mudar_app.cx_role_at_least(uuid, uuid, mudar.member_role), mudar_app.cx_can_read(uuid, mudar.classification, uuid, text, uuid, uuid),
                       mudar_app.cx_load_row(text, uuid, uuid, boolean), mudar_app.cx_update_fields(text, uuid, uuid, jsonb),
                       mudar_app.cx_patch_fields(text, jsonb), mudar_app.cx_audit(uuid, uuid, text, uuid, jsonb, bigint)
  from public, anon, authenticated;
revoke all on function mudar_app.approve_change(uuid, text, text, int, uuid), mudar_app.apply_change(uuid, uuid),
                       mudar_app.reverse_change(uuid, uuid, text[]), mudar_app.preview_reverse(uuid, uuid),
                       mudar_app.search_entity_candidates(uuid, text, text, uuid, uuid, int)
  from public, anon;
grant execute on function mudar_app.approve_change(uuid, text, text, int, uuid), mudar_app.apply_change(uuid, uuid),
                          mudar_app.reverse_change(uuid, uuid, text[]), mudar_app.preview_reverse(uuid, uuid),
                          mudar_app.search_entity_candidates(uuid, text, text, uuid, uuid, int), mudar_app.change_hash(mudar.change_proposal)
  to authenticated, service_role;

-- ============================================================ C1/C2/M3: proposals and approvals are not freely writable
-- Direct API writes to change_proposal are allowed only as "proposal drafts": a BEFORE trigger forces
-- state='proposed', clears before/applied_audit_id/reversal_of/decided_*, recomputes risk server-side and only lets
-- the content (patch/reason/evidence/expected_version) be edited while undecided — which invalidates any approval.
-- Decisions, application and reversal happen only in the SECURITY DEFINER functions above (they run as the
-- function owner, so current_user is not an API role). approval rows for change proposals are written only by
-- approve_change; change_conflict only by reverse_change.
create or replace function mudar_app.cx_proposal_guard() returns trigger language plpgsql as $$
declare
  v_floor mudar.risk_level; v_old jsonb; v_new jsonb;
  v_editable text[] := array['patch','reason','evidence_ids','expected_version','before','row_version','updated_at'];
begin
  if tg_op = 'INSERT' then
    v_floor := mudar_app.cx_risk_floor(new.target_type, new.operation, mudar_app.cx_fields_of(new.patch));
    if new.target_type = 'draft' then v_floor := mudar_app.cx_max_risk(v_floor, 'external_message'); end if;
    new.risk := mudar_app.cx_max_risk(new.risk, v_floor);
    new.approval_required := coalesce(new.approval_required, false) or new.risk <> 'routine_internal' or new.proposed_by_kind = 'model';
    if current_user in ('authenticated','anon') then
      new.state := 'proposed';
      new.applied_audit_id := null;
      new.reversal_of := null;
      new.decided_by := null;
      new.decided_at := null;
      new.before := case when jsonb_typeof(new.before->'fields') = 'object'
                         then jsonb_build_object('kind','proposal_snapshot','fields', new.before->'fields') end;
    end if;
    return new;
  end if;

  -- UPDATE
  if current_user not in ('authenticated','anon') then return new; end if;
  if old.state not in ('proposed','approved','clarify') then
    raise exception 'forbidden: a % proposal cannot be edited', old.state using errcode = '42501';
  end if;
  v_old := to_jsonb(old) - v_editable;
  v_new := to_jsonb(new) - v_editable;
  if v_old is distinct from v_new then
    raise exception 'forbidden: only patch, reason, evidence and expected_version of a proposal can be edited' using errcode = '42501';
  end if;
  if new.before is distinct from old.before then
    new.before := case when jsonb_typeof(new.before->'fields') = 'object'
                       then jsonb_build_object('kind','proposal_snapshot','fields', new.before->'fields') end;
  end if;
  if new.patch is distinct from old.patch or new.expected_version is distinct from old.expected_version then
    -- content changed: any approval no longer matches (hash-bound) and the proposal goes back to the queue
    new.state := 'proposed';
    new.decided_by := null;
    new.decided_at := null;
    new.risk := mudar_app.cx_max_risk(old.risk, mudar_app.cx_risk_floor(new.target_type, new.operation, mudar_app.cx_fields_of(new.patch)));
    new.approval_required := old.approval_required or new.risk <> 'routine_internal';
  end if;
  return new;
end $$;
drop trigger if exists cx_proposal_guard on mudar.change_proposal;
create trigger cx_proposal_guard before insert or update on mudar.change_proposal
  for each row execute function mudar_app.cx_proposal_guard();

create or replace function mudar_app.cx_approval_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') then
    if tg_op <> 'INSERT' then
      raise exception 'forbidden: approvals are immutable' using errcode = '42501';
    end if;
    if new.subject_type = 'change_proposal' then
      raise exception 'forbidden: change proposals are approved only through mudar_app.approve_change' using errcode = '42501';
    end if;
    if new.approver_user_id is distinct from auth.uid() then
      raise exception 'forbidden: approver must be the signed-in user' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists cx_approval_guard on mudar.approval;
create trigger cx_approval_guard before insert or update on mudar.approval
  for each row execute function mudar_app.cx_approval_guard();

revoke delete on mudar.change_proposal from authenticated, anon;
revoke update, delete on mudar.approval from authenticated, anon;
revoke insert, update, delete on mudar.change_conflict from authenticated, anon;

-- M3: material fields of canonical tables cannot be changed by direct API updates; only apply_change /
-- reverse_change (SECURITY DEFINER) or trusted service-role jobs may write them.
create or replace function mudar_app.cx_material_guard() returns trigger language plpgsql as $$
declare f text; o jsonb; n jsonb;
begin
  if current_user not in ('authenticated','anon') then return new; end if;
  o := to_jsonb(old); n := to_jsonb(new);
  foreach f in array mudar_app.cx_material_fields(tg_table_name) loop
    if (o->f) is distinct from (n->f) then
      raise exception 'approval_required: %.% is a material field; submit a change proposal', tg_table_name, f using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['requirement','opportunity','lease','lease_event','employment','quote','fee_milestone',
                           'organisation','person','contact_method','availability'] loop
    execute format('drop trigger if exists cx_material_guard on mudar.%I', t);
    execute format('create trigger cx_material_guard before update on mudar.%I for each row execute function mudar_app.cx_material_guard()', t);
  end loop;
end $$;

-- ============================================================ propose (the supported way to create a proposal)
-- Risk is computed here (never lower than the SQL floor), the actor is auth.uid() (or the explicit user for
-- service-role jobs), and the caller must be able to write the target row.
create or replace function mudar_app.propose_change(
  p_workspace uuid, p_target_type text, p_target_id uuid, p_operation text, p_patch jsonb,
  p_reason text default null, p_expected_version bigint default null, p_evidence_ids uuid[] default '{}',
  p_proposed_by_kind text default 'user', p_model text default null, p_idempotency_key text default null,
  p_capture_id uuid default null, p_classification mudar.classification default 'corporate_confidential',
  p_owner_user_id uuid default null, p_risk_hint mudar.risk_level default null, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare
  v_actor uuid; v_op text := coalesce(p_operation, 'update'); v_fields text[] := '{}'; v_row jsonb; v_risk mudar.risk_level;
  v_existing mudar.change_proposal; v_new mudar.change_proposal; v_snap jsonb; v_kind text := coalesce(p_proposed_by_kind, 'user');
  v_owner uuid; v_obj jsonb;
begin
  if auth.uid() is not null or p_actor is not null then
    v_actor := mudar_app.cx_actor(p_actor);
    if not mudar_app.cx_role_at_least(p_workspace, v_actor, 'editor') then
      raise exception 'forbidden: proposing changes requires editor role' using errcode = '42501';
    end if;
  else
    v_kind := case when v_kind = 'model' then 'model' else 'job' end;   -- service-role job without a named user
  end if;
  if v_op not in ('create','update','archive','merge','link') then
    raise exception 'invalid_patch: operation %', v_op using errcode = '22023';
  end if;
  if v_kind not in ('user','job','model') then
    raise exception 'invalid_parameter: proposed_by_kind %', v_kind using errcode = '22023';
  end if;
  if not (p_target_type = any(mudar_app.cx_allowed_tables())) then
    raise exception 'forbidden: table % is not changeable through proposals', p_target_type using errcode = '42501';
  end if;
  if p_idempotency_key is not null then
    select * into v_existing from mudar.change_proposal where workspace_id = p_workspace and idempotency_key = p_idempotency_key;
    if found then
      if v_actor is not null and not mudar_app.cx_can_read(v_existing.workspace_id, v_existing.classification, v_existing.owner_user_id,
                                                      'change_proposal', v_existing.id, v_actor) then
        raise exception 'conflict: idempotency key already used' using errcode = '23505';
      end if;
      return to_jsonb(v_existing);
    end if;
  end if;

  if v_op in ('update','create','link') then
    v_fields := mudar_app.cx_patch_fields(p_target_type, p_patch);
  elsif v_op = 'merge' then
    if p_target_type not in ('organisation','person','asset') then
      raise exception 'forbidden: merge not supported for %', p_target_type using errcode = '42501';
    end if;
    v_obj := mudar_app.cx_patch_object(coalesce(p_patch, '[]'));
    if (v_obj->>'loser_id') is null or (v_obj->>'loser_id') = p_target_id::text then
      raise exception 'invalid_patch: merge needs /loser_id different from target' using errcode = '22023';
    end if;
    v_row := mudar_app.cx_load_row(p_target_type, (v_obj->>'loser_id')::uuid, p_workspace, false);
    if v_row is null or (v_actor is not null and not mudar_app.cx_can_write(p_workspace, (v_row->>'classification')::mudar.classification,
                            (v_row->>'owner_user_id')::uuid, p_target_type, (v_obj->>'loser_id')::uuid, v_actor)) then
      raise exception 'not_found: merge source' using errcode = 'P0002';
    end if;
  end if;

  if v_op in ('create','link') then
    if p_target_id is not null then
      raise exception 'invalid_patch: create must not carry target_id' using errcode = '22023';
    end if;
  else
    if p_target_id is null then
      raise exception 'invalid_patch: % needs a target_id', v_op using errcode = '22023';
    end if;
    v_row := mudar_app.cx_load_row(p_target_type, p_target_id, p_workspace, false);
    if v_row is null or (v_actor is not null and not mudar_app.cx_can_write(p_workspace, (v_row->>'classification')::mudar.classification,
                            (v_row->>'owner_user_id')::uuid, p_target_type, p_target_id, v_actor)) then
      raise exception 'not_found: target %', p_target_type using errcode = 'P0002';
    end if;
    if v_op = 'update' then
      v_snap := jsonb_build_object('kind','proposal_snapshot','fields', (select jsonb_object_agg(f, v_row->f) from unnest(v_fields) f));
    end if;
  end if;

  v_owner := coalesce(p_owner_user_id, v_actor);
  if v_actor is not null and not mudar_app.cx_can_read(p_workspace, p_classification, v_owner, 'change_proposal', null, v_actor) then
    raise exception 'forbidden: classification % / owner not permitted', p_classification using errcode = '42501';
  end if;
  v_risk := mudar_app.cx_max_risk(p_risk_hint, mudar_app.cx_risk_floor(p_target_type, v_op, v_fields));
  if v_risk = 'external_message' then
    raise exception 'forbidden: external messages are drafts, not change proposals' using errcode = '42501';
  end if;

  insert into mudar.change_proposal(workspace_id, target_type, target_id, operation, expected_version, patch, before, reason,
                                     evidence_ids, risk, approval_required, state, proposed_by_kind, model, idempotency_key,
                                     capture_id, owner_user_id, classification)
  values (p_workspace, p_target_type, p_target_id, v_op,
          coalesce(p_expected_version, case when v_op in ('update','archive') then (v_row->>'row_version')::bigint end),
          coalesce(p_patch, '[]'::jsonb), v_snap, p_reason, coalesce(p_evidence_ids, '{}'), v_risk,
          v_risk <> 'routine_internal' or v_kind = 'model', 'proposed', v_kind, p_model, p_idempotency_key, p_capture_id,
          v_owner, p_classification)
  on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
  returning * into v_new;
  if v_new.id is null then
    select * into v_new from mudar.change_proposal where workspace_id = p_workspace and idempotency_key = p_idempotency_key;
  end if;
  return to_jsonb(v_new);
end $$;

-- edit the content of an undecided proposal (invalidates any approval; see cx_proposal_guard)
create or replace function mudar_app.edit_change(p_proposal uuid, p_patch jsonb, p_reason text default null, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = mudar, mudar_app, public, extensions as $$
declare cp mudar.change_proposal; v_actor uuid; v_fields text[]; v_risk mudar.risk_level; v_row jsonb;
begin
  v_actor := mudar_app.cx_actor(p_actor);
  select * into cp from mudar.change_proposal where id = p_proposal for update;
  if not found or not mudar_app.cx_can_read(cp.workspace_id, cp.classification, cp.owner_user_id, 'change_proposal', cp.id, v_actor) then
    raise exception 'not_found: change proposal' using errcode = 'P0002';
  end if;
  if not mudar_app.cx_role_at_least(cp.workspace_id, v_actor, 'editor') then
    raise exception 'forbidden: editing proposals requires editor role' using errcode = '42501';
  end if;
  if cp.state not in ('proposed','approved','clarify') then
    raise exception 'invalid_state: proposal is %', cp.state using errcode = '22023';
  end if;
  if not (cp.target_type = any(mudar_app.cx_allowed_tables())) or cp.operation not in ('update','create','link') then
    raise exception 'forbidden: only field updates/creates can be edited' using errcode = '42501';
  end if;
  v_fields := mudar_app.cx_patch_fields(cp.target_type, p_patch);
  v_risk := mudar_app.cx_max_risk(cp.risk, mudar_app.cx_risk_floor(cp.target_type, cp.operation, v_fields));
  if cp.target_id is not null then
    v_row := mudar_app.cx_load_row(cp.target_type, cp.target_id, cp.workspace_id, false);
  end if;
  update mudar.change_proposal
     set patch = p_patch, reason = coalesce(p_reason, reason), risk = v_risk,
         approval_required = approval_required or v_risk <> 'routine_internal',
         state = 'proposed', decided_by = null, decided_at = null,
         before = case when v_row is not null then jsonb_build_object('kind','proposal_snapshot','fields',
                         (select jsonb_object_agg(f, v_row->f) from unnest(v_fields) f)) else before end
   where id = cp.id;
  perform mudar_app.cx_audit(cp.workspace_id, v_actor, 'edit', cp.id, jsonb_build_object('patch', p_patch));
  select * into cp from mudar.change_proposal where id = p_proposal;
  return to_jsonb(cp);
end $$;

revoke all on function mudar_app.cx_can_write(uuid, mudar.classification, uuid, text, uuid, uuid), mudar_app.cx_verified_apply(uuid),
                       mudar_app.cx_proposal_guard(), mudar_app.cx_approval_guard(), mudar_app.cx_material_guard()
  from public, anon, authenticated;
revoke all on function mudar_app.propose_change(uuid, text, uuid, text, jsonb, text, bigint, uuid[], text, text, text, uuid, mudar.classification, uuid, mudar.risk_level, uuid),
                       mudar_app.edit_change(uuid, jsonb, text, uuid)
  from public, anon;
grant execute on function mudar_app.propose_change(uuid, text, uuid, text, jsonb, text, bigint, uuid[], text, text, text, uuid, mudar.classification, uuid, mudar.risk_level, uuid),
                          mudar_app.edit_change(uuid, jsonb, text, uuid)
  to authenticated, service_role;
