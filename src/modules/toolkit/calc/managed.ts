import Decimal from "decimal.js";
import { assertValidInputs } from "./validate";

/**
 * Conventional lease vs managed office (formula "cvm-1.0"). PURE, deterministic, decimal.js only — no AI maths (S5).
 *
 * Conventions
 * - Blank input = unknown (never zero). A blank cost item is listed in `missing`; totals then cover KNOWN costs only
 *   and `complete` is false. Enter 0 explicitly for "none".
 * - Refundable deposits are kept separate: they are in initial cash, never in cost/commitment totals.
 * - Conventional rent/CAM are priced per sf on an explicit area basis (chargeable or carpet); managed is per seat.
 *   The two unit prices are never compared directly — both are normalised to monthly cost and cost per usable seat.
 * - A service ticked as included in the managed quote is never costed again: an amount entered for it is excluded and
 *   a warning raised (no double counting).
 * - Comparison period P months (default: longer of the two terms). Month m escalates by (1+e)^floor((m-1)/every).
 *   Managed costs after its contract term assume renewal on the same escalation path (stated as an assumption).
 * - One-offs (fit-out, furniture, IT, setup, restoration) are added to the period total undiscounted.
 * - Recommendation = weighted score over cost, flexibility, commitment, speed to occupy, control. Cheapest is not
 *   preferred automatically; a criterion without data is dropped and reported.
 */
export const CVM_VERSION = "cvm-1.0";
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type D = Decimal;
export type N = number | string | null | undefined;

const known = (x: N) => x !== null && x !== undefined && String(x).trim() !== "" && Number.isFinite(Number(x));
const dv = (x: N): D => new Dec(known(x) ? String(x).trim() : 0);
const s2 = (x: D) => x.toFixed(2);

export const MANAGED_SERVICES = ["utilities", "housekeeping", "maintenance", "internet", "reception", "security", "furniture", "meeting_rooms", "parking", "it"] as const;
export type ManagedService = (typeof MANAGED_SERVICES)[number];
export const SERVICE_LABEL: Record<ManagedService, string> = {
  utilities: "Utilities / electricity", housekeeping: "Housekeeping", maintenance: "Maintenance", internet: "Internet",
  reception: "Reception", security: "Security", furniture: "Furniture", meeting_rooms: "Meeting rooms", parking: "Parking", it: "IT setup",
};

export interface Escalation { pct: N; everyMonths: N }
export interface ConventionalInput {
  rentRate: N; rentBasis: "chargeable" | "carpet"; chargeableSf: N; carpetSf: N; seats: N;
  camRate: N; camBasis: "chargeable" | "carpet";
  deposit: N; fitout: N; furniture: N; it: N; restoration: N;
  utilitiesMonthly: N; housekeepingMonthly: N; maintenanceMonthly: N; parkingMonthly: N; otherServicesMonthly: N;
  tenureMonths: N; lockInMonths?: N; escalation?: Escalation | null; monthsToOccupy?: N; control?: N; notes?: string;
}
export interface ManagedInput {
  perSeatPrice: N; seats: N; contractMonths: N; lockInMonths?: N; included: ManagedService[]; meetingRoomHours?: N;
  internetMonthly: N; utilitiesMonthly: N; housekeepingMonthly: N; receptionMonthly: N; securityMonthly: N; maintenanceMonthly: N;
  parkingMonthly?: N; furniture: N; it?: N; deposit: N; setup: N; addOnsMonthly: N;
  exclusions?: string; escalation?: Escalation | null; flexibilityNotes?: string; monthsToOccupy?: N; control?: N;
}
export interface Weights { cost: N; flexibility: N; commitment: N; speed: N; control: N }
export const DEFAULT_WEIGHTS = { cost: 35, flexibility: 20, commitment: 15, speed: 15, control: 15 };
export interface CvmInput { conventional: ConventionalInput; managed: ManagedInput; comparisonMonths?: N; headcount?: N; weights?: Partial<Weights> }

