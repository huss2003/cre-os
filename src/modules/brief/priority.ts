/**
 * Priority adviser + calendar capacity controller (spec Part I §8, §9 "Suggested daily selection"). PURE.
 *
 * Selection: deadline override first; then score relative to effort, capped by available call time and a target
 * count; 10–20% of slots reserved for new-prospect exploration. Every selected target says which candidate it
 * displaced and why. No opaque optimisation: ratio = score / effort minutes.
 */
import type { CapacitySettings } from "./settings";
import { BRIEF_DEFAULTS, minutesOf } from "./settings";
import type { ScoreResult, Tier } from "./scoring";

export interface MeetingLite {
  id: string;
  title: string | null;
  startAt: string;
  endAt: string;
  kind: "meeting" | "site_visit" | "call" | "internal";
  status: string;
  location?: string | null;
}

export type ProductionLevel = "normal" | "reduced" | "paused";

export interface Capacity {
  mode: "workday" | "light";
  workdayMinutes: number;
  meetingMinutes: number;
  travelBufferMinutes: number;
  freeMinutes: number;
  callMinutesAvailable: number;
  maxTargets: number;
  researchDraftLevel: ProductionLevel;
  approvalsPending: number;
  reasons: string[];
}

/** Calendar capacity controller: reduce research/draft production when calls and approvals are already full. */
export function computeCapacity(opts: {
  meetings: MeetingLite[];
  isWorkday: boolean;
  approvalsPending: number;
  settings?: CapacitySettings;
}): Capacity {
  const s = opts.settings ?? BRIEF_DEFAULTS.capacity;
  const workdayMinutes = Math.max(0, minutesOf(s.workdayEnd) - minutesOf(s.workdayStart));
  const active = opts.meetings.filter((m) => m.status !== "cancelled");
  let meetingMinutes = 0;
  let buffer = 0;
  for (const m of active) {
    const dur = Math.max(0, (Date.parse(m.endAt) - Date.parse(m.startAt)) / 60000);
    meetingMinutes += dur;
    if ((m.kind === "meeting" || m.kind === "site_visit") && m.location) buffer += s.travelBufferMinutes;
  }
  meetingMinutes = Math.round(meetingMinutes);
  const reasons: string[] = [];
  if (!opts.isWorkday) {
    return {
      mode: "light", workdayMinutes, meetingMinutes, travelBufferMinutes: buffer, freeMinutes: 0, callMinutesAvailable: 0, maxTargets: 0,
      researchDraftLevel: "paused", approvalsPending: opts.approvalsPending, reasons: ["Non-workday: light review only, no client-contact targets"],
    };
  }
  const freeMinutes = Math.max(0, workdayMinutes - meetingMinutes - buffer);
  const callMinutesAvailable = Math.max(0, Math.min(s.dailyCallMinutes, freeMinutes - s.adminReserveMinutes));
  const maxTargets = Math.min(s.maxDailyTargets, Math.floor(callMinutesAvailable / s.callMinutesPerTarget));
  let level: ProductionLevel = freeMinutes >= 240 ? "normal" : freeMinutes >= 120 ? "reduced" : "paused";
  if (level !== "normal") reasons.push(`Calendar is full: ${meetingMinutes} min meetings + ${buffer} min travel leaves ${freeMinutes} min free`);
  if (opts.approvalsPending >= s.approvalsFullThreshold) {
    level = level === "normal" ? "reduced" : "paused";
    reasons.push(`${opts.approvalsPending} approvals already pending — new drafts held back`);
  }
  if (callMinutesAvailable < s.dailyCallMinutes) reasons.push(`Call time capped at ${callMinutesAvailable} min`);
  return { mode: "workday", workdayMinutes, meetingMinutes, travelBufferMinutes: buffer, freeMinutes, callMinutesAvailable, maxTargets, researchDraftLevel: level, approvalsPending: opts.approvalsPending, reasons };
}

export interface Candidate {
  orgId: string;
  name: string;
  score: Pick<ScoreResult, "total" | "tier" | "overrides" | "nextDeadline" | "flags" | "evidenceConfidence" | "warmth"> & { components?: ScoreResult["components"] };
  hasContactPath: boolean;   // relationship component > 0 or a known contact
  approachedBefore: boolean; // any prior outbound/meaningful interaction
  tier: Tier;
}

export interface SelectedTarget {
  orgId: string;
  name: string;
  rank: number;
  slot: "deadline" | "exploit" | "exploration";
  effortMinutes: number;
  ratio: number;
  total: number;
  tier: Tier;
  why: string;
  displaced: { orgId: string; name: string; total: number; ratio: number } | null;
}

export interface DisplacedCandidate { orgId: string; name: string; total: number; ratio: number; reason: string }

