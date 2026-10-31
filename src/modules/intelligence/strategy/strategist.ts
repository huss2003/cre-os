/**
 * Deal strategist — pure, rule-based, transparent (spec Part I §8 "Deal strategist", P1; workflow 15).
 * Output = deal health factors, stakeholder gaps, evidence gaps, BATNA questions, a concession ladder and risks.
 * Every recommendation cites the recorded facts it rests on (`basis`: stage, quote version, objection id, stakeholder record…)
 * and lists its assumptions separately. Questions and the ladder are tailored from the deal's own facts.
 * SUGGESTIONS ONLY: price and negotiation decisions stay with the adviser; nothing here commits terms or moves a stage.
 * No LLM arithmetic: the health score is a sum of named factor points; concession values come from the finance engine.
 */
import { STRATEGY_DISCLAIMER, DEFAULT_EXPIRY_DAYS } from "../common";
import { detectThreadingGaps, stageIndex, type StakeholderLite, type ThreadingGap } from "../network/graph";

export { STRATEGY_DISCLAIMER };

export type FactKind = "opportunity" | "stage" | "requirement" | "quote" | "objection" | "stakeholder" | "lease" | "interaction" | "availability" | "finance" | "signal_claim";
export interface FactRef { kind: FactKind; id: string | null; label: string }

export interface ObjectionFact {
  id: string | null; source: "objection_log" | "interaction"; text: string; category: string | null; raised_on: string | null; outcome: string | null;
}
export interface QuoteFact {
  id: string; valid_until: string | null; superseded: boolean; version?: number | null; created_at?: string | null;
  terms?: Record<string, unknown> | null; evidence?: string | null; approved?: boolean; label?: string | null;
}
export interface StakeholderFact extends StakeholderLite { id?: string | null; name?: string | null; employment_status?: string | null }
export interface AvailabilityFact { id: string; label: string; as_of: string | null; valid_until: string | null; status: string; fact_status: string | null }
export interface UnsourcedClaim { id: string; claim_type: string; text: string }

export interface DealContext {
  opportunity: {
    id: string; name: string; stage: string; outcome: string; stage_entered_at: string | null; temperature: string | null;
    mandate_status: string | null; expected_close: string | null; next_action: string | null; next_action_due: string | null; risks: string | null;
  };
  requirement: {
    id?: string | null; decision_date: string | null; occupation_date: string | null; area_target_sf: number | null; area_min_sf: number | null; area_max_sf: number | null;
    budget_min: number | null; budget_max: number | null; constraints: Record<string, unknown> | null; status: string | null; confirmed_at?: string | null;
  } | null;
  stakeholders: StakeholderFact[];
  quotes: QuoteFact[];
  lastInteractionAt: string | null;
  /** Objections from deals' objection_log and interaction.objections. Plain strings are accepted (legacy). */
  objections: (string | ObjectionFact)[];
  currentLeaseExpiry: string | null;
  currentLeaseId?: string | null;
  financeScenarioCount: number;
  latestStageChange?: { id: string; to_stage: string; changed_at: string } | null;
  availability?: AvailabilityFact[];
  unsourcedClaims?: UnsourcedClaim[];
}

export interface HealthFactor { key: string; label: string; points: number; max: number; detail: string; basis: FactRef[] }
export interface DealHealth { score: number; max: number; band: "healthy" | "watch" | "at_risk"; factors: HealthFactor[] }
export interface RiskItem { key: string; severity: "low" | "medium" | "high"; detail: string; basis: FactRef[]; assumptions: string[] }
export interface BatnaQuestion { text: string; basis: FactRef[]; assumptions: string[] }
export type ConcessionType = "rent" | "rent_free" | "capex_support" | "deposit" | "escalation" | "lockin" | "cam" | "parking" | "other";
export interface ConcessionSuggestion {
  rank: number; party: "landlord" | "tenant"; item: string; concession_type: ConcessionType; ask: string; give: string | null; value_basis: string;
  why: string; basis: FactRef[]; assumptions: string[]; finance_type: "rent_free" | "capex_support" | "deposit_months" | "escalation_pct" | "rent_rate" | null;
  /** Size of the concession in finance-engine terms (deals.concession_npv). null = unknown (never 0). */
  finance_value: number | null;
  finance_value_basis: string | null;
}

