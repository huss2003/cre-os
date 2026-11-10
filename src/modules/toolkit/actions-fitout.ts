"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { saveAnalysis } from "./store";
import { computeFitout, compareQuotes, FITOUT_CATEGORIES, FITOUT_FORMULA, type FitoutCategory, type FitoutLine, type PartnerQuote, type QuoteCriteria } from "./calc/fitout";
import { computeLoan, LOAN_FORMULA, type LoanInput } from "./calc/financing";
import type { ActionState } from "@/modules/admin/ui/client";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const str = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" && v.trim() ? v.trim() : null; };
const cats = (xs: unknown): FitoutCategory[] => (Array.isArray(xs) ? xs.filter((x): x is FitoutCategory => (FITOUT_CATEGORIES as readonly string[]).includes(String(x))) : []);

export interface FitoutPayload {
  areaSf?: string; seats?: string; lines: FitoutLine[]; quotes: PartnerQuote[]; requiredScope: FitoutCategory[];
  criteria?: QuoteCriteria; preferredIndex?: number | null; preferredReason?: string | null;
}

/** Inputs arrive as one JSON field from the line-item island; every number is recomputed here by the pure calculator. */
export async function saveFitoutAction(_p: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor");
    const raw = JSON.parse(String(form.get("payload") ?? "{}")) as FitoutPayload;
    const inputs: FitoutPayload = {
      areaSf: raw.areaSf ?? "", seats: raw.seats ?? "",
      lines: (raw.lines ?? []).map((l) => ({ ...l, category: (FITOUT_CATEGORIES as readonly string[]).includes(l.category) ? l.category : "other" })),
      quotes: (raw.quotes ?? []).map((q) => ({ ...q, scope: cats(q.scope), exclusions: (q.exclusions ?? []).map(String).filter(Boolean) })).filter((q) => q.partnerName?.trim()),
      requiredScope: cats(raw.requiredScope), criteria: raw.criteria,
      preferredIndex: raw.preferredIndex ?? null, preferredReason: raw.preferredReason ?? null,
    };
    if (inputs.preferredIndex !== null && !inputs.quotes[inputs.preferredIndex!]) inputs.preferredIndex = null;
    const asOf = new Date().toISOString().slice(0, 10);
    const budget = computeFitout(inputs);
    const quotes = compareQuotes({ quotes: inputs.quotes, requiredScope: inputs.requiredScope.length ? inputs.requiredScope : [...new Set(inputs.lines.map((l) => l.category))], asOf, criteria: inputs.criteria, preferredIndex: inputs.preferredIndex, preferredReason: inputs.preferredReason });
    const r = await saveAnalysis(ctx.db, ctx.workspaceId, ctx.userId, {
      id: str(form, "id"), kind: "fitout", title: str(form, "title") ?? "Fit-out budget",
      inputs, outputs: { budget, quotes, asOf }, formulaVersion: FITOUT_FORMULA,
      quoteRefs: inputs.quotes.map((q) => ({ partner: q.partnerName, partnerId: q.partnerId ?? null, validUntil: q.validUntil ?? null })),
      missing: [...budget.missing], note: str(form, "note"),
    });
    id = r.id;
  } catch (e) { return { error: msg(e) }; }
  revalidatePath("/toolkit/fitout");
  redirect(`/toolkit/fitout/${id}`);
}

export async function saveFinancingAction(_p: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireContext("editor");
    const g = (k: string) => str(form, k);
    const feeType = (g("feeType") ?? "none") as LoanInput["feeType"];
    const inputs: LoanInput = {
      projectCost: g("projectCost"), clientContribution: g("clientContribution"), financedAmount: g("financedAmount"),
      annualRatePct: g("annualRatePct"), tenureMonths: g("tenureMonths"),
      feeType: feeType === "pct" || feeType === "fixed" ? feeType : "none", feeValue: g("feeValue"), feeTaxPct: g("feeTaxPct"),
      moratoriumMonths: g("moratoriumMonths"), moratoriumMode: g("moratoriumMode") === "capitalised" ? "capitalised" : "interest_only",
    };
    const result = computeLoan(inputs);
    const r = await saveAnalysis(ctx.db, ctx.workspaceId, ctx.userId, {
      id: g("id"), kind: "financing", title: g("title") ?? "Fit-out financing",
      inputs: { ...inputs, partner: g("partner"), status: g("status") ?? "estimated" }, outputs: result, formulaVersion: LOAN_FORMULA,
      missing: result.missing, note: g("note"),
    });
    id = r.id;
  } catch (e) { return { error: msg(e) }; }
  revalidatePath("/toolkit/financing");
  redirect(`/toolkit/financing/${id}`);
}
