import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { runAction, workflowAction } from "@/modules/orchestrator/ui/actions";
import { RunStatus, When } from "@/modules/orchestrator/ui/components";
import { DEF_STATUS, everyText, priorityText, triggerText } from "@/modules/orchestrator/ui/labels";
import { AutomationError, dateForRequest, loadWorkflow } from "@/modules/orchestrator/ui/service";
import { PREPARE_MEETINGS } from "@/modules/orchestrator/ui/workflows";

export const metadata = { title: "Workflow" };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function Body({ params }: { params: Promise<{ workflowId: string }> }) {
  const key = decodeURIComponent((await params).workflowId);
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const w = await loadWorkflow({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId, role: ctx.role, timezone: tz }, key)
    .catch((e) => { if (e instanceof AutomationError && e.status === 404) return null; throw e; });
  if (!w) notFound();
  const admin = hasRole(ctx, "admin");
  const editor = hasRole(ctx, "editor");
  const st = w.state?.status ?? "active";
  const every = w.state?.every_minutes ?? null;
  const labelOf = new Map(w.steps.map((s) => [s.key, s.label]));
  const runs = w.recentExecutions as Row[];

  return (
    <div className="space-y-4">
      <PageHeader title={w.name} subtitle={<span className="flex flex-wrap items-center gap-2"><Badge tone={DEF_STATUS[st]?.tone ?? "neutral"}>{DEF_STATUS[st]?.label ?? st}</Badge>{triggerText(w.trigger, every)}</span>}
        actions={<ButtonLink variant="secondary" href="/automation">All automation</ButtonLink>} />

      <Card title="What it does">
        <p className="text-sm">{w.description}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-ink-soft">Last run</dt><dd><When at={w.state?.last_run_at ?? w.latest?.started_at} tz={tz} /></dd></div>
          <div><dt className="text-xs text-ink-soft">Next run</dt><dd>{w.trigger.type === "schedule" ? (st === "paused" ? "Paused" : <When at={w.state?.next_run_at} tz={tz} />) : "When triggered"}</dd></div>
          <div><dt className="text-xs text-ink-soft">Priority</dt><dd>{priorityText(w.state?.priority ?? w.priority)} ({w.state?.priority ?? w.priority})</dd></div>
          <div><dt className="text-xs text-ink-soft">Last result</dt><dd>{w.latest ? <RunStatus status={w.latest.status} /> : "Never run"}</dd></div>
        </dl>
        {w.approvals.length ? <p className="mt-3 text-xs text-ink-soft">Needs approval for: {w.approvals.join(", ")}.</p> : null}
      </Card>

      <Card title="Steps">
        <ol className="space-y-2">
          {w.steps.map((s, i) => (
            <li key={s.key} className="rounded-lg border border-line p-3 text-sm">
              <p className="font-medium">{i + 1}. {s.label}</p>
              <p className="text-xs text-ink-soft">
                {s.dependsOn.length ? `After: ${s.dependsOn.map((d) => labelOf.get(d) ?? d).join(", ")}` : "Starts first"}
                {s.consequential ? " · important step — never retried automatically" : ""}
              </p>
            </li>
          ))}
        </ol>
      </Card>

      {w.lastFailed ? (
        <Card title="Last error">
          <p className="text-sm text-bad">{w.lastFailed.error ?? "A step failed."}</p>
          <p className="mt-1 text-sm"><Link className="text-brand underline" href={`/automation/runs/${w.lastFailed.id}`}>See what failed and what to do</Link></p>
        </Card>
      ) : null}

      {editor ? (
        <Card title="Controls">
          <div className="space-y-4">
            {w.trigger.type === "user" ? (
              <ActionForm action={workflowAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="key" value={w.key} />
                {w.key === PREPARE_MEETINGS ? <Field label="For which day?"><Input type="date" name="date" defaultValue={dateForRequest("tomorrow", tz)} required /></Field> : null}
                <Submit name="op" value="start">Run now</Submit>
              </ActionForm>
            ) : null}
            {w.activeRun ? (
              <ActionForm action={runAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={w.activeRun.id} />
                <span className="w-full text-sm">Current run: <Link className="text-brand underline" href={`/automation/runs/${w.activeRun.id}`}>{w.activeRun.progress ?? 0}% done</Link></span>
                {w.activeRun.status === "paused" ? <Submit name="op" value="resume" variant="secondary">Resume run</Submit> : <Submit name="op" value="pause" variant="secondary">Pause run</Submit>}
                {admin ? <Submit name="op" value="cancel" variant="danger" confirm="Cancel this run? Finished steps are kept.">Cancel run</Submit> : null}
              </ActionForm>
            ) : null}
            {w.lastFailed && !w.activeRun ? (
              <ActionForm action={runAction}>
                <input type="hidden" name="id" value={w.lastFailed.id} />
                <Submit name="op" value="retry" variant="secondary">Retry last failed run</Submit>
              </ActionForm>
            ) : null}
            {admin ? (
              <>
                <ActionForm action={workflowAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="key" value={w.key} />
                  {st === "paused" ? <Submit name="op" value="resume">Switch on</Submit> : <Submit name="op" value="pause" variant="secondary" confirm="Pause this workflow? It will not start new runs until switched on. Runs already started continue.">Pause workflow</Submit>}
                </ActionForm>
                {w.trigger.type === "schedule" ? (
                  <ActionForm action={workflowAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="key" value={w.key} /><input type="hidden" name="op" value="schedule" />
                    <Field label="Run every" hint={`Now: ${everyText(every) || "no schedule"}`}><Input type="number" name="everyMinutes" min={1} step={1} defaultValue={every ? (every % 1440 === 0 ? every / 1440 : every % 60 === 0 ? every / 60 : every) : ""} className="w-24" /></Field>
                    <Field label="Unit"><Select name="unit" defaultValue={every && every % 1440 === 0 ? "1440" : every && every % 60 === 0 ? "60" : "1"}><option value="1">minutes</option><option value="60">hours</option><option value="1440">days</option></Select></Field>
                    <Submit variant="secondary">Save schedule</Submit>
                  </ActionForm>
                ) : null}
                <ActionForm action={workflowAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="key" value={w.key} /><input type="hidden" name="op" value="priority" />
                  <Field label="Priority" hint="Higher runs first when several jobs wait."><Select name="priority" defaultValue={String(w.state?.priority ?? w.priority)}>
                    {[[90, "High"], [50, "Normal"], [20, "Low"]].concat([[w.state?.priority ?? w.priority, `Current (${w.state?.priority ?? w.priority})`]]).filter((x, i, arr) => arr.findIndex((y) => y[0] === x[0]) === i).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select></Field>
                  <Submit variant="secondary">Save priority</Submit>
                </ActionForm>
              </>
            ) : <p className="text-xs text-ink-soft">Only admins can pause the workflow, change its schedule or priority, or cancel runs.</p>}
          </div>
        </Card>
      ) : null}

      <Card title="Recent runs">
        {runs.length ? (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <Link className="min-w-0 flex-1 text-ink hover:text-brand" href={`/automation/runs/${r.id}`}><When at={r.started_at} tz={tz} /></Link>
                <RunStatus status={r.status} /><span className="text-xs text-ink-soft">{r.progress ?? 0}%</span>
                {r.error ? <p className="w-full text-xs text-bad">{r.error}</p> : null}
                <a className="text-xs text-brand underline" href={`/api/v1/orchestrator/runs/${r.id}/log`} download>Export log</a>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No runs yet">{triggerText(w.trigger, every)}.</EmptyState>}
      </Card>

      <Card title="Affected records (last run)">
        {w.related.length ? (
          <ul className="flex flex-wrap gap-2 text-sm">
            {w.related.map((r) => <li key={`${r.type}:${r.id}`}>{r.href ? <Link className="rounded-md border border-line px-2 py-1 hover:text-brand" href={r.href}>{r.typeLabel}: {r.label ?? "open"}</Link> : <span className="rounded-md border border-line px-2 py-1">{r.typeLabel}: {r.label ?? r.id.slice(0, 8)}</span>}</li>)}
          </ul>
        ) : <p className="text-sm text-ink-soft">No records were touched by the last run.</p>}
      </Card>

      <Card title="Change history">
        {w.versions.length ? (
          <ul className="divide-y divide-line text-sm">
            {(w.versions as Row[]).map((v) => <li key={v.version} className="py-2">Version {v.version} · {v.note ?? "changed"} · <When at={v.created_at} tz={tz} /></li>)}
          </ul>
        ) : <p className="text-sm text-ink-soft">No changes yet.</p>}
      </Card>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ workflowId: string }> }) {
  return <Suspense fallback={<Skeleton variant="detail" />}><Body params={params} /></Suspense>;
}
