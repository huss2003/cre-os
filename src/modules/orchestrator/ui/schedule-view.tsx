import Link from "next/link";
import { Badge, Card, EmptyState, Field, Input, Select, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt, localDate } from "@/lib/util/time";
import { isoWeekKey } from "@/modules/brief/dates";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { listInbox } from "@/modules/orchestrator/notify/service";
import { loadCapacity } from "@/modules/orchestrator/capacity/service";
import { CLASS_LABEL } from "@/modules/orchestrator/capacity/capacity";
import { budgetStates, usageReport } from "@/modules/orchestrator/budget/service";
import { RESOURCES, UNITS } from "@/modules/orchestrator/budget/rules";
import { loadOrchSettings } from "@/modules/orchestrator/schedule/settings-db";
import { budgetAction, notificationAction, planNowAction } from "@/modules/orchestrator/schedule/actions";
import { capacityKindLabel } from "@/modules/orchestrator/ui/labels";

type Row = Record<string, any>;

const DAILY_LABEL: Record<string, string> = {
  todays_meetings: "Today's meetings", meetings_needing_prep: "Meetings needing preparation", priority_accounts: "Priority accounts",
  new_signals: "New signals", lease_alerts: "Lease expiry alerts", followups_due_today: "Follow-ups due today", overdue_commitments: "Overdue commitments",
  deals_attention: "Deals needing attention", pending_approvals: "Pending approvals", recommended_actions: "Recommended next actions",
};
const WEEKLY_LABEL: Record<string, string> = {
  new_opportunities: "New opportunities", priority_account_changes: "Priority account changes", important_signals: "Important signals",
  meetings_completed: "Meetings completed", meetings_scheduled: "Meetings scheduled (next 7 days)", followups_completed: "Follow-ups completed",
  overdue_commitments: "Overdue commitments", requirements_changed: "Requirements added or changed", active_deals: "Active deals",
  stalled_transactions: "Stalled transactions", proposals_pending: "Commercial proposals pending", market_developments: "Market developments",
  recommended_next_week: "Recommended for next week",
};

function itemText(i: Row): string {
  if (i.changes !== undefined) return `${i.changes} proposed change(s), ${i.drafts} draft(s) waiting`;
  return [i.title ?? i.name ?? i.tenant, i.reason ?? i.why ?? (i.kind && i.date ? `${i.kind} ${i.date}` : null), i.start ? fmt(i.start, "dd MMM, HH:mm") : null, i.due ? `due ${String(i.due).slice(0, 10)}` : null]
    .filter(Boolean).join(" · ");
}

function Sections({ sections, labels }: { sections: Row; labels: Record<string, string> }) {
  return (
    <div className="grid gap-3">
      {Object.entries(labels).map(([k, label]) => {
        const s = sections?.[k];
        if (!s) return null;
        return (
          <div key={k}>
            <h3 className="text-sm font-semibold">{label} {s.state === "ok" && <span className="text-xs text-[var(--muted)]">({s.items.length})</span>}</h3>
            {s.state !== "ok" ? <StaleBanner>{s.note ?? "Source unavailable"} — shown as unavailable, not as “nothing”.</StaleBanner>
              : !s.items.length ? <p className="text-sm text-[var(--muted)]">None.</p>
              : <ul className="mt-1 grid gap-1 text-sm">{(s.items as Row[]).slice(0, 8).map((i, n) => (
                  <li key={i.id ?? i.ref ?? n} className="break-words">{i.href ? <Link className="underline" href={i.href}>{itemText(i)}</Link> : itemText(i)}
                    {Array.isArray(i.missing) && i.missing.length > 0 && <span className="block text-xs text-[var(--muted)]">Missing: {i.missing.slice(0, 3).join("; ")}</span>}</li>))}</ul>}
          </div>
        );
      })}
    </div>
  );
}

