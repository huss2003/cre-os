/**
 * Financial analyst service: runs the deterministic engine (fin-1.0) and stores the scenario, its cash flows and
 * output hash. Quote provenance is recorded and checked (superseded / expired quotes produce blocking warnings).
 */
import { type DealsCtx, DealsError, dbError, must, owned, today } from "../ctx";
import { compareScenarios, concessionEquivalence, evaluate, FinanceInputError, sensitivities, type Concession } from "./engine";
import type { CostItem, CostState, FinanceInput, FinanceResult } from "./types";
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
  const sc = await insertScenario(ctx, cls, s.input, result, quoteIssues, { requirementId: s.requirementId ?? null, optionId: s.optionId ?? null, version: 1, previousId: null });
  return { scenarioId: sc.id, ...withSens };
}

/** Store one immutable scenario version: inputs, engine output + hash, rounding rule, gaps, cash flows, assumptions. */
async function insertScenario(ctx: DealsCtx, cls: string, input: FinanceInput, result: FinanceResult, quoteIssues: string[],
  o: { requirementId: string | null; optionId: string | null; version: number; previousId: string | null }) {
  const refs = input.quoteRefs ?? [];
  const sc = must(await ctx.db.from("finance_scenario").insert({
    ...owned(ctx, cls), requirement_id: o.requirementId, option_id: o.optionId, name: input.name,
    input_json: input, quote_ids: refs.map((r) => r.quoteId), quote_versions: refs.map((r) => r.version),
    engine_version: result.engineVersion, result_json: { ...result, cashflows: undefined, quoteIssues }, output_hash: result.outputHash,
    rounding_rule: result.roundingRule, gaps: result.gaps, version: o.version, previous_id: o.previousId,
  }).select("id").single(), "finance_scenario") as { id: string };
  const rows = result.cashflows.map((c) => ({ ...owned(ctx, cls), scenario_id: sc.id, period_index: c.period, period_date: c.date, category: c.category, amount: c.amount }));
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await ctx.db.from("finance_cashflow").insert(rows.slice(i, i + 500));
    if (ins.error) throw dbError(ins.error, "finance_cashflow");
  }
  if (result.assumptions.length) {
    const ins = await ctx.db.from("finance_assumption").insert(result.assumptions.map((a) => ({
      ...owned(ctx, cls), scenario_id: sc.id, key: a.key, label: a.label, value: a.value, value_hash: a.valueHash, source: a.source,
    })));
    if (ins.error) throw dbError(ins.error, "finance_assumption");
  }
  return sc;
}

/**
 * Recalculate a scenario with changed inputs as a NEW version (versions are immutable; the previous one is kept).
 * Assumption approvals carry over only where the value is unchanged; a changed assumption needs a fresh approval.
 */
export async function recalculateScenario(ctx: DealsCtx, previousId: string, input: FinanceInput) {
  const prev = must(await ctx.db.from("finance_scenario").select("id, version, requirement_id, option_id, classification").eq("workspace_id", ctx.workspaceId).eq("id", previousId).maybeSingle(), "scenario") as
    { id: string; version: number; requirement_id: string | null; option_id: string | null; classification: string };
  const result = runEngine(input);
  const quoteIssues = await checkQuoteRefs(ctx, input);
  const { data: last } = await ctx.db.from("finance_scenario").select("version").eq("workspace_id", ctx.workspaceId).eq("previous_id", previousId).order("version", { ascending: false }).limit(1).maybeSingle();
  if (last) throw new DealsError(409, `a newer version (v${(last as { version: number }).version}) already exists: recalculate from the latest version`);
  const sc = await insertScenario(ctx, prev.classification, input, result, quoteIssues, { requirementId: prev.requirement_id, optionId: prev.option_id, version: (prev.version ?? 1) + 1, previousId });
  const carried = await ctx.db.rpc("deals_carry_assumption_approvals", { p_new: sc.id, p_prev: previousId });
  if (carried.error) throw dbError(carried.error, "assumptions");
  return { scenarioId: sc.id, version: (prev.version ?? 1) + 1, carriedApprovals: Number(carried.data ?? 0), result, quoteIssues };
}

export interface AssumptionRow { id: string; key: string; label: string; value: unknown; value_hash: string; source: string; approval_state: string; approved_by: string | null; approved_at: string | null; approval_note: string | null }