/**
 * Deterministic concession size for the finance engine, only from recorded deal facts:
 *  1. a target recorded on the requirement (constraints.target_rent_free_months / max_escalation_pct / max_deposit_months /
 *     target_capex_support) against the quoted term => the gap;
 *  2. otherwise one ladder step against a quoted term (+1 month rent-free / fit-out, −1 pp escalation, −1 deposit month),
 *     so the adviser sees what one step is worth.
 * Unknown quoted term (or no gap) => null. Never 0, never a guessed ₹ amount.
 */
export function financeSize(item: string, terms: Record<string, unknown>, constraints: Record<string, unknown> | null, quoteLabelText: string | null): { value: number | null; basis: string | null } {
  const t = (k: string[]) => { for (const x of k) { const v = num(terms[x]); if (v !== null) return v; } return null; };
  const target = (k: string) => (constraints ? num(constraints[k]) : null);
  const q = quoteLabelText ?? "the quote";
  const out = (value: number, basis: string) => (value === 0 || !Number.isFinite(value) ? { value: null, basis: null } : { value: Math.round(value * 10000) / 10000, basis });
  switch (item) {
    case "rent_free": {
      const quoted = t(["rent_free", "rent_free_months"]);
      if (quoted === null) return { value: null, basis: null };
      const tg = target("target_rent_free_months");
      if (tg !== null && tg > quoted && Number.isInteger(tg - quoted)) return out(tg - quoted, `requirement target ${tg} vs ${quoted} month(s) in ${q}`);
      return out(1, `one step: +1 month on ${quoted} month(s) in ${q} (illustrative — you choose the ask)`);
    }
    case "fitout_period": {
      const quoted = t(["fitout_period", "fitout_months", "fit_out_period"]);
      return quoted === null ? { value: null, basis: null } : out(1, `one step: +1 fit-out month on ${quoted} in ${q} (illustrative)`);
    }
    case "escalation": {
      const quoted = t(["escalation", "escalation_pct"]);
      if (quoted === null || quoted <= 0) return { value: null, basis: null };
      const tg = target("max_escalation_pct");
      if (tg !== null && tg < quoted && tg >= 0) return out(tg - quoted, `requirement ceiling ${tg}% vs ${quoted}% in ${q}`);
      return out(-Math.min(1, quoted), `one step: −${Math.min(1, quoted)} pp on ${quoted}% in ${q} (illustrative)`);
    }
    case "deposit": {
      const quoted = t(["deposit", "deposit_months"]);
      if (quoted === null || quoted <= 0) return { value: null, basis: null };
      const tg = target("max_deposit_months");
      if (tg !== null && tg < quoted && tg >= 0) return out(tg - quoted, `requirement ceiling ${tg} vs ${quoted} month(s) in ${q}`);
      return out(-1, `one step: −1 month on ${quoted} month(s) in ${q} (illustrative)`);
    }
    case "capex": {
      const quoted = t(["capex", "landlord_capex", "capex_support"]);
      const tg = target("target_capex_support");
      if (quoted === null || tg === null || tg <= quoted) return { value: null, basis: null };
      return out(tg - quoted, `requirement target ₹${tg} vs ₹${quoted} in ${q}`);
    }
    default: return { value: null, basis: null };
  }
}
export interface EvidenceGap { key: string; severity: "low" | "medium" | "high"; detail: string; basis: FactRef[] }
export interface StrategyOutput {
  disclaimer: string;
  health: DealHealth;
  gaps: ThreadingGap[];
  evidence_gaps: EvidenceGap[];
  batna_questions: BatnaQuestion[];
  concession_ladder: ConcessionSuggestion[];
  risks: RiskItem[];
  facts: FactRef[];
  assumptions: string[];
}

const DAY = 86_400_000;
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b.slice(0, 10) + "T00:00:00Z").getTime() - new Date(a.slice(0, 10) + "T00:00:00Z").getTime()) / DAY);
}
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return num(o.value ?? o.months ?? o.pct ?? o.rate ?? o.amount ?? null);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function normaliseObjections(c: DealContext): ObjectionFact[] {
  return c.objections.map((o) => (typeof o === "string" ? { id: null, source: "interaction" as const, text: o, category: null, raised_on: null, outcome: "open" } : o));
}
const isOpen = (o: ObjectionFact) => !o.outcome || ["open", "unresolved", "partially_resolved"].includes(o.outcome);

