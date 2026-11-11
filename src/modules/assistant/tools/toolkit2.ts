/* eslint-disable @typescript-eslint/no-explicit-any -- calculator outputs are rendered generically */
import { z } from "zod";
import { runBts, runInvestment } from "@/modules/toolkit/models-service";
import { AREA_BASES, type BtsInput } from "@/modules/toolkit/calc/bts";
import type { InvestmentInput } from "@/modules/toolkit/calc/investment";
import { generateDeck } from "@/modules/toolkit/deck";
import type { Block, ToolContext, ToolResult } from "../types";
import { db, defineTool, denied, failed, getOne, isUuid, missingBlock, ref, ws, type Row } from "./shared";

/**
 * Deal Toolkit round 2 (category B: auto-run + logged): Built-to-Suit (bts-1.0), investment analysis (inv-1.0) and
 * presentation decks from any saved analysis. Every number comes from the pure calculators in src/modules/toolkit/calc
 * and is saved through saveAnalysis (immutable version). Unknown inputs stay null → listed as missing (S6).
 */
const num = z.union([z.number(), z.string()]).nullable().optional();
const basis = z.enum(AREA_BASES).nullable().optional();
const href = (kind: string, id: string) => (kind === "bts" ? `/toolkit/bts/${id}` : kind === "investment" ? `/toolkit/investment/${id}` : `/toolkit`);
const pct = (x: string | null | undefined) => (x == null ? null : `${x}%`);
async function checkRequirement(t: ToolContext, tool: string, requirementId?: string | null): Promise<ToolResult | null> {
  if (!requirementId) return null;
  if (!isUuid(requirementId) || !(await getOne(t, "requirement", requirementId, "id"))) return denied(t, tool, { entity: "requirement", id: requirementId });
  return null;
}
const listBlock = (title: string, items: string[]): Block[] => (items.length ? [{ kind: "brief", title, sections: [{ heading: title, bullets: items }] }] : []);

const runBtsModel = defineTool({
  id: "run_bts_model", module: "toolkit", category: "B",
  description: "Built-to-suit model (bts-1.0): total project cost (land + construction + soft costs + optional interest during construction), required rent per SF per month for a developer yield on cost (or implied yield for a target rent), rent schedule, tenant total occupancy cost (nominal + NPV) with deposit kept separate, optional comparison with a lease alternative on the SAME area basis. Pass null for anything unknown — never guess. Saves the analysis.",
  input: z.object({
    title: z.string().max(200).optional(), requirementId: z.string().optional(),
    land: z.object({ mode: z.enum(["purchase", "lease"]).nullable(), cost: num.describe("₹ total if purchased"), leaseRentMonthly: num.describe("₹/month if leased") }),
    areaSf: num, areaBasis: basis.describe("Area basis of the area AND of all per-SF figures"),
    constructionCostPerSf: num, softCostPct: num, constructionMonths: num, drawSchedulePct: z.array(z.union([z.number(), z.string()])).optional().describe("% per construction month, sums to 100"),
    includeConstructionInterest: z.boolean().optional(), constructionInterestPct: num,
    mode: z.enum(["yield", "rent"]), yieldOnCostPct: num, targetRentPerSfMonth: num,
    leaseTermMonths: num, escalationPct: num, escalationEveryMonths: num, rentFreeMonths: num, depositMonths: num, tenantFitout: num, discountRatePct: num,
    alternative: z.object({ name: z.string(), areaSf: num, areaBasis: basis, rentPerSfMonth: num, escalationPct: num, escalationEveryMonths: num, rentFreeMonths: num, depositMonths: num, fitout: num, termMonths: num }).nullable().optional(),
  }),
  async run(i, t) {
    const bad = await checkRequirement(t, "run_bts_model", i.requirementId); if (bad) return bad;
    try {
      const { title, requirementId, ...inputs } = i;
      const nm = title ?? "Built-to-suit (assistant)";
      const s = await runBts(db(t), ws(t), t.ctx.userId, { title: nm, requirementId: requirementId ?? null, note: `assistant run ${t.runId}` }, { ...inputs, areaBasis: inputs.areaBasis ?? null, alternative: inputs.alternative ? { ...inputs.alternative, areaBasis: inputs.alternative.areaBasis ?? null } : null } as BtsInput);
      const r = s.outputs; const h = href("bts", s.id);
      return {
        ok: true, summary: r.rent.requiredRentPerSfMonth ? `BTS: project cost ₹${r.projectCost.total ?? "unknown"}, rent ₹${r.rent.requiredRentPerSfMonth}/SF/month (${r.areaBasis ?? "basis not stated"})` : "BTS saved — key results unknown until missing inputs are given",
        entities: [ref("analysis", s.id, nm, h)], missing: r.missing,
        data: { analysisId: s.id, version: s.version, formula: r.formula, projectCost: r.projectCost, rent: r.rent, tenant: r.tenant, schedule: r.schedule, comparison: r.comparison, nulls: r.nulls, href: h },
        blocks: [
          { kind: "table", title: "Built-to-suit (bts-1.0)", columns: ["Measure", "Value"], rows: [["Land", r.projectCost.land], ["Construction", r.projectCost.hard], ["Soft costs", r.projectCost.soft], ["Interest during construction", r.projectCost.interest], ["Total project cost", r.projectCost.total], ["Required / target rent ₹/SF/month", r.rent.requiredRentPerSfMonth], ["Yield on cost", pct(r.rent.impliedYieldPct)], ["Tenant cost (nominal)", r.tenant.nominal], ["Tenant cost (NPV)", r.tenant.npv], ["Refundable deposit (separate)", r.tenant.deposit]] },
          ...(r.comparison ? [{ kind: "table" as const, title: `BTS vs ${r.comparison.name}`, columns: ["Measure", "BTS", r.comparison.name], rows: [["Nominal", r.tenant.nominal, r.comparison.alternative.nominal], ["NPV", r.tenant.npv, r.comparison.alternative.npv]], note: r.comparison.reason ?? `Cheaper: ${r.comparison.cheaper}` }] : []),
          ...listBlock("Assumptions", r.assumptions), ...missingBlock(r.missing),
          { kind: "download", label: "Open BTS model", href: h },
        ],
        sources: [{ label: `Analysis v${s.version} (${r.formula})`, href: h, status: "verified" }],
      };
    } catch (e) { return failed("BTS model failed", e); }
  },
});

