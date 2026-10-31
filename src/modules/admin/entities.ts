/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyRisk, proposeChange } from "@/lib/services/changes";
import { badRequest, conflict, notFound } from "./errors";

/**
 * Entity pages (Company / Person / Building) — read models and simple edits.
 * Every read uses the caller's RLS client: a record the user cannot see returns null (=> 404), including via
 * direct object URL. Material field edits are routed to proposeChange() (approval queue), never written directly.
 */
type Client = SupabaseClient<any, "public", any>;
type Row = Record<string, any>;

export type EntityTable = "organisation" | "person" | "asset";

export const CLASSIFICATIONS = ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] as const;

/** Form-editable columns per entity (anything else is owned by imports/captures/other modules). */
export const EDITABLE: Record<EntityTable, string[]> = {
  organisation: ["display_name", "legal_name", "domain", "cin", "gstin", "sector", "hq_country", "headcount_min", "headcount_max",
    "is_gcc", "crm_external_id", "account_owner_note", "contact_restrictions", "classification"],
  person: ["full_name", "aliases", "public_profile_url", "preferred_language", "preferred_channel", "contact_restrictions", "personal_notes", "classification"],
  asset: ["name", "asset_kind", "parent_asset_id", "address", "status", "grade", "total_area_sf", "floors", "floor_size_text",
    "completion_date", "completion_precision", "lat", "lon", "classification"],
};

const NUMERIC = new Set(["headcount_min", "headcount_max", "total_area_sf", "floors", "lat", "lon"]);
const BOOL = new Set(["is_gcc"]);
const ARRAY = new Set(["aliases"]);

/** Normalise form input. Blank stays null (unknown) — never coerced to 0 (rule S6). */
export function normaliseInput(table: EntityTable, input: Record<string, unknown>): Row {
  const out: Row = {};
  for (const k of EDITABLE[table]) {
    if (!(k in input)) continue;
    const v = input[k];
    if (ARRAY.has(k)) {
      const list = Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/);
      out[k] = list.map((s) => String(s).trim()).filter(Boolean);
    } else if (NUMERIC.has(k)) {
      const s = String(v ?? "").replace(/,/g, "").trim();
      if (s === "") out[k] = null;
      else if (!Number.isFinite(Number(s))) throw badRequest(`${k} must be a number`);
      else out[k] = Number(s);
    } else if (BOOL.has(k)) {
      const s = String(v ?? "").trim();
      out[k] = s === "" || s === "unknown" ? null : s === "true" || s === "on" || s === "yes";
    } else {
      const s = v === null || v === undefined ? "" : String(v).trim();
      out[k] = s === "" ? null : s;
    }
  }
  if (table === "organisation" && "display_name" in out && !out.display_name) throw badRequest("display name is required");
  if (table === "person" && "full_name" in out && !out.full_name) throw badRequest("full name is required");
  if (table === "asset" && "name" in out && !out.name) throw badRequest("building name is required");
  if (out.classification && !(CLASSIFICATIONS as readonly string[]).includes(out.classification)) throw badRequest("invalid classification");
  if (out.classification === null) delete out.classification;
  return out;
}

function same(a: unknown, b: unknown) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

export async function createEntity(db: Client, workspaceId: string, userId: string, table: EntityTable, input: Record<string, unknown>) {
  const row = normaliseInput(table, input);
  const { data, error } = await db.from(table)
    .insert({ ...row, workspace_id: workspaceId, owner_user_id: userId })
    .select().single();
  if (error) throw badRequest(error.message);
  return data as Row;
}

export interface SaveResult {
  applied: string[];
  proposed: string[];
  proposalId: string | null;
  rowVersion: number;
}

/**
 * Save an edit form: routine fields are written with optimistic concurrency; material fields (classified in code by
 * classifyRisk) become a change proposal against the resulting row version.
 */
