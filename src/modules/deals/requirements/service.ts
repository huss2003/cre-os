/**
 * Requirement analyst service (spec Part I §8 "Requirement"). User-scoped (RLS) only.
 * - Estimated fields are edited directly; client-confirmed fields (or any field of a confirmed requirement) change
 *   only through proposeChange() → approval → mudar_app.apply_change (enforced again in SQL by requirement_deals_guard).
 * - Every save appends an immutable requirement_version snapshot.
 */
import { proposeChange } from "@/lib/services/changes";
import { escapeLike } from "@/lib/util/like";
import { type DealsCtx, DealsError, dbError, must, owned } from "../ctx";
import { syncQuestionTasks } from "./tasks";
import {
  FIELD_BY_KEY, REQUIREMENT_FIELDS, applyDerivedSpecs, confirmationBlockers, hardConstraints, fieldStatus, missingQuestions, partitionEdit, requirementCompleteness,
  stakeholderGaps, toColumnPatch, type FieldStatus, type RequirementConstraints, type RequirementRow, STAKEHOLDER_ROLES,
} from "./contract";

export interface FieldChange { key: string; value?: unknown; status?: FieldStatus }

const SNAPSHOT_COLS = ["title", "org_id", "objective", "transaction_kinds", "area_min_sf", "area_target_sf", "area_max_sf", "area_basis",
  "seats_min", "seats_target", "seats_max", "budget_min", "budget_max", "budget_basis", "preferred_geography_ids", "excluded_geography_ids",
  "decision_date", "occupation_date", "constraints", "status", "confirmed_by_person_id", "confirmed_at", "mandate_status", "conflict_status"];

function coerce(key: string, value: unknown): unknown {
  const def = FIELD_BY_KEY.get(key);
  if (!def) throw new DealsError(400, `unknown requirement field: ${key}`);
  const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  const asNum = (v: unknown) => {
    if (blank(v)) return null;
    const n = Number(String(v).replace(/,/g, ""));
    if (!Number.isFinite(n)) throw new DealsError(400, `${def.label}: not a number`);
    return n;
  };
  switch (def.kind) {
    case "range": {
      const arr = Array.isArray(value) ? value : [];
      return arr.map(asNum);
    }
    case "number": return asNum(value);
    case "date": {
      if (blank(value)) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new DealsError(400, `${def.label}: use YYYY-MM-DD`);
      return String(value);
    }
    case "enum": {
      if (blank(value)) return null;
      if (def.options && !def.options.includes(String(value))) throw new DealsError(400, `${def.label}: must be one of ${def.options.join(", ")}`);
      return String(value);
    }
    case "list": case "geo_list": {
      if (blank(value)) return [];
      return Array.isArray(value) ? value.map(String).filter(Boolean) : String(value).split(",").map((s) => s.trim()).filter(Boolean);
    }
    case "boolean": return blank(value) ? null : value === true || value === "true";
    default: return blank(value) ? null : String(value);
  }
}

/**
 * Build the column patch + new constraints object for a set of field changes (pure). Free-text technical answers
 * (power, parking, transit, working hours, certifications, fit-out) are re-parsed into constraints.required_specs.
 */
export function buildPatch(req: RequirementRow, changes: FieldChange[]): { columns: Record<string, unknown>; constraints: RequirementConstraints; specNotes: string[] } {
  const constraints: RequirementConstraints = JSON.parse(JSON.stringify(req.constraints ?? {}));
  constraints.values = constraints.values ?? {};
  constraints.field_status = constraints.field_status ?? {};
  const columns: Record<string, unknown> = {};
  for (const ch of changes) {
    if ("value" in ch) {
      const v = coerce(ch.key, ch.value);
      const p = toColumnPatch(ch.key, v);
      Object.assign(columns, p.columns);
      if (!FIELD_BY_KEY.get(ch.key)!.columns) {
        if (v === null || (Array.isArray(v) && v.length === 0)) delete constraints.values[ch.key];
        else constraints.values[ch.key] = v;
      }
      // a new value without an explicit status is an estimate (never silently "confirmed")
      if (!ch.status) constraints.field_status[ch.key] = v === null || (Array.isArray(v) && (v.length === 0 || v.every((x) => x === null))) ? "unknown" : "estimated";
    }
    if (ch.status) constraints.field_status[ch.key] = ch.status;
  }
  const specNotes = applyDerivedSpecs(constraints, changes.filter((c) => "value" in c).map((c) => c.key));
  return { columns, constraints, specNotes };
}

