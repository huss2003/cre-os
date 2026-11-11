/**
 * Shared input validation for every toolkit calculator (lease, occupancy, negotiation, managed, renewal, fit-out,
 * financing, BTS, investment, landlord-offer comparison) and the assistant toolkit tools that call them.
 *
 * - Blank (null / undefined / "") = unknown and is always allowed (S6) — never coerced to 0.
 * - NaN, Infinity and exponent notation ("5e66") are rejected.
 * - Each field type has sensible bounds; an out-of-range value stops the calculation with a clear message
 *   ("Escalation must be between 0 and 100 %") instead of producing absurd totals.
 * Pure: no I/O. Used server-side (calculators) and client-side (inline field errors).
 */

export type FieldKind = "percent" | "months" | "years" | "area" | "rentPerSf" | "money" | "signedMoney" | "count" | "quantity";

export const BOUNDS: Record<FieldKind, { min: number; max: number; int?: boolean; unit: string }> = {
  percent: { min: 0, max: 100, unit: "%" },
  months: { min: 0, max: 600, unit: "months" },
  years: { min: 0, max: 50, unit: "years" },
  area: { min: 1, max: 10_000_000, unit: "sf" },
  rentPerSf: { min: 0, max: 100_000, unit: "₹/sf" },
  money: { min: 0, max: 1e12, unit: "₹" },
  signedMoney: { min: -1e12, max: 1e12, unit: "₹" },
  count: { min: 0, max: 10_000_000, int: true, unit: "" },
  quantity: { min: 0, max: 1e9, unit: "" },
};

export class InputRangeError extends Error {
  constructor(public field: string, message: string) { super(message); this.name = "InputRangeError"; }
}

const fmtN = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** Human label from a key path segment: "escalationPct" → "Escalation". */
const LABELS: Record<string, string> = {
  escalationPct: "Escalation", camEscalationPct: "CAM escalation", pct: "Escalation", pctPoints: "Escalation reduction", discountRatePct: "Discount rate",
  annualRatePct: "Interest rate", ratePct: "Interest rate", feeTaxPct: "Tax on fee", softCostPct: "Soft cost", constructionInterestPct: "Construction interest",
  yieldOnCostPct: "Yield on cost", stampDutyPct: "Stamp duty", exitCapRatePct: "Exit cap rate", saleCostsPct: "Sale costs", ltvPct: "Loan-to-value",
  opexEscalationPct: "Opex escalation", reletEscalationPct: "Re-let escalation", taxPct: "Tax", drawSchedulePct: "Draw schedule",
  areaSf: "Area", leasableAreaSf: "Leasable area", chargeableSf: "Chargeable area", carpetSf: "Carpet area",
  rentPerSf: "Rent per sf", rentPerSfMonth: "Rent per sf", camPerSf: "CAM per sf", perSf: "Rent reduction per sf", rentRate: "Rent rate", camRate: "CAM rate",
  tenureMonths: "Tenure", rentFreeMonths: "Rent-free period", escalationEveryMonths: "Escalation interval", everyMonths: "Escalation interval", depositMonths: "Deposit",
  lockInMonths: "Lock-in", noticeMonths: "Notice", termMonths: "Term", comparisonMonths: "Comparison period", holdingYears: "Holding period", tenorYears: "Loan tenor",
  parkingSlots: "Parking slots", seats: "Seats", headcount: "Headcount", slots: "Parking slots", parkingRatePerSlot: "Parking rate",
};
export function labelFor(path: string): string {
  const k = path.split(".").filter((s) => !/^\d+$/.test(s)).pop() ?? path;
  if (LABELS[k]) return LABELS[k];
  const w = k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b(Pct|Sf)\b/g, (m) => (m === "Pct" ? "%" : "sf")).toLowerCase().trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Field kind from a calculator input key (camelCase). null = not a numeric field we bound. */
const SKIP = /^(name|label|no|notes?|description|unit|vendor|quoteRef|status|mode|treatment|periodicity|areaBasis|rentBasis|camBasis|basis|included|exclusions|flexibilityNotes|breakClause|possessionDate|handover|other|createdAt|leaseCommencement|rentCommencement|validUntil|documentsUrl|category|control|weights?|scores?|criteria|feeType|moratoriumMode|amortisation|partnerName|.*Date|.*At|.*Id)$/;
export function kindForKey(key: string): FieldKind | null {
  if (!key || SKIP.test(key)) return null;
  if (/^depositChange$/.test(key)) return "signedMoney";
  if (/pct/i.test(key)) return "percent";
  if (/persf|^(rentRate|camRate)$/i.test(key)) return "rentPerSf";
  if (/years$/i.test(key)) return "years";
  if (/months?$/i.test(key)) return "months";
  if (/^(areaSf|leasableAreaSf|chargeableSf|carpetSf|area)$/.test(key)) return "area";
  if (/^(seats|headcount|parkingSlots|slots|employees)$/.test(key)) return "count";
  if (/^(quantity|meetingRoomHours|metroKm|timelineWeeks|warrantyMonths)$/.test(key)) return "quantity";
  if (/(cost|costs|price|amount|deposit|fitout|furniture|^it$|monthly|oneoff|setup|moving|brokerage|estimated|approved|actual|contribution|financed|feeValue|land|downtime|transition|relocation|returned|refurbishment|restorationOld|perSlot|rent$|value)/i.test(key)) return "money";
  return null;
}

