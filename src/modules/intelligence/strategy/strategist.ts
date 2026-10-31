/**
 * Deal strategist — pure, rule-based, transparent (spec Part I §8 "Deal strategist", P1).
 * Output = deal health factors, stakeholder gaps, BATNA questions, a concession ladder and risks.
 * SUGGESTIONS ONLY: price and negotiation decisions stay with the adviser. No opaque scores, no LLM arithmetic:
 * the health score is a sum of named, visible factor points; concession values are compared through the finance module.
 */
import { STRATEGY_DISCLAIMER } from "../common";
import { detectThreadingGaps, stageIndex, type StakeholderLite, type ThreadingGap } from "../network/graph";

export { STRATEGY_DISCLAIMER };

export interface DealContext {
  opportunity: {
    id: string; name: string; stage: string; outcome: string; stage_entered_at: string | null; temperature: string | null;
    mandate_status: string | null; expected_close: string | null; next_action: string | null; next_action_due: string | null; risks: string | null;
  };
  requirement: {
    decision_date: string | null; occupation_date: string | null; area_target_sf: number | null; area_min_sf: number | null; area_max_sf: number | null;
    budget_min: number | null; budget_max: number | null; constraints: Record<string, unknown> | null; status: string | null;
  } | null;
  stakeholders: StakeholderLite[];
  quotes: { id: string; valid_until: string | null; superseded: boolean }[];
  lastInteractionAt: string | null;
  objections: string[];
  currentLeaseExpiry: string | null;
  financeScenarioCount: number;
}

export interface HealthFactor { key: string; label: string; points: number; max: number; detail: string }
export interface DealHealth { score: number; max: number; band: "healthy" | "watch" | "at_risk"; factors: HealthFactor[] }
export interface RiskItem { key: string; severity: "low" | "medium" | "high"; detail: string }
export interface ConcessionSuggestion { rank: number; party: "landlord" | "tenant"; item: string; ask: string; give: string | null; value_basis: string }
export interface StrategyOutput {
  disclaimer: string;
  health: DealHealth;
  gaps: ThreadingGap[];
  batna_questions: string[];
  concession_ladder: ConcessionSuggestion[];
  risks: RiskItem[];
}

const DAY = 86_400_000;
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b.slice(0, 10) + "T00:00:00Z").getTime() - new Date(a.slice(0, 10) + "T00:00:00Z").getTime()) / DAY);
}

export function dealHealth(c: DealContext, today: string): DealHealth {
  const f: HealthFactor[] = [];
  const idx = stageIndex(c.opportunity.stage);
  // 1. recency of a two-way touch
  const since = c.lastInteractionAt ? daysBetween(c.lastInteractionAt, today) : null;
  f.push({ key: "recency", label: "Recent contact", max: 20,
    points: since === null ? 0 : since <= 14 ? 20 : since <= 30 ? 12 : since <= 60 ? 5 : 0,
    detail: since === null ? "No interaction on file." : `Last interaction ${since} day(s) ago.` });
  // 2. next action defined and not overdue
  const due = c.opportunity.next_action_due;
  const overdue = !!due && due < today;
  f.push({ key: "next_action", label: "Next action", max: 15,
    points: !c.opportunity.next_action ? 0 : overdue ? 5 : 15,
    detail: !c.opportunity.next_action ? "No next action recorded." : overdue ? `Next action overdue since ${due}.` : `Next action: ${c.opportunity.next_action}${due ? ` (due ${due})` : ""}.` });
  // 3. multi-threading
  const people = new Set(c.stakeholders.map((s) => s.person_id)).size;
  f.push({ key: "threading", label: "Stakeholder coverage", max: 20,
    points: people >= 3 ? 20 : people === 2 ? 12 : people === 1 ? 5 : 0, detail: `${people} stakeholder(s) mapped.` });
  // 4. requirement clarity
  const r = c.requirement;
  const known = r ? [r.decision_date, r.occupation_date, r.area_target_sf ?? r.area_min_sf ?? r.area_max_sf, r.budget_max ?? r.budget_min].filter((x) => x !== null && x !== undefined).length : 0;
  f.push({ key: "requirement", label: "Requirement clarity", max: 20, points: known * 5,
    detail: r ? `${known}/4 of decision date, occupation date, area, budget recorded.` : "No requirement linked." });
  // 5. commercial evidence once options/proposal stage reached
  const liveQuotes = c.quotes.filter((q) => !q.superseded && (!q.valid_until || q.valid_until >= today));
  const needsQuotes = idx >= stageIndex("options_visits");
  f.push({ key: "commercials", label: "Live commercials", max: 15,
    points: !needsQuotes ? 15 : liveQuotes.length > 0 ? (c.financeScenarioCount > 0 ? 15 : 10) : 0,
    detail: !needsQuotes ? "Not yet required at this stage." : `${liveQuotes.length} live quote(s); ${c.financeScenarioCount} finance scenario(s).` });
  // 6. stage age
  const age = c.opportunity.stage_entered_at ? daysBetween(c.opportunity.stage_entered_at, today) : null;
  f.push({ key: "stage_age", label: "Stage momentum", max: 10,
    points: age === null ? 5 : age <= 30 ? 10 : age <= 60 ? 6 : age <= 120 ? 2 : 0,
    detail: age === null ? "Stage entry date unknown." : `${age} day(s) in ${c.opportunity.stage.replace(/_/g, " ")}.` });
  const score = f.reduce((s, x) => s + x.points, 0);
  const max = f.reduce((s, x) => s + x.max, 0);
  return { score, max, band: score >= 70 ? "healthy" : score >= 45 ? "watch" : "at_risk", factors: f };
}

