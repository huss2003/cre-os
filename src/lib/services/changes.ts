import "server-only";
import type { Db } from "@/lib/supabase/server";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

/**
 * Change-proposal contract (spec Part III "Example extraction/change contract").
 * Anything that would change a canonical record from a capture, connector, job or model goes through here.
 * Apply/approve/reverse live in src/modules/changes (owned by the capture/approvals module) and are executed
 * transactionally by the SQL functions app.apply_change / app.reverse_change (which re-check risk, role and approval).
 */
export type RiskLevel = "routine_internal" | "material_fact" | "identity_merge" | "external_message" | "high_value";

export interface PatchOp { op: "add" | "replace" | "remove"; path: string; value?: unknown }

export interface ProposeInput {
  targetType: string;            // table name, e.g. "requirement"
  targetId?: string | null;      // null for create
  operation?: "create" | "update" | "archive" | "merge" | "link";
  expectedVersion?: number | null;
  patch: PatchOp[];
  reason: string;
  evidenceIds?: string[];
  proposedByKind?: "user" | "job" | "model";
  model?: string;
  idempotencyKey?: string;
  captureId?: string;
  classification?: string;
  /** Row owner (visibility for colleagues without see_all_accounts). Jobs should pass the originating user. */
  ownerUserId?: string | null;
  /** Ignored since the propose_change RPC: the server snapshots the current values of the patched fields itself. */
  before?: Record<string, unknown> | null;
  /** Service-role (job) callers: the user on whose behalf the proposal is made (must be an editor who can write the target). */
  actorUserId?: string | null;
}

/** Tables a proposal may never target (permissions, tenancy, system). Mirrors app.cx_allowed_tables() in SQL. */
export const FORBIDDEN_TARGETS = new Set([
  "membership", "workspace", "platform_admin", "record_share", "approval", "audit_event", "change_proposal",
  "change_conflict", "job", "outbox", "connector_account", "connector_cursor", "model_usage", "user_preference",
  "workspace_setting", "data_lane", "licensed_source", "consent_permission",
]);

/** Fields whose change is always "material" (requires approval). Determined OUTSIDE the LLM. Mirrors app.cx_material_fields(). */
export const MATERIAL_FIELDS: Record<string, string[]> = {
  requirement: ["area_min_sf", "area_target_sf", "area_max_sf", "budget_min", "budget_max", "budget_basis", "area_basis",
    "seats_min", "seats_target", "seats_max", "decision_date", "occupation_date", "status", "constraints", "org_id",
    "preferred_geography_ids", "excluded_geography_ids", "confirmed_by_person_id", "confirmed_at"],
  opportunity: ["stage", "outcome", "expected_fee", "credit_share", "mandate_status", "account_owner_user_id", "expected_close", "org_id"],
  lease: ["contractual_expiry", "start_date", "tenure_months_raw", "lockin_months_raw", "area_sf", "rent_per_sf", "tenant_org_id"],
  lease_event: ["event_date", "confirmed", "date_basis"],
  employment: ["end_date", "is_current", "org_id", "person_id"],
  quote: ["terms_json", "valid_until", "approved_floor", "approved_ceiling"],
  fee_milestone: ["gross_fee", "credit_share", "invoiced_amount", "recognised_amount", "collected_amount"],
  organisation: ["legal_name", "cin", "gstin", "domain", "crm_external_id"],
  person: ["full_name"],
  contact_method: ["value", "suppressed"],
  availability: ["status", "asking_rent_min", "asking_rent_max", "available_from"],
};

/** Proposed high-value threshold (spec §10): expected attributed fee >= ₹30 lakh. */
export const HIGH_VALUE_FEE_INR = 30_00_000;

const MATERIAL_CREATE = ["requirement", "opportunity", "lease", "quote", "employment"];
const MATERIAL_ARCHIVE = ["requirement", "opportunity", "lease", "quote", "employment", "organisation", "person", "asset", "fee_milestone"];

