/**
 * NPV equivalent of a negotiation ladder step (mudar.concession_step, written by the Deal Strategist / intelligence).
 *
 * Deterministic, using concessionEquivalence() of engine fin-1.0 against a BASE scenario:
 *   1. the step's quote, followed along superseded_by to the current version;
 *   2. the latest stored finance_scenario whose quote_ids contain that quote (approved first, then newest).
 * The concession itself comes from value_json:
 *   finance_type  — "rent_free" | "capex_support" | "deposit_months" | "escalation_pct" | "rent_rate"
 *   finance_value — the change in engine terms: +months rent-free; +₹ capex support; Δ deposit months (e.g. -2);
 *                   Δ escalation percentage points (e.g. -2.5); Δ rent ₹/unit/month (e.g. -5).
 * npv_equivalent = NPV saving to the occupier (positive = worth that much to the tenant); engine_version = "fin-1.0".
 * Anything unknown (no finance_type/value, no quote, no base scenario, concession not applicable to the base) leaves
 * npv_equivalent and engine_version NULL — never 0 — and records why in value_json.finance_equivalence.
 * Runs as the `deals.concession_npv` job (service role, explicit workspace filters), enqueued by SQL triggers when a
 * step is created / its quote or finance fields change, a quote is superseded, or a scenario is saved for the quote.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "../ctx";
import { concessionEquivalence, evaluate, FinanceInputError } from "./engine";
import { ENGINE_VERSION, type FinanceInput } from "./types";
import type { Concession } from "./engine";

type Db = SupabaseClient<any, any, any>;
const FINANCE_TYPES = ["rent_free", "capex_support", "deposit_months", "escalation_pct", "rent_rate"] as const;
type FinanceType = (typeof FINANCE_TYPES)[number];

export interface ConcessionNpv {
  npv: string | null;
  status: "computed" | "unknown";
  reason: string | null;
  basis?: { scenario_id: string; scenario_version: number; output_hash: string; quote_id: string; npv_base: string; npv_with: string; equivalent_rent_free_months: string | null; equivalent_rate_reduction: string | null; base_complete: boolean };
}

/** Pure: concession from value_json, or a reason why it is unknown. */
export function concessionFromValue(v: Record<string, unknown> | null | undefined): Concession | string {
  const type = v?.finance_type as string | null | undefined;
  if (!type) return "no finance_type: not a priced concession";
  if (!(FINANCE_TYPES as readonly string[]).includes(type)) return `unsupported finance_type ${type}`;
  const raw = v?.finance_value;
  if (raw === null || raw === undefined || raw === "") return "finance_value (size of the concession) not recorded";
  const x = Number(raw);
  if (!Number.isFinite(x)) return "finance_value is not a number";
  switch (type as FinanceType) {
    case "rent_free": return Number.isInteger(x) && x > 0 ? { type: "rent_free", months: x } : "rent_free finance_value must be a positive whole number of months";
    case "capex_support": return x > 0 ? { type: "capex_support", amount: x } : "capex_support finance_value must be a positive ₹ amount";
    case "deposit_months": return { type: "deposit_months", months: x };
    case "escalation_pct": return { type: "escalation_pct", pct: x };
    case "rent_rate": return { type: "rent_rate", rate: x };
  }
}

/** Pure: value of the concession against a base scenario input. */
export function npvForConcession(base: FinanceInput, c: Concession): { npv: string; npvBase: string; npvWith: string; months: string | null; rate: string | null } | string {
  try {
    const [r] = concessionEquivalence(base, [c]);
    return { npv: r.npvValue, npvBase: r.npvBase, npvWith: r.npvWith, months: r.equivalentRentFreeMonths, rate: r.equivalentRateReduction };
  } catch (e) {
    if (e instanceof FinanceInputError) return `not applicable to the base scenario: ${e.message}`;
    throw e;
  }
}

async function currentQuoteId(db: Db, ws: string, quoteId: string): Promise<string> {
  let id = quoteId;
  for (let i = 0; i < 50; i++) {
    const q = await db.from("quote").select("id, superseded_by").eq("workspace_id", ws).eq("id", id).maybeSingle();
    if (q.error) throw dbError(q.error, "quote");
    const next = (q.data as { superseded_by: string | null } | null)?.superseded_by;
    if (!next) return id;
    id = next;
  }
  return id;
}

export async function computeConcessionNpv(db: Db, workspaceId: string, stepId: string): Promise<ConcessionNpv & { written: boolean }> {
  const s = await db.from("concession_step").select("id, quote_id, value_json").eq("workspace_id", workspaceId).eq("id", stepId).maybeSingle();
  if (s.error) throw dbError(s.error, "concession_step");
  if (!s.data) return { npv: null, status: "unknown", reason: "step not found", written: false };
  const step = s.data as { id: string; quote_id: string | null; value_json: Record<string, unknown> | null };
  let out: ConcessionNpv;
  const c = concessionFromValue(step.value_json);
  if (typeof c === "string") out = { npv: null, status: "unknown", reason: c };
  else if (!step.quote_id) out = { npv: null, status: "unknown", reason: "no quote linked to this step" };
  else {
    const qid = await currentQuoteId(db, workspaceId, step.quote_id);
    const sc = await db.from("finance_scenario").select("id, version, output_hash, input_json, approved_at, created_at").eq("workspace_id", workspaceId)
      .contains("quote_ids", [qid]).is("archived_at", null).order("approved_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (sc.error) throw dbError(sc.error, "finance_scenario");
    if (!sc.data) out = { npv: null, status: "unknown", reason: "no finance scenario for the current quote version — calculate one to price this step" };
    else {
      const base = sc.data as { id: string; version: number; output_hash: string; input_json: FinanceInput };
      const v = npvForConcession(base.input_json, c);
      if (typeof v === "string") out = { npv: null, status: "unknown", reason: v };
      else {
        let complete = true;
        try { complete = evaluate(base.input_json).complete; } catch { complete = false; }
        out = { npv: v.npv, status: "computed", reason: null, basis: { scenario_id: base.id, scenario_version: base.version ?? 1, output_hash: base.output_hash, quote_id: qid, npv_base: v.npvBase, npv_with: v.npvWith, equivalent_rent_free_months: v.months, equivalent_rate_reduction: v.rate, base_complete: complete } };
      }
    }
  }
  const value_json = { ...(step.value_json ?? {}), finance_equivalence: { status: out.status, reason: out.reason, ...(out.basis ?? {}), computed_at: new Date().toISOString() } };
  const u = await db.from("concession_step").update({ npv_equivalent: out.npv, engine_version: out.npv === null ? null : ENGINE_VERSION, value_json })
    .eq("workspace_id", workspaceId).eq("id", stepId);
  if (u.error) throw dbError(u.error, "concession_step");
  return { ...out, written: true };
}
