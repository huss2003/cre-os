import Link from "next/link";
import { Badge, Card, EmptyState, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { automationAction } from "./actions";
import { RunStatus, When } from "./components";
import { getAutomationState, listBackgroundJobs, listHistory, listRouted } from "../automation/service";
import { moduleLabel, type Alert, type CategoryUsage } from "../automation/rules";

/** UI A — "Automation active / paused" + one-click pause/resume (shown on every Automation tab). */
export async function AutomationSwitch() {
  const ctx = await requirePageContext();
  const s = await getAutomationState(ctx.db, ctx.workspaceId).catch(() => null);
  if (!s) return <StaleBanner>Automation status could not be loaded.</StaleBanner>;
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${s.paused ? "border-warn bg-warn/10" : "border-line bg-surface"}`} data-testid="automation-status">
      <Badge tone={s.paused ? "warn" : "ok"}>{s.paused ? "Automation paused" : "Automation active"}</Badge>
      <p className="min-w-0 flex-1 text-sm text-ink-soft">
        {s.paused
          ? <>Background checks, research, scoring and scheduled runs wait{s.pausedAt ? <> since <When at={s.pausedAt} tz={ctx.timezone || "Asia/Kolkata"} /></> : null}. Your own actions, captures and meeting reminders still run.</>
          : "Scheduled checks, research, scoring and event-driven updates run in the background."}
      </p>
      {hasRole(ctx, "editor") ? (
        <ActionForm action={automationAction} className="flex items-center gap-2">
          <input type="hidden" name="op" value={s.paused ? "resume" : "pause"} />
          <Submit variant={s.paused ? "primary" : "secondary"} confirm={s.paused ? undefined : "Pause all background automation? Nothing is lost; it continues when you resume."}>{s.paused ? "Resume automation" : "Pause automation"}</Submit>
        </ActionForm>
      ) : null}
    </div>
  );
}

/** UI E — system alerts (most serious first). */
export function AlertsCard({ alerts }: { alerts: Alert[] }) {
  return (
    <Card title="System alerts">
      {alerts.length ? (
        <ul className="space-y-2 text-sm">
          {alerts.map((a, i) => (
            <li key={i} className="flex flex-wrap items-start gap-2">
              <Badge tone={a.tone}>{ALERT_LABEL[a.kind]}</Badge>
              <Link href={a.href} className="min-w-0 flex-1 hover:text-brand"><span className="font-medium">{a.title}</span>{a.detail ? <span className="block text-xs text-ink-soft">{a.detail}</span> : null}</Link>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-ink-soft">No alerts. Failures, delays, source outages, stale data and budget warnings appear here.</p>}
    </Card>
  );
}
const ALERT_LABEL: Record<Alert["kind"], string> = { paused: "Paused", outage: "Source outage", failed: "Failed", budget: "Budget", attention: "Needs you", delayed: "Delayed", stale: "Stale", info_change: "Changed" };

/** UI F — research / enrichment / transcription / AI: limit, used, remaining. */
export function UsageCategories({ items }: { items: CategoryUsage[] }) {
  return (
    <ul className="divide-y divide-line" data-testid="usage-categories">
      {items.map((c) => (
        <li key={c.resource} className="py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{c.label}</span>
            <Badge tone={c.status === "exhausted" ? "bad" : c.status === "near" ? "warn" : c.status === "no_limit" ? "neutral" : "ok"}>{c.status === "exhausted" ? "Limit reached" : c.status === "near" ? "Near limit" : c.status === "no_limit" ? "No limit set" : "OK"}</Badge>
          </div>
          <p className="text-xs text-ink-soft">
            Used {fmtUnits(c.used, c.unit)} this {c.period === "daily" ? "day" : "month"} · Limit {c.limit == null ? "—" : fmtUnits(c.limit, c.unit)} · Remaining {c.remaining == null ? "—" : fmtUnits(c.remaining, c.unit)}
          </p>
        </li>
      ))}
    </ul>
  );
}
const fmtUnits = (n: number, unit: string) => (unit === "usd" ? `US$${n.toFixed(2)}` : `${n} ${unit}`);

const HISTORY_FILTERS = [["", "All"], ["failed", "Failed"], ["delayed", "Delayed"], ["completed", "Completed"], ["paused", "Paused"]] as const;

/** UI C — workflow history. */
export async function HistoryView({ status }: { status?: string }) {
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const rows = await listHistory(ctx.db, ctx.workspaceId, { status: status || undefined, limit: 50 }).catch(() => null);
  return (
    <Card title="Workflow history">
      <nav className="mb-2 flex flex-wrap gap-1 text-xs">{HISTORY_FILTERS.map(([v, l]) => <Link key={v} href={`/automation?view=history${v ? `&status=${v}` : ""}`} className={`rounded px-2 py-1 ${status === v || (!status && !v) ? "bg-brand text-white" : "border border-line"}`}>{l}</Link>)}</nav>
      {!rows ? <StaleBanner>History could not be loaded.</StaleBanner> : !rows.length ? <EmptyState title="No runs yet">Every workflow run is listed here with what triggered it, what it did and what failed.</EmptyState> : (
        <ul className="divide-y divide-line" data-testid="workflow-history">
          {rows.map((r) => (
            <li key={r.id} className="space-y-1 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/automation/runs/${r.id}`} className="min-w-0 flex-1 font-medium hover:text-brand">{r.name}</Link>
                <RunStatus status={r.status} />{r.delayed ? <Badge tone="warn">Delayed</Badge> : null}
              </div>
              <p className="text-xs text-ink-soft">{r.trigger} · started <When at={r.started_at} tz={tz} /> · finished {r.finished_at ? <When at={r.finished_at} tz={tz} /> : "—"} · {r.retries} retr{r.retries === 1 ? "y" : "ies"}</p>
              <p className="text-xs"><span className="text-ok">Done: {r.executed.length ? r.executed.join(", ") : "—"}</span>{r.failed.length ? <span className="text-bad"> · Failed: {r.failed.join(", ")}</span> : null}</p>
              {r.errors.length ? <p className="text-xs text-bad">{r.errors.slice(0, 2).join(" · ")}</p> : null}
              {r.delayed ? <p className="text-xs text-warn">{r.delayed}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const JOB_STATE: Record<string, { label: string; tone: "ok" | "bad" | "warn" | "neutral" }> = {
  queued: { label: "Waiting", tone: "neutral" }, running: { label: "Running", tone: "warn" }, succeeded: { label: "Completed", tone: "ok" },
  failed: { label: "Failed — will retry", tone: "warn" }, dead: { label: "Failed", tone: "bad" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
const ROUTED: Record<string, { label: string; tone: "ok" | "bad" | "warn" | "neutral" }> = {
  pending: { label: "Sent — not started yet", tone: "neutral" }, running: { label: "In progress", tone: "warn" }, completed: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "bad" }, delayed: { label: "Delayed", tone: "warn" }, untracked: { label: "Module decided no work was needed", tone: "neutral" },
};

/** UI D — background jobs + work routed to specialist modules. */
export async function JobsView({ state }: { state?: string }) {
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const admin = hasRole(ctx, "admin");
  const [jobs, routed] = await Promise.all([
    admin ? listBackgroundJobs(ctx.db, ctx.workspaceId, { state: state || undefined, limit: 80 }).catch(() => null) : Promise.resolve([]),
    listRouted(ctx.db, ctx.workspaceId, 30).catch(() => null),
  ]);
  return (
    <div className="space-y-4">
      <Card title="Background jobs">
        <nav className="mb-2 flex flex-wrap gap-1 text-xs">{[["", "All"], ["queued", "Waiting"], ["delayed", "Delayed"], ["dead", "Failed"], ["succeeded", "Completed"]].map(([v, l]) => <Link key={v} href={`/automation?view=jobs${v ? `&state=${v}` : ""}`} className={`rounded px-2 py-1 ${state === v || (!state && !v) ? "bg-brand text-white" : "border border-line"}`}>{l}</Link>)}</nav>
        {!admin ? <p className="text-sm text-ink-soft">Only admins can see background job details.</p> : !jobs ? <StaleBanner>Jobs could not be loaded.</StaleBanner> : !jobs.length ? <EmptyState title="No jobs">Source updates, signal checks, scoring, research, enrichment and transcription jobs appear here.</EmptyState> : (
          <ul className="divide-y divide-line" data-testid="background-jobs">
            {jobs.map((j) => (
              <li key={j.id} className="space-y-1 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 font-medium">{j.name}</span>
                  <Badge tone={JOB_STATE[j.state]?.tone ?? "neutral"}>{JOB_STATE[j.state]?.label ?? j.state}</Badge>
                  {j.delayed ? <Badge tone="warn">Delayed</Badge> : null}{j.deferred ? <Badge tone="neutral">Held: {j.deferred}</Badge> : null}
                </div>
                <p className="text-xs text-ink-soft">Module: {moduleLabel(j.module)} · due <When at={j.dueAt} tz={tz} /> · {j.finishedAt ? <>finished <When at={j.finishedAt} tz={tz} />{j.seconds != null ? ` (${j.seconds}s)` : ""}</> : "not finished"} · Retries: {j.retry}</p>
                {j.error ? <p className="text-xs text-bad">Reason: {j.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Work handed to specialist modules">
        {!routed ? <StaleBanner>Routed work could not be loaded.</StaleBanner> : !routed.length ? <p className="text-sm text-ink-soft">Signals, meeting outcomes, employer changes and lease updates handed to other modules are tracked here until they finish.</p> : (
          <ul className="divide-y divide-line" data-testid="routed-work">
            {routed.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">{String((r.event as { event_type?: string } | null)?.event_type ?? "event").replace(/[._]/g, " ")} → {moduleLabel(r.routed_module)}</span>
                <Badge tone={ROUTED[r.routed_status]?.tone ?? "neutral"}>{ROUTED[r.routed_status]?.label ?? r.routed_status}</Badge>
                <span className="text-xs text-ink-soft">checked <When at={r.routed_checked_at ?? r.created_at} tz={tz} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