/** Field kind from the unit shown inside a form field (client-side inline validation). */
export function kindForUnit(unit?: string | null): FieldKind | null {
  if (!unit) return null;
  const u = unit.trim().toLowerCase();
  if (u.startsWith("%")) return "percent";
  if (u === "months" || u.startsWith("months ")) return "months";
  if (u === "years") return "years";
  if (u === "sf" || u === "sq ft") return "area";
  if (u.startsWith("₹/sf")) return "rentPerSf";
  if (u.startsWith("₹")) return "money";
  if (u === "seats" || u === "slots" || u === "employees") return "count";
  return null;
}

/** Messages for one value. Returns null when valid or blank (unknown). */
export function checkValue(raw: unknown, kind: FieldKind, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean" || typeof raw === "object") return null;
  let n: number;
  if (typeof raw === "number") n = raw;
  else {
    const s = String(raw).replace(/[,₹\s]/g, "");
    if (s === "") return null;
    if (/^[+-]?(nan|infinity|inf)$/i.test(s)) return `${label} must be a real number`;
    if (/\d[eE][+-]?\d/.test(s)) return `${label} must be written as a plain number (no exponent like 5e6)`;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return `${label} must be a number`;
    n = Number(s);
  }
  if (!Number.isFinite(n)) return `${label} must be a real number`;
  const b = BOUNDS[kind];
  if (n < b.min || n > b.max) return `${label} must be between ${fmtN(b.min)} and ${fmtN(b.max)}${b.unit ? ` ${b.unit}` : ""}`;
  if (b.int && !Number.isInteger(n)) return `${label} must be a whole number`;
  return null;
}

/** Walk a calculator input object; return the first problem ({field, message}) or null. Text values on non-numeric keys are ignored. */
export function findInputProblem(input: unknown, path = ""): { field: string; message: string } | null {
  if (input === null || input === undefined) return null;
  if (Array.isArray(input)) {
    const key = path.split(".").pop() ?? "";
    const kind = kindForKey(key);
    for (let i = 0; i < input.length; i++) {
      const v = input[i];
      if (kind && (typeof v === "number" || typeof v === "string")) {
        const m = checkValue(v, kind, labelFor(key));
        if (m) return { field: `${path}.${i}`, message: m };
      } else { const r = findInputProblem(v, `${path}.${i}`); if (r) return r; }
    }
    return null;
  }
  if (typeof input !== "object") return null;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (v !== null && typeof v === "object") { if (SKIP.test(k)) continue; const r = findInputProblem(v, p); if (r) return r; continue; }
    // one-off lines may be credits (e.g. a landlord fit-out allowance is a negative one-off)
    const kind = /(^|\.)nonRecurring\.\d+$/.test(path) && k === "amount" ? "signedMoney" : kindForKey(k);
    if (!kind) continue;
    if (typeof v === "string" && /[a-df-z]/i.test(v.replace(/^[+-]?(nan|infinity|inf)$/i, "")) ) continue; // free text on a numeric-looking key
    const m = checkValue(v, kind, labelFor(p));
    if (m) return { field: p, message: m };
  }
  return null;
}

/** Throw InputRangeError on the first invalid value. Prefix names the item, e.g. "Offer 2: ". */
export function assertValidInputs(input: unknown, prefix = ""): void {
  const p = findInputProblem(input);
  if (p) throw new InputRangeError(p.field, prefix + p.message);
}

/** Parse one form value: blank → null (unknown); otherwise validated against `kind` (throws InputRangeError naming `field`). */
export function parseFormNumber(raw: unknown, kind: FieldKind, label: string, field = label): number | null {
  const s = typeof raw === "string" ? raw.replace(/[,₹\s]/g, "") : raw === null || raw === undefined ? "" : String(raw);
  if (s === "") return null;
  const m = checkValue(s, kind, label);
  if (m) throw new InputRangeError(field, m);
  return Number(s);
}
