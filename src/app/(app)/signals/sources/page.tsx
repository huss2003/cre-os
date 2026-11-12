import { Suspense } from "react";
import Link from "next/link";
import { Card, Field, Input, StaleBanner } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { listSourceRegistry, type RegistryView } from "@/modules/signals/sources";
import { refreshStatus, TIER_CADENCE_DAYS } from "@/modules/signals/refresh";
import { sourceAction, refreshNowAction, retryItemAction, universeAction } from "@/modules/signals/actions";

export const metadata = { title: "Signal sources" };
type Row = Record<string, any>;
const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");

const CONN: Record<string, { label: string; cls: string }> = {
  connected: { label: "Connected", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  paused: { label: "Paused", cls: "bg-stone-100 text-stone-700 ring-stone-200" },
  error: { label: "Failing", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  needs_access: { label: "Unavailable — needs access", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  unavailable: { label: "Unavailable", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
};

function SourceRow({ r, admin }: { r: RegistryView; admin: boolean }) {
  const st = !r.available ? (CONN[r.connectionStatus === "needs_access" ? "needs_access" : "unavailable"]) : CONN[r.connectionStatus] ?? CONN.unavailable;
  const act = sourceAction.bind(null, r.id);
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="font-semibold">{r.name}</p>
          <p className="text-xs text-ink-soft">{r.type} · {r.accessMethod}</p>
        </div>
        <span className={`self-start rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${st.cls}`}>{st.label}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div><dt className="text-ink-soft">Permission</dt><dd>{r.permissionStatus ?? "unknown"}{r.permittedPurposes.length ? <span className="text-ink-soft"> ({r.permittedPurposes.join(", ").replace(/_/g, " ")})</span> : null}</dd></div>
        <div><dt className="text-ink-soft">Last sync</dt><dd>{fmt(r.lastRetrieval)}</dd></div>
        <div><dt className="text-ink-soft">Refresh</dt><dd>{r.refreshDays ? `Every ${r.refreshDays} day${r.refreshDays === 1 ? "" : "s"}` : "On demand"}</dd></div>
        <div><dt className="text-ink-soft">Used</dt><dd>{r.usageCount} time{r.usageCount === 1 ? "" : "s"}</dd></div>
      </dl>
      {r.lastError ? <p className="mt-2 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">{r.lastError}</p> : null}
      {admin ? (
        <ActionForm action={act} className="mt-3 flex flex-wrap gap-2">
          {r.paused ? <Submit name="op" value="resume" variant="secondary">Resume</Submit> : r.available ? <Submit name="op" value="pause" variant="secondary">Pause</Submit> : null}
          {r.connectionStatus !== "connected" || !r.available ? <Submit name="op" value="reconnect" variant="secondary">Reconnect</Submit> : null}
        </ActionForm>
      ) : null}
    </li>
  );
}

async function Body() {
  const ctx = await requirePageContext("viewer");
  const admin = ["admin", "owner"].includes(ctx.role);
  const editor = ctx.role !== "viewer";
  let reg: RegistryView[] = []; let st: Awaited<ReturnType<typeof refreshStatus>> | null = null; let failed: string | null = null;
  try { [reg, st] = await Promise.all([listSourceRegistry(ctx.db, ctx.workspaceId), refreshStatus(ctx.db, ctx.workspaceId)]); }
  catch (e) { failed = e instanceof Error ? e.message : "Unknown error"; }
  const broken = reg.filter((r) => r.connectionStatus === "error");
  return (
    <div className="space-y-6">
      <div>
        <Link href="/signals" className="inline-flex min-h-11 items-center text-sm text-ink-soft hover:text-ink">← Signals</Link>
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><h1 className="text-2xl font-bold tracking-tight">Sources</h1><p className="mt-1 text-sm text-ink-soft">Where signals come from, whether each source is working, and when it last ran.</p></div>
          {editor ? <ActionForm action={refreshNowAction}><Submit variant="secondary">Refresh now</Submit></ActionForm> : null}
        </header>
      </div>
      {failed ? <div role="alert" className="rounded-2xl border border-bad/30 bg-bad/10 px-5 py-4 text-sm text-bad">Sources could not be loaded: {failed}</div> : null}
      {broken.length ? <StaleBanner>{broken.length} source{broken.length === 1 ? " is" : "s are"} failing — signals from {broken.length === 1 ? "it" : "them"} may be missing or stale.</StaleBanner> : null}

      <section aria-labelledby="reg-h" className="space-y-3">
        <h2 id="reg-h" className="text-sm font-semibold">Source registry</h2>
        {reg.length ? <ul className="space-y-3">{reg.map((r) => <SourceRow key={r.id} r={r} admin={admin} />)}</ul>
          : !failed ? <p className="rounded-2xl border border-dashed border-line px-5 py-8 text-center text-sm text-ink-soft">No sources registered yet. An admin opening this page registers the built-in sources automatically.</p> : null}
      </section>

      {st ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Recent runs">
            {st.syncRuns.length ? <ul className="space-y-1 text-sm">{(st.syncRuns as Row[]).map((r) => <li key={r.id} className="break-words"><span className="text-ink-soft">{fmt(r.started_at)}</span> · {r.adapter} · {r.trigger} · <span className={r.status === "failed" ? "text-bad" : ""}>{r.status}</span>{typeof r.items_new === "number" ? ` · ${r.items_new} new` : ""}{r.error ? <span className="text-bad"> — {r.error}</span> : null}</li>)}</ul> : <p className="text-sm text-ink-soft">No runs yet. Press “Refresh now”.</p>}
          </Card>
          <Card title="Failed items and jobs">
            {st.failedItems.length || st.failedJobs.length ? (
              <ul className="space-y-2 text-sm">
                {(st.failedItems as Row[]).map((x) => (
                  <li key={x.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0 break-words">{x.title ?? x.source_name ?? x.adapter} <span className="text-bad">— {x.error ?? "failed"}</span> <span className="text-xs text-ink-soft">({x.attempts ?? 0} attempts)</span></span>
                    {editor ? <ActionForm action={retryItemAction.bind(null, x.id)}><Submit variant="secondary">Retry</Submit></ActionForm> : null}
                  </li>
                ))}
                {(st.failedJobs as Row[]).map((j) => <li key={j.id}>Job {j.job_type} <span className="text-bad">— {j.last_error ?? j.state}</span></li>)}
              </ul>
            ) : <p className="text-sm text-ink-soft">Nothing has failed.</p>}
          </Card>
        </div>
      ) : null}

      {st ? (
        <Card title="Research universe">
          <p className="text-sm">{st.universe.size.toLocaleString("en-IN")} of {st.universe.cap.toLocaleString("en-IN")} companies in the active universe · {st.due} due for refresh.</p>
          <ul className="mt-2 space-y-1 text-sm text-ink-soft">{Object.entries(st.tiers as Record<string, string>).map(([k, v]) => <li key={k}><span className="font-medium text-ink">{k}</span>: {v}{TIER_CADENCE_DAYS[k] ? ` — every ${TIER_CADENCE_DAYS[k]} days` : ""}</li>)}</ul>
          {admin ? (
            <ActionForm action={universeAction} className="mt-4 flex flex-wrap items-end gap-2">
              <Field label="Universe size (companies)" hint="50–8,000. Bounds how many companies are refreshed."><Input name="cap" type="number" min={50} max={8000} step={1} defaultValue={st.universe.cap} required /></Field>
              <Submit>Save</Submit>
            </ActionForm>
          ) : <p className="mt-2 text-xs text-ink-soft">Only admins can change the universe size.</p>}
        </Card>
      ) : null}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Body /></Suspense>;
}