async function snapshot(ctx: DealsCtx, req: Record<string, unknown>, reason: string | null, changeProposalId: string | null = null) {
  const { data: last } = await ctx.db.from("requirement_version").select("version").eq("requirement_id", req.id as string)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  const snap: Record<string, unknown> = {};
  for (const c of SNAPSHOT_COLS) snap[c] = req[c] ?? null;
  const r = await ctx.db.from("requirement_version").insert({
    ...owned(ctx, String(req.classification ?? "corporate_confidential")),
    requirement_id: req.id, version: ((last as { version: number } | null)?.version ?? 0) + 1,
    snapshot: snap, field_status: (req.constraints as RequirementConstraints | null)?.field_status ?? {},
    change_reason: reason, change_proposal_id: changeProposalId,
  });
  if (r.error && r.error.code !== "23505") throw dbError(r.error, "requirement_version");
}

export interface CreateRequirementInput {
  orgId?: string | null;
  orgName?: string | null;
  title: string;
  changes?: FieldChange[];
  classification?: string;
}

/** DB-214/215: ranges and date windows must be in order. Blank stays allowed (unknown). */
export function assertRequirementRanges(r: Record<string, unknown>) {
  const n = (k: string) => (r[k] === null || r[k] === undefined || r[k] === "" ? null : Number(r[k]));
  const pairs: [string, string, string][] = [["area_min_sf", "area_max_sf", "Minimum area cannot be more than maximum area."],
    ["seats_min", "seats_max", "Minimum seats cannot be more than maximum seats."], ["budget_min", "budget_max", "Minimum budget cannot be more than maximum budget."]];
  for (const [a, b, msg] of pairs) { const x = n(a), y = n(b); if (x !== null && y !== null && x > y) throw new DealsError(400, msg); }
  for (const k of ["area_min_sf", "area_target_sf", "area_max_sf", "seats_min", "seats_target", "seats_max", "budget_min", "budget_max"]) {
    const v = n(k); if (v !== null && v < 0) throw new DealsError(400, "Area, seats and budget cannot be negative. Leave blank if unknown.");
  }
  if (r.decision_date && r.occupation_date && String(r.occupation_date) < String(r.decision_date)) throw new DealsError(400, "Move-in (occupation) date cannot be before the decision date.");
}

export async function createRequirement(ctx: DealsCtx, input: CreateRequirementInput) {
  if (!input.title?.trim()) throw new DealsError(400, "title is required");
  // Validate everything before any write, so a bad value never leaves an orphan company behind.
  const { columns, constraints } = buildPatch({ constraints: {} }, input.changes ?? []);
  assertRequirementRanges(columns);
  let orgId = input.orgId ?? null;
  if (!orgId) {
    const name = input.orgName?.trim();
    if (!name) throw new DealsError(400, "choose a company or enter a new company name");
    // Exact, case-insensitive match (wildcards escaped). Two matches => ask the user to pick.
    const existing = await ctx.db.from("organisation").select("id").eq("workspace_id", ctx.workspaceId).is("archived_at", null).ilike("display_name", escapeLike(name)).limit(2);
    if (existing.error) throw dbError(existing.error, "organisation");
    const hits = (existing.data ?? []) as { id: string }[];
    if (hits.length > 1) throw new DealsError(409, `More than one company is called "${name}". Choose the right one from the company list instead.`);
    if (hits.length === 1) orgId = hits[0].id;
    else orgId = (must(await ctx.db.from("organisation").insert({ ...owned(ctx, input.classification), display_name: name }).select("id").single(), "organisation") as { id: string }).id;
  }
  const anyValue = Object.values(columns).some((v) => v !== null && !(Array.isArray(v) && v.length === 0)) || Object.keys(constraints.values ?? {}).length > 0;
  const row = must(await ctx.db.from("requirement").insert({
    ...owned(ctx, input.classification), org_id: orgId, title: input.title.trim(), ...columns, constraints,
    status: anyValue ? "estimated" : "draft",
    mandate_status: (columns.mandate_status as string | undefined) ?? "unknown",
    conflict_status: (columns.conflict_status as string | undefined) ?? "not_checked",
  }).select("*").single(), "requirement") as Record<string, unknown>;
  await snapshot(ctx, row, "created");
  await syncQuestionTasks(ctx, row as unknown as RequirementRow & { id: string });
  return row;
}