const tenancy = z.object({ name: z.string(), areaSf: num, rentPerSfMonth: num, escalationPct: num, escalationEveryMonths: num, expiryMonth: num.describe("months from acquisition"), downtimeMonths: num, reletRentPerSfMonth: num, reletEscalationPct: num, camRecoveryPerSfMonth: num });
const runInvestmentModel = defineTool({
  id: "run_investment_model", module: "toolkit", category: "B",
  description: "Commercial real-estate investment analysis (inv-1.0): NOI by year from a tenancy schedule (expiry, downtime, re-letting), yield on cost, unlevered and levered cash flows, IRR (deterministic solver; null if none), NPV, equity multiple, DSCR, exit value, sensitivities (exit cap ±50 bps, rent ±10%). Pass null for unknowns — never guess. Saves the analysis.",
  input: z.object({
    title: z.string().max(200).optional(), requirementId: z.string().optional(),
    purchasePrice: num, stampDutyPct: num, otherAcquisitionCosts: num, leasableAreaSf: num, areaBasis: basis,
    tenancies: z.array(tenancy).max(20), opexPerSfMonth: num, opexEscalationPct: num, capexReservePerSfYear: num,
    holdingYears: num, exitCapRatePct: num, saleCostsPct: num, discountRatePct: num,
    debt: z.object({ ltvPct: num, ratePct: num, tenorYears: num, amortisation: z.enum(["interest_only", "amortising"]) }).nullable().optional(),
  }),
  async run(i, t) {
    const bad = await checkRequirement(t, "run_investment_model", i.requirementId); if (bad) return bad;
    try {
      const { title, requirementId, ...inputs } = i;
      const nm = title ?? "Investment analysis (assistant)";
      const s = await runInvestment(db(t), ws(t), t.ctx.userId, { title: nm, requirementId: requirementId ?? null, note: `assistant run ${t.runId}` }, { ...inputs, areaBasis: inputs.areaBasis ?? null, debt: inputs.debt ?? null } as InvestmentInput);
      const r = s.outputs; const h = href("investment", s.id);
      return {
        ok: true, summary: r.ok ? `Investment: unlevered IRR ${pct(r.unlevered.irrPct) ?? "not determined"}, NPV ₹${r.unlevered.npv}${r.levered ? `, levered IRR ${pct(r.levered.irrPct) ?? "not determined"}` : ""}` : "Investment analysis saved — returns unknown until missing inputs are given",
        entities: [ref("analysis", s.id, nm, h)], missing: r.missing,
        data: { analysisId: s.id, version: s.version, formula: r.formula, acquisition: r.acquisition, yieldOnCostPct: r.yieldOnCostPct, unlevered: r.unlevered, levered: r.levered, minDscr: r.minDscr, exit: r.exit, years: r.years, sensitivities: r.sensitivities, nulls: r.nulls, href: h },
        blocks: [
          { kind: "table", title: "Returns (inv-1.0)", columns: ["Measure", "Unlevered", "Levered"], rows: [["IRR", pct(r.unlevered.irrPct), r.levered ? pct(r.levered.irrPct) : "no debt"], ["NPV", r.unlevered.npv, r.levered?.npv ?? null], ["Equity multiple", r.unlevered.equityMultiple, r.levered?.equityMultiple ?? null], ["Yield on cost", pct(r.yieldOnCostPct), null], ["Min DSCR", null, r.minDscr], ["Net exit value", r.exit.net, null]] },
          ...(r.years.length ? [{ kind: "table" as const, title: "NOI and cash flow by year (₹)", columns: ["Year", "NOI", "Unlevered CF", "Levered CF"], rows: r.years.map((y) => [y.year, y.noi, y.unlevered, y.levered]) }] : []),
          ...(r.sensitivities.length ? [{ kind: "table" as const, title: "Sensitivities", columns: ["Case", "Exit value", "Unlevered IRR", "Levered IRR", "NPV"], rows: r.sensitivities.map((x) => [x.label, x.exitValue, pct(x.unleveredIrrPct), pct(x.leveredIrrPct), x.npv]) }] : []),
          ...listBlock("Assumptions", [...r.assumptions, ...Object.values(r.nulls)]), ...missingBlock(r.missing),
          { kind: "download", label: "Open investment analysis", href: h },
        ],
        sources: [{ label: `Analysis v${s.version} (${r.formula})`, href: h, status: "verified" }],
      };
    } catch (e) { return failed("Investment model failed", e); }
  },
});

