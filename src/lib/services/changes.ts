import "server-only";
import type { Db } from "@/lib/supabase/server";

/**
 * Change-proposal contract (spec Part III "Example extraction/change contract").
 * Anything that would change a canonical record from a capture, connector, job or model goes through here.
 * Apply/approve/reverse live in src/modules/changes (owned by the capture/approvals module).
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
}

/** Fields whose change is always "material" (requires approval). Determined OUTSIDE the LLM. */
const MATERIAL_FIELDS: Record<string, string[]> = {
  requirement: ["area_min_sf", "area_target_sf", "area_max_sf", "budget_min", "budget_max", "decision_date", "occupation_date", "status", "constraints", "org_id"],
  opportunity: ["stage", "outcome", "expected_fee", "credit_share", "mandate_status", "account_owner_user_id", "expected_close"],
  lease: ["contractual_expiry", "start_date", "tenure_months_raw", "lockin_months_raw", "area_sf", "rent_per_sf", "tenant_org_id"],
  lease_event: ["event_date", "confirmed", "date_basis"],
  employment: ["end_date", "is_current", "org_id"],
  quote: ["terms_json", "valid_until", "approved_floor", "approved_ceiling"],
  fee_milestone: ["gross_fee", "credit_share", "invoiced_amount", "recognised_amount", "collected_amount"],
  organisation: ["legal_name", "cin", "gstin", "domain", "crm_external_id"],
  person: ["full_name"],
  contact_method: ["value", "suppressed"],
  availability: ["status", "asking_rent_min", "asking_rent_max", "available_from"],
};

export function classifyRisk(targetType: string, operation: string, patch: PatchOp[]): RiskLevel {
  if (operation === "merge") return "identity_merge";
  if (targetType === "draft") return "external_message";
  if (targetType === "opportunity" && patch.some((p) => /expected_fee|credit_share|stage/.test(p.path))) return "high_value";
  if (targetType === "fee_milestone") return "high_value";
  const material = MATERIAL_FIELDS[targetType] ?? [];
  if (operation === "create" && ["requirement", "opportunity", "lease", "quote", "employment"].includes(targetType)) return "material_fact";
  if (patch.some((p) => material.includes(p.path.replace(/^\//, "").split("/")[0]))) return "material_fact";
  return "routine_internal";
}

export async function proposeChange(db: Db, workspaceId: string, input: ProposeInput) {
  const operation = input.operation ?? "update";
  const risk = classifyRisk(input.targetType, operation, input.patch);
  const approvalRequired = risk !== "routine_internal" || input.proposedByKind === "model";
  if (input.idempotencyKey) {
    const { data: existing } = await db.from("change_proposal").select("*")
      .eq("workspace_id", workspaceId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
    if (existing) return existing;
  }
  const { data, error } = await db.from("change_proposal").insert({
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
  }).select().single();
  if (error) throw error;
  return data;
}
