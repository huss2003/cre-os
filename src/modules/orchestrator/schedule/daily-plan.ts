import "server-only";
/**
 * Daily 08:00 plan (spec §4.2, test 1 / 7). Extends the brief module's daily brief (it is generated if missing and
 * linked by brief_id) with the ten §4.2 sections, stored once per user + local date in mudar.orch_plan (re-runs update
 * the same row; no tasks are created). AI only adds an optional headline: when the provider is unavailable the plan is
 * still produced from tasks, meetings and calendar records and the AI part is marked "delayed" with a retry queued.
 */
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { enqueue } from "@/lib/jobs/queue";
import { localDate } from "@/lib/util/time";
import { generateDailyBrief, latestBrief } from "@/modules/brief/brief-service";
import { loadApprovals, loadMeetings, loadOpenTasks } from "@/modules/brief/data";
import { loadMemberAccess } from "@/modules/brief/db";
import { addDays, isoWeekKey } from "@/modules/brief/dates";
import type { StructuredCaller } from "@/modules/brief/synthesis";
import { notifyUser } from "../notify/service";
import { loadCapacity } from "../capacity/service";
import { dealsNeedingAttention, loadOpenDeals, loadOverdueCommitments, loadPrepStatus, loadSignals, section, type LoadCtx } from "./data";
import { buildDailySections, planHash, type PlanMeeting } from "./plan-builder";
import { loadOrchSettings } from "./settings-db";
import type { OrchSettings } from "./settings";

export type AiCaller = typeof callStructured;

const Headline = z.object({ headline: z.string(), focus: z.array(z.string()).max(3) });

export interface PlanRow { id: string; kind: string; period_key: string; sections: any; recommended: any; ai_status: string; ai_summary: any; content_hash: string; version: number; brief_id: string | null; generated_at: string; tz: string }

export async function memberLoadCtx(admin: Db, ws: string, userId: string, s: OrchSettings): Promise<LoadCtx | null> {
  const access = await loadMemberAccess(admin, ws, userId);
  return access ? { db: admin, workspaceId: ws, userId, tz: s.timezone, access } : null;
}

/** Upsert by (user, kind, period). Unchanged content + AI status => no write. */
export async function savePlan(db: Db, ws: string, userId: string, p: { kind: "daily" | "weekly"; period: string; tz: string; briefId: string | null; sections: unknown; recommended: unknown; aiStatus: string; aiSummary: unknown }): Promise<{ plan: PlanRow; changed: boolean }> {
  const hash = planHash({ s: p.sections, r: p.recommended, a: p.aiSummary });
  const { data: prev } = await db.from("orch_plan").select("*").eq("workspace_id", ws).eq("user_id", userId).eq("kind", p.kind).eq("period_key", p.period).maybeSingle();
  if (prev && prev.content_hash === hash && prev.ai_status === p.aiStatus) return { plan: prev as PlanRow, changed: false };
  const row = { sections: p.sections, recommended: p.recommended, ai_status: p.aiStatus, ai_summary: p.aiSummary, content_hash: hash, brief_id: p.briefId, tz: p.tz, generated_at: new Date().toISOString() };
  if (prev) {
    const { data, error } = await db.from("orch_plan").update({ ...row, version: prev.version + 1 }).eq("workspace_id", ws).eq("id", prev.id).select("*").single();
    if (error) throw error;
    return { plan: data as PlanRow, changed: true };
  }
  const { data, error } = await db.from("orch_plan").insert({ workspace_id: ws, user_id: userId, owner_user_id: userId, kind: p.kind, period_key: p.period, ...row }).select("*").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return savePlan(db, ws, userId, p); // concurrent writer
    throw error;
  }
  return { plan: data as PlanRow, changed: true };
}

/** The ten §4.2 sections from live records (shared by the 08:00 job and the /today planner's live fallback). */
export async function computeDailySections(c: LoadCtx, date: string, now: Date, brief: any, briefError: string | null) {
  const userId = c.userId;
  const meetings = await section(async () => loadMeetings(c, date));
  const tomorrow = await section(async () => loadMeetings(c, addDays(date, 1)));
  const allMeetings = [...meetings.items, ...tomorrow.items];
  const prep = await loadPrepStatus(c, allMeetings.map((m) => m.id)).catch(() => new Map());
  const toPlan = (m: any): PlanMeeting => ({ id: m.id, title: m.title, startAt: m.startAt, endAt: m.endAt, kind: m.kind, status: m.status, location: m.location, prep: prep.get(m.id) ?? null });
  const soon = allMeetings.filter((m) => Date.parse(m.startAt) <= +now + 24 * 3600e3).map(toPlan);
  const deals = await section(async () => loadOpenDeals(c));
  return buildDailySections({
    date, now: now.toISOString(),
    meetingsToday: { ...meetings, items: meetings.items.map(toPlan) }, meetingsSoon: soon,
    brief: brief ? { id: brief.id, targets: brief.content?.targets ?? [], deadlines: brief.content?.deadlines?.items ?? [] } : null, briefError,
    signals: await section(async () => loadSignals(c, new Date(+now - 36 * 3600e3).toISOString())),
    tasks: await section(async () => (await loadOpenTasks(c)).map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, priority: t.priority, status: t.status, linkedEntityType: t.linkedEntityType, linkedEntityId: t.linkedEntityId, source: t.source }))),
    commitments: await section(async () => (await loadOverdueCommitments(c, date, { mineOnly: true })).map((x) => ({ id: x.id, title: x.title, due: x.due, href: x.href, kind: x.kind }))),
    deals: deals.state === "ok" ? { ...deals, items: dealsNeedingAttention(deals.items.filter((d: any) => !d.account_owner_user_id || d.account_owner_user_id === userId || d.owner_user_id === userId), date, now.toISOString()) } : deals as any,
    approvals: await loadApprovals(c).catch(() => null),
  });
}