export interface LineItem { label: string; monthly?: string | null; oneOff?: string | null; status: "known" | "unknown" | "included" | "excluded_double_count" }
export interface OptionResult {
  complete: boolean; lines: LineItem[];
  month1Monthly: string; averageMonthly: string; annual: string; recurringTotal: string; oneOffTotal: string; totalCommitment: string;
  effectiveMonthly: string; costPerSeat: string | null; costPerEmployee: string | null;
  initialCashExDeposit: string; refundableDeposit: string | null; initialCashInclDeposit: string;
  fitoutInvestment: string; commitmentMonths: number | null; seats: string | null;
  cumulative: string[]; expansionNote: string;
}
export interface CriterionScore { key: keyof Weights; label: string; weight: string; conventional: string | null; managed: string | null; reason: string }
export interface CvmResult {
  formula: string; ok: boolean; comparisonMonths: number | null;
  conventional: OptionResult | null; managed: OptionResult | null;
  differences: string[]; warnings: string[]; assumptions: string[]; missing: string[];
  criteria: CriterionScore[]; weightedScore: { conventional: string; managed: string } | null;
  recommendation: { preferred: "conventional" | "managed" | "too_close" | null; text: string; reasons: string[] };
}

function escFactor(e: Escalation | null | undefined, m: number): D {
  if (!e || !known(e.pct) || dv(e.pct).isZero()) return new Dec(1);
  const every = known(e.everyMonths) && Number(e.everyMonths) > 0 ? Math.floor(Number(e.everyMonths)) : 12;
  return dv(e.pct).div(100).plus(1).pow(Math.floor((m - 1) / every));
}
function intOrNull(x: N): number | null { return known(x) && Number(x) > 0 ? Math.floor(Number(x)) : null; }

interface Built { lines: LineItem[]; escalating: D; fixed: D; oneOff: D; deposit: D | null; fitout: D; complete: boolean }

function buildConventional(c: ConventionalInput, missing: string[]): Built | null {
  const lines: LineItem[] = []; let complete = true;
  const area = (b: "chargeable" | "carpet") => (b === "carpet" ? c.carpetSf : c.chargeableSf);
  let fatal = false;
  if (!known(c.rentRate)) { missing.push("Conventional: rent per sf"); fatal = true; }
  if (!known(area(c.rentBasis))) { missing.push(`Conventional: ${c.rentBasis} area (sf) — rent is quoted on ${c.rentBasis} basis`); fatal = true; }
  if (fatal) return null;
  const rent = dv(c.rentRate).times(dv(area(c.rentBasis)));
  lines.push({ label: `Rent (₹${dv(c.rentRate).toFixed(2)}/sf × ${dv(area(c.rentBasis)).toString()} sf ${c.rentBasis})`, monthly: s2(rent), status: "known" });
  let escalating = rent;
  if (!known(c.camRate)) { missing.push("Conventional: CAM per sf"); complete = false; lines.push({ label: "CAM", monthly: null, status: "unknown" }); }
  else if (!known(area(c.camBasis))) { missing.push(`Conventional: ${c.camBasis} area for CAM`); complete = false; lines.push({ label: "CAM", monthly: null, status: "unknown" }); }
  else { const cam = dv(c.camRate).times(dv(area(c.camBasis))); escalating = escalating.plus(cam); lines.push({ label: `CAM (₹${dv(c.camRate).toFixed(2)}/sf × ${c.camBasis})`, monthly: s2(cam), status: "known" }); }
  let fixed = new Dec(0);
  const rec: [keyof ConventionalInput, string][] = [["utilitiesMonthly", "Utilities"], ["housekeepingMonthly", "Housekeeping"], ["maintenanceMonthly", "Maintenance"], ["parkingMonthly", "Parking"], ["otherServicesMonthly", "Other services"]];
  for (const [k, label] of rec) {
    const v = c[k] as N;
    if (!known(v)) { missing.push(`Conventional: ${label.toLowerCase()} (monthly)`); complete = false; lines.push({ label, monthly: null, status: "unknown" }); }
    else { fixed = fixed.plus(dv(v)); lines.push({ label, monthly: s2(dv(v)), status: "known" }); }
  }
  let oneOff = new Dec(0); let fitout = new Dec(0);
  const one: [keyof ConventionalInput, string][] = [["fitout", "Fit-out"], ["furniture", "Furniture"], ["it", "IT / cabling"], ["restoration", "Restoration at exit"]];
  for (const [k, label] of one) {
    const v = c[k] as N;
    if (!known(v)) { missing.push(`Conventional: ${label.toLowerCase()}`); complete = false; lines.push({ label, oneOff: null, status: "unknown" }); }
    else { oneOff = oneOff.plus(dv(v)); if (k !== "restoration") fitout = fitout.plus(dv(v)); lines.push({ label, oneOff: s2(dv(v)), status: "known" }); }
  }
  let deposit: D | null = null;
  if (!known(c.deposit)) { missing.push("Conventional: security deposit"); complete = false; } else deposit = dv(c.deposit);
  return { lines, escalating, fixed, oneOff, deposit, fitout, complete };
}