const generateDeckTool = defineTool({
  id: "generate_deck", module: "toolkit", category: "B", timeoutMs: 90_000,
  description: "Make an editable PowerPoint deck from a SAVED toolkit analysis (comparison, lease economics, occupancy, managed vs conventional, renewal vs relocation, fit-out, financing, negotiation, requirement brief, BTS, investment): recommendation, options table, native charts from the stored numbers, assumptions, missing info, sources, appendix. Stored as a new document version; returns a download link. Never sends anything.",
  input: z.object({ analysisId: z.string(), version: z.number().int().min(1).optional() }),
  async run(i, t) {
    if (!isUuid(i.analysisId)) return denied(t, "generate_deck", { entity: "deal_analysis", id: i.analysisId });
    const a = (await getOne(t, "deal_analysis", i.analysisId, "id, title, kind")) as Row | null;
    if (!a) return denied(t, "generate_deck", { entity: "deal_analysis", id: i.analysisId });
    try {
      const d = await generateDeck(db(t), ws(t), t.ctx.userId, i.analysisId, i.version ?? null);
      const dl = `/toolkit/deck/${i.analysisId}?doc=${d.documentId}`;
      return {
        ok: true, summary: `Deck v${d.versionNo} ready for "${a.title}"`, entities: [ref("document", d.documentId, d.fileName, dl)],
        data: { documentId: d.documentId, versionNo: d.versionNo, fileName: d.fileName, sha256: d.sha256, bytes: d.bytes, href: dl },
        blocks: [{ kind: "download", label: `Download ${d.fileName}`, href: dl }],
        sources: [{ label: `${a.kind} "${a.title}"`, href: href(a.kind, a.id), status: "verified" }],
      };
    } catch (e) { return failed("Deck generation failed", e); }
  },
});

export const toolkit2Tools = [runBtsModel, runInvestmentModel, generateDeckTool];