// ------------------------------------------------------------------ fact references
const stageRef = (c: DealContext): FactRef => ({ kind: "stage", id: c.latestStageChange?.id ?? c.opportunity.id, label: `Stage: ${c.opportunity.stage.replace(/_/g, " ")}${c.opportunity.stage_entered_at ? ` since ${c.opportunity.stage_entered_at.slice(0, 10)}` : ""}` });
const oppRef = (c: DealContext, label: string): FactRef => ({ kind: "opportunity", id: c.opportunity.id, label });
const reqRef = (c: DealContext, label: string): FactRef => ({ kind: "requirement", id: c.requirement?.id ?? null, label });
export const quoteLabel = (q: QuoteFact) => `${q.label ?? "Quote"}${q.version ? ` v${q.version}` : ""}${q.valid_until ? ` (valid until ${q.valid_until})` : ""}`;
const quoteRef = (q: QuoteFact): FactRef => ({ kind: "quote", id: q.id, label: quoteLabel(q) });
const objRef = (o: ObjectionFact): FactRef => ({ kind: o.source === "objection_log" ? "objection" : "interaction", id: o.id, label: `Objection${o.category ? ` (${o.category})` : ""}: “${o.text.slice(0, 80)}”${o.raised_on ? ` — ${o.raised_on}` : ""}` });
const shRef = (s: StakeholderFact): FactRef => ({ kind: "stakeholder", id: s.id ?? s.person_id, label: `${s.name ?? "Stakeholder"} — ${s.role}` });

export function liveQuotes(c: DealContext, today: string): QuoteFact[] {
  return c.quotes.filter((q) => !q.superseded && (!q.valid_until || q.valid_until >= today))
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}
/** Latest non-superseded quote (even if expired) — the commercial position the ladder is built against. */
export function currentQuote(c: DealContext): QuoteFact | null {
  return [...c.quotes].filter((q) => !q.superseded).sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0] ?? null;
}

// ------------------------------------------------------------------ health
export function dealHealth(c: DealContext, today: string): DealHealth {
  const f: HealthFactor[] = [];
  const idx = stageIndex(c.opportunity.stage);
  const since = c.lastInteractionAt ? daysBetween(c.lastInteractionAt, today) : null;
  f.push({ key: "recency", label: "Recent contact", max: 20,
    points: since === null ? 0 : since <= 14 ? 20 : since <= 30 ? 12 : since <= 60 ? 5 : 0,
    detail: since === null ? "No interaction on file." : `Last interaction ${since} day(s) ago.`,
    basis: c.lastInteractionAt ? [{ kind: "interaction", id: null, label: `Last interaction ${c.lastInteractionAt.slice(0, 10)}` }] : [] });
  const due = c.opportunity.next_action_due;
  const overdue = !!due && due < today;
  f.push({ key: "next_action", label: "Next action", max: 15,
    points: !c.opportunity.next_action ? 0 : overdue ? 5 : 15,
    detail: !c.opportunity.next_action ? "No next action recorded." : overdue ? `Next action overdue since ${due}.` : `Next action: ${c.opportunity.next_action}${due ? ` (due ${due})` : ""}.`,
    basis: [oppRef(c, c.opportunity.next_action ? `Next action: ${c.opportunity.next_action}` : "Next action: none recorded")] });
  const people = new Set(c.stakeholders.map((s) => s.person_id)).size;
  f.push({ key: "threading", label: "Stakeholder coverage", max: 20,
    points: people >= 3 ? 20 : people === 2 ? 12 : people === 1 ? 5 : 0, detail: `${people} stakeholder(s) mapped.`, basis: c.stakeholders.map(shRef) });
  const r = c.requirement;
  const known = r ? [r.decision_date, r.occupation_date, r.area_target_sf ?? r.area_min_sf ?? r.area_max_sf, r.budget_max ?? r.budget_min].filter((x) => x !== null && x !== undefined).length : 0;
  f.push({ key: "requirement", label: "Requirement clarity", max: 20, points: known * 5,
    detail: r ? `${known}/4 of decision date, occupation date, area, budget recorded.` : "No requirement linked.", basis: r ? [reqRef(c, `Requirement (${r.status ?? "status unknown"})`)] : [] });
  const live = liveQuotes(c, today);
  const needsQuotes = idx >= stageIndex("options_visits");
  f.push({ key: "commercials", label: "Live commercials", max: 15,
    points: !needsQuotes ? 15 : live.length > 0 ? (c.financeScenarioCount > 0 ? 15 : 10) : 0,
    detail: !needsQuotes ? "Not yet required at this stage." : `${live.length} live quote(s); ${c.financeScenarioCount} finance scenario(s).`, basis: live.map(quoteRef) });
  const age = c.opportunity.stage_entered_at ? daysBetween(c.opportunity.stage_entered_at, today) : null;
  f.push({ key: "stage_age", label: "Stage momentum", max: 10,
    points: age === null ? 5 : age <= 30 ? 10 : age <= 60 ? 6 : age <= 120 ? 2 : 0,
    detail: age === null ? "Stage entry date unknown." : `${age} day(s) in ${c.opportunity.stage.replace(/_/g, " ")}.`, basis: [stageRef(c)] });
  const score = f.reduce((s, x) => s + x.points, 0);
  const max = f.reduce((s, x) => s + x.max, 0);
  return { score, max, band: score >= 70 ? "healthy" : score >= 45 ? "watch" : "at_risk", factors: f };
}