export async function runDailyPlan(admin: Db, ws: string, userId: string, opts: { now?: Date; ai?: AiCaller; notify?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const ai = opts.ai ?? callStructured;
  const s = await loadOrchSettings(admin, ws, userId);
  const c = await memberLoadCtx(admin, ws, userId, s);
  if (!c) return { skipped: "not a member" };
  const date = localDate(now, s.timezone);

  // 1. the brief module's daily brief (reused, generated if missing; its own no-AI fallback applies)
  let brief: any = null, briefError: string | null = null;
  try {
    brief = await latestBrief(admin, ws, userId, date, "daily");
    if (!brief) brief = (await generateDailyBrief(c, s.brief, { date, now, caller: ((call: any) => ai(call)) as unknown as StructuredCaller, generatedBy: "orchestrator" })).brief;
  } catch (e) { briefError = `Daily brief unavailable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200); }

  // 2. deterministic sections from records
  const sections = await computeDailySections(c, date, now, brief, briefError);
  const capacity = await loadCapacity(c, s, date, now).catch((e) => ({ error: String(e?.message ?? e) }));

  // 3. optional AI headline — never required
  let aiStatus: "ok" | "delayed" = "ok";
  let aiSummary: unknown;
  const recs = sections.recommended_actions.items;
  try {
    const r = await ai({
      workspaceId: ws, workflow: "orchestrator.daily_plan", tier: "luna", schema: Headline, schemaName: "daily_plan_headline", maxOutputTokens: 300,
      system: "Write a one-sentence headline and up to three focus points for a commercial real-estate adviser's day. Use only the items given; do not invent facts, people, numbers or dates.",
      input: JSON.stringify({ meetings: sections.todays_meetings.items.length, recommended: recs.map((x) => x.title) }),
      mock: () => ({ headline: recs.length ? `${recs.length} recommended action${recs.length === 1 ? "" : "s"} today; start with: ${recs[0].title}` : "No urgent items today.", focus: recs.slice(0, 3).map((x) => x.title) }),
    });
    aiSummary = { ...r.data, model: r.model, mocked: r.mocked };
  } catch (e) {
    aiStatus = "delayed";
    aiSummary = { delayed: true, reason: (e as any)?.reason ?? (e instanceof Error ? e.message : String(e)), retry: "queued" };
    await enqueue({ workspaceId: ws, type: "orchestrator.plan_ai", payload: { userId, date }, dueAt: new Date(+now + 30 * 60_000), dedupeKey: `orchestrator.plan_ai:${ws}:${userId}:${date}`, maxAttempts: 4 }).catch(() => undefined);
  }

  const { plan, changed } = await savePlan(admin, ws, userId, { kind: "daily", period: date, tz: s.timezone, briefId: brief?.id ?? null, sections: { ...sections, capacity }, recommended: recs, aiStatus, aiSummary });
  if (opts.notify !== false) {
    await notifyUser(admin, ws, { userId, category: "daily_plan", eventKey: `daily_plan:${userId}:${date}`, title: "Your plan for today is ready", body: aiStatus === "delayed" ? "Basic plan (AI summary delayed)" : null, record: { type: "orch_plan", id: plan.id }, href: "/today", settings: s, now });
    if (capacity && "warnings" in capacity) {
      for (const w of capacity.warnings.filter((x) => x.kind !== "over_capacity" || capacity.unplaced.length > 2))
        await notifyUser(admin, ws, { userId, category: "capacity", eventKey: `capacity:${userId}:${date}:${w.kind}`, title: w.message, severity: w.severity, groupKey: `capacity:${date}`, triggerKey: `capacity:${userId}:${date}`, href: "/today", settings: s, now });
    }
  }
  return { planId: plan.id, date, changed, aiStatus, week: isoWeekKey(date) };
}

/** Retry only the AI headline for an existing plan (job orchestrator.plan_ai). Throws while still unavailable so the queue backs off. */
export async function retryPlanAi(admin: Db, ws: string, userId: string, date: string, ai: AiCaller = callStructured) {
  const { data: plan } = await admin.from("orch_plan").select("*").eq("workspace_id", ws).eq("user_id", userId).eq("kind", "daily").eq("period_key", date).maybeSingle();
  if (!plan || plan.ai_status !== "delayed") return { skipped: "nothing delayed" };
  const recs = (plan.recommended ?? []) as { title: string }[];
  const r = await ai({ workspaceId: ws, workflow: "orchestrator.daily_plan", tier: "luna", schema: Headline, schemaName: "daily_plan_headline", maxOutputTokens: 300,
    system: "Write a one-sentence headline and up to three focus points for a commercial real-estate adviser's day. Use only the items given.",
    input: JSON.stringify({ recommended: recs.map((x) => x.title) }),
    mock: () => ({ headline: recs.length ? `${recs.length} recommended actions today; start with: ${recs[0].title}` : "No urgent items today.", focus: recs.slice(0, 3).map((x) => x.title) }) });
  await admin.from("orch_plan").update({ ai_status: "ok", ai_summary: { ...r.data, model: r.model, mocked: r.mocked }, version: plan.version + 1 }).eq("workspace_id", ws).eq("id", plan.id);
  return { updated: plan.id };
}
