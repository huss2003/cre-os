import Decimal from "decimal.js";
import { addMonths } from "./dates";

/**
 * Rent escalation (SPEC §6). PURE, decimal.js only (S5). The basis is whatever the executed agreement says —
 * never assumed: `compounding` (each step on the previous escalated rent), `on_original` (each step on the original
 * rent, simple), `fixed_amount` (add a fixed ₹ per step), or `schedule` (explicit rent per step). Unknown basis with
 * more than one step → steps beyond the first are not calculated and flagged.
 */
export const ESC_VERSION = "lease-esc-1.0";
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type EscBasis = "compounding" | "on_original" | "fixed_amount" | "schedule" | "unknown";
export interface EscalationClause {
  basis: EscBasis;
  pct?: number | string | null;            // % per step (compounding / on_original)
  amount?: number | string | null;         // ₹ per step (fixed_amount)
  everyMonths?: number | null;             // step frequency; first step after `firstAfterMonths` (default = everyMonths)
  firstAfterMonths?: number | null;
  schedule?: { afterMonths: number; monthlyRent: number | string }[];
  clauseText?: string | null;
  page?: number | null;
}
export interface EscStep { step: number; effectiveDate: string | null; afterMonths: number; expectedMonthlyRent: string | null; method: string; flag?: string }
export interface EscResult { formula: string; baseMonthlyRent: string | null; steps: EscStep[]; missing: string[] }

const known = (x: unknown) => x !== null && x !== undefined && String(x).trim() !== "" && Number.isFinite(Number(x));

export function escalationSchedule(baseMonthlyRent: number | string | null, start: string | null, c: EscalationClause, termMonths: number | null): EscResult {
  const missing: string[] = [];
  if (!known(baseMonthlyRent)) missing.push("current monthly rent");
  if (!start) missing.push("commencement / escalation start date");
  if (c.basis === "unknown") missing.push("escalation basis (compounding or on original rent) — check the agreement");
  const base = known(baseMonthlyRent) ? new Dec(String(baseMonthlyRent)) : null;
  const steps: EscStep[] = [];
  if (c.basis === "schedule") {
    (c.schedule ?? []).forEach((s, i) => steps.push({ step: i + 1, afterMonths: s.afterMonths, effectiveDate: start ? addMonths(start, s.afterMonths) : null, expectedMonthlyRent: new Dec(String(s.monthlyRent)).toFixed(2), method: "stated in schedule" }));
    return { formula: ESC_VERSION, baseMonthlyRent: base?.toFixed(2) ?? null, steps, missing };
  }
  const every = c.everyMonths ?? null;
  const first = c.firstAfterMonths ?? every;
  if (!first) { missing.push("escalation frequency"); return { formula: ESC_VERSION, baseMonthlyRent: base?.toFixed(2) ?? null, steps, missing }; }
  const limit = termMonths ?? first; // without a term, show the first step only
  let prev = base;
  for (let k = 0, after = first; after < limit || (k === 0 && after <= limit); k++, after += every ?? Infinity) {
    const n = k + 1;
    let rent: Decimal | null = null; let method = ""; let flag: string | undefined;
    if (base && c.basis === "compounding" && known(c.pct)) { rent = prev!.mul(new Dec(1).add(new Dec(String(c.pct)).div(100))); method = `previous rent × (1 + ${c.pct}%)`; }
    else if (base && c.basis === "on_original" && known(c.pct)) { rent = base.mul(new Dec(1).add(new Dec(String(c.pct)).div(100).mul(n))); method = `original rent × (1 + ${n} × ${c.pct}%)`; }
    else if (base && c.basis === "fixed_amount" && known(c.amount)) { rent = base.add(new Dec(String(c.amount)).mul(n)); method = `original rent + ${n} × ₹${c.amount}`; }
    else if (base && c.basis === "unknown" && known(c.pct) && n === 1) { rent = base.mul(new Dec(1).add(new Dec(String(c.pct)).div(100))); method = `current rent × (1 + ${c.pct}%) — first step is the same under either basis`; }
    else { flag = c.basis === "unknown" ? "Basis unknown: later steps differ between compounding and on-original — not calculated." : "Missing value."; }
    steps.push({ step: n, afterMonths: after, effectiveDate: start ? addMonths(start, after) : null, expectedMonthlyRent: rent ? rent.toFixed(2) : null, method, ...(flag ? { flag } : {}) });
    if (rent) prev = rent;
    if (!every) break;
    if (steps.length > 40) break;
  }
  return { formula: ESC_VERSION, baseMonthlyRent: base?.toFixed(2) ?? null, steps, missing };
}

/** Expected vs actual rent after escalation. Tolerance ₹1. Actual must come from a verified record. */
export function escalationDiscrepancy(expected: string | null, actual: number | string | null): { status: "match" | "discrepancy" | "unknown"; difference: string | null } {
  if (!known(expected) || !known(actual)) return { status: "unknown", difference: null };
  const diff = new Dec(String(actual)).sub(new Dec(String(expected)));
  return { status: diff.abs().lte(1) ? "match" : "discrepancy", difference: diff.toFixed(2) };
}

/** Parse an escalation clause (code-first). Basis only if the clause says so. */
export function parseEscalationClause(text: string): EscalationClause | null {
  const t = text.replace(/\s+/g, " ");
  const pct = /(\d+(?:\.\d+)?)\s*(?:%|per\s*cent|percent)/i.exec(t);
  const amt = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i.exec(t);
  const every = /every\s+(\d+|one|two|three|four|five)\s*(?:\(\d+\)\s*)?(years?|months?)/i.exec(t);
  const after = /after\s+(?:(?:the\s+)?(?:expiry|completion)\s+of\s+)?(?:every\s+)?(\d+)\s*(?:\(\w+\)\s*)?(years?|months?)/i.exec(t);
  const wordN: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const toMonths = (n: string, u: string) => (Number(n) || wordN[n.toLowerCase()] || 0) * (/year/i.test(u) ? 12 : 1);
  const everyMonths = every ? toMonths(every[1], every[2]) : after ? toMonths(after[1], after[2]) : null;
  if (!pct && !amt) return null;
  const basis: EscBasis = /compound|on\s+the\s+(?:then\s+)?(?:last|previous|prevailing|existing)\s+(?:paid\s+)?rent|last\s+paid/i.test(t) ? "compounding"
    : /on\s+the\s+(?:original|initial|base|starting)\s+rent|simple/i.test(t) ? "on_original"
    : pct ? "unknown" : "fixed_amount";
  return { basis, pct: pct ? Number(pct[1]) : null, amount: !pct && amt ? Number(amt[1].replace(/,/g, "")) : null, everyMonths, firstAfterMonths: everyMonths, clauseText: text };
}