// ------------------------------------------------------------------ BATNA questions (tailored)
const OBJECTION_Q: Record<string, (o: ObjectionFact, q: QuoteFact | null) => string> = {
  price: (o, q) => `Price objection (“${o.text.slice(0, 100)}”): what all-in monthly cost would the budget owner sign${q ? ` compared with ${quoteLabel(q)}` : ""}, and what is the cost of staying put?`,
  location: (o) => `Location objection (“${o.text.slice(0, 100)}”): which micro-markets would remove it, and would the client trade location for terms?`,
  timing: (o) => `Timing objection (“${o.text.slice(0, 100)}”): what is the latest workable occupation date, and what drives it?`,
  specification: (o) => `Specification objection (“${o.text.slice(0, 100)}”): which spec items are must-haves vs. fit-out the landlord could fund?`,
  terms: (o) => `Terms objection (“${o.text.slice(0, 100)}”): which term (lock-in, escalation, deposit, reinstatement) matters most, and what would they give for it?`,
  landlord: (o) => `Landlord objection (“${o.text.slice(0, 100)}”): is it about this landlord's track record or the building — would a different owner in the same micro-market solve it?`,
  competitor: (o) => `Competing option (“${o.text.slice(0, 100)}”): which option exactly, on what terms, and what would make it their walk-away choice?`,
  internal_approval: (o) => `Internal approval (“${o.text.slice(0, 100)}”): who approves, on what cycle, and what evidence will they ask for?`,
};