const MANAGED_AMOUNT: [keyof ManagedInput, ManagedService | null, string, "monthly" | "oneOff"][] = [
  ["internetMonthly", "internet", "Internet", "monthly"], ["utilitiesMonthly", "utilities", "Utilities", "monthly"],
  ["housekeepingMonthly", "housekeeping", "Housekeeping", "monthly"], ["receptionMonthly", "reception", "Reception", "monthly"],
  ["securityMonthly", "security", "Security", "monthly"], ["maintenanceMonthly", "maintenance", "Maintenance", "monthly"],
  ["parkingMonthly", "parking", "Parking", "monthly"], ["addOnsMonthly", null, "Add-ons", "monthly"],
  ["furniture", "furniture", "Furniture", "oneOff"], ["it", "it", "IT setup", "oneOff"], ["setup", null, "Setup / onboarding fee", "oneOff"],
];

function buildManaged(m: ManagedInput, missing: string[], warnings: string[]): Built | null {
  const lines: LineItem[] = []; let complete = true; let fatal = false;
  if (!known(m.perSeatPrice)) { missing.push("Managed: price per seat per month"); fatal = true; }
  if (!known(m.seats)) { missing.push("Managed: number of seats"); fatal = true; }
  if (fatal) return null;
  const inc = new Set(m.included ?? []);
  const seatFee = dv(m.perSeatPrice).times(dv(m.seats));
  lines.push({ label: `Seat fee (₹${dv(m.perSeatPrice).toFixed(2)}/seat × ${dv(m.seats).toString()} seats)`, monthly: s2(seatFee), status: "known" });
  let fixed = new Dec(0); let oneOff = new Dec(0); let fitout = new Dec(0);
  for (const [k, svc, label, kind] of MANAGED_AMOUNT) {
    const v = m[k] as N;
    if (svc && inc.has(svc)) {
      if (known(v) && !dv(v).isZero()) {
        warnings.push(`${label} is included in the managed quote; the separate ₹${s2(dv(v))} you entered is excluded to avoid double counting.`);
        lines.push({ label: `${label} (entered ₹${s2(dv(v))} — excluded, already included)`, status: "excluded_double_count" });
      } else lines.push({ label: `${label} — included in seat price`, status: "included" });
      continue;
    }
    if (!known(v)) {
      if (k === "parkingMonthly" || k === "it") continue; // optional rows, not shown unless entered
      missing.push(`Managed: ${label.toLowerCase()}${svc ? " (not ticked as included — enter cost or tick included)" : ""}`); complete = false;
      lines.push(kind === "monthly" ? { label, monthly: null, status: "unknown" } : { label, oneOff: null, status: "unknown" });
      continue;
    }
    if (kind === "monthly") { fixed = fixed.plus(dv(v)); lines.push({ label, monthly: s2(dv(v)), status: "known" }); }
    else { oneOff = oneOff.plus(dv(v)); if (k !== "setup") fitout = fitout.plus(dv(v)); lines.push({ label, oneOff: s2(dv(v)), status: "known" }); }
  }
  for (const svc of inc) if (svc === "meeting_rooms") lines.push({ label: `Meeting rooms — included${known(m.meetingRoomHours) ? ` (${dv(m.meetingRoomHours).toString()} h/month allowance)` : " (allowance not stated)"}`, status: "included" });
  if (inc.has("meeting_rooms") && !known(m.meetingRoomHours)) missing.push("Managed: meeting-room allowance (hours/credits per month)");
  let deposit: D | null = null;
  if (!known(m.deposit)) { missing.push("Managed: security deposit"); complete = false; } else deposit = dv(m.deposit);
  return { lines, escalating: seatFee, fixed, oneOff, deposit, fitout, complete };
}

