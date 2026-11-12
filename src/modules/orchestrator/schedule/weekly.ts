import "server-only";
/**
 * Weekly CRE review (spec §4.5, Workflow G) at the configured weekday/time (default: the brief module's Friday 18:00).
 * Deterministic, saved once per user + ISO week in mudar.orch_plan (kind 'weekly'); a re-run updates the same row.
 * Each section reports `unavailable` with the reason when its source fails (never "nothing happened").
 */
import type { Db } from "@/lib/supabase/server";
import { localDate, atLocal } from "@/lib/util/time";
import { addDays, isoWeekKey } from "@/modules/brief/dates";
import { visible } from "@/modules/brief/visibility";
import { notifyUser } from "../notify/service";
import { dealsNeedingAttention, loadOpenDeals, loadOverdueCommitments, loadSignals, section, type LoadCtx, type Section } from "./data";
import { weeklyRecommendations, type SectionOut } from "./plan-builder";
import { loadOrchSettings } from "./settings-db";
import { memberLoadCtx, savePlan } from "./daily-plan";
import { weeklySummary } from "./summaries";

const must = (r: { data: any; error: any }) => { if (r.error) throw r.error; return (r.data ?? []) as any[]; };
const filt = (c: LoadCtx, rows: any[], t: string) => (c.access ? visible(c.access, rows, t) : rows);

