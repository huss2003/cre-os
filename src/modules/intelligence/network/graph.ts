/**
 * Network intelligence — pure graph helpers: warm introduction paths and multi-threading gaps.
 * intro_permission is never set automatically; paths without it are shown as "ask first", never as usable.
 */

export interface Edge {
  id: string;
  from_user_id: string | null;
  from_person_id: string | null;
  to_person_id: string;
  edge_type: string;
  warmth: "cold" | "warm" | "hot" | "trusted" | null;
  intro_permission: boolean;
  last_meaningful_contact: string | null;
  valid_to: string | null;
}

export interface IntroPath {
  target_person_id: string;
  hops: { kind: "me" | "colleague" | "person"; id: string }[];
  edge_ids: string[];
  warmth: Edge["warmth"];          // weakest link
  needs_permission: boolean;      // some intermediate hop lacks intro_permission
  last_contact: string | null;    // most recent contact on the first hop
  score: number;
}

const W: Record<string, number> = { trusted: 4, hot: 3, warm: 2, cold: 1 };
const wv = (w: Edge["warmth"]) => (w ? W[w] : 0);
const weakest = (a: Edge["warmth"], b: Edge["warmth"]): Edge["warmth"] => (wv(a) <= wv(b) ? a : b);

/** BFS up to two hops from the adviser (me) and colleagues to each target person. */
export function findIntroPaths(edges: Edge[], me: string, targets: string[], today: string): IntroPath[] {
  const live = edges.filter((e) => !e.valid_to || e.valid_to >= today);
  const targetSet = new Set(targets);
  const out: IntroPath[] = [];
  const fromUser = live.filter((e) => e.from_user_id);
  const byFromPerson = new Map<string, Edge[]>();
  for (const e of live) if (e.from_person_id) byFromPerson.set(e.from_person_id, [...(byFromPerson.get(e.from_person_id) ?? []), e]);

  for (const e of fromUser) {
    const isMe = e.from_user_id === me;
    const start = { kind: isMe ? "me" as const : "colleague" as const, id: e.from_user_id! };
    // direct
    if (targetSet.has(e.to_person_id)) {
      out.push({
        target_person_id: e.to_person_id, hops: [start, { kind: "person", id: e.to_person_id }], edge_ids: [e.id], warmth: e.warmth,
        needs_permission: !isMe && !e.intro_permission, last_contact: e.last_meaningful_contact, score: 0,
      });
    }
    // two hops: (me|colleague) -> P1 -> target ; P1 must have recorded intro permission
    for (const e2 of byFromPerson.get(e.to_person_id) ?? []) {
      if (!targetSet.has(e2.to_person_id) || e2.to_person_id === e.to_person_id) continue;
      out.push({
        target_person_id: e2.to_person_id,
        hops: [start, { kind: "person", id: e.to_person_id }, { kind: "person", id: e2.to_person_id }],
        edge_ids: [e.id, e2.id], warmth: weakest(e.warmth, e2.warmth),
        needs_permission: !e2.intro_permission || (!isMe && !e.intro_permission), last_contact: e.last_meaningful_contact, score: 0,
      });
    }
  }
  for (const p of out) {
    p.score = wv(p.warmth) * 10 - (p.hops.length - 2) * 5 - (p.needs_permission ? 20 : 0) + (p.hops[0].kind === "me" ? 3 : 0);
  }
  // keep best path per (target, hop sequence)
  const uniq = new Map<string, IntroPath>();
  for (const p of out) {
    const k = p.hops.map((h) => h.id).join(">");
    const cur = uniq.get(k);
    if (!cur || p.score > cur.score) uniq.set(k, p);
  }
  return [...uniq.values()].sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ multi-threading gap detector
export interface StakeholderLite { person_id: string; role: string; employment_current: boolean | null }
export interface ThreadingGap { kind: "one_person_dependency" | "no_stakeholders" | "missing_economic_buyer" | "procurement_not_involved" | "legal_not_involved" | "stakeholder_left"; severity: "low" | "medium" | "high"; detail: string }

const STAGE_ORDER = ["research", "approach_attempted", "engaged", "qualified_discussion", "requirement_confirmed", "options_visits", "proposal_negotiation", "loi", "documentation", "signed", "possession", "invoiced", "recognised", "collected"];
export const stageIndex = (s: string) => STAGE_ORDER.indexOf(s);
export const STAGES = STAGE_ORDER;

export function detectThreadingGaps(stage: string, stakeholders: StakeholderLite[]): ThreadingGap[] {
  const gaps: ThreadingGap[] = [];
  const idx = stageIndex(stage);
  const people = new Set(stakeholders.map((s) => s.person_id));
  const roles = new Set(stakeholders.map((s) => s.role));
  const late = idx >= stageIndex("proposal_negotiation");
  if (people.size === 0) {
    if (idx >= stageIndex("engaged")) gaps.push({ kind: "no_stakeholders", severity: idx >= stageIndex("requirement_confirmed") ? "high" : "medium", detail: "No stakeholders recorded for this deal." });
    return gaps;
  }
  if (people.size === 1) gaps.push({ kind: "one_person_dependency", severity: idx >= stageIndex("requirement_confirmed") ? "high" : "medium", detail: "Only one contact is engaged — the deal depends on a single person." });
  if (!roles.has("finance") && !roles.has("approver") && !roles.has("sponsor")) {
    gaps.push({ kind: "missing_economic_buyer", severity: idx >= stageIndex("qualified_discussion") ? "high" : "medium", detail: "No economic buyer (sponsor / approver / finance) identified." });
  }
  if (!roles.has("procurement") && idx >= stageIndex("options_visits")) gaps.push({ kind: "procurement_not_involved", severity: late ? "high" : "medium", detail: "Procurement not involved yet — vendor onboarding / RFP lead times may bite." });
  if (!roles.has("legal") && idx >= stageIndex("proposal_negotiation")) gaps.push({ kind: "legal_not_involved", severity: "high", detail: "Tenant legal not involved at negotiation/LOI stage." });
  const left = stakeholders.filter((s) => s.employment_current === false);
  if (left.length) gaps.push({ kind: "stakeholder_left", severity: "high", detail: `${left.length} stakeholder(s) no longer current at the company — re-map the decision committee.` });
  return gaps;
}
