import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, Field, Input, PageHeader, StaleBanner, Stat } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { JobBacklogBanner } from "@/modules/capture/docs/backlog-banner";
import { fmt, localDate } from "@/lib/util/time";
import { loadCapacity } from "@/modules/orchestrator/capacity/service";
import { loadOrchSettings } from "@/modules/orchestrator/schedule/settings-db";
import { ScheduleView } from "@/modules/orchestrator/ui/schedule-view";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { workflowAction } from "@/modules/orchestrator/ui/actions";
import { RunStatus, When } from "@/modules/orchestrator/ui/components";
import { capacityKindLabel, DEF_STATUS, everyText, triggerText } from "@/modules/orchestrator/ui/labels";
import { dateForRequest, loadDashboard, startableWorkflows } from "@/modules/orchestrator/ui/service";
import { PREPARE_MEETINGS } from "@/modules/orchestrator/ui/workflows";
import { AlertsCard, AutomationSwitch, HistoryView, JobsView, UsageCategories } from "@/modules/orchestrator/ui/overview";

export const metadata = { title: "Automation" };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function RunList({ runs, tz, empty }: { runs: Row[]; tz: string; empty: string }) {
  if (!runs.length) return <p className="text-sm text-ink-soft">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {runs.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
          <Link href={`/automation/runs/${r.id}`} className="min-w-0 flex-1 font-medium text-ink hover:text-brand">{r.name}</Link>
          <RunStatus status={r.status} />
          <span className="text-xs text-ink-soft">{r.progress ?? 0}% · started <When at={r.started_at} tz={tz} /></span>
          {r.error ? <p className="w-full text-xs text-bad">{r.error}</p> : null}
        </li>
      ))}
    </ul>
  );
}

const VIEWS = [["overview", "Overview"], ["daily", "Daily plan"], ["history", "History"], ["jobs", "Background jobs"], ["weekly", "Weekly review"], ["budgets", "Budgets & usage"], ["notifications", "Notifications"]] as const;
type View = (typeof VIEWS)[number][0];

