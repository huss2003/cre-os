/* eslint-disable @typescript-eslint/no-explicit-any -- calculator outputs are rendered generically */
import { z } from "zod";
import { runComparison } from "@/modules/toolkit/comparison";
import { runLeaseEconomics, runOccupancy } from "@/modules/toolkit/lease-service";
import { saveAnalysis, getAnalysis } from "@/modules/toolkit/store";
import { compareRenewalRelocation, RVR_VERSION, type RvrInput } from "@/modules/toolkit/calc/renewal";
import { computeFitout, compareQuotes, FITOUT_CATEGORIES, FITOUT_FORMULA, type FitoutInput, type PartnerQuote } from "@/modules/toolkit/calc/fitout";
import type { LeaseTerms, Extras } from "@/modules/toolkit/calc/lease";
import type { Block, ToolContext, ToolResult } from "../types";
import { HREF, db, defineTool, denied, failed, getOne, isUuid, missingBlock, ws, type Row } from "./shared";

/**
 * Deal Toolkit tools (category B: auto-run + logged). Every number comes from the existing pure calculators in
 * src/modules/toolkit/calc/* and is saved through saveAnalysis() (immutable version) so it is reproducible.
 * The assistant never computes money itself.
 */
const num = z.union([z.number(), z.string()]).nullable().optional();
const n = (d: string) => num.describe(d);

export const leaseTermsSchema = z.object({
  name: z.string().describe("Option name, e.g. 'Tower A 5th floor'"),
  label: z.enum(["quoted", "estimated"]).describe("quoted = from a landlord quote; estimated = adviser assumption"),
  areaSf: z.union([z.number(), z.string()]).describe("Area in SF"),
  areaBasis: z.enum(["chargeable", "carpet"]),
  rentPerSf: z.union([z.number(), z.string()]).describe("Rent ₹/SF/month on areaBasis"),
  leaseCommencement: z.string().describe("YYYY-MM-DD"),
  rentCommencement: z.string().nullable().optional(),
  tenureMonths: z.number().int().min(1).max(600),
  rentFreeMonths: z.number().int().nullable().optional(),
  escalationPct: n("Rent escalation % per step"), escalationEveryMonths: z.number().int().nullable().optional(),
  camPerSf: n("CAM ₹/SF/month; null = unknown; 0 = none"), camEscalationPct: num, camEscalationEveryMonths: z.number().int().nullable().optional(),
  parkingSlots: z.number().int().nullable().optional(), parkingRatePerSlot: num,
  depositMonths: n("Security deposit in months of rent; null = unknown"),
  otherRecurringState: z.enum(["known", "none", "unknown"]).optional(),
  discountRatePct: z.union([z.number(), z.string()]).optional().describe("Annual discount rate % for NPV, e.g. 10. Omit to use the workspace default (or 10%, shown as an assumption)"),
});

export const DEFAULT_DISCOUNT_PCT = 10;
/** Discount rate when the caller gave none: workspace setting (toolkit.discount_rate_pct / discount_rate_pct) else 10%, always labelled as assumed. */
async function withDiscount<T extends { discountRatePct?: number | string | null; name: string }>(t: ToolContext, offers: T[]): Promise<{ offers: (T & { discountRatePct: number | string })[]; assumption: string | null }> {
  if (offers.every((o) => o.discountRatePct !== undefined && o.discountRatePct !== null && o.discountRatePct !== "")) return { offers: offers as (T & { discountRatePct: number | string })[], assumption: null };
  const { data } = await db(t).from("workspace_setting").select("key, value").eq("workspace_id", ws(t)).in("key", ["toolkit.discount_rate_pct", "discount_rate_pct"]);
  const v = ((data ?? []) as Row[]).map((r) => Number(typeof r.value === "object" && r.value !== null ? (r.value as Row).value ?? (r.value as Row).pct : r.value)).find((x) => Number.isFinite(x) && x >= 0 && x < 100);
  const rate = v ?? DEFAULT_DISCOUNT_PCT;
  const missing = offers.filter((o) => o.discountRatePct === undefined || o.discountRatePct === null || o.discountRatePct === "").map((o) => o.name);
  return {
    offers: offers.map((o) => ({ ...o, discountRatePct: o.discountRatePct === undefined || o.discountRatePct === null || o.discountRatePct === "" ? rate : o.discountRatePct })),
    assumption: `Discount rate ${rate}% assumed (${v !== undefined ? "workspace default" : "standard default — not set for this workspace"}) for ${missing.join(", ")}; NPV changes if you use a different rate.`,
  };
}
const extrasSchema = z.object({ advanceRentMonths: num, fitoutCost: num, movingCost: num, initialCharges: num }).partial();

