import "server-only";
/**
 * Daily plan (07:20): priority adviser + calendar capacity controller → daily_plan row keyed by
 * user + local date + input version (spec Part III "Daily plan" dedupe). Works with ctx.db (RLS) or admin + access.
 */
import { stableHash } from "@/lib/util/crypto";
import { componentRows, isWorkday, type TargetView } from "./builder";
import { activeSnoozes, fetchAll, loadUserPrefs } from "./db";
import { loadApprovals, loadApproaches, loadMeetings, orgNames, type LoadCtx } from "./data";
import { computeCapacity, selectTargets, type Candidate, type Capacity, type DisplacedCandidate } from "./priority";
import { SCORE_VERSION, type ComponentKey, type Tier } from "./scoring";
import type { BriefSettings } from "./settings";

export interface DailyPlan {
  id: string | null;
  planDate: string;
  inputVersion: string;
  mode: "workday" | "light";
  capacity: Capacity;
  targets: TargetView[];
  displaced: DisplacedCandidate[];
  generatedAt: string;
  persisted: boolean;
}

export interface ScoreRow { subject_id: string; total: number | string; tier: Tier; overrides: string[]; components: Record<string, any>; evidence_confidence: string | null; warmth: string | null; computed_at: string }

export async function loadCurrentScores(c: LoadCtx): Promise<(ScoreRow & { name: string })[]> {
  const rows = await fetchAll<ScoreRow & { classification: string; owner_user_id: string | null; archived_at: string | null; id: string }>((f, t) => c.db.from("lead_score")
    .select("id, subject_id, total, tier, overrides, components, evidence_confidence, warmth, computed_at, classification, owner_user_id, archived_at")
    .eq("workspace_id", c.workspaceId).eq("subject_type", "organisation").eq("is_current", true).eq("score_version", SCORE_VERSION)
    .is("archived_at", null).order("id").range(f, t), { cap: 20_000 });
  // visibility follows the organisation (shares are on the org, not on lead_score)
  const names = await orgNames(c, rows.map((r) => r.subject_id));
  return rows.filter((r) => names.has(r.subject_id)).map((r) => ({ ...r, name: names.get(r.subject_id)! }));
}

function toCandidate(r: ScoreRow & { name: string }, approached: Set<string>): Candidate {
  const comps = r.components ?? {};
  const deadline = (r.overrides ?? []).includes("deadline_within_90d");
  // nextDeadline is not stored on lead_score; recover the date from the timing evidence line when present
  const m = deadline ? /(\d{4}-\d{2}-\d{2}) \((\d+) days/.exec((comps.timing?.evidence ?? []).join(" ")) : null;
  return {
    orgId: r.subject_id, name: r.name, tier: r.tier,
    hasContactPath: Number(comps.relationship?.points ?? 0) > 0,
    approachedBefore: approached.has(r.subject_id),
    score: {
      total: Number(r.total), tier: r.tier, overrides: r.overrides ?? [], evidenceConfidence: (r.evidence_confidence ?? "none") as never, warmth: (r.warmth ?? "cold") as never,
      nextDeadline: m ? { date: m[1], days: Number(m[2]), kind: /Decision/.test(comps.timing?.evidence?.[0] ?? "") ? "decision" : "notice" } : null,
      flags: { deadlineWithin90: deadline, statusNeedsConfirmation: false, needsEnrichment: false, unverifiedDates: false },
      components: comps as never,
    },
  };
}

export async function computeDailyPlan(c: LoadCtx, settings: BriefSettings, date: string): Promise<Omit<DailyPlan, "id" | "persisted" | "generatedAt">> {
  const workday = isWorkday(date, settings.workdays);
  const [scores, approaches, meetings, approvals, prefs] = await Promise.all([
    loadCurrentScores(c), loadApproaches(c, date), loadMeetings(c, date), loadApprovals(c), loadUserPrefs(c.db, c.workspaceId, c.userId),
  ]);
  const snoozed = activeSnoozes(prefs, date);
  const capacity = computeCapacity({
    meetings: meetings.map((m) => ({ ...m, kind: m.kind as never })), isWorkday: workday,
    approvalsPending: approvals.changes + approvals.drafts, settings: settings.capacity,
  });
  const byOrg = new Map(scores.map((s) => [s.subject_id, s]));
  const candidates = scores.map((s) => toCandidate(s, approaches.approached));
  const sel = selectTargets(candidates, capacity, { settings: settings.capacity, snoozed });
  const targets: TargetView[] = sel.targets.map((t) => {
    const s = byOrg.get(t.orgId)!;
    return {
      ...t, components: componentRows(s.components), overrides: s.overrides ?? [], evidenceConfidence: s.evidence_confidence ?? "none",
      warmth: s.warmth ?? "cold", enrichment: [],
    };
  });
  const inputVersion = stableHash({
    s: scores.map((x) => [x.subject_id, Number(x.total), x.tier, x.computed_at]).sort(),
    m: meetings.map((x) => [x.id, x.startAt, x.endAt, x.status]),
    a: approvals.changes + approvals.drafts, z: [...snoozed].sort(), cap: settings.capacity, ap: approaches.approached.size,
  }).slice(0, 24);
  return { planDate: date, inputVersion, mode: capacity.mode, capacity, targets, displaced: sel.displaced };
}

/** Compute + store (idempotent on user+date+input version). Viewers (no insert right) still get the computed plan. */
export async function buildDailyPlan(c: LoadCtx, settings: BriefSettings, date: string): Promise<DailyPlan> {
  const p = await computeDailyPlan(c, settings, date);
  const row = {
    workspace_id: c.workspaceId, user_id: c.userId, plan_date: date, input_version: p.inputVersion, mode: p.mode,
    capacity: p.capacity, items: p.targets, displaced: p.displaced, rubric_version: SCORE_VERSION, owner_user_id: c.userId,
  };
  const { error } = await c.db.from("daily_plan").upsert(row, { onConflict: "workspace_id,user_id,plan_date,input_version", ignoreDuplicates: true });
  const { data } = await c.db.from("daily_plan").select("id, generated_at").eq("workspace_id", c.workspaceId).eq("user_id", c.userId)
    .eq("plan_date", date).eq("input_version", p.inputVersion).maybeSingle();
  return { ...p, id: data?.id ?? null, generatedAt: data?.generated_at ?? new Date().toISOString(), persisted: !error && !!data };
}

export async function latestPlan(c: LoadCtx, date: string): Promise<DailyPlan | null> {
  const { data } = await c.db.from("daily_plan").select("id, plan_date, input_version, mode, capacity, items, displaced, generated_at")
    .eq("workspace_id", c.workspaceId).eq("user_id", c.userId).eq("plan_date", date).is("archived_at", null)
    .order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  return {
    id: data.id, planDate: data.plan_date, inputVersion: data.input_version, mode: data.mode, capacity: data.capacity,
    targets: data.items ?? [], displaced: data.displaced ?? [], generatedAt: data.generated_at, persisted: true,
  };
}

export type { ComponentKey };
