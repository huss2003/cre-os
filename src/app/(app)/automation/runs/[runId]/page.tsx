import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, PageHeader, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { runAction } from "@/modules/orchestrator/ui/actions";
import { RunStatus, When } from "@/modules/orchestrator/ui/components";
import { MARK, REF_TYPE, refHref } from "@/modules/orchestrator/ui/labels";
import { loadRun } from "@/modules/orchestrator/ui/service";
import { triggerLabel } from "@/modules/orchestrator/automation/service";

export const metadata = { title: "Run" };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const UUID = /^[0-9a-f-]{36}$/i;
const FINAL = ["completed", "failed", "cancelled", "done", "skipped"];

const HISTORY: Record<string, string> = {
  started: "Started", duplicate_trigger: "Same request received again (not run twice)", paused: "Paused", resumed: "Resumed", cancelled: "Cancelled",
  manual_retry: "Retry requested", priority_changed: "Priority changed", step_done: "Step finished", step_failed: "Step failed", step_skipped: "Step skipped", advance: "Moved on to the next steps", timed_out: "Took too long — stopped",
};
const historyText = (a: string) => HISTORY[a] ?? (a.startsWith("status_") ? `Now: ${a.slice(7).replace(/_/g, " ")}` : a.replace(/_/g, " "));

function RefList({ refs }: { refs: { type: string; id: string; label?: string | null; href: string | null; typeLabel: string }[] }) {
  if (!refs.length) return <p className="text-sm text-ink-soft">None.</p>;
  return (
    <ul className="flex flex-wrap gap-2 text-sm">
      {refs.map((r) => <li key={`${r.type}:${r.id}`}>{r.href ? <Link className="rounded-md border border-line px-2 py-1 hover:text-brand" href={r.href}>{r.typeLabel}: {r.label ?? "open"}</Link> : <span className="rounded-md border border-line px-2 py-1">{r.typeLabel}: {r.label ?? r.id.slice(0, 8)}</span>}</li>)}
    </ul>
  );
}

