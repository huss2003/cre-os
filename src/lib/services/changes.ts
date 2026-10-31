import "server-only";
import type { Db } from "@/lib/supabase/server";

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
  /** Optional proposal-time snapshot of the patched fields (shown as "before" in the approval card). */
  before?: Record<string, unknown> | null;
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

export async function proposeChange(db: Db, workspaceId: string, input: ProposeInput) {
  const operation = input.operation ?? "update";
  if (FORBIDDEN_TARGETS.has(input.targetType)) {
    throw new ForbiddenTargetError(`proposals may not target ${input.targetType}`);
  }
  const risk = classifyRisk(input.targetType, operation, input.patch);
  const approvalRequired = risk !== "routine_internal" || input.proposedByKind === "model";
  if (input.idempotencyKey) {
    const { data: existing } = await db.from("change_proposal").select("*")
      .eq("workspace_id", workspaceId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
    if (existing) return existing;
  }
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    operation,
    expected_version: input.expectedVersion ?? null,
    patch: input.patch,
    reason: input.reason,
    evidence_ids: input.evidenceIds ?? [],
    risk,
    approval_required: approvalRequired,
    proposed_by_kind: input.proposedByKind ?? "user",
    model: input.model ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    capture_id: input.captureId ?? null,
    classification: input.classification ?? "corporate_confidential",
  };
  if (input.ownerUserId) row.owner_user_id = input.ownerUserId;
  if (input.before) row.before = { kind: "proposal_snapshot", fields: input.before };
  const { data, error } = await db.from("change_proposal").insert(row).select().single();
  if (error) {
    // concurrent duplicate on the idempotency key: return the winner
    if (error.code === "23505" && input.idempotencyKey) {
      const { data: existing } = await db.from("change_proposal").select("*")
        .eq("workspace_id", workspaceId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
      if (existing) return existing;
    }
    throw error;
  }
  return data;
}
