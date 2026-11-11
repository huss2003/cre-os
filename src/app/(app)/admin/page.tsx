import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, Input, PageHeader, Stat, StaleBanner, inr } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { getHealth } from "@/modules/admin/health";
import { ackAlertAction, retryJobAction, setJobsPausedAction, setPausedAction, setPlatformJobsPausedAction } from "@/modules/admin/actions/settings";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Health" };

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`);
const mins = (m: number | null) => (m === null ? "never" : m < 1 ? "under a minute ago" : m < 120 ? `${Math.round(m)} min ago` : hours(m / 60));

function RedBanner({ children }: { children: React.ReactNode }) {
  return <div role="alert" className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm font-medium text-bad">{children}</div>;
}

const hours = (h: number | null) => (h === null ? "never" : h < 1 ? "under 1 h ago" : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`);

async function Body() {
  const ctx = await requireAdminPage("admin", "/admin");
  const h = await getHealth(ctx.db, ctx.workspaceId);
  const failingConnectors = h.connectors.filter((c) => !c.healthy || c.resources.some((r) => r.failing || r.stale));
  const b = h.backups;
  const sch = h.scheduler;
  const pause = h.jobs.paused;
  const openAlerts = h.alerts.open;
  const critical = openAlerts.filter((a) => a.severity === "critical" && !a.acknowledged_at).length;
  const restore = b.lastRestoreSample?.findings?.restore as { tables_restored?: number; rows_restored?: number; failed?: { table: string; error: string }[]; skipped_for_time?: string[] } | undefined;
  return (
    <div className="space-y-4">
      {!sch.checked ? <RedBanner>Scheduler status could not be checked ({sch.error}). Treat background processing as unknown, not healthy.</RedBanner>
        : sch.stale ? <RedBanner>Background scheduler has not run for {sch.lastTickAt ? mins(sch.minutesSince) : "ever"} (expected every 5 min). Briefs, syncs, alerts and backups are not being processed — check pg_cron / Vercel cron (runbook: “Jobs that never run”).</RedBanner> : null}
      {pause.globalPaused ? <RedBanner>The platform administrator has paused all background jobs (since {fmtDate(pause.globalPausedAt, true)}). Only backups run.</RedBanner> : null}
      {pause.workspacePaused ? <StaleBanner>Background jobs are paused for this workspace{pause.reason ? ` (${pause.reason})` : ""} since {fmtDate(pause.pausedAt, true)}. Queued work waits; backups continue.</StaleBanner> : null}
      {!pause.checked ? <StaleBanner>Pause state could not be read — check again before relying on it.</StaleBanner> : null}
      {critical ? <RedBanner>{critical} open critical alert(s) — see the failure queue below.</RedBanner> : null}
      {!h.alerts.checked ? <StaleBanner>Alerts could not be loaded — the failure queue below may be incomplete.</StaleBanner> : null}
      {h.workspace.status !== "active" ? <StaleBanner>Workspace status is <strong>{h.workspace.status}</strong> (set by the platform administrator).</StaleBanner> : null}
      {failingConnectors.length ? <StaleBanner>{failingConnectors.length} connector(s) failing or stale — briefs label affected sections as stale.</StaleBanner> : null}
      {!b.rpoMet ? <StaleBanner>No successful logical export in the last 24 hours (RPO). Last export: {hours(b.exportAgeHours)}.</StaleBanner> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Kill switch" value={h.workspace.aiPaused ? <span className="text-bad">Paused</span> : <span className="text-ok">Running</span>} hint="AI + external ingestion" />
        <Stat label="AI spend (month)" value={inr(h.spend.spentInr)} hint={h.spend.budgetInr > 0 ? `${(h.spend.pctOfBudget ?? 0).toFixed(0)}% of ${inr(h.spend.budgetInr)}` : "no budget set"} />
        <Stat label="Failed jobs" value={h.jobs.counts.failed + h.jobs.counts.dead} hint={`${h.jobs.counts.queued} queued · ${h.jobs.counts.running} running`} />
        <Stat label="Last backup" value={b.lastExport ? hours(b.exportAgeHours) : "never"} hint={b.rpoMet ? "RPO 24 h met" : "RPO 24 h missed"} />
        <Stat label="Scheduler" value={!sch.checked ? <span className="text-bad">Unknown</span> : sch.stale ? <span className="text-bad">Stopped</span> : <span className="text-ok">Running</span>} hint={`last tick ${mins(sch.minutesSince)}`} />
        <Stat label="Background jobs" value={pause.globalPaused || pause.workspacePaused ? <span className="text-warn">Paused</span> : <span className="text-ok">Processing</span>} hint={pause.globalPaused ? "platform-wide pause" : "backups always run"} />
        <Stat label="Open alerts" value={openAlerts.length} hint={`${critical} critical, unacknowledged`} />
        <Stat label="Dead jobs" value={h.jobs.counts.dead} hint="retries exhausted" />
      </div>

      <div id="alerts">
        <Card title="Alerts (failure queue)">
          {openAlerts.length === 0 ? <p className="text-sm text-ink-soft">No open alerts. The supervisor checks dead jobs, backups, AI budget (80% / 100%), connectors and the scheduler heartbeat on every tick and notifies owners/admins privately in Today.</p> : (
            <ul className="divide-y divide-line">{openAlerts.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5"><Badge tone={a.severity === "critical" ? "bad" : "warn"}>{a.severity}</Badge><span className="text-xs text-ink-soft">{a.kind.replace(/_/g, " ")}</span>{a.acknowledged_at ? <Badge>acknowledged</Badge> : null}</div>
                  <p className="mt-1 break-words">{a.title}</p>
                  <div className="text-xs text-ink-soft">open since {fmtDate(a.opened_at, true)} · last seen {fmtDate(a.last_seen_at, true)} · {a.notified_at ? "owners notified" : "notification pending"}{a.action_href ? <> · <Link className="text-brand" href={a.action_href}>Fix</Link></> : null}</div>
                </div>
                {!a.acknowledged_at ? <ActionForm action={ackAlertAction.bind(null, a.id)}><Submit variant="secondary">Acknowledge</Submit></ActionForm> : null}
              </li>))}</ul>
          )}
          {h.alerts.recent.length ? (
            <details className="mt-2 text-sm"><summary className="cursor-pointer text-ink-soft">Resolved in the last 7 days ({h.alerts.recent.length})</summary>
              <ul className="mt-1 space-y-1">{h.alerts.recent.map((a) => <li key={a.id} className="break-words text-xs text-ink-soft">{fmtDate(a.opened_at, true)} → {fmtDate(a.resolved_at, true)} · {a.title}</li>)}</ul>
            </details>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kill switch">
          <ActionForm action={setPausedAction} className="space-y-2">
            <p className="text-sm text-ink-soft">{h.workspace.aiPaused ? "AI calls and external ingestion are stopped. Internal records, tasks, approvals and the deterministic brief keep working." : "Pausing stops AI calls and external ingestion immediately. Internal work continues."}</p>
            <input type="hidden" name="paused" value={h.workspace.aiPaused ? "0" : "1"} />
            <Input name="reason" aria-label="Reason" placeholder="Reason (recorded in the audit log)" />
            <Submit variant={h.workspace.aiPaused ? "primary" : "danger"} confirm={h.workspace.aiPaused ? undefined : "Pause AI and external ingestion for this workspace?"}>{h.workspace.aiPaused ? "Resume" : "Pause AI & ingestion"}</Submit>
          </ActionForm>
          <ActionForm action={setJobsPausedAction} className="mt-4 space-y-2 border-t border-line pt-3">
            <p className="text-sm text-ink-soft">{pause.workspacePaused ? "Background jobs (syncs, imports, briefs, research, purges) are paused for this workspace. Nightly backups still run." : "Pause background jobs: the scheduler stops picking up this workspace's queued work (backups continue). Use during an incident or a bad import."}</p>
            <input type="hidden" name="paused" value={pause.workspacePaused ? "0" : "1"} />
            <Input name="reason" aria-label="Reason" placeholder="Reason (recorded in the audit log)" />
            <Submit variant={pause.workspacePaused ? "primary" : "danger"} confirm={pause.workspacePaused ? undefined : "Pause all background jobs for this workspace?"}>{pause.workspacePaused ? "Resume background jobs" : "Pause background jobs"}</Submit>
          </ActionForm>
          {ctx.isPlatformAdmin ? (
            <ActionForm action={setPlatformJobsPausedAction} className="mt-4 space-y-2 border-t border-line pt-3">
              <p className="text-sm text-ink-soft"><Badge tone="accent">Platform admin</Badge> {pause.globalPaused ? "All tenants' background jobs are paused (backups continue)." : "Pause background jobs for every tenant (backups continue)."}</p>
              <input type="hidden" name="paused" value={pause.globalPaused ? "0" : "1"} />
              <Input name="reason" aria-label="Reason" placeholder="Reason (written to every tenant's audit log)" />
              <Submit variant={pause.globalPaused ? "primary" : "danger"} confirm={pause.globalPaused ? undefined : "Pause background jobs for ALL tenants?"}>{pause.globalPaused ? "Lift platform-wide pause" : "Pause all tenants"}</Submit>
            </ActionForm>
          ) : null}
        </Card>

        <div id="spend"><Card title="AI spend by workflow">
          {h.spend.byWorkflow.length === 0 ? <p className="text-sm text-ink-soft">No model calls this month{h.spend.mockedCalls ? "" : ""}. Without an API key the app runs in mock mode at zero cost.</p> : (
            <ul className="space-y-1 text-sm">{h.spend.byWorkflow.slice(0, 10).map((w) => <li key={w.workflow} className="flex justify-between gap-2"><span>{w.workflow}</span><span className="text-ink-soft">{w.calls} calls · ${w.usd.toFixed(3)}</span></li>)}</ul>
          )}
          <p className="mt-2 text-xs text-ink-soft">{h.spend.calls} calls · {h.spend.failedCalls} failed · {h.spend.mockedCalls} mocked · pricing {h.spend.currentPricingVersion} · ₹{h.spend.fxInrPerUsd}/USD{h.spend.budgetExceeded ? " · BUDGET REACHED" : ""}</p>
        </Card></div>

        <div id="failures" className="lg:col-span-2"><Card title="Jobs">
          <div className="mb-3 flex flex-wrap gap-1.5">{Object.entries(h.jobs.counts).map(([s, n]) => <Badge key={s} tone={s === "failed" || s === "dead" ? (n ? "bad" : "neutral") : "neutral"}>{s}: {n}</Badge>)}</div>
          {h.jobs.recentFailures.length === 0 ? <p className="text-sm text-ink-soft">No failed jobs.</p> : (
            <ul className="divide-y divide-line">{h.jobs.recentFailures.map((j) => (
              <li key={j.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 text-sm"><div className="font-medium">{j.job_type} <Badge tone="bad">{j.state}</Badge></div>
                  <div className="text-xs text-ink-soft">{j.attempts}/{j.max_attempts} attempts · {fmtDate(j.updated_at, true)}</div>
                  {j.last_error ? <p className="line-clamp-3 break-words text-xs text-bad">{j.last_error}</p> : null}</div>
                <ActionForm action={retryJobAction.bind(null, j.id)}><Submit variant="secondary">Retry</Submit></ActionForm>
              </li>))}</ul>
          )}
          {h.jobs.retrying.length ? <p className="mt-2 text-xs text-ink-soft">{h.jobs.retrying.length} job(s) retrying automatically with back-off.</p> : null}
        </Card></div>

        <Card title="Job latency (last 24 h)" className="lg:col-span-2">
          {!h.jobs.latency.checked ? <StaleBanner>Latency could not be computed ({h.jobs.latency.error}).</StaleBanner>
            : h.jobs.latency.rows.length === 0 ? <p className="text-sm text-ink-soft">No timed job runs in the last 8 days yet. Durations are recorded from the next job run.</p> : (
            <ul className="divide-y divide-line text-sm">{h.jobs.latency.rows.map((r) => (
              <li key={r.jobType} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5">
                <span className="min-w-0 break-all font-medium">{r.jobType} {r.drift ? <Badge tone="warn" title="p95 more than 2x the previous 7 days">slower than usual</Badge> : null}</span>
                <span className="text-xs text-ink-soft">{r.runs24h} runs{r.failed24h ? ` · ${r.failed24h} failed` : ""} · p50 {ms(r.p50Ms)} · p95 {ms(r.p95Ms)} · max {ms(r.maxMs)} · 7-day p95 {ms(r.p95BaselineMs)}</span>
              </li>))}</ul>
          )}
          {h.jobs.slowest.length ? (
            <details className="mt-2 text-sm"><summary className="cursor-pointer text-ink-soft">Slowest runs (24 h)</summary>
              <ul className="mt-1 space-y-1">{h.jobs.slowest.map((j) => <li key={j.id} className="flex flex-wrap justify-between gap-2 text-xs"><span className="break-all">{j.job_type} <Badge tone={j.state === "succeeded" ? "ok" : "bad"}>{j.state}</Badge></span><span className="text-ink-soft">{ms(j.duration_ms)} · {fmtDate(j.finished_at, true)}</span></li>)}</ul>
            </details>
          ) : null}
          <p className="mt-2 text-xs text-ink-soft">Scheduler: last tick {mins(sch.minutesSince)}{sch.checked ? ` · ${sch.ticks24h} ticks in 24 h · ${sch.ticksWithErrors24h} with errors · longest gap ${sch.maxGapMinutes24h ?? "—"} min · p95 tick ${ms(sch.p95TickMs24h)}` : ""}. A gap over {sch.staleAfterMinutes} min alerts owners.</p>
        </Card>

        <div id="connectors"><Card title="Connectors" actions={<Link className="text-sm text-brand" href="/settings/connections">Manage</Link>}>
          {h.connectors.length === 0 ? <p className="text-sm text-ink-soft">No connectors yet. Connect mail and calendar in Settings → Connections.</p> : (
            <ul className="space-y-2 text-sm">{h.connectors.map((c) => (
              <li key={c.id}><div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{c.provider}</span><span className="text-ink-soft">{c.account_email}</span><Badge tone={c.healthy ? "ok" : "bad"}>{c.status}</Badge></div>
                {c.resources.map((r) => <div key={r.resource} className="text-xs text-ink-soft">{r.resource}: last success {r.last_success_at ? fmtDate(r.last_success_at, true) : "never"} {r.failing ? <Badge tone="bad">failing</Badge> : r.stale ? <Badge tone="warn">stale</Badge> : null}</div>)}
                {c.last_error ? <p className="text-xs text-bad">{c.last_error}</p> : null}</li>))}</ul>
          )}
        </Card></div>

        <Card title="Imports" actions={<Link className="text-sm text-brand" href="/imports">Open</Link>}>
          {h.imports.recent.length === 0 ? <p className="text-sm text-ink-soft">No imports yet.</p> : (
            <>
              {Object.keys(h.imports.byStatus).length ? <div className="mb-2 flex flex-wrap gap-1">{Object.entries(h.imports.byStatus).map(([s, n]) => <Badge key={s}>{s}: {n}</Badge>)}</div> : null}
              <ul className="space-y-1 text-sm">{h.imports.recent.slice(0, 6).map((r) => <li key={r.id} className="truncate">{r.file_name ?? r.source_name ?? r.job_type ?? "import"} <span className="text-xs text-ink-soft">{r.status ?? r.state} · {fmtDate(r.updated_at ?? r.created_at, true)}</span></li>)}</ul>
            </>
          )}
        </Card>

        <div id="backups" className="lg:col-span-2"><Card title="Backups">
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div><div className="text-xs uppercase text-ink-soft">Nightly logical export</div>{b.lastExport ? <>{fmtDate(b.lastExport.finished_at ?? b.lastExport.started_at, true)} <Badge tone={b.rpoMet ? "ok" : "bad"}>{b.rpoMet ? "within RPO" : "RPO missed"}</Badge></> : <Badge tone="bad">none yet</Badge>}</div>
            <div><div className="text-xs uppercase text-ink-soft">Monthly restore sample</div>{b.lastRestoreSample ? <>{fmtDate(b.lastRestoreSample.finished_at, true)} <Badge tone={b.lastRestoreSample.status === "succeeded" ? "ok" : "warn"}>{b.lastRestoreSample.status}</Badge></> : null}{b.restoreSampleDue ? <Badge tone="warn">due</Badge> : null}</div>
            <div><div className="text-xs uppercase text-ink-soft">Quarterly full drill</div>{b.lastFullDrill ? fmtDate(b.lastFullDrill.finished_at, true) : "not recorded"} {b.fullDrillDue ? <Badge tone="warn">due</Badge> : null}</div>
          </div>
          {b.lastFailure ? <p className="mt-2 text-xs text-bad">Last failure {fmtDate(b.lastFailure.started_at, true)}: {b.lastFailure.error}</p> : null}
          {b.lastRestoreSample?.findings?.hazards && Object.keys(b.lastRestoreSample.findings.hazards).length ? <p className="mt-2 text-xs text-warn">Restore hazards: {Object.keys(b.lastRestoreSample.findings.hazards).join(", ").replace(/_/g, " ")} — re-apply suppressions and removals after any restore.</p> : null}
          {restore ? <p className="mt-2 text-xs text-ink-soft">Last restore test: {restore.rows_restored ?? 0} rows from {restore.tables_restored ?? 0} tables restored into scratch copies of the live tables and compared value by value{restore.failed?.length ? <span className="text-bad"> · {restore.failed.length} table(s) could not be restored: {restore.failed.map((f) => f.table).join(", ")}</span> : null}{restore.skipped_for_time?.length ? ` · ${restore.skipped_for_time.length} skipped for time` : ""}.</p> : null}
          <p className="mt-2 text-xs text-ink-soft">Exports are stored under the workspace&apos;s admin-only backups area; production also relies on managed daily database backups / PITR. Targets: RPO 24 h, RTO one working day.</p>
        </Card></div>
      </div>
      <p className="text-xs text-ink-soft">Generated {fmtDate(h.generatedAt, true)} · <Link className="text-brand" href="/admin/audit">Audit log</Link> · JSON: <code>/api/v1/admin/health</code></p>
    </div>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="Health" subtitle="System supervisor: alerts, jobs, latency, scheduler, connectors, AI spend, imports, backups and the kill switches." />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}