export async function listAssumptions(ctx: DealsCtx, scenarioId: string): Promise<AssumptionRow[]> {
  const r = await ctx.db.from("finance_assumption").select("id, key, label, value, value_hash, source, approval_state, approved_by, approved_at, approval_note")
    .eq("workspace_id", ctx.workspaceId).eq("scenario_id", scenarioId).order("key");
  if (r.error) throw dbError(r.error, "assumptions");
  return (r.data ?? []) as AssumptionRow[];
}

/** Approve assumptions (admin; enforced in SQL). Only rows whose stored value matches the engine's current derivation are approvable. */
export async function approveAssumptions(ctx: DealsCtx, scenarioId: string, keys: string[], note?: string | null) {
  if (!keys.length) throw new DealsError(400, "choose at least one assumption");
  const sc = must(await ctx.db.from("finance_scenario").select("input_json").eq("workspace_id", ctx.workspaceId).eq("id", scenarioId).maybeSingle(), "scenario") as { input_json: FinanceInput };
  const current = new Map(runEngine(sc.input_json).assumptions.map((a) => [a.key, a.valueHash]));
  const rows = await listAssumptions(ctx, scenarioId);
  const mismatch = rows.filter((r) => keys.includes(r.key) && current.get(r.key) !== r.value_hash).map((r) => r.label);
  if (mismatch.length) throw new DealsError(409, "stored assumptions no longer match the inputs: recalculate first", { reasons: mismatch });
  const r = await ctx.db.rpc("deals_approve_assumptions", { p_scenario: scenarioId, p_keys: keys, p_note: note ?? null });
  if (r.error) throw dbError(r.error, "assumptions");
  return { approved: Number(r.data ?? 0) };
}

