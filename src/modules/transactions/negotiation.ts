import { analyseNegotiation, diffOffers, type OfferTerms, type OfferVersion, type TermDiff } from "@/modules/toolkit/calc/negotiation";
import { validateTerms } from "@/modules/toolkit/calc/lease";
import { TERM_LABEL, type Terms } from "./model";

/**
 * Module 16 never re-implements commercial maths (USER-RULES 2): every diff, NPV, total and concession value comes from
 * the Module 8 toolkit (nego-1.0 on fin-1.0). This file only maps stored offer terms → toolkit OfferTerms and turns the
 * toolkit output into a transaction-facing comparison with explicit assumptions and missing components.
 */
export interface StoredOffer { id: string; version_no: number; kind: string; offering_party: string; offer_date: string; terms: Terms; property_label?: string | null }

const has = (t: Terms, k: string) => t[k] !== undefined && t[k] !== null && t[k] !== "";
const num = (t: Terms, k: string) => (has(t, k) ? Number(t[k]) : null);
const str = (t: Terms, k: string) => (has(t, k) ? String(t[k]) : null);

/** Map stored terms to toolkit terms. Missing values stay null (never coerced to 0); defaults are listed as assumptions. */
export function toToolkitTerms(o: StoredOffer, assumptions: Terms = {}): { terms: OfferTerms; assumed: string[] } {
  const t = o.terms;
  const assumed: string[] = [];
  const pick = (k: string) => (has(t, k) ? t[k] : has(assumptions, k) ? (assumed.push(`${TERM_LABEL[k] ?? k} = ${assumptions[k]} (assumption, not in offer)`), assumptions[k]) : null);
  const terms: OfferTerms = {
    name: `${o.kind} v${o.version_no}`, label: "quoted",
    areaSf: (pick("areaSf") as string) ?? (null as unknown as string), areaBasis: ((pick("areaBasis") as string) === "carpet" ? "carpet" : "chargeable"),
    rentPerSf: (pick("rentPerSf") as string) ?? (null as unknown as string),
    leaseCommencement: (pick("leaseCommencement") as string) ?? "",
    tenureMonths: Number(pick("tenureMonths") ?? NaN),
    rentFreeMonths: num({ v: pick("rentFreeMonths") }, "v"), escalationPct: str({ v: pick("escalationPct") }, "v"),
    escalationEveryMonths: num({ v: pick("escalationEveryMonths") }, "v"), camPerSf: str({ v: pick("camPerSf") }, "v"),
    parkingSlots: num({ v: pick("parkingSlots") }, "v"), parkingRatePerSlot: str({ v: pick("parkingRatePerSlot") }, "v"),
    depositMonths: str({ v: pick("depositMonths") }, "v"), fitoutContribution: str({ v: pick("fitoutContribution") }, "v"),
    lockInMonths: num(t, "lockInMonths"), noticeMonths: num(t, "noticeMonths"), breakClause: str(t, "breakClause"),
    possessionDate: str(t, "possessionDate"), handover: str(t, "handover"), other: str(t, "other"),
    otherRecurringState: "unknown", gst: null,
    discountRatePct: (pick("discountRatePct") as string) ?? (null as unknown as string),
  };
  if (!has(t, "areaBasis") && has(t, "areaSf")) assumed.push("Area basis not stated in offer — treated as chargeable for the calculation");
  return { terms, assumed };
}

/** Version-by-version term diffs (toolkit diffOffers) — works with incomplete offers. */
export function offerVersionDiffs(offers: StoredOffer[]): { from: number | null; to: number; terms: TermDiff[] }[] {
  const sorted = [...offers].sort((a, b) => a.version_no - b.version_no);
  return sorted.map((o, i) => ({
    from: i ? sorted[i - 1].version_no : null, to: o.version_no,
    terms: diffOffers(i ? toToolkitTerms(sorted[i - 1]).terms : null, toToolkitTerms(o).terms),
  }));
}

export interface PackageComparison {
  offers: { id: string; label: string; npv: string | null; nominalTotal: string | null; depositAmount: string | null; complete: boolean; gaps: string[] }[];
  termDiffs: TermDiff[];
  /** Plain-language trade-offs taken from the term statuses (B relative to A). */
  tradeOffs: { betterInB: string[]; worseInB: string[]; changedInB: string[] };
  financial: { npvChange: string; nominalChange: string; rentChange: string; depositChange: string | null; cheaper: "A" | "B" | "equal" } | null;
  verdict: "A_lower_modelled_cost" | "B_lower_modelled_cost" | "equal_modelled_cost" | "cannot_determine";
  verdictText: string;
  assumptions: string[];
  missing: string[];
  notModelled: string[];
  formulaVersion: string | null;
  warnings: string[];
}

