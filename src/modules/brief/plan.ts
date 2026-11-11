import "server-only";
/**
 * Daily plan (07:20): priority adviser + calendar capacity controller → daily_plan row keyed by
 * user + local date + input version (spec Part III "Daily plan" dedupe). Works with ctx.db (RLS) or admin + access.
 */
import { stableHash } from "@/lib/util/crypto";
import { componentRows, isWorkday, type TargetView } from "./builder";
import { buildAgenda, type AgendaDeadline, type AgendaDep, type AgendaTask, type DayAgenda } from "./agenda";
import { computeRelationshipSuggestions } from "./caretaker-data";
import { daysBetween } from "./dates";
import { activeSnoozes, fetchAll, loadUserPrefs } from "./db";
import { loadApprovals, loadApproaches, loadMeetings, loadReplies, orgNames, type LoadCtx } from "./data";
import { upcomingEventFacts, type RadarItem } from "./lease-radar";
import { loadRadar } from "./radar-data";
import { visible } from "./visibility";
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
  agenda: DayAgenda | null;
  generatedAt: string;
  persisted: boolean;
  /** Where the priority scores came from (legacy fallback is labelled on screen). */
  scoreSource?: ScoreSource;
}

/** Lease windows (≤ 30 days) for the day order: notice, break, expiry, rent escalation and option are separate kinds. */
export function radarDeadlines(items: RadarItem[], today: string): AgendaDeadline[] {
  const out: AgendaDeadline[] = [];
  for (const r of items) {
    if (r.status !== "active") continue;
    const tenant = r.tenantName ?? "Unknown tenant";
    const push = (kind: string, f: { date: string; basisLabel: string; verified: boolean }) => {
      const days = daysBetween(today, f.date);
      if (days >= 0 && days <= 30) out.push({ leaseId: r.leaseId, tenant, kind, date: f.date, days, basisLabel: f.basisLabel, verified: f.verified });
    };
    if (r.noticeDeadline) push("notice", r.noticeDeadline);
    for (const b of r.breaks) push("break", b);
    if (r.expiry) push("expiry", r.expiry);
    for (const u of upcomingEventFacts(r, today, 30)) push(u.kind, u.fact);
  }
  return out.sort((a, b) => a.days - b.days || a.tenant.localeCompare(b.tenant));
}

const TASK_COLS = "id, title, due_at, priority, status, snoozed_until, depends_on, source, idempotency_key, linked_entity_type, linked_entity_id, assigned_user_id, classification, owner_user_id, archived_at";

/** The user's open tasks with dependency info, plus the (visible) tasks they depend on in any state. */
export async function loadAgendaTasks(c: LoadCtx): Promise<{ tasks: AgendaTask[]; deps: AgendaDep[] }> {
  let rows = await fetchAll((f, t) => c.db.from("task").select(TASK_COLS)
    .eq("workspace_id", c.workspaceId).is("archived_at", null).in("status", ["open", "snoozed", "stale"])
    .or(`assigned_user_id.eq.${c.userId},and(assigned_user_id.is.null,owner_user_id.eq.${c.userId})`).order("id").range(f, t), { cap: 5000 });
  if (c.access) rows = visible(c.access, rows, "task");
  const depIds = [...new Set(rows.map((r) => r.depends_on).filter(Boolean))] as string[];
  const deps: AgendaDep[] = [];
  for (let k = 0; k < depIds.length; k += 200) {
    const { data } = await c.db.from("task").select("id, title, status, classification, owner_user_id, archived_at").eq("workspace_id", c.workspaceId).in("id", depIds.slice(k, k + 200));
    // an archived dependency no longer blocks; an invisible one stays "a prerequisite you cannot see"
    for (const d of (c.access ? (data ?? []).filter((x: any) => !x.archived_at && visible(c.access!, [x], "task").length) : data ?? []) as any[]) {
      deps.push({ id: d.id, title: d.title, status: d.archived_at ? "cancelled" : d.status });
    }
  }
  return {
    tasks: rows.map((t: any) => ({ id: t.id, title: t.title, dueAt: t.due_at, priority: t.priority, status: t.status, snoozedUntil: t.snoozed_until, dependsOn: t.depends_on,
      source: t.source, idempotencyKey: t.idempotency_key, linkedEntityType: t.linked_entity_type, linkedEntityId: t.linked_entity_id })),
    deps,
  };
}