export interface UpdateResult { requirement: Record<string, unknown>; applied: string[]; proposals: { id: string; fields: string[]; risk: string }[]; specNotes: string[] }

/**
 * Apply field changes. Estimated/unknown fields are written directly (optimistic concurrency on row_version);
 * confirmed fields become one change proposal (approval required). Never both silently.
 */
export async function updateRequirementFields(ctx: DealsCtx, id: string, expectedVersion: number, changes: FieldChange[], reason: string, idempotencyKey?: string | null): Promise<UpdateResult> {
  if (!changes.length) throw new DealsError(400, "no changes");
  for (const c of changes) if (!FIELD_BY_KEY.has(c.key)) throw new DealsError(400, `unknown requirement field: ${c.key}`);
  const req = must(await ctx.db.from("requirement").select("*").eq("id", id).maybeSingle(), "requirement") as RequirementRow & Record<string, unknown>;
  if (Number(req.row_version) !== Number(expectedVersion)) throw new DealsError(409, "stale_version: the requirement changed, reload and retry");
  const { direct, viaProposal } = partitionEdit(req, changes.map((c) => c.key));
  const directChanges = changes.filter((c) => direct.includes(c.key));
  const propChanges = changes.filter((c) => viaProposal.includes(c.key));
  let current: Record<string, unknown> = req;
  const applied: string[] = [];
  const specNotes: string[] = [];
  if (directChanges.length) {
    const { columns, constraints, specNotes: notes } = buildPatch(req, directChanges);
    assertRequirementRanges({ ...req, ...columns });
    specNotes.push(...notes);
    // a confirmed field's status may never be changed through the direct path
    // controlled write path (SQL re-checks role, row access, version and confirmed-field locks)
    const upd = await ctx.db.rpc("deals_update_requirement", {
      p_id: id, p_expected_version: expectedVersion, p_patch: { ...columns, constraints, ...(req.status === "draft" ? { status: "estimated" } : {}) },
    });
    if (upd.error) throw dbError(upd.error, "requirement");
    current = upd.data as Record<string, unknown>;
    applied.push(...directChanges.map((c) => c.key));
    await snapshot(ctx, current, reason || "edited");
    await syncQuestionTasks(ctx, current as unknown as RequirementRow & { id: string });
  }
  const proposals: UpdateResult["proposals"] = [];
  if (propChanges.length) {
    // Patch built against the CURRENT row so the confirmed values in constraints are replaced only for these keys.
    const { columns, constraints } = buildPatch(current as RequirementRow, propChanges.map((c) => ({ ...c, status: c.status ?? "client_confirmed" })));
    const patch = [
      ...Object.entries(columns).map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v })),
      { op: "replace" as const, path: "/constraints", value: constraints },
    ];
    const before: Record<string, unknown> = {};
    for (const p of patch) before[p.path.slice(1)] = (current as Record<string, unknown>)[p.path.slice(1)] ?? null;
    const cp = await proposeChange(ctx.db, ctx.workspaceId, {
      targetType: "requirement", targetId: id, operation: "update", expectedVersion: Number(current.row_version),
      patch, reason: reason || `Change to confirmed field(s): ${propChanges.map((c) => c.key).join(", ")}`,
      proposedByKind: "user", ownerUserId: ctx.userId, classification: String(current.classification ?? "corporate_confidential"),
      idempotencyKey: idempotencyKey ? `deals.req:${id}:${idempotencyKey}` : undefined, before,
    });
    proposals.push({ id: (cp as { id: string }).id, fields: propChanges.map((c) => c.key), risk: (cp as { risk: string }).risk });
  }
  return { requirement: current, applied, proposals, specNotes };
}