const NOT_MODELLED = ["lockInMonths", "breakClause", "renewalOption", "handover", "noticeMonths", "other"];

/**
 * §5.2 full-package comparison of two offers. Never decides on headline rent: the verdict is the toolkit's equal-horizon
 * NPV (all modelled cash flows) when every required input is known; otherwise "cannot determine" with the missing list.
 */
export function comparePackages(a: StoredOffer, b: StoredOffer, assumptions: Terms = {}): PackageComparison {
  const A = toToolkitTerms(a, assumptions); const B = toToolkitTerms(b, assumptions);
  const termDiffs = diffOffers(A.terms, B.terms);
  const lbl = (d: TermDiff) => `${d.label}: ${d.previous ?? "unknown"} → ${d.current ?? "unknown"}`;
  const tradeOffs = {
    betterInB: termDiffs.filter((d) => d.status === "improved").map(lbl),
    worseInB: termDiffs.filter((d) => d.status === "worse").map(lbl),
    changedInB: termDiffs.filter((d) => d.status === "changed").map(lbl),
  };
  const missingA = validateTerms(A.terms).map((m) => `A: ${m}`); const missingB = validateTerms(B.terms).map((m) => `B: ${m}`);
  const missing = [...missingA, ...missingB];
  for (const [k, side] of [["camPerSf", "CAM"], ["depositMonths", "deposit"], ["rentFreeMonths", "rent-free"], ["parkingSlots", "parking"]] as const) {
    if (!has(a.terms, k) && !has(assumptions, k)) missing.push(`A: ${side} unknown`);
    if (!has(b.terms, k) && !has(assumptions, k)) missing.push(`B: ${side} unknown`);
  }
  const notModelled = NOT_MODELLED.filter((k) => has(a.terms, k) || has(b.terms, k)).map((k) => `${TERM_LABEL[k] ?? k} — flexibility/condition, weigh qualitatively`);
  const assumptionsList = [...new Set([...A.assumed, ...B.assumed])];
  const base: Omit<PackageComparison, "financial" | "verdict" | "verdictText" | "offers" | "formulaVersion" | "warnings"> = { termDiffs, tradeOffs, assumptions: assumptionsList, missing, notModelled };
  const labelOf = (o: StoredOffer, s: string) => `${s}: ${o.kind} v${o.version_no}${o.property_label ? ` (${o.property_label})` : ""}`;
  if (missingA.length || missingB.length) {
    return {
      ...base, financial: null, formulaVersion: null, warnings: [],
      offers: [a, b].map((o, i) => ({ id: o.id, label: labelOf(o, i ? "B" : "A"), npv: null, nominalTotal: null, depositAmount: null, complete: false, gaps: [] })),
      verdict: "cannot_determine",
      verdictText: `Cannot say which package is better: ${missing.join("; ")}. Term-by-term, B is better on ${tradeOffs.betterInB.length} and worse on ${tradeOffs.worseInB.length} terms — a lower headline rent alone does not make it cheaper.`,
    };
  }
  const versions: OfferVersion[] = [
    { no: 1, label: labelOf(a, "A"), terms: A.terms, createdAt: a.offer_date },
    { no: 2, label: labelOf(b, "B"), terms: B.terms, createdAt: b.offer_date },
  ];
  const r = analyseNegotiation(versions);
  const f = r.diffs[1].financial!;
  const cheaper = f.better === "equal" ? "equal" : f.better === "to" ? "B" : "A";
  const gaps = r.offers.flatMap((o) => o.gaps.map((g) => `${o.label}: ${g} unknown (excluded)`));
  return {
    ...base, missing: [...new Set([...missing, ...gaps])], formulaVersion: r.formulaVersion, warnings: r.warnings,
    offers: r.offers.map((o, i) => ({ id: i ? b.id : a.id, label: o.label, npv: o.npv, nominalTotal: o.nominalTotal, depositAmount: o.depositAmount, complete: o.complete, gaps: o.gaps })),
    financial: { npvChange: f.npvChange, nominalChange: f.nominalChange, rentChange: f.rentChange, depositChange: f.depositChange, cheaper },
    verdict: cheaper === "A" ? "A_lower_modelled_cost" : cheaper === "B" ? "B_lower_modelled_cost" : "equal_modelled_cost",
    verdictText: `On modelled cash cost over ${r.horizonMonths} months (toolkit ${r.formulaVersion}, NPV change A→B ${f.npvChange}) ${cheaper === "equal" ? "the packages cost the same" : `package ${cheaper} costs less`}.`
      + (gaps.length ? ` Incomplete: ${gaps.join("; ")}.` : "") + (notModelled.length ? ` Not modelled: ${notModelled.join("; ")}.` : "") + " This is analysis, not a commitment.",
  };
}
