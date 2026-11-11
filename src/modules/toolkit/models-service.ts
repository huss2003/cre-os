/**
 * §8.11 specialist models — service layer shared by the /toolkit/bts + /toolkit/investment pages and the assistant.
 * Runs the pure calculators and saves through saveAnalysis (immutable versions, formula bts-1.0 / inv-1.0).
 */
import type { Db } from "@/lib/supabase/server";
import { AREA_BASES, BTS_FORMULA, computeBts, type AreaBasis, type BtsInput } from "./calc/bts";
import { computeInvestment, INV_FORMULA, type InvestmentInput, type Tenancy } from "./calc/investment";
import { saveAnalysis } from "./store";

export interface RunOpts { id?: string | null; title: string; requirementId?: string | null; note?: string | null }

export async function runBts(db: Db, ws: string, userId: string, o: RunOpts, inputs: BtsInput) {
  const out = computeBts(inputs);
  const saved = await saveAnalysis(db, ws, userId, { id: o.id ?? null, kind: "bts", title: o.title, requirementId: o.requirementId ?? null, inputs, outputs: out, formulaVersion: BTS_FORMULA, missing: out.missing, note: o.note ?? null });
  return { ...saved, outputs: out };
}
export async function runInvestment(db: Db, ws: string, userId: string, o: RunOpts, inputs: InvestmentInput) {
  const out = computeInvestment(inputs);
  const saved = await saveAnalysis(db, ws, userId, { id: o.id ?? null, kind: "investment", title: o.title, requirementId: o.requirementId ?? null, inputs, outputs: out, formulaVersion: INV_FORMULA, missing: out.missing, note: o.note ?? null });
  return { ...saved, outputs: out };
}

// ───────────── form parsing (blank stays blank = unknown) ─────────────
type Get = (k: string) => string | null;
const basis = (x: string | null): AreaBasis | null => ((AREA_BASES as readonly string[]).includes(x ?? "") ? (x as AreaBasis) : null);
export const MAX_DRAW_MONTHS = 60;

export function btsFromForm(g: Get): BtsInput {
  const landMode = g("landMode");
  const draws = (g("drawSchedule") ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  if (draws.length > MAX_DRAW_MONTHS) throw new Error(`Draw schedule can have at most ${MAX_DRAW_MONTHS} entries`);
  const altRent = g("alt_rentPerSfMonth");
  return {
    land: { mode: landMode === "purchase" || landMode === "lease" ? landMode : null, cost: g("landCost"), leaseRentMonthly: g("landLeaseRentMonthly") },
    areaSf: g("areaSf"), areaBasis: basis(g("areaBasis")), constructionCostPerSf: g("constructionCostPerSf"), softCostPct: g("softCostPct"),
    constructionMonths: g("constructionMonths"), drawSchedulePct: draws.length ? draws : null,
    includeConstructionInterest: g("includeConstructionInterest") === "on", constructionInterestPct: g("constructionInterestPct"),
    mode: g("mode") === "rent" ? "rent" : "yield", yieldOnCostPct: g("yieldOnCostPct"), targetRentPerSfMonth: g("targetRentPerSfMonth"),
    leaseTermMonths: g("leaseTermMonths"), escalationPct: g("escalationPct"), escalationEveryMonths: g("escalationEveryMonths"),
    rentFreeMonths: g("rentFreeMonths"), depositMonths: g("depositMonths"), tenantFitout: g("tenantFitout"), discountRatePct: g("discountRatePct"),
    alternative: altRent ? { name: g("alt_name") ?? "Lease alternative", areaSf: g("alt_areaSf"), areaBasis: basis(g("alt_areaBasis")), rentPerSfMonth: altRent, escalationPct: g("alt_escalationPct"), escalationEveryMonths: g("alt_escalationEveryMonths"), rentFreeMonths: g("alt_rentFreeMonths"), depositMonths: g("alt_depositMonths"), fitout: g("alt_fitout") } : null,
  };
}

export const TENANCY_FIELDS = ["name", "areaSf", "rentPerSfMonth", "escalationPct", "escalationEveryMonths", "expiryMonth", "downtimeMonths", "reletRentPerSfMonth", "reletEscalationPct", "camRecoveryPerSfMonth"] as const;
export const MAX_TENANCY_ROWS = 8;
export function investmentFromForm(g: Get): InvestmentInput {
  const tenancies: Tenancy[] = [];
  for (let k = 0; k < MAX_TENANCY_ROWS; k++) {
    const row = Object.fromEntries(TENANCY_FIELDS.map((f) => [f, g(`t${k}_${f}`)])) as Record<(typeof TENANCY_FIELDS)[number], string | null>;
    if (TENANCY_FIELDS.every((f) => !row[f])) continue;
    tenancies.push({ ...row, name: row.name ?? `Tenancy ${tenancies.length + 1}` });
  }
  const hasDebt = g("debt") === "on";
  return {
    purchasePrice: g("purchasePrice"), stampDutyPct: g("stampDutyPct"), otherAcquisitionCosts: g("otherAcquisitionCosts"),
    leasableAreaSf: g("leasableAreaSf"), areaBasis: basis(g("areaBasis")), tenancies,
    opexPerSfMonth: g("opexPerSfMonth"), opexEscalationPct: g("opexEscalationPct"), capexReservePerSfYear: g("capexReservePerSfYear"),
    holdingYears: g("holdingYears"), exitCapRatePct: g("exitCapRatePct"), saleCostsPct: g("saleCostsPct"), discountRatePct: g("discountRatePct"),
    debt: hasDebt ? { ltvPct: g("ltvPct"), ratePct: g("debtRatePct"), tenorYears: g("tenorYears"), amortisation: g("amortisation") === "amortising" ? "amortising" : "interest_only" } : null,
  };
}
