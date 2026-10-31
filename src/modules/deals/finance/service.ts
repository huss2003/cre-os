/**
 * Financial analyst service: runs the deterministic engine (fin-1.0) and stores the scenario, its cash flows and
 * output hash. Quote provenance is recorded and checked (superseded / expired quotes produce blocking warnings).
 */
import { type DealsCtx, DealsError, dbError, must, owned, today } from "../ctx";
import { compareScenarios, concessionEquivalence, evaluate, FinanceInputError, sensitivities, type Concession } from "./engine";
import type { FinanceInput, FinanceResult } from "./types";
import type { QuoteTermsInput } from "../quotes/service";

export async function checkQuoteRefs(ctx: DealsCtx, input: FinanceInput, asOf = today()): Promise<string[]> {
  const refs = input.quoteRefs ?? [];
  if (!refs.length) return [];
  const r = await ctx.db.from("quote").select("id, version, valid_until, superseded_by").in("id", refs.map((x) => x.quoteId));
  if (r.error) throw dbError(r.error, "quotes");
  const byId = new Map((r.data ?? []).map((q) => [q.id as string, q]));
  const out: string[] = [];
  for (const ref of refs) {
    const q = byId.get(ref.quoteId);
    if (!q) out.push(`quote ${ref.quoteId} not found or not visible`);
    else if (q.version !== ref.version) out.push(`quote ${ref.quoteId}: input uses v${ref.version}, stored quote is v${q.version}`);
    else if (q.superseded_by) out.push(`quote v${q.version} has been superseded by a newer version`);
    else if (q.valid_until && q.valid_until < asOf) out.push(`quote v${q.version} expired on ${q.valid_until}`);
  }
  return out;
}

export function runEngine(input: FinanceInput): FinanceResult {
  try {
    return evaluate(input);
  } catch (e) {
    if (e instanceof FinanceInputError) throw new DealsError(400, e.message, { field: e.field });
    throw e;
  }
}

export interface SaveScenarioInput { input: FinanceInput; requirementId?: string | null; optionId?: string | null; save?: boolean }

export async function evaluateScenario(ctx: DealsCtx, s: SaveScenarioInput) {
  const result = runEngine(s.input);
  const quoteIssues = await checkQuoteRefs(ctx, s.input);
  const withSens = { result, sensitivities: safe(() => sensitivities(s.input)), quoteIssues };
  if (!s.save) return { scenarioId: null as string | null, ...withSens };
  let cls = "corporate_confidential";
  if (s.requirementId) cls = (must(await ctx.db.from("requirement").select("classification").eq("id", s.requirementId).maybeSingle(), "requirement") as { classification: string }).classification;
  const refs = s.input.quoteRefs ?? [];
  const sc = must(await ctx.db.from("finance_scenario").insert({
    ...owned(ctx, cls), requirement_id: s.requirementId ?? null, option_id: s.optionId ?? null, name: s.input.name,
    input_json: s.input, quote_ids: refs.map((r) => r.quoteId), quote_versions: refs.map((r) => r.version),
    engine_version: result.engineVersion, result_json: { ...result, cashflows: undefined, quoteIssues }, output_hash: result.outputHash,
  }).select("id").single(), "finance_scenario") as { id: string };
  const rows = result.cashflows.map((c) => ({ ...owned(ctx, cls), scenario_id: sc.id, period_index: c.period, period_date: c.date, category: c.category, amount: c.amount }));
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await ctx.db.from("finance_cashflow").insert(rows.slice(i, i + 500));
    if (ins.error) throw dbError(ins.error, "finance_cashflow");
  }
  return { scenarioId: sc.id, ...withSens };
}

function safe<T>(fn: () => T): T | [] { try { return fn(); } catch { return []; } }

export function compare(inputs: FinanceInput[]) {
  try { return compareScenarios(inputs); } catch (e) {
    if (e instanceof FinanceInputError) throw new DealsError(400, e.message, { field: e.field });
    throw e;
  }
}

export function concessions(base: FinanceInput, list: Concession[]) {
  try { return concessionEquivalence(base, list); } catch (e) {
    if (e instanceof FinanceInputError) throw new DealsError(400, e.message, { field: e.field });
    throw e;
  }
}