export function batnaQuestions(c: DealContext, today: string): string[] {
  const q: string[] = [];
  const r = c.requirement;
  if (c.currentLeaseExpiry) {
    q.push(`What does renewal at the current premises (expiry ${c.currentLeaseExpiry}) look like — has the landlord been asked for renewal terms?`);
  } else {
    q.push("Where does the team sit today, and is staying put (renewal) a real option?");
  }
  q.push("What happens if no decision is made this year — what is the cost of delay to the client?");
  q.push("Which other buildings or operators (including managed/flex) is the client also evaluating?");
  if (!r?.decision_date) q.push("Who sets the decision deadline, and what drives it (board cycle, budget year, lease event)?");
  else if (r.decision_date < today) q.push(`The recorded decision date (${r.decision_date}) has passed — what is the new date and why did it move?`);
  if (!c.stakeholders.some((s) => s.role === "finance" || s.role === "approver")) q.push("Who approves the budget, and what all-in cost ceiling would they sign without escalation?");
  q.push("What is the landlord's alternative if this tenant walks — vacancy period, competing occupiers, upcoming supply nearby?");
  for (const o of c.objections.slice(0, 3)) q.push(`Open objection — “${o.slice(0, 140)}”: what evidence would resolve it?`);
  return q;
}

/** Ordered landlord asks the adviser may consider; values are NOT computed here (compare via finance scenarios). */
export function concessionLadder(c: DealContext): ConcessionSuggestion[] {
  const basis = c.financeScenarioCount > 0 ? "Compare as NPV / effective rent in the finance scenarios on this deal." : "Create a finance scenario to compare this concession as NPV / effective rent before offering.";
  const base: Omit<ConcessionSuggestion, "rank">[] = [
    { party: "landlord", item: "fitout_period", ask: "Rent-free fit-out period aligned to the actual fit-out programme", give: "Firm commitment on signing date", value_basis: basis },
    { party: "landlord", item: "rent_free", ask: "Additional rent-free months", give: "Longer lock-in (only if the client's growth plan supports it)", value_basis: basis },
    { party: "landlord", item: "escalation", ask: "Lower or deferred escalation (e.g. first escalation after year 3)", give: "Longer tenure", value_basis: basis },
    { party: "landlord", item: "capex", ask: "Landlord capex / warm-shell contribution", give: "Acceptance of standard reinstatement", value_basis: basis },
    { party: "landlord", item: "deposit", ask: "Reduced security deposit months", give: "Bank guarantee or parent comfort letter", value_basis: basis },
    { party: "landlord", item: "cam", ask: "CAM cap or fixed CAM for the lock-in period", give: null, value_basis: basis },
    { party: "landlord", item: "lockin", ask: "Shorter lock-in or a break option after the lock-in", give: "Higher rent-step later in term", value_basis: basis },
    { party: "tenant", item: "expansion_rights", ask: "Right of first refusal on adjacent space", give: null, value_basis: "Non-financial — record as an option, not a value." },
  ];
  return base.map((b, i) => ({ ...b, rank: i + 1 }));
}

export function dealRisks(c: DealContext, today: string, gaps: ThreadingGap[]): RiskItem[] {
  const out: RiskItem[] = [];
  const idx = stageIndex(c.opportunity.stage);
  if (c.opportunity.expected_close && c.opportunity.expected_close < today) out.push({ key: "close_slipped", severity: "high", detail: `Expected close ${c.opportunity.expected_close} has passed — update or record slippage.` });
  if (c.opportunity.mandate_status === "none" || c.opportunity.mandate_status === "unknown" || !c.opportunity.mandate_status) {
    if (idx >= stageIndex("requirement_confirmed")) out.push({ key: "no_mandate", severity: "high", detail: "No confirmed mandate at a late stage — fee protection risk." });
  }
  const expired = c.quotes.filter((q) => !q.superseded && q.valid_until && q.valid_until < today);
  if (expired.length) out.push({ key: "expired_quote", severity: "medium", detail: `${expired.length} quote(s) past validity — re-confirm before any client send.` });
  if (c.requirement?.occupation_date && c.currentLeaseExpiry && c.requirement.occupation_date > c.currentLeaseExpiry) {
    out.push({ key: "occupation_after_expiry", severity: "high", detail: `Occupation date ${c.requirement.occupation_date} is after current lease expiry ${c.currentLeaseExpiry} — holding-over / parallel-rent exposure.` });
  }
  for (const g of gaps.filter((x) => x.severity === "high")) out.push({ key: `gap_${g.kind}`, severity: "high", detail: g.detail });
  if (c.opportunity.risks) out.push({ key: "recorded", severity: "medium", detail: `Recorded: ${c.opportunity.risks}` });
  return out;
}

export function strategize(c: DealContext, today: string): StrategyOutput {
  const gaps = detectThreadingGaps(c.opportunity.stage, c.stakeholders);
  return {
    disclaimer: STRATEGY_DISCLAIMER,
    health: dealHealth(c, today),
    gaps,
    batna_questions: batnaQuestions(c, today),
    concession_ladder: concessionLadder(c),
    risks: dealRisks(c, today, gaps),
  };
}
