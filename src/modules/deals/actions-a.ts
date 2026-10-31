"use server";
/**
 * Server Actions added by the deals-A builder in round 2 (requirements matching configuration, finance assumptions,
 * versioned recalculation). Same pattern as ./actions.ts: run as the signed-in user (RLS), redirect with ?msg= / ?err=.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { toDealsCtx } from "./api";
import { DealsError, type DealsCtx } from "./ctx";
import type { SpecKey } from "./requirements/contract";
import { updateMatchingConfig, type MatchingConfigInput } from "./matching/config";
import { CRITERIA } from "./matching/match";
import { approveAssumptions, recalculateScenario, revokeAssumption } from "./finance/service";
import type { CostItem, CostState, FinanceInput } from "./finance/types";

const s = (f: FormData, k: string) => { const v = f.get(k); return v === null ? "" : String(v).trim(); };
const n = (f: FormData, k: string) => { const v = s(f, k); if (v === "") return null; const x = Number(v.replace(/,/g, "")); return Number.isFinite(x) ? x : null; };

function errText(e: unknown): string {
  if (e instanceof DealsError) {
    const d = e.details as { reasons?: string[]; blockers?: string[]; issues?: string[] } | undefined;
    return [e.message, ...(d?.reasons ?? d?.blockers ?? d?.issues ?? [])].join(" · ").slice(0, 600);
  }
  if (e && typeof e === "object" && "message" in e) return String((e as { message: string }).message).slice(0, 400);
  return "Something went wrong";
}
const withParam = (path: string, k: string, v: string) => `${path}${path.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;

async function run(back: string, minRole: "editor" | "admin", fn: (ctx: DealsCtx) => Promise<string | { to?: string; msg?: string } | void>, okMsg = "Saved") {
  let dest = back, msg = okMsg, err: string | null = null;
  try {
    const ctx = toDealsCtx(await requireContext(minRole));
    const r = await fn(ctx);
    if (typeof r === "string") dest = r;
    else if (r) { dest = r.to ?? back; msg = r.msg ?? okMsg; }
  } catch (e) {
    err = errText(e);
  }
  revalidatePath(back.split("?")[0]);
  redirect(err ? withParam(back, "err", err) : withParam(dest, "msg", msg));
}

const NUM_SPECS: SpecKey[] = ["min_power_kva", "min_car_parks", "min_two_wheeler_parks", "max_metro_km"];
const LIST_SPECS: SpecKey[] = ["certifications", "fitout_basis"];

/** Parse "label, lat, lon[, weight]" lines. */
function parseCatchments(text: string) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const parts = line.split(",").map((x) => x.trim());
    if (parts.length < 3) throw new DealsError(400, `catchment line ${i + 1}: use “label, latitude, longitude[, weight]”`);
    const [label, lat, lon, weight] = parts;
    return { label, lat: Number(lat), lon: Number(lon), ...(weight ? { weight: Number(weight) } : {}) };
  });
}

/**
 * Matching configuration form. Only values that differ from what the form was rendered with (orig_* fields) are sent,
 * so untouched derived specs stay derived; a cleared box clears the spec.
 */
export async function saveMatchingConfigAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => {
    const input: MatchingConfigInput = {};
    const weights: NonNullable<MatchingConfigInput["weights"]> = {};
    for (const c of CRITERIA) if (s(f, `w_${c}`) !== s(f, `orig_w_${c}`)) weights[c] = s(f, `w_${c}`) === "" ? null : n(f, `w_${c}`) ?? (() => { throw new DealsError(400, `weight for ${c} must be a number`); })();
    if (Object.keys(weights).length) input.weights = weights;
    const specs: NonNullable<MatchingConfigInput["requiredSpecs"]> = {};
    for (const k of NUM_SPECS) if (s(f, `spec_${k}`) !== s(f, `orig_spec_${k}`)) (specs as Record<string, unknown>)[k] = s(f, `spec_${k}`) === "" ? null : s(f, `spec_${k}`);
    for (const k of LIST_SPECS) if (s(f, `spec_${k}`) !== s(f, `orig_spec_${k}`)) (specs as Record<string, unknown>)[k] = s(f, `spec_${k}`) === "" ? null : s(f, `spec_${k}`);
    const on24 = s(f, "spec_operating_24x7") === "on";
    if (String(on24) !== s(f, "orig_spec_operating_24x7")) specs.operating_24x7 = on24 ? true : null;
    if (Object.keys(specs).length) input.requiredSpecs = specs;
    if (s(f, "reset_derived") === "on") input.resetDerived = [...NUM_SPECS, ...LIST_SPECS, "operating_24x7"];
    const norm = (x: string) => x.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
    if (norm(s(f, "catchments")) !== norm(s(f, "orig_catchments"))) input.catchments = parseCatchments(s(f, "catchments"));
    const hf = { budget_ceiling: s(f, "hf_budget_ceiling") === "on", latest_occupation: s(f, "hf_latest_occupation") === "on", preferred_only: s(f, "hf_preferred_only") === "on" };
    if (JSON.stringify(hf) !== s(f, "orig_hf")) input.hardFilters = hf;
    const r = await updateMatchingConfig(ctx, id, Number(s(f, "row_version")), input, s(f, "reason"), s(f, "nonce") || null);
    if (r.proposalId) return { msg: `Requirement is client-confirmed: hard-constraint change submitted for approval${r.applied.length ? ` (${r.applied.join(", ")} applied directly)` : ""}. Re-run the shortlist after approval.` };
    return { msg: r.applied.length ? `Matching configuration saved (${r.applied.join(", ")}). Re-run the shortlist to apply it.` : "Nothing changed" };
  });
}