/** Daily plan / weekly review / budgets & usage / notifications tabs of /automation (moved from /orchestrator/schedule). */
export async function ScheduleView({ view }: { view: "daily" | "weekly" | "budgets" | "notifications" }) {
  const ctx = await requirePageContext();
  const s = await loadOrchSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const today = localDate(new Date(), s.timezone);
  const isAdmin = hasRole(ctx, "admin");
  const [inbox, plan, weekly] = await Promise.all([
    view === "notifications" ? listInbox(ctx.db, ctx.workspaceId, ctx.userId).catch(() => null) : Promise.resolve([]),
    ctx.db.from("orch_plan").select("*").eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId).eq("kind", "daily").eq("period_key", today).maybeSingle().then((r: Row) => r.data),
    view === "weekly" ? ctx.db.from("orch_plan").select("*").eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId).eq("kind", "weekly").order("period_key", { ascending: false }).limit(1).maybeSingle().then((r: Row) => r.data) : null,
  ]);
  const capacity = view === "daily" ? await loadCapacity({ db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId, tz: s.timezone, access: null }, s, today).catch(() => null) : null;
  const budgets = view === "budgets" && isAdmin ? await budgetStates(ctx.db, ctx.workspaceId).catch(() => null) : null;
  const usage = view === "budgets" && isAdmin ? await usageReport(ctx.db, ctx.workspaceId).catch(() => null) : null;

  return (
    <div className="grid gap-4">

      {view === "notifications" && <Card title={`Notifications${inbox ? ` (${inbox.length})` : ""}`}>
        {!inbox ? <StaleBanner>Notifications could not be loaded.</StaleBanner> : !inbox.length ? <EmptyState title="All clear">Meeting briefs, overdue commitments, budget and capacity alerts appear here. Informational ones wait for working hours.</EmptyState> : (
          <ul className="grid gap-2">{inbox.slice(0, 30).map((n) => (
            <li key={n.id} className="flex flex-wrap items-start justify-between gap-2 border-b pb-2 text-sm">
              <div className="min-w-0 flex-1">
                {n.severity === "urgent" && <Badge tone="bad">Urgent</Badge>} {n.count > 1 && <Badge>{n.count}×</Badge>}{" "}
                {n.href ? <Link className="underline" href={n.href}>{n.title}</Link> : n.title}
                {n.body && <span className="block text-xs text-[var(--muted)]">{n.body}</span>}
                <span className="block text-xs text-[var(--muted)]">{fmt(n.createdAt, "dd MMM, HH:mm", s.timezone)}</span>
              </div>
              <ActionForm action={notificationAction} className="flex gap-1">
                <input type="hidden" name="id" value={n.id} />
                <Submit name="action" value="complete" variant="secondary">Done</Submit>
                <Submit name="action" value="snooze" variant="secondary">Snooze 3h</Submit>
                <Submit name="action" value="dismiss" variant="ghost">Dismiss</Submit>
              </ActionForm>
            </li>))}</ul>)}
      </Card>}

      {view === "daily" && (<>
        <Card title={`Plan for ${today}`} actions={<ActionForm action={planNowAction}><Submit variant="secondary">Build now</Submit></ActionForm>}>
          {!plan ? <EmptyState title="No plan yet today">It is built automatically at {s.dailyPlanTime} from your meetings, tasks, calendar records and the daily brief. Use “Build now” to create it earlier.</EmptyState> : (<>
            {plan.ai_status === "delayed" && <StaleBanner>AI summary delayed (provider unavailable) — this basic plan uses your records only; the summary is retried automatically.</StaleBanner>}
            {plan.ai_summary?.headline && <p className="mb-3 font-medium">{plan.ai_summary.headline}</p>}
            <Sections sections={plan.sections} labels={DAILY_LABEL} />
            <p className="mt-2 text-xs text-[var(--muted)]">Daily plan at {s.dailyPlanTime}, weekly review {["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][s.weeklyReview.weekday]} {s.weeklyReview.time} ({s.timezone}). Generated {fmt(plan.generated_at, "dd MMM, HH:mm", s.timezone)} · version {plan.version}{plan.brief_id ? <> · extends <Link className="underline" href="/today">today's brief</Link></> : null}</p>
          </>)}
        </Card>
        <Card title="Capacity">
          {!capacity ? <StaleBanner>Capacity could not be calculated.</StaleBanner> : (<div className="grid gap-2 text-sm">
            <p>{capacity.meetingMinutes} min in meetings · {capacity.freeMinutes} min free · {capacity.demandMinutes} min of task work ({s.workingHours.start}–{s.workingHours.end})</p>
            {[...capacity.conflicts, ...capacity.warnings].map((w, i) => <p key={i}><Badge tone={w.severity === "urgent" ? "bad" : "warn"}>{capacityKindLabel(w.kind)}</Badge> {w.message}</p>)}
            {capacity.travel.map((t, i) => <p key={`t${i}`} className="text-[var(--muted)]">{t.from} → {t.to}: {t.message}</p>)}
            {capacity.suggestions.length > 0 && <div><h3 className="font-semibold">Suggestions (you decide)</h3><ul className="grid gap-1">{capacity.suggestions.slice(0, 10).map((x, i) => <li key={i}>{x.kind === "reschedule" ? `Move “${x.title}” to ${x.proposedDate ?? "another day"}` : x.kind === "prep_slot" ? `${x.title} at ${fmt(x.proposedStart!, "HH:mm", s.timezone)}` : `Consider moving “${x.title}”`} — <span className="text-[var(--muted)]">{x.reason}</span></li>)}</ul></div>}
            {capacity.placed.length > 0 && <div><h3 className="font-semibold">Suggested order</h3><ul className="grid gap-1">{capacity.placed.slice(0, 12).map((p) => <li key={p.taskId}>{fmt(p.start, "HH:mm", s.timezone)} {p.title} <span className="text-xs text-[var(--muted)]">({CLASS_LABEL[p.cls]}{p.overridden ? ", your slot" : ""})</span></li>)}</ul></div>}
            {!capacity.placed.length && !capacity.warnings.length && !capacity.conflicts.length && <p className="text-[var(--muted)]">No open tasks or meetings for today.</p>}
          </div>)}
        </Card>
      </>)}

      {view === "weekly" && (
        <Card title={weekly ? `Weekly review ${weekly.period_key}` : "Weekly review"}>
          {!weekly ? <EmptyState title="No weekly review yet">It is generated every {["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][s.weeklyReview.weekday]} at {s.weeklyReview.time} (this week: {isoWeekKey(today)}).</EmptyState>
            : <Sections sections={weekly.sections} labels={WEEKLY_LABEL} />}
        </Card>
      )}

      {view === "budgets" && !isAdmin && <EmptyState title="Admins only">Budgets and usage are managed by workspace admins.</EmptyState>}
      {view === "budgets" && isAdmin && (<>
        <Card title="Budgets">
          {!budgets ? <StaleBanner>Budgets could not be loaded.</StaleBanner> : !budgets.length ? <EmptyState title="No budgets set">Add daily or monthly limits per resource. When a limit is reached, non-critical background work pauses (nothing is lost) and admins are alerted. A budget never switches to another provider. The workspace's monthly AI cap (Admin) still applies.</EmptyState> : (
            <ul className="grid gap-1 text-sm">{budgets.map((b) => <li key={b.budget.id}><Badge tone={b.status === "exhausted" ? "bad" : b.status === "near" ? "warn" : "ok"}>{b.status}</Badge> {b.budget.resource.replace(/_/g, " ")}{b.budget.module !== "*" ? ` · ${b.budget.module}` : ""}{b.budget.provider !== "*" ? ` · ${b.budget.provider}` : ""} — {b.used} / {b.limit} {b.budget.unit} ({b.budget.period}, {b.pct}%) · resets {fmt(b.resetsAt, "dd MMM HH:mm", s.timezone)}</li>)}</ul>)}
          <ActionForm action={budgetAction} className="mt-3 grid gap-2 sm:grid-cols-3">
            <Field label="Resource"><Select name="resource">{RESOURCES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}</Select></Field>
            <Field label="Period"><Select name="period"><option value="monthly">Monthly</option><option value="daily">Daily</option></Select></Field>
            <Field label="Unit"><Select name="unit">{UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</Select></Field>
            <Field label="Limit"><Input name="limit" type="number" min="0" step="any" required /></Field>
            <Field label="Alert at %"><Input name="alert" type="number" min="1" max="100" defaultValue="80" /></Field>
            <Field label="Module (optional)" hint="e.g. intelligence; blank = all"><Input name="module" /></Field>
            <Submit>Save budget</Submit>
          </ActionForm>
        </Card>
        <Card title={`Usage this month${usage ? ` (${usage.month})` : ""}`}>
          {!usage ? <StaleBanner>Usage could not be loaded.</StaleBanner> : (<div className="grid gap-2 text-sm">
            {(["byResource", "byModuleUsd", "byWorkflowUsd"] as const).map((k) => <div key={k}><h3 className="font-semibold">{k === "byResource" ? "By resource" : k === "byModuleUsd" ? "AI cost by module (USD)" : "AI cost by workflow (USD)"}</h3>
              {Object.keys(usage[k]).length ? <ul>{Object.entries(usage[k]).slice(0, 12).map(([n, v]) => <li key={n}>{n}: {String(v)}</li>)}</ul> : <p className="text-[var(--muted)]">No usage recorded.</p>}</div>)}
            <p className="text-xs text-[var(--muted)]">{usage.note}</p>
          </div>)}
        </Card>
      </>)}
    </div>
  );
}
