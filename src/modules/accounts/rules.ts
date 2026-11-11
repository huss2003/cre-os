/** Pure rules for the account & contact workspaces. No I/O, no LLM: everything here is deterministic and unit-tested. */

// ---------- Relationship level (spec 2.3) ----------
export const LEVELS = ["not_interacted", "spoke_on_call", "met_once", "met_few", "good", "not_interested"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<Level, string> = {
  not_interacted: "Not interacted", spoke_on_call: "Spoke on call", met_once: "Met once",
  met_few: "Met a few times", good: "Good relationship", not_interested: "Not interested in working with us",
};
export const LEVEL_TONE: Record<Level, "neutral" | "brand" | "ok" | "warn" | "bad"> = {
  not_interacted: "neutral", spoke_on_call: "brand", met_once: "brand", met_few: "ok", good: "ok", not_interested: "bad",
};
export const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as readonly string[]).includes(v);

export type IntLite = { channel: string; direction?: string | null; occurred_at?: string | null; objections?: unknown };
export type Suggestion = { level: Exclude<Level, "good">; reason: string };

/**
 * Suggest a level from recorded interactions. Only a suggestion: never written automatically,
 * and never "Good relationship" — that is a judgement only a person on the team can make.
 */
export function suggestLevel(ints: IntLite[]): Suggestion {
  const latest = [...ints].sort((a, b) => String(b.occurred_at ?? "").localeCompare(String(a.occurred_at ?? ""))).slice(0, 3);
  const declined = latest.find((i) => /not interested|do not contact|no longer interested|stop contacting/i.test(JSON.stringify(i.objections ?? "")));
  if (declined) return { level: "not_interested", reason: "A recent interaction records an objection saying they are not interested." };
  const meetings = ints.filter((i) => i.channel === "meeting" || i.channel === "visit").length;
  const calls = ints.filter((i) => i.channel === "call").length;
  const inbound = ints.filter((i) => i.direction === "inbound").length;
  if (meetings >= 2) return { level: "met_few", reason: `${meetings} meetings or visits recorded.` };
  if (meetings === 1) return { level: "met_once", reason: "One meeting or visit recorded." };
  if (calls) return { level: "spoke_on_call", reason: `${calls} call${calls > 1 ? "s" : ""} recorded, no meeting yet.` };
  if (inbound) return { level: "spoke_on_call", reason: `${inbound} inbound repl${inbound > 1 ? "ies" : "y"} recorded, no call or meeting yet.` };
  return { level: "not_interacted", reason: ints.length ? "Only outbound messages or notes recorded; no reply, call or meeting." : "No interactions recorded." };
}

// ---------- Stakeholder map (spec 5.2 / 5 visible result) ----------
export const FUNCTIONS = ["real_estate", "finance", "procurement", "hr_admin", "it", "leadership", "operations", "other"] as const;
export type Fn = (typeof FUNCTIONS)[number];
export const FUNCTION_LABEL: Record<Fn, string> = {
  real_estate: "Real estate & workplace", finance: "Finance", procurement: "Procurement", hr_admin: "HR & admin",
  it: "IT & technology", leadership: "Leadership", operations: "Operations", other: "Other / unknown function",
};
export function functionOf(dept: string | null | undefined, title: string | null | undefined): Fn {
  const t = `${dept ?? ""} ${title ?? ""}`.toLowerCase();
  if (/real estate|workplace|facilit|\bcre\b|property|premises/.test(t)) return "real_estate";
  if (/financ|\bcfo\b|controller|treasur|account/.test(t)) return "finance";
  if (/procure|purchas|sourcing|vendor/.test(t)) return "procurement";
  if (/\bhr\b|human res|people|talent|admin/.test(t)) return "hr_admin";
  if (/\bit\b|technolog|\bcto\b|\bcio\b|infra|engineering/.test(t)) return "it";
  if (/\bceo\b|managing director|\bmd\b|country head|president|founder|site leader|\bvp\b|vice president|director/.test(t)) return "leadership";
  if (/operat|\bcoo\b|delivery/.test(t)) return "operations";
  return "other";
}
export const INFLUENCE = ["decides", "approves", "influences", "uses", "unknown"] as const;
export type Influence = (typeof INFLUENCE)[number];
export const INFLUENCE_LABEL: Record<Influence, string> = { decides: "Decides", approves: "Approves / signs", influences: "Influences", uses: "Uses the space", unknown: "Influence unknown" };
export function influenceOf(roleClass: string | null | undefined, stakeholderRoles: string[]): Influence {
  const r = `${roleClass ?? ""} ${stakeholderRoles.join(" ")}`.toLowerCase();
  if (/decision_maker|decision maker|decider/.test(r)) return "decides";
  if (/economic_buyer|approver|signator|financial|procurement/.test(r)) return "approves";
  if (/influencer|technical_evaluator|champion|evaluator|gatekeeper/.test(r)) return "influences";
  if (/operational|administrative|user/.test(r)) return "uses";
  return "unknown";
}

export type StakePerson = {
  personId: string; name: string; title: string | null; department: string | null; roleClass: string | null;
  stakeholderRoles: string[]; level: Level | null; channel: { type: string; verifiedOn: string | null } | null; current: boolean;
};
export type StakeGroup = { fn: Fn; label: string; people: (StakePerson & { influence: Influence })[] };