export interface ScoreRow { subject_id: string; total: number | string; tier: Tier; overrides: string[]; components: Record<string, any>; evidence_confidence: string | null; warmth: string | null; computed_at: string }

/** Module 3 `score_result` row (lead model) as read for the plan. */
export interface ScoreResultRow {
  entity_id: string; score: number; band: string; disqualified: boolean; confidence: string; completeness: number;
  factors: { key: string; label: string; points: number; max: number; known: boolean; explanation: string }[] | null;
  missing: string[] | null; recommended_action: string | null; calculated_at: string;
}
export type ScoreSource = "score_result" | "lead_score_legacy" | "none";

/** Lead-model factor → legacy component key (so the priority adviser / breakdown keep working). */
const FACTOR_TO_COMPONENT: Record<string, ComponentKey> = { timing: "timing", fit: "fit", budget: "budget", engagement: "engagement", authority: "relationship", need: "trigger" };

/** Tier from the current lead model. Unknown ≠ low: an "insufficient" score is parked for enrichment, not ranked low. */
export function tierFromScoreResult(r: Pick<ScoreResultRow, "score" | "disqualified" | "confidence">): Tier {
  if (r.disqualified) return "suppressed";
  if (r.confidence === "insufficient") return "enrich_or_park";
  return r.score >= 60 ? "act_this_week" : r.score >= 40 ? "validate_nurture" : "enrich_or_park";
}

/** Pure mapping score_result → ScoreRow (deterministic; no arithmetic beyond copying the stored points). */
export function scoreResultToRow(r: ScoreResultRow): ScoreRow {
  const components: Record<string, { points: number; max: number; band: string; evidence: string[] }> = {};
  for (const f of r.factors ?? []) {
    const k = FACTOR_TO_COMPONENT[f.key];
    if (!k) continue;
    components[k] = { points: Number(f.points ?? 0), max: Number(f.max ?? 0), band: f.known ? "known" : "unknown", evidence: f.explanation ? [f.explanation] : [] };
  }
  const evidence = (r.factors ?? []).find((f) => f.key === "evidence");
  return {
    subject_id: r.entity_id, total: r.score, tier: tierFromScoreResult(r), overrides: [], components,
    evidence_confidence: evidence?.known && Number(evidence.points) > 0 ? "credible_reported" : "none", warmth: null, computed_at: r.calculated_at,
  };
}

/**
 * Current priority scores. Source of truth is Module 3 `score_result` (model_key = lead, is_current). Only when the
 * workspace has NO lead score_result rows at all do we fall back to the legacy `lead_score` table — labelled.
 */
export async function loadCurrentScoresWithSource(c: LoadCtx): Promise<{ source: ScoreSource; rows: (ScoreRow & { name: string })[] }> {
  const sr = await fetchAll<ScoreResultRow>((f, t) => c.db.from("score_result")
    .select("entity_id, score, band, disqualified, confidence, completeness, factors, missing, recommended_action, calculated_at")
    .eq("workspace_id", c.workspaceId).eq("model_key", "lead").eq("entity_type", "organisation").eq("is_current", true)
    .is("archived_at", null).order("id").range(f, t), { cap: 20_000 });
  let rows: ScoreRow[];
  let source: ScoreSource;
  if (sr.length) { rows = sr.map(scoreResultToRow); source = "score_result"; }
  else {
    rows = await fetchAll<ScoreRow>((f, t) => c.db.from("lead_score")
      .select("id, subject_id, total, tier, overrides, components, evidence_confidence, warmth, computed_at")
      .eq("workspace_id", c.workspaceId).eq("subject_type", "organisation").eq("is_current", true).eq("score_version", SCORE_VERSION)
      .is("archived_at", null).order("id").range(f, t), { cap: 20_000 });
    source = rows.length ? "lead_score_legacy" : "none";
  }
  // visibility follows the organisation (shares are on the org, not on the score row)
  const names = await orgNames(c, rows.map((r) => r.subject_id));
  return { source, rows: rows.filter((r) => names.has(r.subject_id)).map((r) => ({ ...r, name: names.get(r.subject_id)! })) };
}

export async function loadCurrentScores(c: LoadCtx): Promise<(ScoreRow & { name: string })[]> {
  return (await loadCurrentScoresWithSource(c)).rows;
}