async function loadSaved(t: ToolContext, id: string) {
  const a = await getAnalysis(db(t), ws(t), id);
  return a as Row | null;
}
function savedRef(kind: string, id: string, title: string) {
  return { type: "analysis" as const, id, label: title, href: HREF.analysis(kind, id) };
}
async function checkRequirement(t: ToolContext, tool: string, requirementId?: string | null): Promise<ToolResult | null> {
  if (!requirementId) return null;
  if (!isUuid(requirementId) || !(await getOne(t, "requirement", requirementId, "id"))) return denied(t, tool, { entity: "requirement", id: requirementId });
  return null;
}
const assumptionsBlock = (items: string[]): Block[] => (items.length ? [{ kind: "brief", title: "Assumptions", sections: [{ heading: "Inputs and labels", bullets: items }] }] : []);

// ---------------------------------------------------------------------------------------------------- compare properties
const compareProperties = defineTool({
  id: "compare_properties", module: "toolkit", category: "B",
  description: "Rate and rank buildings for a requirement with the toolkit's property comparison model (rating-1.0): mandatory/disqualify rules first, then weighted factors, occupancy cost over the term. Saves the analysis. Pass building ids (from search_properties) and optionally the requirement. For 'which is financially better / cheaper' use data.byOccupancyCost (lowest occupancy cost first) or calculate_lease_economics — the weighted rating is not a cost ranking; state it separately.",
  input: z.object({
    title: z.string().max(200).optional(), requirementId: z.string().optional(),
    assetIds: z.array(z.string()).min(1).max(10).describe("Building (asset) ids to compare"),
    termMonths: z.number().int().min(1).max(240).optional().describe("Occupancy term for cost comparison (default model term)"),
  }),
  async run(i, t) {
    const bad = await checkRequirement(t, "compare_properties", i.requirementId); if (bad) return bad;
    for (const a of i.assetIds) if (!isUuid(a) || !(await getOne(t, "asset", a, "id"))) return denied(t, "compare_properties", { entity: "asset", id: a });
    try {
      const saved = await runComparison(db(t), ws(t), t.ctx.userId, { title: i.title ?? "Property comparison (assistant)", requirementId: i.requirementId ?? null, assetIds: i.assetIds, manual: [], termMonths: i.termMonths ?? null, note: `assistant run ${t.runId}` });
      const a = (await loadSaved(t, saved.id))!; const out = a.outputs as Row;
      const props = (out.properties as Row[]).slice().sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
      const rec = out.recommendation as Row;
      // "Financially better" = lowest occupancy cost (Module 8 output), kept separate from the weighted rating.
      const byOccupancyCost = props.filter((p) => p.occupancyCost != null && Number.isFinite(Number(p.occupancyCost)))
        .slice().sort((x, y) => Number(x.occupancyCost) - Number(y.occupancyCost)).map((p) => ({ name: p.name, occupancyCost: p.occupancyCost, rating: p.rank }));
      const costUnknown = props.filter((p) => p.occupancyCost == null).map((p) => p.name);
      return {
        ok: true, summary: `Compared ${props.length} properties${rec.key ? `; recommended ${props.find((p) => p.key === rec.key)?.name}` : ""}`,
        entities: [savedRef("property_comparison", saved.id, a.title)], missing: a.missing ?? [],
        data: { analysisId: saved.id, version: saved.version, formula: a.formula_version, termMonths: out.termMonths, termAssumed: out.termAssumed, recommendation: rec, properties: props.map((p) => ({ name: p.name, rank: p.rank, score: p.score, eligibility: p.eligibility, occupancyCost: p.occupancyCost, missing: p.missing, disadvantages: p.disadvantages })), byOccupancyCost, costUnknown, href: HREF.analysis("property_comparison", saved.id) },
        blocks: [
          { kind: "table", title: "Property comparison (rating-1.0)", columns: ["Rank", "Property", "Score", "Eligibility", "Occupancy cost (term)", "Evidence"], rows: props.map((p) => [p.rank, p.name, p.score, p.eligibility, p.occupancyCost, p.evidence ?? "unknown"]), note: rec.explanation },
          ...(byOccupancyCost.length ? [{ kind: "table" as const, title: "Financial ranking — lowest occupancy cost first", columns: ["#", "Property", "Occupancy cost (term)", "Weighted rating rank"], rows: byOccupancyCost.map((p, k) => [k + 1, p.name, p.occupancyCost, p.rating]), note: `Use this for "which is financially better". The weighted rating above also scores fit, location and specs.${costUnknown.length ? ` Cost unknown: ${costUnknown.join(", ")}.` : ""}` }] : []),
          ...assumptionsBlock([`Term ${out.termMonths} months${out.termAssumed ? " (assumed default)" : ""}`, `Model ${out.model?.name} v${out.model?.version ?? "?"}`, "Rent/area from latest quotes or availability; unknown values are not scored as zero"]),
          ...missingBlock(a.missing ?? []),
          { kind: "download", label: "Open analysis", href: HREF.analysis("property_comparison", saved.id) },
        ],
        sources: [{ label: `Analysis v${saved.version} (${a.formula_version})`, href: HREF.analysis("property_comparison", saved.id), observedAt: new Date().toISOString().slice(0, 10), status: "verified" }],
      };
    } catch (e) { return failed("Property comparison failed", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- lease economics
function leaseRows(r: Row): (string | number | null)[] {
  return [r.name, r.label, r.monthly?.baseRent ?? null, r.totals?.rent ?? null, r.totals?.contractualExpenditure ?? null, r.totals?.npv ?? null, r.deposit?.amount ?? null, r.complete ? "complete" : "INCOMPLETE"];
}
const calculateLeaseEconomics = defineTool({
  id: "calculate_lease_economics", module: "toolkit", category: "B",
  description: "Lease economics (lease-1.0 on the fin-1.0 engine) for one offer, or an equal-horizon comparison of several offers sharing a commencement date: monthly/annual rent, rent steps, total rent, contractual expenditure, NPV, deposit, rent-free benefit. Unknown inputs stay unknown and are listed. Saves the analysis.",
  input: z.object({ title: z.string().max(200).optional(), requirementId: z.string().optional(), offers: z.array(leaseTermsSchema).min(1).max(6) }),
  async run(i, t) {
    const bad = await checkRequirement(t, "calculate_lease_economics", i.requirementId); if (bad) return bad;
    try {
      const disc = await withDiscount(t, i.offers); i = { ...i, offers: disc.offers };
      const saved = await runLeaseEconomics({ db: db(t), ws: ws(t), userId: t.ctx.userId }, { title: i.title ?? "Lease economics (assistant)", requirementId: i.requirementId ?? null, offers: i.offers as unknown as LeaseTerms[], note: `assistant run ${t.runId}` });
      const a = (await loadSaved(t, saved.id))!; const out = a.outputs as Row;
      const results = (out.mode === "compare" ? out.comparison.offers : [out.result]) as Row[];
      const ranks = out.mode === "compare" ? (out.comparison.rows as Row[]) : [];
      return {
        ok: true, summary: `Lease economics for ${results.length} offer(s)`, entities: [savedRef("lease_economics", saved.id, a.title)], missing: a.missing ?? [],
        data: { analysisId: saved.id, version: saved.version, formula: a.formula_version, offers: results.map((r) => ({ name: r.name, label: r.label, monthlyRent: r.monthly?.baseRent, totals: r.totals, deposit: r.deposit?.amount ?? null, rentFreeBenefit: r.rentFreeBenefit, complete: r.complete, gaps: r.gaps, warnings: r.warnings })), ranking: ranks, href: HREF.analysis("lease_economics", saved.id) },
        blocks: [
          { kind: "table", title: "Lease economics (₹)", columns: ["Option", "Label", "Month-1 rent", "Total rent", "Contractual spend", "NPV", "Deposit", "Totals"], rows: results.map(leaseRows), note: results.map((r) => r.totalsLabel).filter(Boolean).join(" · ") },
          ...(ranks.length ? [{ kind: "table" as const, title: "Ranking (equal horizon, NPV)", columns: ["Rank", "Option", "NPV", "Nominal TCO", "Δ NPV vs first"], rows: ranks.map((r) => [r.rank, r.name, r.npv, r.nominalTco, r.incrementalNpvVsBaseline]) }] : []),
          ...assumptionsBlock([...i.offers.map((o) => `${o.name}: ${o.label}, ${o.areaSf} SF ${o.areaBasis} @ ₹${o.rentPerSf}/SF/mo, ${o.tenureMonths} months from ${o.leaseCommencement}, discount ${o.discountRatePct}%`), ...(disc.assumption ? [disc.assumption] : [])]),
          ...missingBlock(a.missing ?? []),
        ],
        sources: [{ label: `Analysis v${saved.version} (${a.formula_version})`, href: HREF.analysis("lease_economics", saved.id), status: "verified" }],
      };
    } catch (e) { return failed("Lease economics failed", e); }
  },
});

const calculateOccupancyCost = defineTool({
  id: "calculate_occupancy_cost", module: "toolkit", category: "B",
  description: "Occupancy economics (occ-1.0): effective rent per SF, PV-equivalent rent, cash funding needed up front (deposit, advance rent, fit-out, moving), present value, peak cash requirement, with standard sensitivities. Saves the analysis.",
  input: z.object({ title: z.string().max(200).optional(), requirementId: z.string().optional(), terms: leaseTermsSchema, extras: extrasSchema.optional() }),
  async run(i, t) {
    const bad = await checkRequirement(t, "calculate_occupancy_cost", i.requirementId); if (bad) return bad;
    try {
      const disc = await withDiscount(t, [i.terms]); i = { ...i, terms: disc.offers[0] };
      const saved = await runOccupancy({ db: db(t), ws: ws(t), userId: t.ctx.userId }, { title: i.title ?? "Occupancy cost (assistant)", requirementId: i.requirementId ?? null, terms: i.terms as unknown as LeaseTerms, extras: (i.extras ?? {}) as Extras });
      const a = (await loadSaved(t, saved.id))!; const r = (a.outputs as Row).result as Row;
      return {
        ok: true, summary: `Occupancy cost for ${r.name}: effective ₹${r.effectiveRentPerSf}/SF/mo`, entities: [savedRef("occupancy", saved.id, a.title)], missing: a.missing ?? [],
        data: { analysisId: saved.id, version: saved.version, formula: a.formula_version, nominalRentPerSf: r.nominalRentPerSf, effectiveRentPerSf: r.effectiveRentPerSf, pvEffectiveRentPerSf: r.pvEffectiveRentPerSf, cashFunding: r.cashFunding, cashFundingTotal: r.cashFundingTotal, presentValue: r.presentValue, nominalTotal: r.nominalTotal, equivalentMonthly: r.equivalentMonthly, peakCashRequirement: r.peakCashRequirement, complete: r.complete, gaps: r.gaps, href: HREF.analysis("occupancy", saved.id) },
        blocks: [
          { kind: "table", title: `Occupancy cost — ${r.name} (₹)`, columns: ["Measure", "Value"], rows: [["Nominal rent ₹/SF/mo", r.nominalRentPerSf], ["Effective rent ₹/SF/mo", r.effectiveRentPerSf], ["PV-equivalent rent ₹/SF/mo", r.pvEffectiveRentPerSf], ["Up-front cash", `${r.cashFundingTotal}${r.cashFundingComplete ? "" : " (incomplete)"}`], ["Present value", r.presentValue], ["Nominal total", r.nominalTotal], ["Equivalent monthly", r.equivalentMonthly], ["Peak cash requirement", r.peakCashRequirement]], note: r.totalsLabel },
          { kind: "table", title: "Up-front cash", columns: ["Item", "Amount"], rows: (r.cashFunding as Row[]).map((c) => [c.label, c.amount]) },
          ...assumptionsBlock([`${i.terms.label} terms`, `Discount ${i.terms.discountRatePct}%`, ...(disc.assumption ? [disc.assumption] : []), ...(r.warnings ?? [])]), ...missingBlock(a.missing ?? []),
        ],
        sources: [{ label: `Analysis v${saved.version} (${a.formula_version})`, href: HREF.analysis("occupancy", saved.id), status: "verified" }],
      };
    } catch (e) { return failed("Occupancy calculation failed", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- renewal vs relocation
const opt = z.number().nullable().optional();
const esc = z.object({ pct: opt, everyMonths: opt }).nullable().optional();
const rvrSchema = z.object({
  title: z.string().max(200).optional(), requirementId: z.string().optional(),
  comparisonMonths: opt.describe("Months to compare over (e.g. 60)"), discountRatePct: z.number().describe("Annual discount rate %"),
  renewal: z.object({ currentRentMonthly: opt, proposedRentMonthly: opt, escalation: esc, extensionMonths: opt, rentFreeMonths: opt, camMonthly: opt, depositChange: opt, refurbishment: opt, maintenanceMonthly: opt, otherMonthly: opt, otherOneOff: opt }).describe("Renewal side, ₹ amounts per month / one-off; null = unknown"),
  relocation: z.object({ newRentMonthly: opt, escalation: esc, rentFreeMonths: opt, camMonthly: opt, deposit: opt, oldDepositReturned: opt, fitout: opt, moving: opt, restorationOld: opt, overlapMonths: opt, brokerage: opt, itRelocation: opt, downtimeCost: opt, employeeTransition: opt, otherMonthly: opt, otherOneOff: opt }).describe("Relocation side, ₹; null = unknown"),
});
const compareRenewalVsRelocation = defineTool({
  id: "compare_renewal_vs_relocation", module: "toolkit", category: "B",
  description: "Renewal vs relocation (rvr-1.0): total and PV cost of each side over the comparison period, difference, break-even month, initial cash, risks and negotiation points. Unknown inputs are listed, never assumed zero. Saves the analysis.",
  input: rvrSchema,
  async run(i, t) {
    const bad = await checkRequirement(t, "compare_renewal_vs_relocation", i.requirementId); if (bad) return bad;
    try {
      const inputs: RvrInput = { renewal: i.renewal as RvrInput["renewal"], relocation: i.relocation as RvrInput["relocation"], comparisonMonths: i.comparisonMonths, discountRatePct: i.discountRatePct };
      const out = compareRenewalRelocation(inputs);
      const saved = await saveAnalysis(db(t), ws(t), t.ctx.userId, { kind: "renewal_vs_relocation", title: i.title ?? "Renewal vs relocation (assistant)", requirementId: i.requirementId ?? null, inputs, outputs: out, formulaVersion: RVR_VERSION, missing: out.missing, note: `assistant run ${t.runId}` });
      const side = (s: Row | null) => (s ? [s.total, s.pv, s.initialCashInclDeposit, s.annualAverage, s.complete ? "complete" : "INCOMPLETE"] : [null, null, null, null, "not computed"]);
      return {
        ok: out.ok, summary: out.verdict, entities: [savedRef("renewal_vs_relocation", saved.id, i.title ?? "Renewal vs relocation")], missing: out.missing,
        data: { analysisId: saved.id, version: saved.version, formula: out.formula, renewal: out.renewal && { total: out.renewal.total, pv: out.renewal.pv, initialCash: out.renewal.initialCashInclDeposit }, relocation: out.relocation && { total: out.relocation.total, pv: out.relocation.pv, initialCash: out.relocation.initialCashInclDeposit }, difference: out.difference, breakEven: out.breakEven, financiallyPreferable: out.financiallyPreferable, verdict: out.verdict, risks: out.risks, negotiation: out.negotiation, href: HREF.analysis("renewal_vs_relocation", saved.id) },
        blocks: [
          { kind: "table", title: `Renewal vs relocation over ${out.comparisonMonths ?? "?"} months (₹)`, columns: ["Option", "Total", "PV", "Initial cash incl. deposit", "Annual average", "Status"], rows: [["Renewal", ...side(out.renewal)], ["Relocation", ...side(out.relocation)]], note: `${out.verdict}${out.breakEven ? ` · ${out.breakEven.text}` : ""}` },
          ...assumptionsBlock(out.assumptions), ...(out.risks.length ? [{ kind: "brief" as const, title: "Risks and negotiation points", sections: [{ heading: "Risks", bullets: out.risks }, { heading: "Negotiation", bullets: out.negotiation }] }] : []),
          ...missingBlock(out.missing),
        ],
        sources: [{ label: `Analysis v${saved.version} (${RVR_VERSION})`, href: HREF.analysis("renewal_vs_relocation", saved.id), status: "verified" }],
      };
    } catch (e) { return failed("Renewal vs relocation failed", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- fit-out / quotes
const cat = z.enum(FITOUT_CATEGORIES as unknown as [string, ...string[]]);
const quoteSchema = z.object({
  partnerName: z.string(), scope: z.array(cat).optional(), exclusions: z.array(z.string()).optional(),
  price: num.describe("Price excluding tax, ₹"), taxPct: num, deliveryWeeks: num, warrantyMonths: num,
  validUntil: z.string().nullable().optional(), status: z.enum(["quoted", "approved"]).optional(),
});
const lineSchema = z.object({ category: cat, description: z.string().optional(), quantity: num, unit: z.string().optional(), unitPrice: num, vendor: z.string().optional(), taxPct: num, estimated: num, approved: num, actual: num });
const criteriaSchema = z.object({ price: z.number(), scope: z.number(), timeline: z.number(), warranty: z.number() }).optional().describe("Criterion weights (default price 40, scope 30, timeline 15, warranty 15)");

function quoteBlocks(q: Row): Block[] {
  return [{ kind: "table", title: `Quote comparison (${q.formula})`, columns: ["Rank", "Partner", "Price excl. tax", "Price incl. tax", "Scope coverage", "Scope gaps", "Total score", "Flags"], rows: (q.rows as Row[]).slice().sort((a, b) => a.rank - b.rank).map((r) => [r.rank, r.partnerName, r.priceExTax, r.priceInclTax, r.coverage, (r.scopeGaps ?? []).join(", ") || null, r.scores.total, (r.flags ?? []).join("; ") || null]), note: q.method }];
}

async function saveFitout(t: ToolContext, title: string, inputs: Row, budget: Row, quotes: Row, asOf: string) {
  return saveAnalysis(db(t), ws(t), t.ctx.userId, {
    kind: "fitout", title, inputs, outputs: { budget, quotes, asOf }, formulaVersion: FITOUT_FORMULA,
    quoteRefs: ((inputs.quotes ?? []) as Row[]).map((q) => ({ partner: q.partnerName, partnerId: null, validUntil: q.validUntil ?? null })),
    missing: [...(budget.missing ?? [])], note: `assistant run ${t.runId}`,
  });
}

const compareQuotesTool = defineTool({
  id: "compare_quotes", module: "toolkit", category: "B",
  description: "Compare fit-out / partner quotations (fitout-1.0 quote ranking): price incl. tax, required-scope coverage, delivery time, warranty, expiry — transparent weighted scores; unknown values score 0 for that criterion and are flagged. Saves as a fit-out analysis. For landlord lease offers use calculate_lease_economics instead.",
  input: z.object({ title: z.string().max(200).optional(), quotes: z.array(quoteSchema).min(1).max(10), requiredScope: z.array(cat).min(1), criteria: criteriaSchema }),
  async run(i, t) {
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const quotes = compareQuotes({ quotes: i.quotes as PartnerQuote[], requiredScope: i.requiredScope as never, asOf, criteria: i.criteria });
      const budget = computeFitout({ lines: [] });
      const title = i.title ?? "Quote comparison (assistant)";
      const saved = await saveFitout(t, title, { lines: [], quotes: i.quotes, requiredScope: i.requiredScope, criteria: i.criteria }, budget as unknown as Row, quotes as unknown as Row, asOf);
      const top = quotes.rows.find((r) => r.rank === 1);
      return {
        ok: true, summary: `Compared ${quotes.rows.length} quotes${top ? `; top ranked ${top.partnerName}` : ""}`, entities: [savedRef("fitout", saved.id, title)], missing: quotes.missing,
        data: { analysisId: saved.id, version: saved.version, formula: quotes.formula, criteria: quotes.criteria, rows: quotes.rows.map((r) => ({ partner: r.partnerName, rank: r.rank, priceInclTax: r.priceInclTax, coverage: r.coverage, scopeGaps: r.scopeGaps, total: r.scores.total, flags: r.flags, expired: r.expired })), href: HREF.analysis("fitout", saved.id) },
        blocks: [...quoteBlocks(quotes as unknown as Row), ...assumptionsBlock([`Weights: price ${quotes.criteria.price}, scope ${quotes.criteria.scope}, timeline ${quotes.criteria.timeline}, warranty ${quotes.criteria.warranty}`, `Expiry checked as of ${asOf}`]), ...missingBlock(quotes.missing)],
        sources: [{ label: `Analysis v${saved.version} (${FITOUT_FORMULA})`, href: HREF.analysis("fitout", saved.id), status: "verified" }],
      };
    } catch (e) { return failed("Quote comparison failed", e); }
  },
});

const analyseFitout = defineTool({
  id: "analyse_fitout", module: "toolkit", category: "B",
  description: "Fit-out budget (fitout-1.0): totals by category and stage (estimated/approved/actual) with tax, variance, cost per SF and per seat; optionally ranks partner quotes too. Unknown lines are counted and listed. Saves the analysis.",
  input: z.object({ title: z.string().max(200).optional(), lines: z.array(lineSchema).min(1).max(100), areaSf: num, seats: num, quotes: z.array(quoteSchema).max(10).optional(), requiredScope: z.array(cat).optional(), criteria: criteriaSchema }),
  async run(i, t) {
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const budget = computeFitout({ lines: i.lines, areaSf: i.areaSf, seats: i.seats } as FitoutInput);
      const qs = (i.quotes ?? []) as PartnerQuote[];
      const quotes = compareQuotes({ quotes: qs, requiredScope: (i.requiredScope?.length ? i.requiredScope : [...new Set(i.lines.map((l) => l.category))]) as never, asOf, criteria: i.criteria });
      const title = i.title ?? "Fit-out budget (assistant)";
      const saved = await saveFitout(t, title, { lines: i.lines, areaSf: i.areaSf ?? "", seats: i.seats ?? "", quotes: qs, requiredScope: i.requiredScope ?? [], criteria: i.criteria }, budget as unknown as Row, quotes as unknown as Row, asOf);
      const tot = budget.totals;
      return {
        ok: true, summary: `Fit-out estimated gross ₹${tot.estimated.gross}`, entities: [savedRef("fitout", saved.id, title)], missing: budget.missing,
        data: { analysisId: saved.id, version: saved.version, formula: budget.formula, totals: tot, perSf: budget.perSf, perSeat: budget.perSeat, variance: budget.variance, byCategory: budget.byCategory.map((c) => ({ category: c.label, estimatedGross: c.estimated.gross, approvedGross: c.approved.gross, actualGross: c.actual.gross })), href: HREF.analysis("fitout", saved.id) },
        blocks: [
          { kind: "table", title: "Fit-out budget (₹, gross incl. tax)", columns: ["Category", "Estimated", "Approved", "Actual"], rows: [...budget.byCategory.map((c) => [c.label, c.estimated.gross, c.approved.gross, c.actual.gross] as (string | null)[]), ["Total", tot.estimated.gross, tot.approved.gross, tot.actual.gross]], note: `Per SF (estimated): ${budget.perSf.estimated ?? "unknown"} · per seat: ${budget.perSeat.estimated ?? "unknown"}` },
          ...(qs.length ? quoteBlocks(quotes as unknown as Row) : []),
          ...assumptionsBlock([`${tot.estimated.unknownLines} line(s) with unknown estimate`, `${tot.estimated.unknownTaxLines} line(s) with unknown tax`]), ...missingBlock(budget.missing),
        ],
        sources: [{ label: `Analysis v${saved.version} (${FITOUT_FORMULA})`, href: HREF.analysis("fitout", saved.id), status: "verified" }],
      };
    } catch (e) { return failed("Fit-out analysis failed", e); }
  },
});

export const toolkitTools = [compareProperties, calculateLeaseEconomics, compareRenewalVsRelocation, calculateOccupancyCost, compareQuotesTool, analyseFitout];