export function batnaQuestions(c: DealContext, today: string): BatnaQuestion[] {
  const out: BatnaQuestion[] = [];
  const r = c.requirement;
  const q = currentQuote(c);
  const objs = normaliseObjections(c).filter(isOpen);
  if (c.currentLeaseExpiry) {
    out.push({ text: `What does renewal at the current premises (expiry ${c.currentLeaseExpiry}) look like — has the landlord been asked for renewal terms?`, basis: [{ kind: "lease", id: c.currentLeaseId ?? null, label: `Current lease expiry ${c.currentLeaseExpiry}` }], assumptions: [] });
  } else {
    out.push({ text: "Where does the team sit today, and is staying put (renewal) a real option?", basis: [], assumptions: ["Current premises / lease expiry not recorded — the client's walk-away option is unknown."] });
  }
  if (q) {
    out.push({ text: `If the landlord holds at ${quoteLabel(q)}, which alternative is the client's next-best option, and at what all-in cost?`, basis: [quoteRef(q)], assumptions: [] });
    out.push({ text: "What is the landlord's alternative if this tenant walks — vacancy period, competing occupiers, upcoming supply nearby?", basis: [quoteRef(q)], assumptions: ["Landlord vacancy / competing demand is not recorded — verify before relying on leverage."] });
  }
  if (r?.decision_date && r.decision_date < today) out.push({ text: `The recorded decision date (${r.decision_date}) has passed — what is the new date and why did it move?`, basis: [reqRef(c, `Decision date ${r.decision_date}`)], assumptions: [] });
  else if (r?.decision_date) out.push({ text: `What happens if no decision is made by ${r.decision_date} — what is the cost of delay to the client?`, basis: [reqRef(c, `Decision date ${r.decision_date}`)], assumptions: [] });
  else out.push({ text: "Who sets the decision deadline, and what drives it (board cycle, budget year, lease event)?", basis: r ? [reqRef(c, "Requirement: no decision date")] : [], assumptions: ["Decision date not recorded."] });
  if (r?.occupation_date && c.currentLeaseExpiry && r.occupation_date > c.currentLeaseExpiry) {
    out.push({ text: `Occupation (${r.occupation_date}) falls after the current expiry (${c.currentLeaseExpiry}) — can the client hold over or extend short-term, and at what cost?`, basis: [reqRef(c, `Occupation date ${r.occupation_date}`), { kind: "lease", id: c.currentLeaseId ?? null, label: `Lease expiry ${c.currentLeaseExpiry}` }], assumptions: [] });
  }
  const econ = c.stakeholders.filter((s) => s.role === "finance" || s.role === "approver");
  if (!econ.length) out.push({ text: "Who approves the budget, and what all-in cost ceiling would they sign without escalation?", basis: c.stakeholders.map(shRef), assumptions: ["No finance/approver stakeholder recorded."] });
  const idx = stageIndex(c.opportunity.stage);
  if (idx >= stageIndex("loi")) out.push({ text: "If documentation slips, which conditions in the LOI lapse first, and who on the client side owns the legal timeline?", basis: [stageRef(c)], assumptions: [] });
  else if (idx >= stageIndex("options_visits")) out.push({ text: "Of the options seen, which one would the client choose if this landlord refused every concession?", basis: [stageRef(c)], assumptions: [] });
  for (const o of objs.slice(0, 4)) {
    const fn = OBJECTION_Q[o.category ?? ""];
    out.push({ text: fn ? fn(o, q) : `Open objection — “${o.text.slice(0, 140)}”: what evidence would resolve it?`, basis: [objRef(o), ...(q && o.category === "price" ? [quoteRef(q)] : [])], assumptions: [] });
  }
  return out;
}

// ------------------------------------------------------------------ concession ladder (tailored)
interface Candidate extends Omit<ConcessionSuggestion, "rank" | "finance_value" | "finance_value_basis"> { score: number }

/**
 * Ordered landlord asks the adviser may consider, built from the current quote's terms, open objections and the requirement.
 * Values are NOT computed here (compare via the finance concession-equivalence engine).
 */
