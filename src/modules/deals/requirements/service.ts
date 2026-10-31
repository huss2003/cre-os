/**
 * Requirement analyst service (spec Part I §8 "Requirement"). User-scoped (RLS) only.
 * - Estimated fields are edited directly; client-confirmed fields (or any field of a confirmed requirement) change
 *   only through proposeChange() → approval → mudar_app.apply_change (enforced again in SQL by requirement_deals_guard).
 * - Every save appends an immutable requirement_version snapshot.
 */
import { proposeChange } from "@/lib/services/changes";
import { type DealsCtx, DealsError, dbError, must, owned } from "../ctx";
import {
  FIELD_BY_KEY, REQUIREMENT_FIELDS, confirmationBlockers, fieldStatus, missingQuestions, partitionEdit, requirementCompleteness,
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

/** Build the column patch + new constraints object for a set of field changes (pure). */
export function buildPatch(req: RequirementRow, changes: FieldChange[]): { columns: Record<string, unknown>; constraints: RequirementConstraints } {
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
  return { columns, constraints };
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

export async function createRequirement(ctx: DealsCtx, input: CreateRequirementInput) {
  if (!input.title?.trim()) throw new DealsError(400, "title is required");
  let orgId = input.orgId ?? null;
  if (!orgId) {
    const name = input.orgName?.trim();
    if (!name) throw new DealsError(400, "choose a company or enter a new company name");
    const existing = await ctx.db.from("organisation").select("id").eq("workspace_id", ctx.workspaceId).ilike("display_name", name).limit(1).maybeSingle();
    if (existing.data) orgId = (existing.data as { id: string }).id;
    else orgId = (must(await ctx.db.from("organisation").insert({ ...owned(ctx, input.classification), display_name: name }).select("id").single(), "organisation") as { id: string }).id;
  }
  const { columns, constraints } = buildPatch({ constraints: {} }, input.changes ?? []);
  const anyValue = Object.values(columns).some((v) => v !== null && !(Array.isArray(v) && v.length === 0)) || Object.keys(constraints.values ?? {}).length > 0;
  const row = must(await ctx.db.from("requirement").insert({
    ...owned(ctx, input.classification), org_id: orgId, title: input.title.trim(), ...columns, constraints,
    status: anyValue ? "estimated" : "draft",
    mandate_status: (columns.mandate_status as string | undefined) ?? "unknown",
    conflict_status: (columns.conflict_status as string | undefined) ?? "not_checked",
  }).select("*").single(), "requirement") as Record<string, unknown>;
  await snapshot(ctx, row, "created");
  return row;
}

export interface UpdateResult { requirement: Record<string, unknown>; applied: string[]; proposals: { id: string; fields: string[]; risk: string }[] }

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
  if (directChanges.length) {
    const { columns, constraints } = buildPatch(req, directChanges);
    // a confirmed field's status may never be changed through the direct path
    // controlled write path (SQL re-checks role, row access, version and confirmed-field locks)
    const upd = await ctx.db.rpc("deals_update_requirement", {
      p_id: id, p_expected_version: expectedVersion, p_patch: { ...columns, constraints, ...(req.status === "draft" ? { status: "estimated" } : {}) },
    });
    if (upd.error) throw dbError(upd.error, "requirement");
    current = upd.data as Record<string, unknown>;
    applied.push(...directChanges.map((c) => c.key));
    await snapshot(ctx, current, reason || "edited");
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
  return { requirement: current, applied, proposals };
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
  const [stake, versions, sv, quotes, opps, props] = await Promise.all([
    ctx.db.from("stakeholder").select("id, role, influence_basis, access_status, person:person_id(id, full_name)").eq("requirement_id", id),
    ctx.db.from("requirement_version").select("version, change_reason, created_at, change_proposal_id").eq("requirement_id", id).order("version", { ascending: false }).limit(20),
    ctx.db.from("shortlist_version").select("*").eq("requirement_id", id).order("version", { ascending: false }).limit(1).maybeSingle(),
    ctx.db.from("quote").select("*").eq("requirement_id", id).order("created_at", { ascending: false }),
    ctx.db.from("opportunity").select("id, name, stage, outcome").eq("requirement_id", id),
    ctx.db.from("change_proposal").select("id, state, risk, reason, created_at").eq("target_type", "requirement").eq("target_id", id).in("state", ["proposed", "approved", "clarify"]),
  ]);
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
  };
}