/** Buying group grouped by function, people ordered by influence. Past employees are excluded (history is kept on the person). */
export function groupStakeholders(people: StakePerson[]): StakeGroup[] {
  const rank = (i: Influence) => INFLUENCE.indexOf(i);
  const by = new Map<Fn, StakeGroup>();
  for (const p of people) {
    if (!p.current) continue;
    const fn = functionOf(p.department, p.title);
    const g = by.get(fn) ?? { fn, label: FUNCTION_LABEL[fn], people: [] };
    if (!g.people.some((x) => x.personId === p.personId)) g.people.push({ ...p, influence: influenceOf(p.roleClass, p.stakeholderRoles) });
    by.set(fn, g);
  }
  const groups = [...by.values()];
  for (const g of groups) g.people.sort((a, b) => rank(a.influence) - rank(b.influence) || a.name.localeCompare(b.name));
  return groups.sort((a, b) => FUNCTIONS.indexOf(a.fn) - FUNCTIONS.indexOf(b.fn));
}

/** Best channel: verified first (newest verification), then unverified; suppressed never counts. Returns null when none. */
export function bestChannel(methods: { method_type: string; verified_on: string | null; verify_status?: string | null; suppressed?: boolean | null }[]) {
  const ok = methods.filter((m) => !m.suppressed && m.verify_status !== "invalid");
  const v = ok.filter((m) => m.verified_on || m.verify_status === "verified").sort((a, b) => String(b.verified_on ?? "").localeCompare(String(a.verified_on ?? "")));
  const pick = v[0] ?? null;
  return pick ? { type: pick.method_type, verifiedOn: pick.verified_on } : null;
}

// ---------- What changed since you last looked ----------
export type Stamped = { id: string; label: string; created_at: string; updated_at?: string | null };
export type ChangeKind = "signal" | "score" | "interaction" | "requirement" | "lease";
export type Change = { kind: ChangeKind; id: string; label: string; what: "new" | "updated"; at: string };

/** Rows created or updated after `since`. First visit (since = null) returns nothing — there is no baseline to diff against. */
export function diffSince(since: string | null, sets: Partial<Record<ChangeKind, Stamped[]>>): Change[] {
  if (!since) return [];
  const t = Date.parse(since);
  const out: Change[] = [];
  for (const [kind, rows] of Object.entries(sets) as [ChangeKind, Stamped[]][]) {
    for (const r of rows ?? []) {
      const c = Date.parse(r.created_at), u = r.updated_at ? Date.parse(r.updated_at) : NaN;
      if (c > t) out.push({ kind, id: r.id, label: r.label, what: "new", at: r.created_at });
      else if (u > t) out.push({ kind, id: r.id, label: r.label, what: "updated", at: r.updated_at! });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Score history delta: current vs the previous calculation of the same model/entity. Unknown previous stays unknown. */
export function scoreDelta(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null) return null;
  return current - previous;
}

// ---------- Next actions (deterministic) ----------
export type NextActionInput = {
  orgId: string;
  openOppsWithAction: { id: string; name: string; next_action: string | null; next_action_due: string | null }[];
  requirements: { id: string; title: string; missing: string[] }[];
  leaseEvents: { lease_id: string; event_type: string; event_date: string }[];
  peopleCount: number;
  hasDecider: boolean;
  lastInteractionAt: string | null;
  unverifiedSignals: number;
  today: string;
};
export type NextAction = { key: string; text: string; why: string; href: string; due?: string | null };
export function nextActions(i: NextActionInput): NextAction[] {
  const out: NextAction[] = [];
  for (const o of i.openOppsWithAction) if (o.next_action) out.push({ key: `opp:${o.id}`, text: o.next_action, why: `Next step recorded on ${o.name}`, href: `/deals/${o.id}`, due: o.next_action_due });
  const horizon = new Date(Date.parse(i.today) + 365 * 864e5).toISOString().slice(0, 10);
  for (const e of i.leaseEvents) if (e.event_date >= i.today && e.event_date <= horizon)
    out.push({ key: `lease:${e.lease_id}:${e.event_type}`, text: `Prepare for ${e.event_type.replace(/_/g, " ")} on ${e.event_date}`, why: "Lease event within 12 months", href: `/leases`, due: e.event_date });
  for (const r of i.requirements) if (r.missing.length) out.push({ key: `req:${r.id}`, text: `Confirm ${r.missing.slice(0, 3).join(", ")} for ${r.title}`, why: "Requirement is missing information", href: `/requirements/${r.id}` });
  if (!i.peopleCount) out.push({ key: "people", text: "Find the people involved in office decisions", why: "No contacts recorded at this company", href: `/contacts/company/${i.orgId}` });
  else if (!i.hasDecider) out.push({ key: "decider", text: "Identify who decides on office space", why: "No decision-maker mapped yet", href: `/contacts/company/${i.orgId}` });
  if (!i.lastInteractionAt) out.push({ key: "first-touch", text: "Plan a first conversation", why: "No interaction recorded", href: `/companies/${i.orgId}?tab=people` });
  else if (Date.parse(i.today) - Date.parse(i.lastInteractionAt) > 60 * 864e5) out.push({ key: "stale", text: "Re-engage — last contact over 60 days ago", why: `Last interaction ${i.lastInteractionAt.slice(0, 10)}`, href: `/companies/${i.orgId}?tab=people` });
  if (i.unverifiedSignals) out.push({ key: "signals", text: `Verify ${i.unverifiedSignals} reported signal${i.unverifiedSignals > 1 ? "s" : ""}`, why: "Reported, not confirmed", href: `/research` });
  return out.sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
}

// ---------- Time-boxing ----------
export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };
/** Resolve within `ms` or return a visible failure (spec S10). Never throws. */
export async function timeboxed<T>(p: PromiseLike<T> | (() => PromiseLike<T>), ms = 4000): Promise<Loaded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = typeof p === "function" ? p() : p;
    const data = await Promise.race([Promise.resolve(run), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`Timed out after ${ms / 1000}s`)), ms); })]);
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  finally { if (timer) clearTimeout(timer); }
}