export function patchFields(patch: PatchOp[]): string[] {
  return patch.map((p) => p.path.replace(/^\//, "").split("/")[0]);
}

export function classifyRisk(targetType: string, operation: string, patch: PatchOp[]): RiskLevel {
  if (operation === "merge") return "identity_merge";
  if (targetType === "draft") return "external_message";
  if (targetType === "opportunity" && patch.some((p) => /expected_fee|credit_share|stage|outcome/.test(p.path))) return "high_value";
  if (targetType === "fee_milestone") return "high_value";
  const material = MATERIAL_FIELDS[targetType] ?? [];
  if (operation === "create" && MATERIAL_CREATE.includes(targetType)) return "material_fact";
  if (operation === "archive" && MATERIAL_ARCHIVE.includes(targetType)) return "material_fact";
  if (patchFields(patch).some((f) => material.includes(f))) return "material_fact";
  return "routine_internal";
}

/** Extra high-value check needing the record (e.g. strategic accounts / fee size). Optional for callers. */
export function isHighValueOpportunity(opp: { expected_fee?: number | string | null; strategic?: boolean | null }): boolean {
  return !!opp.strategic || Number(opp.expected_fee ?? 0) >= HIGH_VALUE_FEE_INR;
}

export class ForbiddenTargetError extends Error {}

/** Error raised by the change RPCs. `code` is the prefix of the SQL message ("forbidden", "approval_invalid", "stale_version", ...). */
export class ChangeError extends Error {
  constructor(public code: string, message: string, public pgCode?: string) {
    super(message);
  }
  get httpStatus(): number {
    switch (this.code) {
      case "not_found": return 404;
      case "forbidden": case "field_not_allowed": return 403;
      case "approval_invalid": case "approval_expired": case "approval_required": case "stale_version": case "invalid_state": case "conflict": return 409;
      case "invalid_patch": case "invalid_parameter": return 400;
      default: return 500;
    }
  }
}

export function toChangeError(e: { message?: string; code?: string } | null | undefined): ChangeError {
  const msg = e?.message ?? "unknown error";
  const m = /^([a-z_]+):\s*([\s\S]*)$/.exec(msg);
  return m ? new ChangeError(m[1], m[2] || msg, e?.code) : new ChangeError("error", msg, e?.code);
}

/**
 * Create a change proposal through app.propose_change (SECURITY DEFINER): the SQL side re-validates the
 * target table/columns, checks the actor can write the target row, computes the risk floor (never lower than
 * the SQL port of MATERIAL_FIELDS), snapshots the current values and dedupes on idempotency_key.
 * User clients act as auth.uid(); service-role (job) clients should pass `actorUserId` (the originating user).
 */
export async function proposeChange(db: Db, workspaceId: string, input: ProposeInput) {
  const operation = input.operation ?? "update";
  if (FORBIDDEN_TARGETS.has(input.targetType)) {
    throw new ForbiddenTargetError(`proposals may not target ${input.targetType}`);
  }
  const hint = classifyRisk(input.targetType, operation, input.patch);
  const { data, error } = await db.schema("app").rpc("propose_change", {
    p_workspace: workspaceId,
    p_target_type: input.targetType,
    p_target_id: input.targetId ?? null,
    p_operation: operation,
    p_patch: input.patch,
    p_reason: input.reason,
    p_expected_version: input.expectedVersion ?? null,
    p_evidence_ids: input.evidenceIds ?? [],
    p_proposed_by_kind: input.proposedByKind ?? "user",
    p_model: input.model ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_capture_id: input.captureId ?? null,
    p_classification: input.classification ?? "corporate_confidential",
    p_owner_user_id: input.ownerUserId ?? null,
    p_risk_hint: hint === "external_message" ? null : hint,
    p_actor: input.actorUserId ?? null,
  });
  if (error) {
    const ce = toChangeError(error);
    if (ce.code === "forbidden" && /not changeable/.test(ce.message)) throw new ForbiddenTargetError(ce.message);
    throw ce;
  }
  return data as AnyRow;
}