export async function buildWeeklySections(c: LoadCtx, date: string, now: Date): Promise<Record<string, Section<any>>> {
  const from = atLocal(addDays(date, -6), "00:00", c.tz).toISOString();
  const to = atLocal(addDays(date, 1), "00:00", c.tz).toISOString();
  const nextTo = atLocal(addDays(date, 8), "00:00", c.tz).toISOString();
  const ws = c.workspaceId;
  const deals = await section(() => loadOpenDeals(c));
  const PROPOSAL = ["proposal_negotiation", "loi", "documentation"];
  const s: Record<string, Section<any>> = {
    new_opportunities: await section(async () => filt(c, must(await c.db.from("opportunity").select("id, name, stage, created_at, classification, owner_user_id, archived_at").eq("workspace_id", ws).gte("created_at", from).lt("created_at", to).limit(200)), "opportunity")
      .map((o) => ({ id: o.id, name: o.name, stage: o.stage, href: `/deals/${o.id}` }))),
    priority_account_changes: await section(async () => {
      const rows = filt(c, must(await c.db.from("score_result").select("id, entity_type, entity_id, score, previous_score, band, change_reason, calculated_at, classification, owner_user_id, archived_at")
        .eq("workspace_id", ws).eq("entity_type", "organisation").eq("is_current", true).gte("calculated_at", from).lt("calculated_at", to).not("previous_score", "is", null).limit(1000)), "score_result")
        .map((r) => ({ ...r, delta: r.score - r.previous_score })).filter((r) => Math.abs(r.delta) >= 10).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10);
      const names = rows.length ? must(await c.db.from("organisation").select("id, display_name").eq("workspace_id", ws).in("id", rows.map((r) => r.entity_id))) : [];
      return rows.map((r) => ({ id: r.entity_id, name: names.find((n) => n.id === r.entity_id)?.display_name ?? "Company", score: r.score, delta: r.delta, band: r.band, why: r.change_reason, href: `/companies/${r.entity_id}` }));
    }),
    important_signals: await section(async () => (await loadSignals(c, from, to)).filter((x) => x.confidence !== "low")),
    meetings_completed: await section(async () => filt(c, must(await c.db.from("meeting_visit").select("id, title, start_at, status, classification, owner_user_id, archived_at").eq("workspace_id", ws).eq("status", "completed").gte("start_at", from).lt("start_at", to).limit(200)), "meeting_visit")
      .map((m) => ({ id: m.id, title: m.title, start: m.start_at, href: "/meetings" }))),
    meetings_scheduled: await section(async () => filt(c, must(await c.db.from("meeting_visit").select("id, title, start_at, status, classification, owner_user_id, archived_at").eq("workspace_id", ws).neq("status", "cancelled").gte("start_at", to).lt("start_at", nextTo).order("start_at").limit(200)), "meeting_visit")
      .map((m) => ({ id: m.id, title: m.title, start: m.start_at, href: "/meetings" }))),
    followups_completed: await section(async () => filt(c, must(await c.db.from("task").select("id, title, completed_at, source, classification, owner_user_id, archived_at").eq("workspace_id", ws).eq("status", "done").gte("completed_at", from).lt("completed_at", to)
      .or(`assigned_user_id.eq.${c.userId},owner_user_id.eq.${c.userId}`).limit(500)), "task").map((t) => ({ id: t.id, title: t.title, completedAt: t.completed_at }))),
    overdue_commitments: await section(async () => loadOverdueCommitments(c, date, { mineOnly: true })),
    requirements_changed: await section(async () => filt(c, must(await c.db.from("requirement").select("id, title, status, created_at, updated_at, classification, owner_user_id, archived_at").eq("workspace_id", ws).gte("updated_at", from).lt("updated_at", to).limit(200)), "requirement")
      .map((r) => ({ id: r.id, title: r.title, status: r.status, change: r.created_at >= from ? "added" : "changed", href: `/requirements/${r.id}` }))),
    active_deals: deals.state === "ok" ? { ...deals, items: deals.items.map((d: any) => ({ id: d.id, name: d.name, stage: d.stage, href: `/deals/${d.id}` })) } : deals,
    stalled_transactions: deals.state === "ok" ? { ...deals, items: dealsNeedingAttention(deals.items.filter((d: any) => Date.parse(d.stage_entered_at) < +now - 30 * 864e5), date, now.toISOString()) } : deals,
    proposals_pending: deals.state === "ok" ? { ...deals, items: deals.items.filter((d: any) => PROPOSAL.includes(d.stage)).map((d: any) => ({ id: d.id, name: d.name, stage: d.stage, href: `/deals/${d.id}` })) } : deals,
    market_developments: await section(async () => {
      const obs = filt(c, must(await c.db.from("market_observation").select("id, metric, geography_raw, value, unit, period_end, created_at, classification, owner_user_id, archived_at").eq("workspace_id", ws).gte("created_at", from).lt("created_at", to).limit(50)), "market_observation");
      const tx = filt(c, must(await c.db.from("market_transaction").select("id, tenant_name_raw, deal_type, area_sf, created_at, classification, owner_user_id, archived_at").eq("workspace_id", ws).gte("created_at", from).lt("created_at", to).limit(50)), "market_transaction");
      return [...obs.map((o) => ({ id: o.id, kind: "observation", title: `${o.metric}${o.geography_raw ? ` — ${o.geography_raw}` : ""}: ${o.value ?? "unknown"} ${o.unit ?? ""}`.trim() })),
        ...tx.map((t) => ({ id: t.id, kind: "transaction", title: `${t.tenant_name_raw ?? "Tenant unknown"} ${t.deal_type ?? ""} ${t.area_sf ? `${t.area_sf} sf` : "(area unknown)"}`.trim() }))].slice(0, 15);
    }),
  };
  s.recommended_next_week = { state: "ok", items: weeklyRecommendations(s as Record<string, SectionOut<any>>), note: null };
  return s;
}

export async function runWeeklyReview(admin: Db, ws: string, userId: string, opts: { now?: Date; notify?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const s = await loadOrchSettings(admin, ws, userId);
  const c = await memberLoadCtx(admin, ws, userId, s);
  if (!c) return { skipped: "not a member" };
  const date = localDate(now, s.timezone);
  const week = isoWeekKey(date);
  const sections = await buildWeeklySections(c, date, now);
  const { plan, changed } = await savePlan(admin, ws, userId, { kind: "weekly", period: week, tz: s.timezone, briefId: null, sections, recommended: sections.recommended_next_week.items, aiStatus: "ok", aiSummary: { ...weeklySummary(sections), source: "code" } });
  if (opts.notify !== false) await notifyUser(admin, ws, { userId, category: "weekly_review", eventKey: `weekly_review:${userId}:${week}`, title: `Weekly review ${week} is ready`, record: { type: "orch_plan", id: plan.id }, href: "/automation?view=weekly", settings: s, now });
  return { planId: plan.id, week, changed };
}