export async function revokeAssumption(ctx: DealsCtx, scenarioId: string, key: string, note?: string | null) {
  const r = await ctx.db.rpc("deals_revoke_assumption", { p_scenario: scenarioId, p_key: key, p_note: note ?? null });
  if (r.error) throw dbError(r.error, "assumptions");
  return { revoked: Number(r.data ?? 0) };
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

/**
 * Approve a stored scenario: recomputes the engine and refuses if the stored hash no longer reproduces, if quotes are
 * stale, if any assumption is unapproved, or if any cost is unknown — unless the gaps are explicitly acknowledged, in
 * which case the acknowledgement (who, when, which gaps, note) is recorded with the scenario and the approval.
 */
export async function approveScenario(ctx: DealsCtx, id: string, opts: { acknowledgeGaps?: boolean; note?: string | null } = {}) {
  const sc = must(await ctx.db.from("finance_scenario").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle(), "scenario") as { input_json: FinanceInput; output_hash: string; classification: string };
  const re = runEngine(sc.input_json);
  if (re.outputHash !== sc.output_hash) throw new DealsError(409, "stored result does not reproduce with the current engine: re-run the scenario");
  const issues = await checkQuoteRefs(ctx, sc.input_json);
  if (issues.length) throw new DealsError(422, "quote provenance problems", { issues });
  const assumptions = await listAssumptions(ctx, id);
  const derived = re.assumptions;
  const stored = new Map(assumptions.map((a) => [a.key, a]));
  const pending = derived.filter((a) => stored.get(a.key)?.approval_state !== "approved" || stored.get(a.key)?.value_hash !== a.valueHash).map((a) => a.label);
  if (pending.length) throw new DealsError(422, "every assumption must be approved first", { reasons: pending.map((p) => `unapproved assumption: ${p}`) });
  let ack: Record<string, unknown> | null = null;
  if (re.gaps.length) {
    if (!opts.acknowledgeGaps) throw new DealsError(422, "unknown cost inputs: fill them in, mark them none, or acknowledge the gaps explicitly", { reasons: re.gaps.map((g) => `${g.label}: ${g.reason}`) });
    ack = { by: ctx.userId, at: new Date().toISOString(), gaps: re.gaps, note: opts.note ?? null };
  }
  const r = await ctx.db.from("finance_scenario").update({ approved_at: new Date().toISOString(), ...(ack ? { gaps_acknowledged: ack } : {}) }).eq("id", id).select("*").single();
  if (r.error) throw dbError(r.error, "scenario");
  const note = [ack ? `Approved with acknowledged unknown costs: ${re.gaps.map((g) => g.label).join(", ")}` : null, opts.note ?? null].filter(Boolean).join(" · ") || null;
  await ctx.db.from("approval").insert({ ...owned(ctx, sc.classification), subject_type: "finance_scenario", subject_id: id, approver_user_id: ctx.userId, approved_hash: sc.output_hash, decision: "approved", note });
  return r.data;
}

/** Build engine input from a quote's typed terms and the space snapshot. Missing values stay missing (S6). Pure. */
export function inputFromQuote(o: {
  name: string; kind?: FinanceInput["kind"]; baseDate: string; horizonMonths: number; annualDiscountRatePct: number | string;
  quote: { id: string; version: number; valid_until?: string | null; terms_json: QuoteTermsInput };
  space: { chargeable_sf?: number | string | null; carpet_sf?: number | string | null; seats?: number | null };
  fitoutCost?: number | string | null; gstRatePct?: number | string | null; afterTenure?: FinanceInput["afterTenure"];
  /** Parking slots needed (from the requirement); 0 = none. Unknown when omitted. */
  parkingSlots?: number | null;
  /** Other monthly operating costs; 0 = none. Unknown when omitted. */
  opexMonthly?: number | string | null;
  reinstatement?: { amount: number | string; period: number } | null;
}): FinanceInput {
  const t = o.quote.terms_json ?? {};
  if (t.rent === undefined || t.rent === null || !t.rent_basis) throw new DealsError(400, "quote has no rent or rent basis");
  const esc = t.escalation_pct != null && t.escalation_every_months ? { pct: t.escalation_pct, everyMonths: t.escalation_every_months } : null;
  const qsrc = `quote ${o.quote.id.slice(0, 8)} v${o.quote.version}`;
  const zero = (x: unknown) => x !== null && x !== undefined && x !== "" && Number(x) === 0;
  const states: Partial<Record<CostItem, CostState>> = { rent: "known" };
  // CAM: included → none; per-SF → known; not stated on the quote → UNKNOWN (never "none")
  states.cam = t.cam_included ? "none" : t.cam_per_sf != null ? "known" : "unknown";
  const parkingKnown = t.parking_per_slot != null && o.parkingSlots != null && o.parkingSlots > 0;
  states.parking = zero(o.parkingSlots) ? "none" : parkingKnown ? "known" : "unknown";
  states.deposit = t.deposit_months == null ? "unknown" : zero(t.deposit_months) ? "none" : "known";
  states.fitout = o.fitoutCost == null || o.fitoutCost === "" ? "unknown" : zero(o.fitoutCost) ? "none" : "known";
  states.opex = o.opexMonthly == null || o.opexMonthly === "" ? "unknown" : zero(o.opexMonthly) ? "none" : "known";
  states.reinstatement = o.reinstatement == null ? "unknown" : zero(o.reinstatement.amount) ? "none" : "known";
  const capexKnown = states.fitout === "known";
  const input: FinanceInput = {
    name: o.name, kind: o.kind ?? "conventional", baseDate: o.baseDate, horizonMonths: o.horizonMonths, annualDiscountRatePct: o.annualDiscountRatePct,
    area: { chargeableSf: o.space.chargeable_sf ?? null, carpetSf: o.space.carpet_sf ?? null, plannedSeats: o.space.seats ?? null },
    tenureMonths: t.tenure_months ?? null, afterTenure: o.afterTenure ?? null,
    rent: { basis: t.rent_basis, rate: t.rent, escalation: esc, rentFreeMonths: t.rent_free_months ?? 0 },
    cam: t.cam_included ? { mode: "none" } : t.cam_per_sf != null ? { mode: "per_sf", ratePerSf: t.cam_per_sf, escalation: esc } : null,
    parking: parkingKnown ? { slots: o.parkingSlots!, ratePerSlot: t.parking_per_slot!, escalation: esc } : null,
    recurring: states.opex === "known" ? [{ label: "Other operating costs", monthly: o.opexMonthly!, category: "opex" }] : [],
    deposit: states.deposit === "known" ? { months: t.deposit_months! } : null,
    capex: capexKnown || t.capex_support || states.reinstatement === "known"
      ? { fitoutCost: capexKnown ? o.fitoutCost! : 0, landlordContribution: t.capex_support ?? 0, reinstatement: states.reinstatement === "known" ? o.reinstatement! : null }
      : null,
    taxes: t.gst === "included" ? { treatment: "included" } : t.gst === "excluded" ? { treatment: "excluded", gstRatePct: o.gstRatePct ?? null } : null,
    quoteRefs: [{ quoteId: o.quote.id, version: o.quote.version, validUntil: o.quote.valid_until ?? null }],
    costStates: states,
    assumptionSources: {
      rent_terms: qsrc, rent_escalation: qsrc, rent_free: qsrc, deposit_terms: qsrc, cam_escalation: qsrc,
      ...(t.gst ? { gst: o.gstRatePct != null ? `${qsrc} (treatment) + user input (rate)` : qsrc } : {}),
      ...(t.cam_included ? { "none:cam": `${qsrc} (CAM included)` } : {}),
      ...(zero(t.deposit_months) ? { "none:deposit": `${qsrc} (no deposit)` } : {}),
      tenure: t.tenure_months != null ? `${qsrc} (tenure) + user input (after tenure)` : "user input",
    },
  };
  return input;
}

export async function listScenarios(ctx: DealsCtx, opts: { requirementId?: string } = {}) {
  let q = ctx.db.from("finance_scenario").select("id, name, requirement_id, engine_version, output_hash, approved_at, created_at, result_json, quote_ids, quote_versions, version, previous_id, gaps, gaps_acknowledged")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(200);
  if (opts.requirementId) q = q.eq("requirement_id", opts.requirementId);
  const r = await q;
  if (r.error) throw dbError(r.error, "scenarios");
  return r.data ?? [];
}

export interface StoredComparison {
  scenarios: { id: string; name: string; version: number; approved: boolean; assumptionsPending: number; requirementId: string | null }[];
  comparison: ReturnType<typeof compareScenarios> | null;
  error: string | null;
  /** Per scenario: sensitivities sorted by |ΔNPV| — which assumptions drive the result. */
  drivers: { id: string; name: string; top: { label: string; npvChange: string }[] }[];
}

/**
 * Compare stored scenario versions on equal terms (first id = baseline). Re-runs the engine from the stored inputs;
 * unequal horizons / base dates / discount rates / currencies are reported as an error, never silently compared.
 */
export async function compareStoredScenarios(ctx: DealsCtx, ids: string[]): Promise<StoredComparison> {
  const uniq = [...new Set(ids)].slice(0, 12);
  if (!uniq.length) return { scenarios: [], comparison: null, error: null, drivers: [] };
  const r = await ctx.db.from("finance_scenario").select("id, name, version, approved_at, input_json, requirement_id").eq("workspace_id", ctx.workspaceId).in("id", uniq);
  if (r.error) throw dbError(r.error, "scenarios");
  const rows = uniq.map((id) => (r.data ?? []).find((x) => x.id === id)).filter(Boolean) as { id: string; name: string; version: number; approved_at: string | null; input_json: FinanceInput; requirement_id: string | null }[];
  const pend = await ctx.db.from("finance_assumption").select("scenario_id").eq("workspace_id", ctx.workspaceId).in("scenario_id", rows.map((x) => x.id)).neq("approval_state", "approved");
  const pendingBy = new Map<string, number>();
  for (const p of pend.data ?? []) pendingBy.set(p.scenario_id as string, (pendingBy.get(p.scenario_id as string) ?? 0) + 1);
  const scenarios = rows.map((x) => ({ id: x.id, name: x.name, version: x.version ?? 1, approved: !!x.approved_at, assumptionsPending: pendingBy.get(x.id) ?? 0, requirementId: x.requirement_id }));
  const inputs = rows.map((x) => ({ ...x.input_json, name: `${x.input_json.name} (v${x.version ?? 1})` }));
  let comparison: StoredComparison["comparison"] = null;
  let error: string | null = null;
  try { comparison = compareScenarios(inputs); } catch (e) {
    if (e instanceof FinanceInputError) error = e.message; else throw e;
  }
  const drivers = rows.map((x, i) => {
    const sens = safe(() => sensitivities(inputs[i])) as ReturnType<typeof sensitivities>;
    const top = [...sens].sort((a, b) => Math.abs(Number(b.npvChange)) - Math.abs(Number(a.npvChange))).slice(0, 3).map((s) => ({ label: s.label, npvChange: s.npvChange }));
    return { id: x.id, name: inputs[i].name, top };
  });
  return { scenarios, comparison, error, drivers };
}
