import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, Input, PageHeader, Stat, StaleBanner, inr } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { getHealth } from "@/modules/admin/health";
import { retryJobAction, setPausedAction } from "@/modules/admin/actions/settings";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Health" };

const hours = (h: number | null) => (h === null ? "never" : h < 1 ? "under 1 h ago" : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`);

async function Body() {
  const ctx = await requireAdminPage("admin", "/admin");
  const h = await getHealth(ctx.db, ctx.workspaceId);
  const failingConnectors = h.connectors.filter((c) => c.status !== "active" || c.resources.some((r) => r.failing || r.stale));
  const b = h.backups;
  return (
    <div className="space-y-4">
      {h.workspace.status !== "active" ? <StaleBanner>Workspace status is <strong>{h.workspace.status}</strong> (set by the platform administrator).</StaleBanner> : null}
      {failingConnectors.length ? <StaleBanner>{failingConnectors.length} connector(s) failing or stale — briefs label affected sections as stale.</StaleBanner> : null}
      {!b.rpoMet ? <StaleBanner>No successful logical export in the last 24 hours (RPO). Last export: {hours(b.exportAgeHours)}.</StaleBanner> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Kill switch" value={h.workspace.aiPaused ? <span className="text-bad">Paused</span> : <span className="text-ok">Running</span>} hint="AI + external ingestion" />
        <Stat label="AI spend (month)" value={inr(h.spend.spentInr)} hint={h.spend.budgetInr > 0 ? `${(h.spend.pctOfBudget ?? 0).toFixed(0)}% of ${inr(h.spend.budgetInr)}` : "no budget set"} />
        <Stat label="Failed jobs" value={h.jobs.counts.failed + h.jobs.counts.dead} hint={`${h.jobs.counts.queued} queued · ${h.jobs.counts.running} running`} />
        <Stat label="Last backup" value={b.lastExport ? hours(b.exportAgeHours) : "never"} hint={b.rpoMet ? "RPO 24 h met" : "RPO 24 h missed"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kill switch">
          <ActionForm action={setPausedAction} className="space-y-2">
            <p className="text-sm text-ink-soft">{h.workspace.aiPaused ? "AI calls and external ingestion are stopped. Internal records, tasks, approvals and the deterministic brief keep working." : "Pausing stops AI calls and external ingestion immediately. Internal work continues."}</p>
            <input type="hidden" name="paused" value={h.workspace.aiPaused ? "0" : "1"} />
            <Input name="reason" placeholder="Reason (recorded in the audit log)" />
            <Submit variant={h.workspace.aiPaused ? "primary" : "danger"} confirm={h.workspace.aiPaused ? undefined : "Pause AI and external ingestion for this workspace?"}>{h.workspace.aiPaused ? "Resume" : "Pause AI & ingestion"}</Submit>
          </ActionForm>
        </Card>

        <Card title="AI spend by workflow">
          {h.spend.byWorkflow.length === 0 ? <p className="text-sm text-ink-soft">No model calls this month{h.spend.mockedCalls ? "" : ""}. Without an API key the app runs in mock mode at zero cost.</p> : (
            <ul className="space-y-1 text-sm">{h.spend.byWorkflow.slice(0, 10).map((w) => <li key={w.workflow} className="flex justify-between gap-2"><span>{w.workflow}</span><span className="text-ink-soft">{w.calls} calls · ${w.usd.toFixed(3)}</span></li>)}</ul>
          )}
          <p className="mt-2 text-xs text-ink-soft">{h.spend.calls} calls · {h.spend.failedCalls} failed · {h.spend.mockedCalls} mocked · pricing {h.spend.currentPricingVersion} · ₹{h.spend.fxInrPerUsd}/USD{h.spend.budgetExceeded ? " · BUDGET REACHED" : ""}</p>
        </Card>

        <Card title="Jobs" className="lg:col-span-2">
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
        </Card>

        <Card title="Connectors" actions={<Link className="text-sm text-brand" href="/settings/connections">Manage</Link>}>
          {h.connectors.length === 0 ? <p className="text-sm text-ink-soft">No connectors yet. Connect mail and calendar in Settings → Connections.</p> : (
            <ul className="space-y-2 text-sm">{h.connectors.map((c) => (
              <li key={c.id}><div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{c.provider}</span><span className="text-ink-soft">{c.account_email}</span><Badge tone={c.status === "active" ? "ok" : "bad"}>{c.status}</Badge></div>
                {c.resources.map((r) => <div key={r.resource} className="text-xs text-ink-soft">{r.resource}: last success {r.last_success_at ? fmtDate(r.last_success_at, true) : "never"} {r.failing ? <Badge tone="bad">failing</Badge> : r.stale ? <Badge tone="warn">stale</Badge> : null}</div>)}
                {c.last_error ? <p className="text-xs text-bad">{c.last_error}</p> : null}</li>))}</ul>
          )}
        </Card>

        <Card title="Imports" actions={<Link className="text-sm text-brand" href="/imports">Open</Link>}>
          {h.imports.recent.length === 0 ? <p className="text-sm text-ink-soft">No imports yet.</p> : (
            <>
              {Object.keys(h.imports.byStatus).length ? <div className="mb-2 flex flex-wrap gap-1">{Object.entries(h.imports.byStatus).map(([s, n]) => <Badge key={s}>{s}: {n}</Badge>)}</div> : null}
              <ul className="space-y-1 text-sm">{h.imports.recent.slice(0, 6).map((r) => <li key={r.id} className="truncate">{r.file_name ?? r.source_name ?? r.job_type ?? "import"} <span className="text-xs text-ink-soft">{r.status ?? r.state} · {fmtDate(r.updated_at ?? r.created_at, true)}</span></li>)}</ul>
            </>
          )}
        </Card>

        <Card title="Backups" className="lg:col-span-2">
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div><div className="text-xs uppercase text-ink-soft">Nightly logical export</div>{b.lastExport ? <>{fmtDate(b.lastExport.finished_at ?? b.lastExport.started_at, true)} <Badge tone={b.rpoMet ? "ok" : "bad"}>{b.rpoMet ? "within RPO" : "RPO missed"}</Badge></> : <Badge tone="bad">none yet</Badge>}</div>
            <div><div className="text-xs uppercase text-ink-soft">Monthly restore sample</div>{b.lastRestoreSample ? <>{fmtDate(b.lastRestoreSample.finished_at, true)} <Badge tone={b.lastRestoreSample.status === "succeeded" ? "ok" : "warn"}>{b.lastRestoreSample.status}</Badge></> : null}{b.restoreSampleDue ? <Badge tone="warn">due</Badge> : null}</div>
            <div><div className="text-xs uppercase text-ink-soft">Quarterly full drill</div>{b.lastFullDrill ? fmtDate(b.lastFullDrill.finished_at, true) : "not recorded"} {b.fullDrillDue ? <Badge tone="warn">due</Badge> : null}</div>
          </div>
          {b.lastFailure ? <p className="mt-2 text-xs text-bad">Last failure {fmtDate(b.lastFailure.started_at, true)}: {b.lastFailure.error}</p> : null}
          {b.lastRestoreSample?.findings?.hazards && Object.keys(b.lastRestoreSample.findings.hazards).length ? <p className="mt-2 text-xs text-warn">Restore hazards: {Object.keys(b.lastRestoreSample.findings.hazards).join(", ").replace(/_/g, " ")} — re-apply suppressions and removals after any restore.</p> : null}
          <p className="mt-2 text-xs text-ink-soft">Exports are stored under the workspace&apos;s admin-only backups area; production also relies on managed daily database backups / PITR. Targets: RPO 24 h, RTO one working day.</p>
        </Card>
      </div>
      <p className="text-xs text-ink-soft">Generated {fmtDate(h.generatedAt, true)} · <Link className="text-brand" href="/admin/audit">Audit log</Link> · JSON: <code>/api/v1/admin/health</code></p>
    </div>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="Health" subtitle="Jobs, connectors, AI spend, imports, backups and the kill switch." />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}