/** Mark the requirement client-confirmed. Every mandatory field must be known AND individually confirmed. */
export async function confirmRequirement(ctx: DealsCtx, id: string, expectedVersion: number, opts: { confirmedByPersonId?: string | null; evidence: string }) {
  if (!opts.evidence?.trim()) throw new DealsError(400, "evidence of client confirmation is required (meeting note, email reference)");
  const req = must(await ctx.db.from("requirement").select("*").eq("id", id).maybeSingle(), "requirement") as RequirementRow & Record<string, unknown>;
  if (req.status === "client_confirmed") return req;
  const blockers = confirmationBlockers(req);
  if (blockers.length) throw new DealsError(422, "requirement cannot be confirmed yet", { blockers });
  const upd = await ctx.db.rpc("deals_confirm_requirement", { p_id: id, p_expected_version: expectedVersion, p_evidence: opts.evidence.trim(), p_person: opts.confirmedByPersonId ?? null });
  if (upd.error) throw dbError(upd.error, "requirement");
  await snapshot(ctx, upd.data as Record<string, unknown>, `client confirmed: ${opts.evidence.trim()}`);
  await syncQuestionTasks(ctx, upd.data as RequirementRow & { id: string });
  return upd.data as Record<string, unknown>;
}

/** Mark contract fields "not applicable" (question suppressed without inventing a value) or clear that mark. */
export async function setNotApplicable(ctx: DealsCtx, id: string, expectedVersion: number, keys: string[], applicable = false) {
  for (const k of keys) if (!FIELD_BY_KEY.has(k)) throw new DealsError(400, `unknown requirement field: ${k}`);
  const req = must(await ctx.db.from("requirement").select("constraints").eq("id", id).maybeSingle(), "requirement") as { constraints: RequirementConstraints | null };
  const cur = new Set(req.constraints?.not_applicable ?? []);
  for (const k of keys) { if (applicable) cur.delete(k); else cur.add(k); }
  const upd = await ctx.db.rpc("deals_update_requirement", { p_id: id, p_expected_version: expectedVersion, p_patch: { constraints: { ...(req.constraints ?? {}), not_applicable: [...cur].sort() } } });
  if (upd.error) throw dbError(upd.error, "requirement");
  await snapshot(ctx, upd.data as Record<string, unknown>, `not applicable: ${keys.join(", ")}`);
  await syncQuestionTasks(ctx, upd.data as RequirementRow & { id: string });
  return upd.data as Record<string, unknown>;
}

export async function addStakeholder(ctx: DealsCtx, requirementId: string, input: { personId?: string | null; personName?: string | null; role: string; influenceBasis?: string | null; accessStatus?: string | null }) {
  if (!(STAKEHOLDER_ROLES as readonly string[]).includes(input.role)) throw new DealsError(400, `role must be one of ${STAKEHOLDER_ROLES.join(", ")}`);
  const req = must(await ctx.db.from("requirement").select("id, classification").eq("id", requirementId).maybeSingle(), "requirement") as { id: string; classification: string };
  let personId = input.personId ?? null;
  if (!personId) {
    const name = input.personName?.trim();
    if (!name) throw new DealsError(400, "choose a person or enter a name");
    personId = (must(await ctx.db.from("person").insert({ ...owned(ctx, req.classification), full_name: name }).select("id").single(), "person") as { id: string }).id;
  }
  const dup = await ctx.db.from("stakeholder").select("id").eq("requirement_id", requirementId).eq("person_id", personId).eq("role", input.role).is("archived_at", null).limit(1);
  if (dup.data?.length) throw new DealsError(409, "This person already has that role on this requirement.");
  return must(await ctx.db.from("stakeholder").insert({
    ...owned(ctx, req.classification), requirement_id: requirementId, person_id: personId, role: input.role,
    influence_basis: input.influenceBasis ?? null, access_status: input.accessStatus ?? null,
  }).select("*").single(), "stakeholder");
}

export async function listRequirements(ctx: DealsCtx, opts: { status?: string; limit?: number } = {}) {
  let q = ctx.db.from("requirement").select("id, title, status, org_id, area_target_sf, area_basis, occupation_date, decision_date, updated_at, row_version, constraints, objective, area_min_sf, area_max_sf, budget_min, budget_max, budget_basis, preferred_geography_ids, mandate_status, conflict_status, organisation:org_id(display_name)")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(opts.limit ?? 200);
  if (opts.status) q = q.eq("status", opts.status);
  const r = await q;
  if (r.error) throw dbError(r.error, "requirements");
  return (r.data ?? []).map((x) => ({ ...x, completeness: requirementCompleteness(x as RequirementRow) }));
}