function Tabs({ view }: { view: View }) {
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Automation views">
      {VIEWS.map(([v, l]) => <Link key={v} href={v === "overview" ? "/automation" : `/automation?view=${v}`} aria-current={v === view ? "page" : undefined}
        className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${v === view ? "bg-brand text-white" : "border border-line bg-surface"}`}>{l}</Link>)}
    </nav>
  );
}

/** Capacity warnings for today (from the capacity service); hidden when there are none. */
async function CapacityCard() {
  const ctx = await requirePageContext();
  const s = await loadOrchSettings(ctx.db, ctx.workspaceId, ctx.userId).catch(() => null);
  if (!s) return null;
  const c = await loadCapacity({ db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId, tz: s.timezone, access: null }, s, localDate(new Date(), s.timezone)).catch(() => null);
  if (!c) return <Card title="Capacity today"><StaleBanner>Capacity could not be calculated.</StaleBanner></Card>;
  const w = [...c.conflicts, ...c.warnings];
  if (!w.length) return null;
  return (
    <Card title="Capacity warnings" actions={<Link className="text-sm text-brand" href="/automation?view=daily">Daily plan</Link>}>
      <ul className="space-y-1 text-sm">{w.slice(0, 6).map((x, i) => <li key={i}><Badge tone={x.severity === "urgent" ? "bad" : "warn"}>{capacityKindLabel(x.kind)}</Badge> {x.message}</li>)}</ul>
    </Card>
  );
}

async function Body({ view, filter }: { view: View; filter?: string }) {
  if (view !== "overview") return (
    <div className="space-y-4">
      <PageHeader title="Automation" subtitle="Your daily plan, weekly review, usage limits and notifications. Nothing here sends messages — drafts only." />
      <AutomationSwitch />
      <Tabs view={view} />
      {view === "history" ? <HistoryView status={filter} /> : view === "jobs" ? <JobsView state={filter} /> : <ScheduleView view={view} />}
    </div>
  );
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const d = await loadDashboard({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId, role: ctx.role, timezone: tz });
  const startable = startableWorkflows(ctx);
  const attention = [...d.failed, ...d.waitingApproval, ...d.pausedRuns];
  const budgets = d.budgets.items;

  return (
    <div className="space-y-4">
      <PageHeader title="Automation" subtitle="Work that runs in the background: what is running, what is scheduled, what failed and what needs you." />
      <AutomationSwitch />
      <Tabs view="overview" />
      <JobBacklogBanner db={ctx.db} ws={ctx.workspaceId} />

      {d.unhealthy.map((h) => (
        <StaleBanner key={h.id}>{h.label ?? h.source_key} is not working ({h.consecutive_failures} failed attempt{h.consecutive_failures === 1 ? "" : "s"}). Data from it may be out of date{h.next_retry_at ? `; next try ${fmt(h.next_retry_at, "dd MMM, HH:mm", tz)}` : ""}.</StaleBanner>
      ))}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="automation-counts">
        <Stat label="Total workflows" value={<Link className="hover:text-brand" href="/automation?view=history">{d.counts.total}</Link>} hint={`${d.workflows.length} defined · ${d.active.length} on`} />
        <Stat label="Active" value={d.counts.active} />
        <Stat label="Scheduled" value={d.counts.scheduled} />
        <Stat label="Completed" value={<Link className="hover:text-brand" href="/automation?view=history&status=completed">{d.counts.completed}</Link>} />
        <Stat label="Failed" value={<Link className="hover:text-brand" href="/automation?view=history&status=failed">{d.counts.failed}</Link>} />
        <Stat label="Delayed" value={<Link className="hover:text-brand" href="/automation?view=history&status=delayed">{d.counts.delayed}</Link>} />
        <Stat label="Needs attention" value={d.counts.attention} hint={d.pendingProposals ? `${d.pendingProposals} change(s) to review` : undefined} />
      </div>

      <AlertsCard alerts={d.alerts} />

      <Suspense fallback={null}><CapacityCard /></Suspense>

      <Card title="Needs attention">
        <RunList runs={attention} tz={tz} empty="Nothing needs you. Failed, paused and waiting jobs appear here." />
        {d.openMarks.length ? <p className="mt-2 text-sm"><Link className="text-brand underline" href="/approvals/outdated">{d.openMarks.length} record(s) flagged as outdated or needing a refresh</Link></p> : null}
      </Card>

      {d.delayed.length ? (
        <Card title="Delayed">
          <ul className="divide-y divide-line">{d.delayed.slice(0, 10).map((r) => <li key={r.id} className="py-2 text-sm"><Link href={`/automation/runs/${r.id}`} className="font-medium hover:text-brand">{r.name}</Link><p className="text-xs text-warn">{r.delayReason}</p></li>)}</ul>
        </Card>
      ) : null}

      <Card title="Running now">
        <RunList runs={d.running} tz={tz} empty="Nothing is running. Jobs start on a schedule, when something changes, or when you start one below." />
      </Card>

      {startable.length && hasRole(ctx, "editor") ? (
        <Card title="Start a job">
          <ul className="space-y-3">
            {startable.map((w) => (
              <li key={w.key} className="rounded-lg border border-line p-3">
                <p className="text-sm font-medium">{w.name}</p>
                <p className="text-xs text-ink-soft">{w.description}</p>
                <ActionForm action={workflowAction} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="key" value={w.key} />
                  {w.key === PREPARE_MEETINGS ? <Field label="For which day?"><Input type="date" name="date" defaultValue={dateForRequest("tomorrow", tz)} required /></Field> : null}
                  <Submit name="op" value="start">Start</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Scheduled">
        {d.scheduled.length || d.recurring.length ? (
          <ul className="divide-y divide-line">
            {d.recurring.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <Link href={r.href} className="min-w-0 flex-1 font-medium hover:text-brand">{r.name}</Link>
                <Badge tone="ok">On</Badge>
                <span className="text-xs text-ink-soft">{r.when} · next <When at={r.nextRunAt} tz={tz} /></span>
              </li>
            ))}
            {d.scheduled.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <Link href={`/automation/${encodeURIComponent(s.key)}`} className="min-w-0 flex-1 font-medium hover:text-brand">{s.name}</Link>
                <Badge tone={DEF_STATUS[s.status]?.tone ?? "neutral"}>{DEF_STATUS[s.status]?.label ?? s.status}</Badge>
                <span className="text-xs text-ink-soft">{everyText(s.everyMinutes) || "no schedule"} · next {s.status === "paused" ? "— (paused)" : <When at={s.nextRunAt} tz={tz} />} · last <When at={s.lastRunAt} tz={tz} /></span>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No scheduled operations">Recurring jobs (daily plan, weekly review, checks) appear here once they are set up.</EmptyState>}
      </Card>

      <Card title="All workflows">
        <ul className="divide-y divide-line">
          {d.workflows.map((w) => {
            const st = w.state?.status ?? "active";
            return (
              <li key={w.key} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/automation/${encodeURIComponent(w.key)}`} className="font-medium hover:text-brand">{w.name}</Link>
                  <Badge tone={DEF_STATUS[st]?.tone ?? "neutral"}>{DEF_STATUS[st]?.label ?? st}</Badge>
                </div>
                <p className="text-xs text-ink-soft">{triggerText(w.trigger, w.state?.every_minutes)} · {w.steps.length} step{w.steps.length === 1 ? "" : "s"}</p>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Recently finished">
        <RunList runs={d.completed} tz={tz} empty="No finished jobs yet." />
      </Card>

      <div id="connections">
        <Card title="Connections">
          {d.health.length ? (
            <ul className="divide-y divide-line">
              {d.health.map((h) => (
                <li key={h.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{h.label ?? h.source_key}</span>
                    <Badge tone={h.status === "healthy" ? "ok" : h.status === "down" ? "bad" : "warn"}>{h.status === "healthy" ? "Working" : h.status === "down" ? "Not working" : "Having problems"}</Badge>
                  </div>
                  <p className="text-xs text-ink-soft">Last worked <When at={h.last_success_at} tz={tz} />{h.status !== "healthy" ? <> · last error: {h.last_error ?? "unknown"} · next try <When at={h.next_retry_at} tz={tz} /></> : null}</p>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No connection checks yet">Connected accounts (mail, calendar) are listed here after their first sync. <Link className="underline" href="/settings/connections">Manage connections</Link></EmptyState>}
        </Card>
      </div>

      <Card title="Usage and limits" actions={<Link className="text-sm text-brand" href="/automation?view=budgets">Details</Link>}>
        <UsageCategories items={d.categories} />
        {!d.budgets.ok ? <StaleBanner>Usage could not be loaded right now.</StaleBanner> : budgets.length ? (
          <ul className="divide-y divide-line">
            {budgets.map((b) => (
              <li key={b.budget.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{b.budget.resource.replace(/_/g, " ")}{b.budget.provider && b.budget.provider !== "*" ? ` · ${b.budget.provider}` : ""}{b.budget.module && b.budget.module !== "*" ? ` · ${b.budget.module}` : ""}</span>
                  <Badge tone={b.status === "exhausted" ? "bad" : b.status === "near" ? "warn" : "ok"}>{b.status === "exhausted" ? "Limit reached" : b.status === "near" ? "Near limit" : "OK"}</Badge>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-canvas" aria-hidden><div className={`h-full ${b.status === "exhausted" ? "bg-bad" : b.status === "near" ? "bg-warn" : "bg-ok"}`} style={{ width: `${Math.min(100, b.pct)}%` }} /></div>
                <p className="mt-1 text-xs text-ink-soft">{b.used} of {b.limit} {unitLabel(b.budget.unit)} this {b.budget.period === "daily" ? "day" : "month"} ({b.pct}%) · resets <When at={b.resetsAt} tz={tz} />{b.status === "exhausted" ? " · non-urgent jobs wait until then" : ""}</p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-xs text-ink-soft">No limits set. Admins can set daily or monthly limits in Budgets &amp; usage.</p>}
      </Card>
    </div>
  );
}

const UNIT_LABEL: Record<string, string> = { usd: "US$", inr: "₹", model_tokens: "AI tokens", tokens: "AI tokens", calls: "calls", requests: "requests" };
function unitLabel(u: string | null | undefined): string { return u ? UNIT_LABEL[u.toLowerCase()] ?? u.replace(/_/g, " ") : ""; }

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string; status?: string; state?: string }> }) {
  const sp = await searchParams;
  const v = sp.view;
  const view: View = VIEWS.some(([k]) => k === v) ? (v as View) : "overview";
  const filter = (view === "history" ? sp.status : view === "jobs" ? sp.state : undefined)?.replace(/[^a-z_]/g, "");
  return <Suspense fallback={<div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">Loading…</div>}><Body view={view} filter={filter} /></Suspense>;
}