/** Approve a stored scenario: recomputes the engine and refuses if the stored hash no longer reproduces. */
export async function approveScenario(ctx: DealsCtx, id: string) {
  const sc = must(await ctx.db.from("finance_scenario").select("*").eq("id", id).maybeSingle(), "scenario") as { input_json: FinanceInput; output_hash: string };
  const re = runEngine(sc.input_json);
  if (re.outputHash !== sc.output_hash) throw new DealsError(409, "stored result does not reproduce with the current engine: re-run the scenario");
  const issues = await checkQuoteRefs(ctx, sc.input_json);
  if (issues.length) throw new DealsError(422, "quote provenance problems", { issues });
  const r = await ctx.db.from("finance_scenario").update({ approved_at: new Date().toISOString() }).eq("id", id).select("*").single();
  if (r.error) throw dbError(r.error, "scenario");
  await ctx.db.from("approval").insert({ ...owned(ctx), subject_type: "finance_scenario", subject_id: id, approver_user_id: ctx.userId, approved_hash: sc.output_hash, decision: "approved" });
  return r.data;
}

/** Build engine input from a quote's typed terms and the space snapshot. Missing values stay missing (S6). Pure. */
export function inputFromQuote(o: {
  name: string; kind?: FinanceInput["kind"]; baseDate: string; horizonMonths: number; annualDiscountRatePct: number | string;
  quote: { id: string; version: number; valid_until?: string | null; terms_json: QuoteTermsInput };
  space: { chargeable_sf?: number | string | null; carpet_sf?: number | string | null; seats?: number | null };
  fitoutCost?: number | string | null; gstRatePct?: number | string | null; afterTenure?: FinanceInput["afterTenure"];
}): FinanceInput {
  const t = o.quote.terms_json ?? {};
  if (t.rent === undefined || t.rent === null || !t.rent_basis) throw new DealsError(400, "quote has no rent or rent basis");
  const esc = t.escalation_pct != null && t.escalation_every_months ? { pct: t.escalation_pct, everyMonths: t.escalation_every_months } : null;
  const input: FinanceInput = {
    name: o.name, kind: o.kind ?? "conventional", baseDate: o.baseDate, horizonMonths: o.horizonMonths, annualDiscountRatePct: o.annualDiscountRatePct,
    area: { chargeableSf: o.space.chargeable_sf ?? null, carpetSf: o.space.carpet_sf ?? null, plannedSeats: o.space.seats ?? null },
    tenureMonths: t.tenure_months ?? null, afterTenure: o.afterTenure ?? null,
    rent: { basis: t.rent_basis, rate: t.rent, escalation: esc, rentFreeMonths: t.rent_free_months ?? 0 },
    cam: t.cam_included ? { mode: "none" } : t.cam_per_sf != null ? { mode: "per_sf", ratePerSf: t.cam_per_sf, escalation: esc } : null,
    deposit: t.deposit_months != null ? { months: t.deposit_months } : null,
    capex: o.fitoutCost != null ? { fitoutCost: o.fitoutCost, landlordContribution: t.capex_support ?? 0 } : t.capex_support ? { fitoutCost: 0, landlordContribution: t.capex_support } : null,
    taxes: t.gst === "included" ? { treatment: "included" } : t.gst === "excluded" ? { treatment: "excluded", gstRatePct: o.gstRatePct ?? null } : null,
    quoteRefs: [{ quoteId: o.quote.id, version: o.quote.version, validUntil: o.quote.valid_until ?? null }],
  };
  return input;
}

export async function listScenarios(ctx: DealsCtx, opts: { requirementId?: string } = {}) {
  let q = ctx.db.from("finance_scenario").select("id, name, requirement_id, engine_version, output_hash, approved_at, created_at, result_json, quote_ids, quote_versions")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(200);
  if (opts.requirementId) q = q.eq("requirement_id", opts.requirementId);
  const r = await q;
  if (r.error) throw dbError(r.error, "scenarios");
  return r.data ?? [];
}