export async function approveAssumptionsAction(f: FormData) {
  const id = s(f, "id");
  await run(`/finance/${id}`, "admin", async (ctx) => {
    const keys = f.getAll("key").map(String).filter(Boolean);
    const r = await approveAssumptions(ctx, id, keys, s(f, "note") || null);
    return { msg: `${r.approved} assumption(s) approved` };
  });
}

export async function revokeAssumptionAction(f: FormData) {
  const id = s(f, "id");
  await run(`/finance/${id}`, "admin", async (ctx) => { await revokeAssumption(ctx, id, s(f, "key"), s(f, "note") || null); }, "Assumption approval revoked (scenario approval dropped)");
}

/**
 * Recalculate as a new version with edited assumptions / filled-in gaps. Untouched fields keep the previous inputs.
 */
export async function recalculateScenarioAction(f: FormData) {
  const id = s(f, "id");
  await run(`/finance/${id}`, "editor", async (ctx) => {
    const prev = (await ctx.db.from("finance_scenario").select("input_json").eq("workspace_id", ctx.workspaceId).eq("id", id).single()).data as { input_json: FinanceInput } | null;
    if (!prev) throw new DealsError(404, "scenario not found");
    const x: FinanceInput = JSON.parse(JSON.stringify(prev.input_json));
    const states: Partial<Record<CostItem, CostState>> = { ...(x.costStates ?? {}) };
    const src: Record<string, string> = { ...(x.assumptionSources ?? {}) };
    if (s(f, "discount") !== "") { x.annualDiscountRatePct = n(f, "discount") ?? x.annualDiscountRatePct; if (s(f, "discount_source")) src.discount_rate = s(f, "discount_source"); }
    if (x.rent && s(f, "esc_pct") !== "") x.rent.escalation = n(f, "esc_pct") === 0 ? null : { pct: n(f, "esc_pct")!, everyMonths: n(f, "esc_every") ?? x.rent.escalation?.everyMonths ?? 12 };
    if (x.rent && s(f, "rent_free") !== "") x.rent.rentFreeMonths = n(f, "rent_free") ?? 0;
    if (s(f, "gst_rate") !== "" && x.taxes) x.taxes.gstRatePct = n(f, "gst_rate");
    // fill gaps: amount → known, "none" → explicitly none
    const fill = (item: CostItem, apply: () => void) => {
      const st = s(f, `${item}_state`);
      if (st === "none") { states[item] = "none"; return; }
      if (st === "amount") { apply(); states[item] = "known"; }
    };
    fill("cam", () => { const r = n(f, "cam_rate"); if (r === null) throw new DealsError(400, "enter the CAM ₹/SF/month"); x.cam = { mode: "per_sf", ratePerSf: r, escalation: x.rent?.escalation ?? null }; });
    fill("parking", () => { const sl = n(f, "parking_slots"), r = n(f, "parking_rate"); if (!sl || r === null) throw new DealsError(400, "enter parking slots and ₹/slot"); x.parking = { slots: sl, ratePerSlot: r, escalation: x.rent?.escalation ?? null }; });
    fill("deposit", () => { const m = n(f, "deposit_months"); if (!m) throw new DealsError(400, "enter deposit months"); x.deposit = { months: m }; });
    fill("fitout", () => { const a = n(f, "fitout"); if (!a) throw new DealsError(400, "enter the fit-out capex"); x.capex = { ...(x.capex ?? { fitoutCost: 0 }), fitoutCost: a }; });
    fill("opex", () => { const a = n(f, "opex_monthly"); if (!a) throw new DealsError(400, "enter other monthly operating costs"); x.recurring = [...(x.recurring ?? []).filter((r) => r.category !== "opex"), { label: "Other operating costs", monthly: a, category: "opex" }]; });
    fill("reinstatement", () => { const a = n(f, "reinstatement"); if (!a) throw new DealsError(400, "enter the reinstatement amount"); x.capex = { ...(x.capex ?? { fitoutCost: 0 }), reinstatement: { amount: a, period: x.tenureMonths ?? x.horizonMonths } }; });
    for (const item of Object.keys(states) as CostItem[]) if (states[item] === "none" && s(f, `${item}_state`) === "none") src[`none:${item}`] = s(f, "none_source") || "user input";
    x.costStates = states;
    x.assumptionSources = src;
    const r = await recalculateScenario(ctx, id, x);
    return { to: `/finance/${r.scenarioId}`, msg: `Recalculated as v${r.version}; ${r.carriedApprovals} unchanged assumption approval(s) carried over — changed ones need approval again` };
  });
}
