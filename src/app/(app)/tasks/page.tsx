import { Suspense } from "react";
import Link from "next/link";
import clsx from "clsx";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import { loadSettings } from "@/modules/brief/db";
import { listTasks, taskFilterSchema, TASK_STATES, type TaskRow } from "@/modules/brief/tasks-service";
import { completeAction, createAction, reopenAction, snoozeAction } from "./actions";


const STATE_LABEL: Record<string, string> = { open: "Open", overdue: "Overdue", snoozed: "Snoozed", stale: "Stale", done: "Done", all: "All" };
const STATE_TONE: Record<TaskRow["state"], "neutral" | "bad" | "accent" | "warn" | "ok"> = { open: "neutral", overdue: "bad", snoozed: "accent", stale: "warn", done: "ok", cancelled: "neutral" };

const EMPTY: Record<string, string> = {
  open: "No open tasks. Tasks are created from captures, the lease radar (missing dates, notice deadlines), today's targets, or manually below.",
  overdue: "Nothing overdue.",
  snoozed: "No snoozed tasks. Snoozed tasks come back automatically when the snooze ends.",
  stale: "No stale tasks. Tasks overdue for longer than the stale threshold land here instead of silently disappearing.",
  done: "No completed tasks yet. Completing a task records what was done as evidence.",
  all: "No tasks yet.",
};

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<div className="p-6 text-sm text-ink-soft">Loading…</div>}><Body searchParams={searchParams} /></Suspense>;
}

async function Body({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const tz = ctx.timezone || "Asia/Kolkata";
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const parsed = taskFilterSchema.safeParse({ state: str("state"), scope: str("scope"), q: str("q") || undefined, source: str("source") || undefined });
  const f = parsed.success ? parsed.data : taskFilterSchema.parse({});
  const settings = await loadSettings(ctx.db, ctx.workspaceId, ctx.userId);
  const tasks = await listTasks(ctx.db, ctx.workspaceId, ctx.userId, f, { staleAfterDays: settings.staleTaskAfterDays });
  const canEdit = hasRole(ctx, "editor");
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const merged = { state: f.state, scope: f.scope, q: f.q, source: f.source, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `/tasks?${u.toString()}`;
  };
  const returnTo = qs({});
  const formKey = crypto.randomUUID();

  return (
    <div className="space-y-4">
      <PageHeader title="Tasks" subtitle={`${tasks.length} ${STATE_LABEL[f.state].toLowerCase()} · ${f.scope === "mine" ? "assigned to me" : "everyone I can see"} · stale after ${settings.staleTaskAfterDays} days overdue`} />
      {str("ok") ? <div className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">{str("ok")}</div> : null}
      {str("error") ? <div className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{str("error")}</div> : null}

      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1 text-sm">
        {TASK_STATES.map((s) => (
          <Link key={s} href={qs({ state: s })} className={clsx("whitespace-nowrap rounded-full border px-3 py-1.5", f.state === s ? "border-brand bg-brand text-white" : "border-line bg-surface")}>{STATE_LABEL[s]}</Link>
        ))}
      </nav>
      <form className="flex flex-col gap-2 sm:flex-row" action="/tasks">
        <input type="hidden" name="state" value={f.state} />
        <Input name="q" defaultValue={f.q ?? ""} placeholder="Search titles" />
        <Select name="scope" defaultValue={f.scope} className="sm:w-44"><option value="mine">Mine</option><option value="all">Everyone</option></Select>
        <Select name="source" defaultValue={f.source ?? ""} className="sm:w-44">
          <option value="">Any source</option><option value="brief">Brief / targets</option><option value="workflow">Lease radar</option><option value="capture">Capture</option><option value="manual">Manual</option><option value="import">Import</option>
        </Select>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>

      {tasks.length === 0 ? <EmptyState title={`No ${STATE_LABEL[f.state].toLowerCase()} tasks`}>{EMPTY[f.state]}</EmptyState> : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li key={t.id} id={t.id} className="rounded-xl border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATE_TONE[t.state]}>{t.state === "snoozed" && t.snoozedUntil ? `Snoozed until ${fmt(t.snoozedUntil, "dd MMM", tz)}` : STATE_LABEL[t.state] ?? t.state}</Badge>
                <span className="font-medium">{t.title}</span>
              </div>
              <div className="mt-1 text-xs text-ink-soft">
                {t.dueAt ? `Due ${fmt(t.dueAt, "dd MMM yyyy HH:mm", tz)}` : "No due date"} · priority {t.priority}{t.source ? ` · ${t.source}` : ""}
                {t.linkedEntityType === "lease" ? <> · <Link className="text-brand" href={`/leases?lease=${t.linkedEntityId}`}>lease</Link></> : null}
                {t.linkedEntityType === "organisation" ? <> · <Link className="text-brand" href={`/companies/${t.linkedEntityId}`}>company</Link></> : null}
              </div>
              {t.description ? <p className="mt-1 text-sm text-ink-soft">{t.description}</p> : null}
              {t.completionEvidence ? <p className="mt-1 text-sm"><span className="font-medium">Evidence:</span> {t.completionEvidence} {t.completedAt ? <span className="text-xs text-ink-soft">({fmt(t.completedAt, "dd MMM HH:mm", tz)})</span> : null}</p> : null}
              {canEdit ? (
                t.state === "done" || t.state === "cancelled" ? (
                  <form action={reopenAction} className="mt-2"><Hidden t={t} r={returnTo} /><Button type="submit" variant="ghost">Reopen</Button></form>
                ) : (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <form action={completeAction} className="flex flex-1 gap-2">
                      <Hidden t={t} r={returnTo} />
                      <Input name="evidence" placeholder="What was done (evidence)" required minLength={3} />
                      <Button type="submit">Complete</Button>
                    </form>
                    <form action={snoozeAction} className="flex gap-2">
                      <Hidden t={t} r={returnTo} />
                      <Select name="days" defaultValue="1" className="w-24"><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option></Select>
                      <Button type="submit" variant="secondary">Snooze</Button>
                    </form>
                    {t.state === "snoozed" || t.state === "stale" ? <form action={reopenAction}><Hidden t={t} r={returnTo} /><Button type="submit" variant="ghost">Reopen</Button></form> : null}
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <Card title="New task">
          <form action={createAction} className="grid gap-3 sm:grid-cols-[1fr_160px_120px_auto] sm:items-end">
            <input type="hidden" name="form_key" value={formKey} /><input type="hidden" name="return_to" value={returnTo} />
            <Field label="Title"><Input name="title" required minLength={3} maxLength={300} placeholder="e.g. Send Baner options to Acme" /></Field>
            <Field label="Due"><Input name="due" type="date" /></Field>
            <Field label="Priority"><Select name="priority" defaultValue="50"><option value="90">High</option><option value="50">Normal</option><option value="20">Low</option></Select></Field>
            <Button type="submit">Add</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function Hidden({ t, r }: { t: TaskRow; r: string }) {
  return (<><input type="hidden" name="id" value={t.id} /><input type="hidden" name="version" value={t.rowVersion} /><input type="hidden" name="return_to" value={r} /></>);
}