function project(b: Built, P: number, esc: Escalation | null | undefined, seats: N, headcount: N, commitmentMonths: number | null, expansionNote: string): OptionResult {
  let recurring = new Dec(0); const cumulative: string[] = []; let month1 = new Dec(0);
  for (let m = 1; m <= P; m++) {
    const mc = b.escalating.times(escFactor(esc, m)).plus(b.fixed).plus(m === 1 ? b.oneOff : 0);
    if (m === 1) month1 = b.escalating.plus(b.fixed);
    recurring = recurring.plus(b.escalating.times(escFactor(esc, m)).plus(b.fixed));
    const prev = cumulative.length ? new Dec(cumulative[cumulative.length - 1]) : new Dec(0);
    cumulative.push(s2(prev.plus(mc)));
  }
  const avg = recurring.div(P); const total = recurring.plus(b.oneOff); const eff = total.div(P);
  const initial = b.oneOff.plus(month1);
  return {
    complete: b.complete, lines: b.lines, month1Monthly: s2(month1), averageMonthly: s2(avg), annual: s2(avg.times(12)),
    recurringTotal: s2(recurring), oneOffTotal: s2(b.oneOff), totalCommitment: s2(total), effectiveMonthly: s2(eff),
    costPerSeat: known(seats) && dv(seats).gt(0) ? s2(eff.div(dv(seats))) : null,
    costPerEmployee: known(headcount) && dv(headcount).gt(0) ? s2(eff.div(dv(headcount))) : null,
    initialCashExDeposit: s2(initial), refundableDeposit: b.deposit ? s2(b.deposit) : null,
    initialCashInclDeposit: s2(initial.plus(b.deposit ?? 0)), fitoutInvestment: s2(b.fitout), commitmentMonths, seats: known(seats) ? dv(seats).toString() : null,
    cumulative, expansionNote,
  };
}

/** Ratio score: the better (lower) value scores 1, the other lower/higher. Values are >= 0; +1 avoids divide-by-zero. */
function lowerBetter(a: D, b: D): [D, D] { const min = Decimal.min(a, b).plus(1); return [min.div(a.plus(1)), min.div(b.plus(1))]; }