export async function saveEntity(db: Client, workspaceId: string, table: EntityTable, id: string, expectedVersion: number,
  input: Record<string, unknown>, reason = "Edited in entity form"): Promise<SaveResult> {
  const { data: current, error: e1 } = await db.from(table).select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (e1) throw badRequest(e1.message);
  if (!current) throw notFound(table);
  if (Number(current.row_version) !== Number(expectedVersion)) throw conflict();
  const next = normaliseInput(table, input);
  const routine: Row = {};
  const material: Row = {};
  for (const [k, v] of Object.entries(next)) {
    if (same(current[k], v)) continue;
    const risk = classifyRisk(table, "update", [{ op: "replace", path: `/${k}`, value: v }]);
    if (risk === "routine_internal") routine[k] = v;
    else material[k] = v;
  }
  let version = Number(current.row_version);
  if (Object.keys(routine).length) {
    const { data, error } = await db.from(table).update(routine).eq("id", id).eq("row_version", version).select("row_version");
    if (error) throw badRequest(error.message);
    if (!data || data.length === 0) throw conflict();
    version = Number(data[0].row_version);
  }
  let proposalId: string | null = null;
  if (Object.keys(material).length) {
    const proposal = await proposeChange(db, workspaceId, {
      targetType: table,
      targetId: id,
      operation: "update",
      expectedVersion: version,
      patch: Object.entries(material).map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v })),
      reason,
      proposedByKind: "user",
      classification: current.classification,
    });
    proposalId = proposal.id;
  }
  return { applied: Object.keys(routine), proposed: Object.keys(material), proposalId, rowVersion: version };
}

/**
 * Archive instead of delete (history, evidence and audit stay intact). Archiving a company/person/building is a
 * material change (classifyRisk), so it becomes a change proposal for approval; restoring an archived record is a
 * direct, audited write.
 */
export async function setArchived(db: Client, workspaceId: string, table: EntityTable, id: string, expectedVersion: number, archived: boolean,
  reason = "Archived from entity page"): Promise<{ proposalId: string | null; rowVersion: number }> {
  if (archived) {
    const { data: current } = await db.from(table).select("id, row_version, classification, archived_at").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!current) throw notFound(table);
    if (Number(current.row_version) !== Number(expectedVersion)) throw conflict();
    if (current.archived_at) return { proposalId: null, rowVersion: Number(current.row_version) };
    const proposal = await proposeChange(db, workspaceId, {
      targetType: table, targetId: id, operation: "archive", expectedVersion: Number(current.row_version), patch: [],
      reason, proposedByKind: "user", classification: current.classification,
    });
    return { proposalId: proposal.id as string, rowVersion: Number(current.row_version) };
  }
  const { data, error } = await db.from(table)
    .update({ archived_at: null })
    .eq("workspace_id", workspaceId).eq("id", id).eq("row_version", expectedVersion).select("id, row_version");
  if (error) throw badRequest(error.message);
  if (!data || data.length === 0) throw conflict("record changed or not visible; reload and retry");
  return { proposalId: null, rowVersion: Number(data[0].row_version) };
}

/** Share a record with a colleague (account assignment). RLS: admins/owners only. */
export async function shareRecord(db: Client, workspaceId: string, entityType: string, entityId: string, userId: string) {
  const { error } = await db.from("record_share").upsert(
    { workspace_id: workspaceId, entity_type: entityType, entity_id: entityId, user_id: userId },
    { onConflict: "entity_type,entity_id,user_id", ignoreDuplicates: true });
  if (error) throw badRequest(error.message);
}
export async function unshareRecord(db: Client, workspaceId: string, entityType: string, entityId: string, userId: string) {
  const { error } = await db.from("record_share").delete()
    .eq("workspace_id", workspaceId).eq("entity_type", entityType).eq("entity_id", entityId).eq("user_id", userId);
  if (error) throw badRequest(error.message);
}