export function concessionLadder(c: DealContext): ConcessionSuggestion[] {
  const q = currentQuote(c);
  const t = (q?.terms ?? {}) as Record<string, unknown>;
  const objs = normaliseObjections(c).filter(isOpen);
  const cats = new Map<string, ObjectionFact[]>();
  for (const o of objs) cats.set(o.category ?? "other", [...(cats.get(o.category ?? "other") ?? []), o]);
  const basisQ = q ? [quoteRef(q)] : [];
  const noQuote = q ? [] : ["No quote recorded — this step is generic until a quote is logged."];
  const valueBasis = c.financeScenarioCount > 0 ? "Compare as NPV / effective rent in the finance scenarios on this deal." : "Create a finance scenario to compare this concession as NPV / effective rent before offering.";
  const objBoost = (...k: string[]) => k.flatMap((x) => cats.get(x) ?? []);
  const cands: Candidate[] = [];
  const add = (x: Omit<Candidate, "value_basis" | "party"> & { party?: "landlord" | "tenant"; value_basis?: string }) =>
    cands.push({ party: "landlord", value_basis: valueBasis, ...x });

  const rentFree = num(t.rent_free ?? t.rent_free_months);
  const pObjs = objBoost("price");
  add({ item: "rent_free", concession_type: "rent_free", finance_type: "rent_free",
    ask: rentFree === null ? "Rent-free months (none recorded in the quote)" : `More rent-free than the quoted ${rentFree} month(s)`,
    give: "Firm commitment on signing date", why: rentFree === null ? "Quote has no rent-free term on record." : `Quote offers ${rentFree} month(s).`,
    basis: [...basisQ, ...pObjs.map(objRef)], assumptions: [...noQuote, ...(rentFree === null && q ? ["Rent-free not recorded in the quote terms — confirm it is really zero."] : [])],
    score: 40 + (rentFree === null || rentFree < 3 ? 15 : 0) + pObjs.length * 20 });

  const timing = objBoost("timing");
  const fitout = num(t.fitout_period ?? t.fitout_months ?? t.fit_out_period);
  add({ item: "fitout_period", concession_type: "rent_free", finance_type: "rent_free",
    ask: fitout === null ? "Rent-free fit-out period aligned to the actual fit-out programme" : `Fit-out period longer than the quoted ${fitout} month(s), matched to the programme`,
    give: "Early access / fixed programme", why: c.requirement?.occupation_date ? `Occupation target ${c.requirement.occupation_date}.` : "Fit-out time is rarely costless to the tenant.",
    basis: [...basisQ, ...timing.map(objRef), ...(c.requirement?.occupation_date ? [reqRef(c, `Occupation date ${c.requirement.occupation_date}`)] : [])],
    assumptions: [...noQuote, ...(c.requirement?.occupation_date ? [] : ["Occupation date not recorded."])], score: 35 + timing.length * 25 });

  const esc = num(t.escalation ?? t.escalation_pct);
  if (esc === null || esc > 0) add({ item: "escalation", concession_type: "escalation", finance_type: "escalation_pct",
    ask: esc === null ? "Lower or deferred escalation (escalation not recorded in the quote)" : `Escalation below the quoted ${esc}% (or first step deferred)`,
    give: "Longer tenure", why: esc === null ? "Escalation unknown." : `Quoted escalation ${esc}%.`,
    basis: [...basisQ, ...pObjs.map(objRef)], assumptions: [...noQuote, ...(esc === null && q ? ["Escalation not recorded in the quote terms."] : [])], score: 30 + (esc !== null && esc >= 5 ? 20 : 0) + pObjs.length * 10 });

  const spec = objBoost("specification");
  const capex = num(t.capex ?? t.landlord_capex ?? t.capex_support);
  add({ item: "capex", concession_type: "capex_support", finance_type: "capex_support",
    ask: capex === null ? "Landlord capex / warm-shell contribution (none recorded)" : "Higher landlord capex contribution than quoted",
    give: "Acceptance of standard reinstatement", why: spec.length ? "Specification objection on record." : "Fit-out cost is a large share of total occupancy cost.",
    basis: [...basisQ, ...spec.map(objRef)], assumptions: noQuote, score: 25 + spec.length * 25 + (capex === null ? 5 : 0) });

  const termsO = objBoost("terms");
  const deposit = num(t.deposit ?? t.deposit_months);
  if (deposit === null || deposit > 3) add({ item: "deposit", concession_type: "deposit", finance_type: "deposit_months",
    ask: deposit === null ? "Reduced security deposit (months not recorded)" : `Deposit below the quoted ${deposit} month(s)`,
    give: "Bank guarantee or parent comfort letter", why: deposit === null ? "Deposit unknown." : `Quoted deposit ${deposit} month(s).`,
    basis: [...basisQ, ...termsO.map(objRef)], assumptions: noQuote, score: 20 + (deposit !== null && deposit >= 6 ? 20 : 0) + termsO.length * 15 });

  const lockin = num(t.lockin ?? t.lockin_months ?? t.lock_in);
  if (lockin === null || lockin > 12) add({ item: "lockin", concession_type: "lockin", finance_type: null,
    ask: lockin === null ? "Shorter lock-in or a break option (lock-in not recorded)" : `Lock-in shorter than the quoted ${lockin} months, or a break option after it`,
    give: "Higher rent-step later in term", why: lockin === null ? "Lock-in unknown." : `Quoted lock-in ${lockin} months.`,
    basis: [...basisQ, ...termsO.map(objRef)], assumptions: noQuote, score: 20 + (lockin !== null && lockin >= 36 ? 20 : 0) + termsO.length * 15 });

  const cam = num(t.cam ?? t.cam_rate);
  add({ item: "cam", concession_type: "cam", finance_type: null, ask: cam === null ? "CAM cap or fixed CAM for the lock-in period (CAM not recorded)" : "Cap the quoted CAM for the lock-in period",
    give: null, why: "CAM increases are outside the headline rent.", basis: basisQ, assumptions: noQuote, score: 10 + pObjs.length * 5 });

  add({ item: "expansion_rights", concession_type: "other", finance_type: null, party: "tenant", ask: "Right of first refusal on adjacent space", give: null,
    value_basis: "Non-financial — record as an option, not a value.", why: c.requirement?.area_max_sf ? `Requirement range up to ${c.requirement.area_max_sf} sf.` : "Protects growth without committing area now.",
    basis: c.requirement ? [reqRef(c, "Requirement area range")] : [], assumptions: c.requirement?.area_max_sf ? [] : ["Growth plan not recorded."], score: 5 });

  const qText = q ? quoteLabel(q) : null;
  return cands.sort((a, b) => b.score - a.score).map(({ score: _s, ...x }, i) => {
    const size = q && x.finance_type ? financeSize(x.item, t, c.requirement?.constraints ?? null, qText) : { value: null, basis: null };
    return { ...x, rank: i + 1, finance_value: size.value, finance_value_basis: size.basis };
  });
}