function toCandidate(r: ScoreRow & { name: string }, approached: Set<string>): Candidate {
  const comps = r.components ?? {};
  const deadline = (r.overrides ?? []).includes("deadline_within_90d");
  // score_result rows carry no legacy deadline override; nextDeadline stays unknown (S6) rather than guessed
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

export async function computeDailyPlan(c: LoadCtx, settings: BriefSettings, date: string, opts: { now?: Date } = {}): Promise<Omit<DailyPlan, "id" | "persisted" | "generatedAt">> {
  const workday = isWorkday(date, settings.workdays);
  const now = opts.now ?? new Date();
  const [scored, approaches, meetings, approvals, prefs, agendaTasks, replies, radar] = await Promise.all([
    loadCurrentScoresWithSource(c), loadApproaches(c, date), loadMeetings(c, date), loadApprovals(c), loadUserPrefs(c.db, c.workspaceId, c.userId),
    loadAgendaTasks(c), loadReplies(c, new Date(now.getTime() - 24 * 3_600_000).toISOString()), loadRadar(c.db, c.workspaceId, date, settings, c.access ?? undefined),
  ]);
  const scores = scored.rows;
  const rel = await computeRelationshipSuggestions(c.db, c.workspaceId, date, radar.items, { access: c.access, userId: c.userId });
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
  const agenda = buildAgenda({
    date, now: now.toISOString(), tz: c.tz, isWorkday: workday, settings: settings.capacity,
    meetings, tasks: agendaTasks.tasks, deps: agendaTasks.deps, approvals, replies,
    deadlines: radarDeadlines(radar.items, date),
    targets: targets.map((t) => ({ orgId: t.orgId, name: t.name, effortMinutes: t.effortMinutes, slot: t.slot, why: t.why, total: t.total })),
    relationship: rel.suggestions.slice(0, 12),
  });
  const inputVersion = stableHash({
    s: scores.map((x) => [x.subject_id, Number(x.total), x.tier, x.computed_at]).sort(),
    m: meetings.map((x) => [x.id, x.startAt, x.endAt, x.status]),
    a: approvals.changes + approvals.drafts, z: [...snoozed].sort(), cap: settings.capacity, ap: approaches.approached.size,
    g: agenda,
  }).slice(0, 24);
  return { planDate: date, inputVersion, scoreSource: scored.source, mode: capacity.mode, capacity, targets, displaced: sel.displaced, agenda };
}

/** Compute + store (idempotent on user+date+input version). Viewers (no insert right) still get the computed plan. */
export async function buildDailyPlan(c: LoadCtx, settings: BriefSettings, date: string, opts: { now?: Date; reason?: string } = {}): Promise<DailyPlan> {
  const p = await computeDailyPlan(c, settings, date, { now: opts.now });
  const row = {
    workspace_id: c.workspaceId, user_id: c.userId, plan_date: date, input_version: p.inputVersion, mode: p.mode,
    capacity: p.capacity, items: p.targets, displaced: p.displaced, rubric_version: SCORE_VERSION, owner_user_id: c.userId,
    agenda: p.agenda ?? {}, trigger_reason: opts.reason ?? "scheduled", generated_at: new Date().toISOString(),
  };
  // same input version => same row, re-stamped so the latest plan is always the one shown (A → B → A stays correct)
  const { error } = await c.db.from("daily_plan").upsert(row, { onConflict: "workspace_id,user_id,plan_date,input_version" });
  const { data } = await c.db.from("daily_plan").select("id, generated_at").eq("workspace_id", c.workspaceId).eq("user_id", c.userId)
    .eq("plan_date", date).eq("input_version", p.inputVersion).maybeSingle();
  return { ...p, id: data?.id ?? null, generatedAt: data?.generated_at ?? new Date().toISOString(), persisted: !error && !!data };
}

export async function latestPlan(c: LoadCtx, date: string): Promise<DailyPlan | null> {
  const { data } = await c.db.from("daily_plan").select("id, plan_date, input_version, mode, capacity, items, displaced, agenda, generated_at")
    .eq("workspace_id", c.workspaceId).eq("user_id", c.userId).eq("plan_date", date).is("archived_at", null)
    .order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  return {
    id: data.id, planDate: data.plan_date, inputVersion: data.input_version, mode: data.mode, capacity: data.capacity,
    targets: data.items ?? [], displaced: data.displaced ?? [], agenda: data.agenda && (data.agenda as DayAgenda).version ? (data.agenda as DayAgenda) : null,
    generatedAt: data.generated_at, persisted: true,
  };
}

export type { ComponentKey };