export interface Selection {
  targets: SelectedTarget[];
  displaced: DisplacedCandidate[];
  minutesUsed: number;
  explorationSlots: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function selectTargets(candidates: Candidate[], capacity: Pick<Capacity, "callMinutesAvailable" | "maxTargets" | "mode">, opts: {
  settings?: CapacitySettings;
  snoozed?: Set<string>;
} = {}): Selection {
  const s = opts.settings ?? BRIEF_DEFAULTS.capacity;
  const snoozed = opts.snoozed ?? new Set<string>();
  const effort = (c: Candidate) => (c.hasContactPath ? s.callMinutesPerTarget : s.researchMinutesPerTarget);
  const ratio = (c: Candidate) => (effort(c) > 0 ? c.score.total / effort(c) : 0);
  const pool = candidates.filter((c) => c.tier !== "suppressed" && !snoozed.has(c.orgId));

  const deadlines = pool.filter((c) => c.score.overrides.includes("deadline_within_90d"))
    .sort((a, b) => (a.score.nextDeadline?.days ?? 999) - (b.score.nextDeadline?.days ?? 999) || b.score.total - a.score.total);
  const ranked = pool.filter((c) => !deadlines.includes(c))
    .sort((a, b) => ratio(b) - ratio(a) || b.score.total - a.score.total || a.name.localeCompare(b.name));

  const slots = capacity.mode === "light" ? 0 : capacity.maxTargets;
  const share = Math.min(0.2, Math.max(0.1, s.explorationShare));
  const explorationSlots = slots >= 5 ? Math.max(1, Math.min(Math.floor(slots * 0.2), Math.round(slots * share))) : 0;

  const chosen: { c: Candidate; slot: SelectedTarget["slot"] }[] = [];
  let minutes = 0;
  const fits = (c: Candidate) => minutes + effort(c) <= capacity.callMinutesAvailable;
  const take = (c: Candidate, slot: SelectedTarget["slot"]) => { chosen.push({ c, slot }); minutes += effort(c); };

  for (const c of deadlines) if (chosen.length < slots && fits(c)) take(c, "deadline");
  const exploitCap = slots - explorationSlots;
  for (const c of ranked) {
    if (chosen.length >= exploitCap) break;
    if (fits(c)) take(c, "exploit");
  }
  // exploration: best-scoring never-approached prospects not already chosen
  const explorers = ranked.filter((c) => !c.approachedBefore && !chosen.some((x) => x.c === c))
    .sort((a, b) => b.score.total - a.score.total || a.name.localeCompare(b.name));
  for (const c of explorers) {
    if (chosen.length >= slots || chosen.filter((x) => x.slot === "exploration").length >= explorationSlots) break;
    if (fits(c)) take(c, "exploration");
  }
  // backfill unused exploration slots with exploit candidates
  for (const c of ranked) {
    if (chosen.length >= slots) break;
    if (!chosen.some((x) => x.c === c) && fits(c)) take(c, "exploit");
  }

  const chosenSet = new Set(chosen.map((x) => x.c.orgId));
  const rest = [...deadlines, ...ranked].filter((c) => !chosenSet.has(c.orgId));
  const best = rest[0] ?? null;
  const bestLite = best ? { orgId: best.orgId, name: best.name, total: best.score.total, ratio: r1(ratio(best)) } : null;

  const targets: SelectedTarget[] = chosen.map(({ c, slot }, idx) => {
    let why: string;
    const rat = r1(ratio(c));
    if (slot === "deadline") {
      const d = c.score.nextDeadline;
      why = `Deadline override: ${d?.kind ?? "notice"} deadline ${d?.date ?? ""} in ${d?.days ?? "?"} days outranks score ordering`;
    } else if (slot === "exploration") {
      why = `Exploration slot (new prospect, ${Math.round(share * 100)}% reserve): score ${c.score.total}`;
    } else {
      why = `Score ${c.score.total} / ${effort(c)} min effort = ${rat} per minute`;
    }
    if (bestLite) {
      why += slot === "exploit"
        ? ` — displaced ${bestLite.name} (${bestLite.total} pts, ${bestLite.ratio}/min)`
        : ` — kept ahead of ${bestLite.name} (${bestLite.total} pts)`;
    } else {
      why += " — no competing candidate (capacity not binding)";
    }
    return { orgId: c.orgId, name: c.name, rank: idx + 1, slot, effortMinutes: effort(c), ratio: rat, total: c.score.total, tier: c.tier, why, displaced: bestLite };
  });

  const displaced: DisplacedCandidate[] = rest.slice(0, 20).map((c) => ({
    orgId: c.orgId, name: c.name, total: c.score.total, ratio: r1(ratio(c)),
    reason: slots === 0 ? "No call capacity today" : !fits(c) && chosen.length < slots ? "Call time exhausted" : "Below today's cut line",
  }));
  return { targets, displaced, minutesUsed: minutes, explorationSlots };
}