async function Body({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!UUID.test(runId)) notFound();
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const x = await loadRun({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId, role: ctx.role, timezone: tz }, runId);
  if (!x) notFound();
  const run = x.run;
  const editor = hasRole(ctx, "editor"); const admin = hasRole(ctx, "admin");
  const f = x.failure;
  const done = FINAL.includes(run.status);

  return (
    <div className="space-y-4">
      <PageHeader title={x.name} subtitle={<span className="flex flex-wrap items-center gap-2"><RunStatus status={run.status} />started <When at={run.started_at} tz={tz} />{run.finished_at ? <> · finished <When at={run.finished_at} tz={tz} /></> : null}</span>}
        actions={<ButtonLink variant="secondary" href={`/automation/${encodeURIComponent(x.definitionKey)}`}>About this workflow</ButtonLink>} />

      <Card title="Progress">
        <div className="h-2 overflow-hidden rounded bg-canvas" role="progressbar" aria-valuenow={run.progress ?? 0} aria-valuemin={0} aria-valuemax={100}><div className={`h-full ${run.status === "failed" ? "bg-bad" : "bg-brand"}`} style={{ width: `${run.progress ?? 0}%` }} /></div>
        <p className="mt-2 text-sm" data-testid="run-trigger">Triggered by: {triggerLabel(run)}</p>
        <p className="mt-1 text-sm text-ink-soft">{run.progress ?? 0}% · {x.completed.length} done · {x.current.length} in progress · {x.failedSteps.length} failed · {x.remaining.length} waiting</p>
        {run.status === "partially_completed" && run.next_attempt_at ? <p className="mt-1 text-sm">Next automatic try <When at={run.next_attempt_at} tz={tz} />.</p> : null}
      </Card>

      {f ? (
        <Card title="What went wrong" className="border-bad/30">
          <div className="space-y-3 text-sm">
            <div><p className="font-medium">What failed</p>
              <ul className="list-disc pl-5">{f.whatFailed.map((w, i) => <li key={i}><span className="font-medium">{w.step}</span>: {w.error ?? "unknown error"} <span className="text-ink-soft">({w.class === "temporary" ? "temporary problem" : w.class === "permanent" ? "needs a fix" : "error"}, {w.attempts} attempt{w.attempts === 1 ? "" : "s"})</span></li>)}</ul></div>
            <div><p className="font-medium">Records affected</p><RefList refs={x.failureRefs} /></div>
            <div><p className="font-medium">Steps that worked</p><p>{f.earlierStepsSucceeded.length ? f.earlierStepsSucceeded.join(", ") : "None yet."} {f.earlierStepsSucceeded.length ? "Their results are kept." : ""}</p></div>
            {f.mayBeStale ? <StaleBanner>Anything this job was updating may be out of date until it finishes.</StaleBanner> : null}
            <div><p className="font-medium">Will it retry by itself?</p><p>{f.willRetry ? <>Yes{f.nextAttemptAt ? <> — next try <When at={f.nextAttemptAt} tz={tz} /></> : null}.</> : "No."}</p></div>
            <div><p className="font-medium">What to do</p><p>{f.userAction}</p></div>
          </div>
        </Card>
      ) : null}

      {editor && (!done || run.status === "failed") ? (
        <Card title="Controls">
          <ActionForm action={runAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="id" value={run.id} />
            {["failed", "partially_completed"].includes(run.status) ? <Submit name="op" value="retry">Retry failed steps</Submit> : null}
            {run.status === "paused" ? <Submit name="op" value="resume" variant="secondary">Resume</Submit> : !done ? <Submit name="op" value="pause" variant="secondary">Pause</Submit> : null}
            {["queued", "waiting_dependency"].includes(run.status) ? <Submit name="op" value="continue" variant="secondary">Run now</Submit> : null}
            {admin && !done ? <Submit name="op" value="cancel" variant="danger" confirm="Cancel this run? Finished steps and their results are kept.">Cancel</Submit> : null}
          </ActionForm>
          {run.status === "waiting_approval" ? <p className="mt-2 text-sm">A step is waiting for approval. <Link className="text-brand underline" href="/approvals">Open Review</Link></p> : null}
        </Card>
      ) : null}

      <Card title="Steps">
        <ol className="space-y-2">
          {x.steps.map((s: Row) => (
            <li key={s.id} className="rounded-lg border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{s.seq}. {s.label}</span><RunStatus status={s.status} step /></div>
              {s.reason ? <p className="mt-1 text-ink">{s.reason}</p> : null}
              {s.error ? <p className="mt-1 text-bad">{s.error}</p> : null}
              <p className="mt-1 text-xs text-ink-soft">{(s.depends_on ?? []).length ? `After: ${(s.depends_on as string[]).map((d) => x.steps.find((y: Row) => y.step_key === d)?.label ?? d).join(", ")} · ` : ""}{s.attempts ?? 0} attempt(s){s.next_attempt_at ? <> · next try <When at={s.next_attempt_at} tz={tz} /></> : null}{s.finished_at ? <> · finished <When at={s.finished_at} tz={tz} /></> : null}</p>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Records involved"><RefList refs={x.related} /></Card>

      {x.marks.length ? (
        <Card title="Flags raised">
          <ul className="divide-y divide-line text-sm">
            {x.marks.map((m: Row) => { const h = refHref(m.entity_type, m.entity_id); return (
              <li key={m.id} className="py-2"><Badge tone={MARK[m.mark]?.tone ?? "warn"}>{MARK[m.mark]?.label ?? m.mark}</Badge> <span className="text-xs text-ink-soft">{REF_TYPE[m.entity_type] ?? m.entity_type}{m.state !== "open" ? ` · ${m.state}` : ""}</span>
                <p>{h ? <Link className="hover:text-brand" href={h}>{m.reason}</Link> : m.reason}</p></li>
            ); })}
          </ul>
        </Card>
      ) : null}

      <Card title="History" actions={<a className="text-sm text-brand underline" href={`/api/v1/orchestrator/runs/${run.id}/log`} download>Export log</a>}>
        <ul className="divide-y divide-line text-sm">
          {(x.history as Row[]).map((h, i) => <li key={i} className="flex flex-wrap gap-x-3 py-1.5"><span className="text-xs text-ink-soft"><When at={h.occurred_at} tz={tz} /></span><span>{historyText(h.action)}{h.actor_user_id ? " (by a person)" : ""}</span></li>)}
        </ul>
      </Card>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ runId: string }> }) {
  return <Suspense fallback={<div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">Loading…</div>}><Body params={params} /></Suspense>;
}