export async function getRequirementDetail(ctx: DealsCtx, id: string) {
  const req = must(await ctx.db.from("requirement").select("*, organisation:org_id(id, display_name)").eq("id", id).maybeSingle(), "requirement") as RequirementRow & Record<string, unknown>;
  const [stake, versions, sv, quotes, opps, props, tasks] = await Promise.all([
    ctx.db.from("stakeholder").select("id, role, influence_basis, access_status, person:person_id(id, full_name)").eq("requirement_id", id),
    ctx.db.from("requirement_version").select("version, change_reason, created_at, change_proposal_id").eq("requirement_id", id).order("version", { ascending: false }).limit(20),
    ctx.db.from("shortlist_version").select("*").eq("requirement_id", id).order("version", { ascending: false }).limit(1).maybeSingle(),
    ctx.db.from("quote").select("*").eq("requirement_id", id).order("created_at", { ascending: false }),
    ctx.db.from("opportunity").select("id, name, stage, outcome").eq("requirement_id", id),
    ctx.db.from("change_proposal").select("id, state, risk, reason, created_at").eq("target_type", "requirement").eq("target_id", id).in("state", ["proposed", "approved", "clarify"]),
    ctx.db.from("task").select("id, title, status, source, idempotency_key, completed_at, completion_evidence, row_version").eq("workspace_id", ctx.workspaceId)
      .eq("linked_entity_type", "requirement").eq("linked_entity_id", id).is("archived_at", null).order("created_at", { ascending: true }).limit(300),
  ]);
  const geoIds = [...new Set([...(req.preferred_geography_ids ?? []), ...(req.excluded_geography_ids ?? [])])];
  const geos = geoIds.length ? ((await ctx.db.from("geography").select("id, name, level").in("id", geoIds)).data ?? []) as { id: string; name: string; level: string }[] : [];
  const geoName = (gid: string) => geos.find((g) => g.id === gid)?.name ?? `unknown geography ${gid.slice(0, 8)}`;
  const latest = sv.data as { version: number } | null;
  const options = latest
    ? (await ctx.db.from("shortlist_option").select("*").eq("requirement_id", id).eq("version", latest.version).order("fit_score", { ascending: false })).data ?? []
    : [];
  const roles = ((stake.data ?? []) as { role: string }[]).map((s) => s.role);
  return {
    requirement: req,
    fields: REQUIREMENT_FIELDS.map((f) => ({ ...f, status: fieldStatus(req, f.key) })),
    missing: missingQuestions(req),
    completeness: requirementCompleteness(req),
    blockers: confirmationBlockers(req),
    stakeholders: stake.data ?? [],
    stakeholderGaps: stakeholderGaps(roles),
    versions: versions.data ?? [],
    shortlist: latest ? { version: latest, options } : null,
    quotes: quotes.data ?? [],
    opportunities: opps.data ?? [],
    pendingProposals: props.data ?? [],
    hardConstraints: hardConstraints(req, geoName),
    geographies: geos,
    tasks: (tasks.data ?? []) as { id: string; title: string; status: string; source: string | null; idempotency_key: string | null; completed_at: string | null; completion_evidence: string | null; row_version: number }[],
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve location names (or ids) to geography ids in this workspace — exact, case-insensitive match on the name or
 * an alias. Unknown names are an error listing them (never silently dropped or fuzzily guessed).
 */
export async function resolveGeographies(ctx: DealsCtx, input: string[] | string): Promise<string[]> {
  const items = (Array.isArray(input) ? input : String(input).split(",")).map((x) => String(x).trim()).filter(Boolean);
  if (!items.length) return [];
  const r = await ctx.db.from("geography").select("id, name, aliases").eq("workspace_id", ctx.workspaceId).is("archived_at", null).limit(5000);
  if (r.error) throw dbError(r.error, "geography");
  const geos = (r.data ?? []) as { id: string; name: string; aliases: string[] | null }[];
  const out: string[] = [];
  const unknown: string[] = [];
  for (const it of items) {
    const low = it.toLowerCase();
    const g = UUID_RE.test(it) ? geos.find((x) => x.id === it) : geos.find((x) => x.name.toLowerCase() === low || (x.aliases ?? []).some((a) => a.toLowerCase() === low));
    if (g) { if (!out.includes(g.id)) out.push(g.id); } else unknown.push(it);
  }
  if (unknown.length) throw new DealsError(400, `unknown location(s): ${unknown.join(", ")} — add them under geographies first or use an existing name`);
  return out;
}