// ------------------------------------------------------------------ evidence gaps
export function evidenceGaps(c: DealContext, today: string): EvidenceGap[] {
  const out: EvidenceGap[] = [];
  const quoteDays = DEFAULT_EXPIRY_DAYS.quote;
  for (const q of c.quotes.filter((x) => !x.superseded)) {
    if (q.valid_until && q.valid_until < today) out.push({ key: `stale_quote:${q.id}`, severity: "high", detail: `${quoteLabel(q)} is past its validity — re-confirm before any client use.`, basis: [quoteRef(q)] });
    else if (!q.valid_until && q.created_at && daysBetween(q.created_at, today) > quoteDays) out.push({ key: `stale_quote:${q.id}`, severity: "medium", detail: `${quoteLabel(q)} has no validity date and is ${daysBetween(q.created_at, today)} days old — treat as stale until re-confirmed.`, basis: [quoteRef(q)] });
    if (!q.evidence && !q.approved) out.push({ key: `quote_no_evidence:${q.id}`, severity: "medium", detail: `${quoteLabel(q)} has no source evidence recorded (email, landlord letter).`, basis: [quoteRef(q)] });
  }
  for (const a of c.availability ?? []) {
    const stale = (a.valid_until && a.valid_until < today) || (a.as_of && daysBetween(a.as_of, today) > DEFAULT_EXPIRY_DAYS.availability);
    const unverified = a.status === "unverified" || (a.fact_status !== null && a.fact_status !== "currently_confirmed");
    if (stale || unverified) out.push({ key: `availability:${a.id}`, severity: stale ? "high" : "medium", detail: `${a.label}: availability ${stale ? `last checked ${a.as_of ?? "unknown"}` : "not confirmed"} — verify before presenting.`, basis: [{ kind: "availability", id: a.id, label: `${a.label} (${a.status}, as of ${a.as_of ?? "unknown"})` }] });
  }
  for (const s of c.stakeholders) {
    if (s.employment_current === false) continue; // reported as a threading gap already
    if (s.employment_current === null || (s.employment_status && s.employment_status !== "currently_confirmed")) {
      out.push({ key: `stakeholder:${s.id ?? s.person_id}`, severity: "low", detail: `${s.name ?? "A stakeholder"} (${s.role}): current employment at the company is ${s.employment_current === null ? "not recorded" : "not confirmed"}.`, basis: [shRef(s)] });
    }
  }
  const r = c.requirement;
  if (r && !r.confirmed_at && stageIndex(c.opportunity.stage) >= stageIndex("requirement_confirmed")) {
    out.push({ key: "requirement_unconfirmed", severity: "high", detail: "Stage says the requirement is confirmed, but no client confirmation is recorded on the requirement.", basis: [stageRef(c), reqRef(c, `Requirement (${r.status ?? "?"}), no confirmation recorded`)] });
  }
  for (const u of c.unsourcedClaims ?? []) out.push({ key: `claim:${u.id}`, severity: "low", detail: `Claim without evidence: ${u.claim_type.replace(/_/g, " ")} — “${u.text.slice(0, 100)}”.`, basis: [{ kind: "signal_claim", id: u.id, label: u.claim_type }] });
  if (c.opportunity.risks) out.push({ key: "risk_note_unsourced", severity: "low", detail: "The recorded risk note has no linked evidence — keep it as an assumption.", basis: [oppRef(c, `Risk note: ${c.opportunity.risks.slice(0, 80)}`)] });
  return out;
}