export async function memberDirectory(db: Client, workspaceId: string): Promise<{ user_id: string; display_name: string; role: string }[]> {
  const { data } = await db.schema("app").rpc("member_directory", { p_workspace: workspaceId });
  return (data ?? []) as { user_id: string; display_name: string; role: string }[];
}

// ------------------------------------------------------------------ lists
export async function listEntities(db: Client, workspaceId: string, table: EntityTable,
  opts: { q?: string; archived?: boolean; page?: number; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 50;
  const page = Math.max(0, opts.page ?? 0);
  const nameCol = table === "organisation" ? "display_name" : table === "person" ? "full_name" : "name";
  const cols = table === "organisation" ? "id, display_name, legal_name, sector, domain, classification, owner_user_id, updated_at, archived_at"
    : table === "person" ? "id, full_name, aliases, contact_restrictions, classification, owner_user_id, updated_at, archived_at"
      : "id, name, asset_kind, parent_asset_id, address, status, grade, total_area_sf, classification, updated_at, archived_at";
  let query: any = (db as any).from(table).select(cols, { count: "exact" }).eq("workspace_id", workspaceId);
  query = opts.archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  if (opts.q?.trim()) query = query.ilike(nameCol, `%${opts.q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`);
  const { data, count, error } = await query.order(nameCol).range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw badRequest(error.message);
  return { rows: (data ?? []) as Row[], total: count ?? 0, page, pageSize };
}

// ------------------------------------------------------------------ evidence trail
export interface TrailItem {
  at: string;
  kind: "audit" | "interaction" | "signal" | "employment" | "availability" | "lease";
  title: string;
  detail?: string | null;
  factStatus?: string | null;
  evidenceTier?: string | null;
  source?: string | null;
  href?: string | null;
}

/** End-of-day instant for an "as of" date (inclusive), or null. */
export function asOfCutoff(asOf?: string | null): string | null {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return null;
  return new Date(Date.parse(`${asOf}T23:59:59.999+05:30`)).toISOString();
}

function inTrail(at: string | null | undefined, cutoff: string | null) {
  return !!at && (!cutoff || at <= cutoff);
}

async function auditFor(db: Client, workspaceId: string, entityType: string, id: string, cutoff: string | null) {
  let q = db.from("audit_event").select("id, occurred_at, action, actor_kind, actor_user_id, before, after, change_proposal_id")
    .eq("workspace_id", workspaceId).eq("entity_type", entityType).eq("entity_id", id).order("occurred_at", { ascending: false }).limit(100);
  if (cutoff) q = q.lte("occurred_at", cutoff);
  const { data } = await q; // RLS: admins only; others get [] (trail still shows interactions/signals)
  return (data ?? []) as Row[];
}

function changedFields(before: Row | null, after: Row | null): string[] {
  if (!before || !after) return [];
  const skip = new Set(["updated_at", "row_version", "search", "created_at"]);
  return Object.keys(after).filter((k) => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

function auditItems(rows: Row[]): TrailItem[] {
  return rows.map((a) => {
    const fields = changedFields(a.before, a.after);
    return {
      at: a.occurred_at, kind: "audit" as const,
      title: `${a.action}${a.change_proposal_id ? " (approved change)" : ""} by ${a.actor_kind}`,
      detail: fields.length ? `Fields: ${fields.join(", ")}` : null,
    };
  });
}

async function interactionsFor(db: Client, workspaceId: string, entityType: string, id: string, cutoff: string | null) {
  const { data: links } = await db.from("interaction_link").select("interaction_id, role").eq("workspace_id", workspaceId)
    .eq("entity_type", entityType).eq("entity_id", id).limit(200);
  const ids = [...new Set((links ?? []).map((l) => l.interaction_id))];
  if (!ids.length) return [] as Row[];
  let q = db.from("interaction").select("id, occurred_at, channel, direction, subject, summary, promises, is_meaningful, opportunity_id")
    .in("id", ids).is("archived_at", null).order("occurred_at", { ascending: false });
  if (cutoff) q = q.lte("occurred_at", cutoff);
  const { data } = await q;
  return (data ?? []) as Row[];
}

async function signalsFor(db: Client, workspaceId: string, subjectType: string, id: string) {
  const { data } = await db.from("signal_claim").select("*").eq("workspace_id", workspaceId)
    .eq("subject_type", subjectType).eq("subject_id", id).is("archived_at", null).order("created_at", { ascending: false }).limit(100);
  return (data ?? []) as Row[];
}

function signalDate(s: Row): string {
  return s.effective_on ?? s.observed_on ?? s.published_on ?? s.created_at;
}

async function namesById(db: Client, table: "organisation" | "person" | "asset", ids: (string | null | undefined)[]) {
  const uniq = [...new Set(ids.filter(Boolean))] as string[];
  if (!uniq.length) return {} as Record<string, string>;
  const col = table === "organisation" ? "display_name" : table === "person" ? "full_name" : "name";
  const { data } = await db.from(table).select(`id, ${col}`).in("id", uniq);
  return Object.fromEntries(((data ?? []) as Row[]).map((r) => [r.id, r[col]])) as Record<string, string>;
}

/** Latest audit "after" snapshot at or before the cutoff — the record as it was recorded on that date (admins). */
function snapshotAsOf(audit: Row[]): Row | null {
  const hit = audit.find((a) => a.after);
  return hit ? (hit.after as Row) : null;
}

const sortTrail = (items: TrailItem[]) => items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

// ------------------------------------------------------------------ Company
export async function getCompany(db: Client, workspaceId: string, id: string, asOf?: string | null) {
  const cutoff = asOfCutoff(asOf);
  const { data: org } = await db.from("organisation").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (!org) return null;

  const [relFrom, relTo, emp, reqs, opps, leases, assets, signals, tasks, audit, interactions, score, shares] = await Promise.all([
    db.from("organisation_relation").select("*").eq("from_org_id", id).is("archived_at", null),
    db.from("organisation_relation").select("*").eq("to_org_id", id).is("archived_at", null),
    db.from("employment").select("*").eq("org_id", id).is("archived_at", null).order("start_date", { ascending: false, nullsFirst: false }),
    db.from("requirement").select("*").eq("org_id", id).is("archived_at", null).order("updated_at", { ascending: false }),
    db.from("opportunity").select("*").eq("org_id", id).is("archived_at", null).order("updated_at", { ascending: false }),
    db.from("lease").select("*").eq("tenant_org_id", id).is("archived_at", null).order("contractual_expiry", { ascending: true, nullsFirst: false }),
    db.from("asset").select("id, name, asset_kind, owner_org_id, developer_org_id, operator_org_id")
      .or(`owner_org_id.eq.${id},developer_org_id.eq.${id},operator_org_id.eq.${id}`).is("archived_at", null),
    signalsFor(db, workspaceId, "organisation", id),
    db.from("task").select("id, title, due_at, status, assigned_user_id").eq("linked_entity_type", "organisation").eq("linked_entity_id", id)
      .in("status", ["open", "snoozed"]).order("due_at", { ascending: true, nullsFirst: false }).limit(10),
    auditFor(db, workspaceId, "organisation", id, cutoff),
    interactionsFor(db, workspaceId, "organisation", id, cutoff),
    db.from("lead_score").select("*").eq("subject_type", "organisation").eq("subject_id", id).eq("is_current", true).maybeSingle(),
    db.from("record_share").select("user_id, created_at").eq("entity_type", "organisation").eq("entity_id", id),
  ]);

  const relations = [
    ...((relFrom.data ?? []) as Row[]).map((r): Row => ({ ...r, other_id: r.to_org_id, direction: "from" as const })),
    ...((relTo.data ?? []) as Row[]).map((r): Row => ({ ...r, other_id: r.from_org_id, direction: "to" as const })),
  ];
  const employment = (emp.data ?? []) as Row[];
  const reqRows = (reqs.data ?? []) as Row[];
  const reqIds = reqRows.map((r) => r.id);
  const { data: stakeholders } = reqIds.length
    ? await db.from("stakeholder").select("*").in("requirement_id", reqIds).is("archived_at", null)
    : { data: [] as Row[] };
  const leaseRows = (leases.data ?? []) as Row[];
  const [orgNames, personNames, assetNames] = await Promise.all([
    namesById(db, "organisation", relations.map((r) => r.other_id)),
    namesById(db, "person", [...employment.map((e) => e.person_id), ...((stakeholders ?? []) as Row[]).map((s) => s.person_id)]),
    namesById(db, "asset", leaseRows.map((l) => l.asset_id)),
  ]);

  const atAsOf = (e: Row) => !asOf || ((!e.start_date || e.start_date <= asOf) && (!e.end_date || e.end_date >= asOf));
  const people = employment.map((e): Row => ({ ...e, person_name: personNames[e.person_id] ?? null, current_at_as_of: asOf ? atAsOf(e) : e.is_current }));
  const signalRows = signals.filter((s) => !cutoff || signalDate(s) <= cutoff);
  const openOpps = ((opps.data ?? []) as Row[]).filter((o) => !o.outcome || ["open", "dormant"].includes(o.outcome));
  const nextAction = openOpps.filter((o) => o.next_action).sort((a, b) => String(a.next_action_due ?? "9999").localeCompare(String(b.next_action_due ?? "9999")))[0]
    ?? null;

  const trail = sortTrail([
    ...auditItems(audit),
    ...interactions.map((i) => ({ at: i.occurred_at, kind: "interaction" as const, title: `${i.channel}${i.direction ? ` · ${i.direction}` : ""}: ${i.subject ?? "(no subject)"}`, detail: i.summary })),
    ...signalRows.map((s) => ({ at: signalDate(s), kind: "signal" as const, title: `${s.claim_type}${s.predicate ? ` — ${s.predicate}` : ""}`, detail: s.evidence_excerpt, factStatus: s.status, evidenceTier: s.evidence_tier, source: s.source_url ?? s.source_locator })),
    ...employment.filter((e) => inTrail(e.start_date, cutoff)).map((e) => ({ at: e.start_date, kind: "employment" as const, title: `${personNames[e.person_id] ?? "Person"} joined${e.title ? ` as ${e.title}` : ""}`, factStatus: e.fact_status, href: `/people/${e.person_id}` })),
    ...employment.filter((e) => inTrail(e.end_date, cutoff)).map((e) => ({ at: e.end_date, kind: "employment" as const, title: `${personNames[e.person_id] ?? "Person"} left${e.title ? ` (${e.title})` : ""}`, factStatus: e.fact_status, href: `/people/${e.person_id}` })),
  ]);

  return {
    org: org as Row,
    snapshot: cutoff ? snapshotAsOf(audit) : null,
    relations: relations.map((r): Row => ({ ...r, other_name: orgNames[r.other_id] ?? null })),
    people,
    stakeholders: ((stakeholders ?? []) as Row[]).map((s): Row => ({ ...s, person_name: personNames[s.person_id] ?? null, requirement_title: reqRows.find((r) => r.id === s.requirement_id)?.title ?? null })),
    requirements: reqRows.filter((r) => r.status !== "closed"),
    opportunities: openOpps,
    leases: leaseRows.map((l): Row => ({ ...l, asset_name: l.asset_id ? assetNames[l.asset_id] ?? null : null })),
    assets: (assets.data ?? []) as Row[],
    signals: signalRows,
    tasks: (tasks.data ?? []) as Row[],
    nextAction,
    leadScore: (score.data ?? null) as Row | null,
    shares: (shares.data ?? []) as Row[],
    trail,
  };
}

// ------------------------------------------------------------------ Person
export async function getPerson(db: Client, workspaceId: string, id: string, asOf?: string | null) {
  const cutoff = asOfCutoff(asOf);
  const { data: person } = await db.from("person").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (!person) return null;
  const [emp, contacts, consents, edgesIn, edgesOut, signals, audit, interactions, stake, shares] = await Promise.all([
    db.from("employment").select("*").eq("person_id", id).is("archived_at", null).order("start_date", { ascending: false, nullsFirst: false }),
    db.from("contact_method").select("id, method_type, value, verified_on, preferred, suppressed, classification").eq("person_id", id).is("archived_at", null),
    db.from("consent_permission").select("*").eq("person_id", id).is("archived_at", null),
    db.from("relationship_edge").select("*").eq("to_person_id", id).is("archived_at", null),
    db.from("relationship_edge").select("*").eq("from_person_id", id).is("archived_at", null),
    signalsFor(db, workspaceId, "person", id),
    auditFor(db, workspaceId, "person", id, cutoff),
    interactionsFor(db, workspaceId, "person", id, cutoff),
    db.from("stakeholder").select("*").eq("person_id", id).is("archived_at", null),
    db.from("record_share").select("user_id, created_at").eq("entity_type", "person").eq("entity_id", id),
  ]);
  const employment = (emp.data ?? []) as Row[];
  const inEdges = (edgesIn.data ?? []) as Row[];
  const outEdges = (edgesOut.data ?? []) as Row[];
  // Intro paths: (user) -> intermediary person -> this person. Only edges the caller can see (RLS).
  const intermediaries = [...new Set(inEdges.filter((e) => e.from_person_id).map((e) => e.from_person_id as string))];
  const { data: userEdges } = intermediaries.length
    ? await db.from("relationship_edge").select("*").in("to_person_id", intermediaries).not("from_user_id", "is", null).is("archived_at", null)
    : { data: [] as Row[] };
  const stakeRows = (stake.data ?? []) as Row[];
  const reqIds = stakeRows.map((s) => s.requirement_id);
  const { data: reqs } = reqIds.length ? await db.from("requirement").select("id, title, org_id, status").in("id", reqIds) : { data: [] as Row[] };
  const [orgNames, personNames, members] = await Promise.all([
    namesById(db, "organisation", [...employment.map((e) => e.org_id), ...((reqs ?? []) as Row[]).map((r) => r.org_id)]),
    namesById(db, "person", [...inEdges.map((e) => e.from_person_id), ...outEdges.map((e) => e.to_person_id)]),
    memberDirectory(db, workspaceId),
  ]);
  const memberName = (uid: string | null) => members.find((m) => m.user_id === uid)?.display_name ?? (uid ? "Team member" : null);

  const contactsRows = (contacts.data ?? []) as Row[];
  const consentRows = (consents.data ?? []) as Row[];
  const suppressedAll = consentRows.some((c) => c.suppressed || c.revoked_at);

  const introPaths = inEdges.filter((e) => e.from_user_id || e.from_person_id).flatMap((e) => {
    if (e.from_user_id) return [{ via: null as string | null, viaId: null as string | null, from: memberName(e.from_user_id), edge: e, firstHop: null as Row | null }];
    return ((userEdges ?? []) as Row[]).filter((u) => u.to_person_id === e.from_person_id)
      .map((u) => ({ via: personNames[e.from_person_id] ?? "Contact", viaId: e.from_person_id as string, from: memberName(u.from_user_id), edge: e, firstHop: u }));
  });

  const signalRows = signals.filter((s) => !cutoff || signalDate(s) <= cutoff);
  const trail = sortTrail([
    ...auditItems(audit),
    ...interactions.map((i) => ({ at: i.occurred_at, kind: "interaction" as const, title: `${i.channel}${i.direction ? ` · ${i.direction}` : ""}: ${i.subject ?? "(no subject)"}`, detail: i.summary })),
    ...signalRows.map((s) => ({ at: signalDate(s), kind: "signal" as const, title: `${s.claim_type}${s.predicate ? ` — ${s.predicate}` : ""}`, detail: s.evidence_excerpt, factStatus: s.status, evidenceTier: s.evidence_tier, source: s.source_url ?? s.source_locator })),
    ...employment.filter((e) => inTrail(e.start_date, cutoff)).map((e) => ({ at: e.start_date, kind: "employment" as const, title: `Started at ${orgNames[e.org_id] ?? "organisation"}${e.title ? ` as ${e.title}` : ""}`, factStatus: e.fact_status, href: `/companies/${e.org_id}` })),
    ...employment.filter((e) => inTrail(e.end_date, cutoff)).map((e) => ({ at: e.end_date, kind: "employment" as const, title: `Left ${orgNames[e.org_id] ?? "organisation"}`, factStatus: e.fact_status, href: `/companies/${e.org_id}` })),
  ]);

  return {
    person: person as Row,
    snapshot: cutoff ? snapshotAsOf(audit) : null,
    employment: employment.map((e): Row => ({
      ...e, org_name: orgNames[e.org_id] ?? null,
      current_at_as_of: asOf ? (!e.start_date || e.start_date <= asOf) && (!e.end_date || e.end_date >= asOf) : e.is_current,
    })),
    contacts: contactsRows.map((c): Row => ({ ...c, effectively_suppressed: c.suppressed || suppressedAll })),
    consents: consentRows,
    relationships: [
      ...inEdges.map((e): Row => ({ ...e, counterpart: e.from_user_id ? memberName(e.from_user_id) : personNames[e.from_person_id] ?? null, counterpart_person_id: e.from_person_id, direction: "in" })),
      ...outEdges.map((e): Row => ({ ...e, counterpart: personNames[e.to_person_id] ?? null, counterpart_person_id: e.to_person_id, direction: "out" })),
    ],
    introPaths,
    stakeholderRoles: stakeRows.map((s): Row => {
      const r = ((reqs ?? []) as Row[]).find((x) => x.id === s.requirement_id);
      return { ...s, requirement_title: r?.title ?? null, org_name: r ? orgNames[r.org_id] ?? null : null };
    }),
    signals: signalRows,
    interactions,
    shares: (shares.data ?? []) as Row[],
    trail,
  };
}

// ------------------------------------------------------------------ Building
export type VacancyState = "available" | "under_offer" | "leased" | "withdrawn" | "unverified" | "expired" | "no_evidence";

/** Never invent vacancy: no snapshot => no_evidence; expired validity => expired (treat as unverified). */
export function vacancyState(latest: Row | null | undefined, today = new Date().toISOString().slice(0, 10)): VacancyState {
  if (!latest) return "no_evidence";
  if (latest.valid_until && latest.valid_until < today) return "expired";
  return latest.status as VacancyState;
}

export async function getBuilding(db: Client, workspaceId: string, id: string, asOf?: string | null) {
  const cutoff = asOfCutoff(asOf);
  const { data: asset } = await db.from("asset").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (!asset) return null;
  const [parent, children, spaces, leases, txns, signals, audit, shares] = await Promise.all([
    asset.parent_asset_id ? db.from("asset").select("id, name, asset_kind, parent_asset_id").eq("id", asset.parent_asset_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from("asset").select("id, name, asset_kind, status, total_area_sf").eq("parent_asset_id", id).is("archived_at", null).order("name"),
    db.from("space").select("*").eq("asset_id", id).is("archived_at", null).order("floor_text"),
    db.from("lease").select("*").eq("asset_id", id).is("archived_at", null).order("contractual_expiry", { ascending: true, nullsFirst: false }),
    db.from("market_transaction").select("*").eq("asset_id", id).is("archived_at", null).order("period_start", { ascending: false, nullsFirst: false }).limit(50),
    signalsFor(db, workspaceId, "asset", id),
    auditFor(db, workspaceId, "asset", id, cutoff),
    db.from("record_share").select("user_id, created_at").eq("entity_type", "asset").eq("entity_id", id),
  ]);
  const spaceRows = (spaces.data ?? []) as Row[];
  const spaceIds = spaceRows.map((s) => s.id);
  const { data: avail } = spaceIds.length
    ? await db.from("availability").select("*").in("space_id", spaceIds).is("archived_at", null).order("as_of", { ascending: false })
    : { data: [] as Row[] };
  const snapshots = ((avail ?? []) as Row[]).filter((a) => !asOf || a.as_of <= asOf);
  const leaseRows = (leases.data ?? []) as Row[];
  const orgNames = await namesById(db, "organisation", [asset.owner_org_id, asset.developer_org_id, asset.operator_org_id,
    ...leaseRows.map((l) => l.tenant_org_id), ...((txns.data ?? []) as Row[]).map((t) => t.tenant_org_id)]);
  const today = asOf ?? new Date().toISOString().slice(0, 10);

  const spacesOut = spaceRows.map((s): Row & { history: Row[]; latest: Row | null; lastVerified: string | null; state: VacancyState } => {
    const history = snapshots.filter((a) => a.space_id === s.id);
    const latest = history[0] ?? null;
    const lastVerified = history.find((a) => a.fact_status === "currently_confirmed")?.as_of ?? null;
    return { ...s, history, latest, lastVerified, state: vacancyState(latest, today) };
  });
  const lastVerification = spacesOut.map((s) => s.lastVerified).filter(Boolean).sort().reverse()[0] ?? null;

  const trail = sortTrail([
    ...auditItems(audit),
    ...snapshots.map((a) => ({ at: a.as_of, kind: "availability" as const, title: `${spaceRows.find((s) => s.id === a.space_id)?.floor_text ?? "Space"}: ${a.status}`, detail: a.asking_rent_min ? `Asking ${a.asking_rent_min}${a.asking_rent_max && a.asking_rent_max !== a.asking_rent_min ? `–${a.asking_rent_max}` : ""} / sf (${a.rent_basis ?? "basis unknown"})` : null, factStatus: a.fact_status })),
    ...leaseRows.filter((l) => inTrail(l.start_date ?? l.registration_date, cutoff)).map((l) => ({ at: (l.start_date ?? l.registration_date) as string, kind: "lease" as const, title: `Lease: ${orgNames[l.tenant_org_id] ?? l.tenant_name_raw ?? "tenant"}`, factStatus: l.fact_status })),
    ...signals.filter((s) => !cutoff || signalDate(s) <= cutoff).map((s) => ({ at: signalDate(s), kind: "signal" as const, title: s.claim_type, detail: s.evidence_excerpt, factStatus: s.status, evidenceTier: s.evidence_tier, source: s.source_url ?? s.source_locator })),
  ]);

  return {
    asset: asset as Row,
    snapshot: cutoff ? snapshotAsOf(audit) : null,
    parent: (parent.data ?? null) as Row | null,
    children: (children.data ?? []) as Row[],
    spaces: spacesOut,
    lastVerification,
    leases: leaseRows.map((l): Row => ({ ...l, tenant_name: orgNames[l.tenant_org_id] ?? l.tenant_name_raw ?? null })),
    transactions: ((txns.data ?? []) as Row[]).map((t): Row => ({ ...t, tenant_name: orgNames[t.tenant_org_id] ?? t.tenant_name_raw ?? null })),
    orgNames,
    signals,
    shares: (shares.data ?? []) as Row[],
    trail,
  };
}

/** Campus/project parents for the building form ([id, label]). */
export async function parentAssetOptions(db: Client, workspaceId: string): Promise<[string, string][]> {
  const { data } = await db.from("asset").select("id, name, asset_kind").eq("workspace_id", workspaceId)
    .in("asset_kind", ["campus", "project"]).is("archived_at", null).order("name").limit(500);
  return ((data ?? []) as Row[]).map((r) => [r.id as string, `${r.name} (${r.asset_kind})`]);
}