export function compareConventionalManaged(inp: CvmInput): CvmResult {
  assertValidInputs(inp);
  const missing: string[] = []; const warnings: string[] = []; const assumptions: string[] = []; const differences: string[] = [];
  const c = inp.conventional; const m = inp.managed;
  const cb = buildConventional(c, missing); const mb = buildManaged(m, missing, warnings);
  const cTerm = intOrNull(c.tenureMonths); const mTerm = intOrNull(m.contractMonths);
  if (!cTerm) missing.push("Conventional: lease tenure (months)");
  if (!mTerm) missing.push("Managed: contract length (months)");
  let P = intOrNull(inp.comparisonMonths);
  if (!P && cTerm && mTerm) { P = Math.max(cTerm, mTerm); assumptions.push(`Comparison period not given: using the longer term, ${P} months.`); }
  if (!P) missing.push("Comparison period (months)");
  if (!known(inp.headcount)) missing.push("Headcount (employees) — needed for cost per employee");
  if (!c.escalation || !known(c.escalation.pct)) missing.push("Conventional: rent escalation (% and frequency) — none applied");
  if (!m.escalation || !known(m.escalation.pct)) missing.push("Managed: seat-price escalation — none applied");
  if (P && mTerm && P > mTerm) assumptions.push(`Managed contract (${mTerm} m) is shorter than the comparison period (${P} m): later months assume renewal on the same escalation path — renewal pricing is not guaranteed.`);
  if (P && cTerm && P > cTerm) assumptions.push(`Lease tenure (${cTerm} m) is shorter than the comparison period: later months assume extension on the same terms.`);
  assumptions.push("Refundable deposits are shown in initial cash only, not in cost or commitment totals.", "One-off costs are added undiscounted; month 1 carries all one-offs.", "Conventional rent and managed seat price are never compared per unit — both are normalised to monthly cost and cost per usable seat.");

  const lockC = intOrNull(c.lockInMonths) ?? cTerm; const lockM = intOrNull(m.lockInMonths) ?? mTerm;
  const conv = cb && P ? project(cb, P, c.escalation, c.seats, inp.headcount, lockC, "Expansion usually needs new space and a second fit-out; contraction is limited by the lock-in (rent payable for the unexpired lock-in).") : null;
  const man = mb && P ? project(mb, P, m.escalation, m.seats, inp.headcount, lockM, "Seats can usually be added at the quoted per-seat price subject to availability; reductions are limited by the contract lock-in/notice." + (m.flexibilityNotes ? ` Operator notes: ${m.flexibilityNotes}` : "")) : null;
  if (!known(c.seats)) missing.push("Conventional: usable seats (capacity) — needed for cost per seat");

  // Differences
  const inc = new Set(m.included ?? []);
  differences.push(`Area basis: conventional rent is on ${c.rentBasis} area${c.camBasis !== c.rentBasis ? ` (CAM on ${c.camBasis})` : ""}; managed is priced per seat — no sf basis.`);
  if (inc.size) differences.push(`Included in managed quote: ${[...inc].map((s) => SERVICE_LABEL[s]).join(", ")}. Under the conventional lease these are separate costs.`);
  if (m.exclusions) differences.push(`Managed exclusions stated: ${m.exclusions}`);
  if (known(c.seats) && known(m.seats) && !dv(c.seats).eq(dv(m.seats))) differences.push(`Capacity differs: conventional ${dv(c.seats).toString()} seats vs managed ${dv(m.seats).toString()} seats — per-seat figures use each option's own capacity.`);
  if (cTerm && mTerm && cTerm !== mTerm) differences.push(`Duration differs: lease ${cTerm} m vs managed ${mTerm} m.`);
  if (lockC && lockM) differences.push(`Commitment (lock-in): conventional ${lockC} m vs managed ${lockM} m.`);
  if (conv && man) differences.push(`Fit-out investment: conventional ₹${conv.fitoutInvestment} vs managed ₹${man.fitoutInvestment}.`);

  // Criteria
  const W = { ...DEFAULT_WEIGHTS, ...Object.fromEntries(Object.entries(inp.weights ?? {}).filter(([, v]) => known(v as N)).map(([k, v]) => [k, Number(v)])) } as Record<keyof Weights, number>;
  const criteria: CriterionScore[] = [];
  const add = (key: keyof Weights, label: string, cs: D | null, ms: D | null, reason: string) =>
    criteria.push({ key, label, weight: String(W[key]), conventional: cs ? cs.toFixed(4) : null, managed: ms ? ms.toFixed(4) : null, reason });
  if (conv && man) {
    const [a, b] = lowerBetter(new Dec(conv.totalCommitment), new Dec(man.totalCommitment));
    const cheaper = a.gt(b) ? "Conventional" : b.gt(a) ? "Managed" : null;
    add("cost", "Cost over period", a, b, cheaper ? `${cheaper} costs less over ${P} months (₹${conv.totalCommitment} vs ₹${man.totalCommitment})${conv.complete && man.complete ? "" : " — known costs only; some items missing"}.` : "Equal cost over the period.");
  } else add("cost", "Cost over period", null, null, "Not scored: required price/area inputs missing.");
  if (lockC && lockM) { const [a, b] = lowerBetter(new Dec(lockC), new Dec(lockM)); add("flexibility", "Flexibility", a, b, `Shorter lock-in is more flexible: ${lockC} m vs ${lockM} m.`); }
  else add("flexibility", "Flexibility", null, null, "Not scored: lock-in/term missing.");
  if (conv && man) { const [a, b] = lowerBetter(new Dec(conv.initialCashInclDeposit), new Dec(man.initialCashInclDeposit)); add("commitment", "Upfront commitment", a, b, `Initial cash incl. deposit: ₹${conv.initialCashInclDeposit} vs ₹${man.initialCashInclDeposit}.`); }
  else add("commitment", "Upfront commitment", null, null, "Not scored: inputs missing.");
  if (known(c.monthsToOccupy) && known(m.monthsToOccupy)) { const [a, b] = lowerBetter(dv(c.monthsToOccupy), dv(m.monthsToOccupy)); add("speed", "Speed to occupy", a, b, `Months to move in: ${dv(c.monthsToOccupy).toString()} vs ${dv(m.monthsToOccupy).toString()}.`); }
  else { add("speed", "Speed to occupy", null, null, "Not scored: months to occupy not entered for both."); missing.push("Months to occupy (both options) — for the speed criterion"); }
  const ctl = (x: N) => (known(x) && Number(x) >= 1 && Number(x) <= 5 ? dv(x).div(5) : null);
  if (ctl(c.control) && ctl(m.control)) add("control", "Control over space", ctl(c.control), ctl(m.control), `Your control rating (1–5): ${dv(c.control).toString()} vs ${dv(m.control).toString()}.`);
  else { add("control", "Control over space", null, null, "Not scored: control rating (1–5) not entered for both."); missing.push("Control rating 1–5 (both options)"); }

  const scored = criteria.filter((k) => k.conventional !== null && k.managed !== null && Number(k.weight) > 0);
  const wsum = scored.reduce((s, k) => s.plus(k.weight), new Dec(0));
  let weightedScore: CvmResult["weightedScore"] = null;
  let rec: CvmResult["recommendation"] = { preferred: null, text: "Not enough information to compare — complete the missing items.", reasons: [] };
  if (conv && man && scored.length && wsum.gt(0)) {
    const sc = scored.reduce((s, k) => s.plus(new Dec(k.conventional!).times(k.weight)), new Dec(0)).div(wsum);
    const sm = scored.reduce((s, k) => s.plus(new Dec(k.managed!).times(k.weight)), new Dec(0)).div(wsum);
    weightedScore = { conventional: sc.toFixed(4), managed: sm.toFixed(4) };
    const reasons = scored.map((k) => `${k.label} (weight ${k.weight}): ${k.reason}`);
    const dropped = criteria.filter((k) => !scored.includes(k)).map((k) => k.label);
    if (dropped.length) reasons.push(`Not scored: ${dropped.join(", ")}.`);
    if (sc.minus(sm).abs().lt(0.05)) rec = { preferred: "too_close", text: `Too close to call on the weighted criteria (${sc.toFixed(2)} vs ${sm.toFixed(2)}). Decide on the qualitative points below; the lower-cost option is not automatically better.`, reasons };
    else {
      const p = sc.gt(sm) ? "conventional" : "managed";
      const costRow = scored.find((k) => k.key === "cost");
      const cheaperNote = costRow && new Dec(costRow[p === "conventional" ? "managed" : "conventional"]!).gt(costRow[p]!) ? " This is preferred despite costing more, because of the other weighted criteria." : "";
      rec = { preferred: p, text: `${p === "conventional" ? "Conventional lease" : "Managed office"} scores higher on your weighted criteria (${sc.toFixed(2)} vs ${sm.toFixed(2)}).${cheaperNote} Check the inclusions, exclusions and missing items before advising.`, reasons };
    }
  }
  const uniq = [...new Set(missing)];
  return { formula: CVM_VERSION, ok: !!(conv && man), comparisonMonths: P, conventional: conv, managed: man, differences, warnings, assumptions, missing: uniq, criteria, weightedScore, recommendation: rec };
}