// ------------------------------------------------------------------ risks
export function dealRisks(c: DealContext, today: string, gaps: ThreadingGap[]): RiskItem[] {
  const out: RiskItem[] = [];
  const idx = stageIndex(c.opportunity.stage);
  if (c.opportunity.expected_close && c.opportunity.expected_close < today) out.push({ key: "close_slipped", severity: "high", detail: `Expected close ${c.opportunity.expected_close} has passed — update or record slippage.`, basis: [oppRef(c, `Expected close ${c.opportunity.expected_close}`)], assumptions: [] });
  if (c.opportunity.mandate_status === "none" || c.opportunity.mandate_status === "unknown" || !c.opportunity.mandate_status) {
    if (idx >= stageIndex("requirement_confirmed")) out.push({ key: "no_mandate", severity: "high", detail: "No confirmed mandate at a late stage — fee protection risk.", basis: [stageRef(c), oppRef(c, `Mandate: ${c.opportunity.mandate_status ?? "not recorded"}`)], assumptions: [] });
  }
  const expired = c.quotes.filter((q) => !q.superseded && q.valid_until && q.valid_until < today);
  if (expired.length) out.push({ key: "expired_quote", severity: "medium", detail: `${expired.length} quote(s) past validity — re-confirm before any client send.`, basis: expired.map(quoteRef), assumptions: [] });
  if (c.requirement?.occupation_date && c.currentLeaseExpiry && c.requirement.occupation_date > c.currentLeaseExpiry) {
    out.push({ key: "occupation_after_expiry", severity: "high", detail: `Occupation date ${c.requirement.occupation_date} is after current lease expiry ${c.currentLeaseExpiry} — holding-over / parallel-rent exposure.`, basis: [reqRef(c, `Occupation date ${c.requirement.occupation_date}`), { kind: "lease", id: c.currentLeaseId ?? null, label: `Lease expiry ${c.currentLeaseExpiry}` }], assumptions: [] });
  }
  const openObjs = normaliseObjections(c).filter(isOpen);
  if (openObjs.length >= 2 && idx >= stageIndex("proposal_negotiation")) out.push({ key: "open_objections_late", severity: "medium", detail: `${openObjs.length} objections still open at ${c.opportunity.stage.replace(/_/g, " ")}.`, basis: openObjs.map(objRef), assumptions: [] });
  for (const g of gaps.filter((x) => x.severity === "high")) out.push({ key: `gap_${g.kind}`, severity: "high", detail: g.detail, basis: [stageRef(c), ...c.stakeholders.map(shRef)], assumptions: [] });
  if (c.opportunity.risks) out.push({ key: "recorded", severity: "medium", detail: `Recorded: ${c.opportunity.risks}`, basis: [oppRef(c, "Risk note on the opportunity")], assumptions: ["Recorded risk note — not independently evidenced."] });
  return out;
}

/** Every recorded fact the strategist looked at (shown as "based on"). */
export function dealFacts(c: DealContext): FactRef[] {
  const f: FactRef[] = [stageRef(c)];
  if (c.requirement) f.push(reqRef(c, `Requirement (${c.requirement.status ?? "status unknown"})`));
  for (const q of c.quotes.filter((x) => !x.superseded)) f.push(quoteRef(q));
  for (const o of normaliseObjections(c)) f.push(objRef(o));
  for (const s of c.stakeholders) f.push(shRef(s));
  if (c.currentLeaseExpiry) f.push({ kind: "lease", id: c.currentLeaseId ?? null, label: `Current lease expiry ${c.currentLeaseExpiry}` });
  if (c.financeScenarioCount) f.push({ kind: "finance", id: null, label: `${c.financeScenarioCount} finance scenario(s)` });
  return f;
}

export function strategize(c: DealContext, today: string): StrategyOutput {
  const gaps = detectThreadingGaps(c.opportunity.stage, c.stakeholders);
  const ladder = concessionLadder(c);
  const batna = batnaQuestions(c, today);
  const risks = dealRisks(c, today, gaps);
  const assumptions = [...new Set([...batna.flatMap((b) => b.assumptions), ...ladder.flatMap((l) => l.assumptions), ...risks.flatMap((r) => r.assumptions)])];
  return {
    disclaimer: STRATEGY_DISCLAIMER,
    health: dealHealth(c, today),
    gaps,
    evidence_gaps: evidenceGaps(c, today),
    batna_questions: batna,
    concession_ladder: ladder,
    risks,
    facts: dealFacts(c),
    assumptions,
  };
}
