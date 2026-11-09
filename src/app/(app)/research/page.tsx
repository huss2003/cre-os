import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { Button, Field, Select, Input } from "@/components/ui";
import { watchlistView, openFindings, orgOptions } from "@/modules/intelligence/research/queries";
import { Flash, fmtDay, label } from "@/modules/intelligence/ui";
import { aiConfigured, monthSpendUsd } from "@/lib/ai/gateway";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { researchNowAction, saveSettingsAction, discoverAction, assessFormAction, assessAction } from "@/modules/signals/actions";
import { ResearchLive, type Run } from "@/modules/signals/ui/research-live";
import { watchAction, findingAction } from "./actions";

const TIERS = [
  { key: "critical", name: "Key accounts", every: "Checked every week" },
  { key: "active", name: "Active accounts", every: "Checked every month" },
  { key: "universe", name: "Wider list", every: "Checked every 3 months" },
] as const;

function ago(iso: string | null) {
  if (!iso) return "Never researched";
  const d = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? "Researched today" : `Researched ${d} day${d === 1 ? "" : "s"} ago`;
}

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const isAdmin = hasRole(ctx, "admin");
  const [{ watch }, findings, orgs, spend, cfg, runs] = await Promise.all([
    watchlistView(ctx.db, ctx.workspaceId), openFindings(ctx.db, ctx.workspaceId), orgOptions(ctx.db, ctx.workspaceId),
    monthSpendUsd(ctx.workspaceId).catch(() => 0),
    ctx.db.from("workspace_setting").select("value").eq("workspace_id", ctx.workspaceId).eq("key", "signals").maybeSingle().then((r) => (r.data?.value ?? {}) as { weeklyCompanyLimit?: number; focusCities?: string[] }),
    ctx.db.from("research_run").select("id, kind, label, status, queries, sources, findings, new_companies, usd, error, created_at, finished_at, assessment").eq("workspace_id", ctx.workspaceId).order("created_at", { ascending: false }).limit(12).then((r) => (r.data ?? []) as Run[]),
  ]);
  const ai = aiConfigured();
  const weekly = cfg.weeklyCompanyLimit ?? 25;
  const due = watch.filter((w) => Date.parse(String(w.next_due_at)) <= Date.now()).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Research</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">Companies you watch are searched on the web on a schedule. What&apos;s found becomes a signal, with its link and date.</p>
      </header>
      <Flash sp={sp} />

      {/* Status: is the engine actually able to search? */}
      <section className={`flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between ${ai ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/70"}`}>
        <div className="flex items-start gap-3">
          <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${ai ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
          <div>
            <p className="font-semibold">{ai ? "Web research is on" : "Web research is off"}</p>
            <p className="text-sm text-ink-soft">{ai ? `Up to ${weekly} companies a week, at most 2 searches each. Runs daily at 05:30.` : "Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy. Until then, only pasted news and your own data are used."}</p>
          </div>
        </div>
        <dl className="flex gap-8 text-sm">
          <div><dt className="text-ink-soft">Watched</dt><dd className="text-xl font-bold">{watch.length}</dd></div>
          <div><dt className="text-ink-soft">Due now</dt><dd className="text-xl font-bold">{due}</dd></div>
          <div><dt className="text-ink-soft">AI this month</dt><dd className="text-xl font-bold">${spend.toFixed(2)}</dd></div>
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-6">
          <section>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div><h2 className="text-lg font-semibold">Live research</h2><p className="text-sm text-ink-soft">What each run searched and the websites it read. Green sites gave evidence.</p></div>
              {canEdit ? <ActionForm action={discoverAction}><Submit>Find a new prospect in {(cfg.focusCities ?? ["Pune"]).join(", ")}</Submit></ActionForm> : null}
            </div>
            <ResearchLive initial={runs} />
          </section>
          {watch.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
              <p className="font-semibold">No companies watched yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">Add a company on the right. It will be researched on its schedule, or straight away with Research now.</p>
            </div>
          ) : TIERS.map((t) => {
            const list = watch.filter((w) => w.tier === t.key);
            if (!list.length) return null;
            return (
              <section key={t.key}>
                <div className="mb-2 flex items-baseline justify-between"><h2 className="font-semibold">{t.name} <span className="font-normal text-ink-soft">({list.length})</span></h2><span className="text-xs text-ink-soft">{t.every}</span></div>
                <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                  {list.map((w) => {
                    const overdue = Date.parse(String(w.next_due_at)) <= Date.now();
                    return (
                      <li key={String(w.id)} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <Link href={`/research/${w.org_id}`} className="font-medium hover:underline">{w.name}</Link>
                          <p className="text-sm text-ink-soft">{ago(w.last_researched_at as string | null)}{overdue ? <span className="text-amber-700"> — due</span> : <> — next {fmtDay(String(w.next_due_at))}</>}</p>
                          {w.reason ? <p className="text-xs text-ink-soft">{String(w.reason)}</p> : null}
                        </div>
                        {canEdit ? <div className="flex gap-2"><ActionForm action={assessAction.bind(null, String(w.org_id))}><Submit variant="secondary">Client score</Submit></ActionForm><ActionForm action={researchNowAction.bind(null, String(w.org_id))}><Submit variant="secondary">Research now</Submit></ActionForm></div> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}

          {findings.length > 0 ? (
            <details className="rounded-2xl border border-line bg-surface">
              <summary className="cursor-pointer p-4 text-sm font-semibold">Evidence checks to look at ({findings.length})</summary>
              <ul className="divide-y divide-line border-t border-line">
                {findings.map((f) => (
                  <li key={String(f.id)} className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-start sm:justify-between">
                    <div><p className="font-medium">{label(String(f.kind))}</p><p className="text-ink-soft">{String(f.detail)}</p></div>
                    {canEdit ? <form action={findingAction} className="flex gap-2"><input type="hidden" name="id" value={String(f.id)} /><Button variant="secondary" name="status" value="resolved">Done</Button><Button variant="ghost" name="status" value="dismissed">Ignore</Button></form> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        <aside className="space-y-4">
          {canEdit && orgs.length ? (
            <section className="rounded-2xl border border-brand/30 bg-surface p-5">
              <h2 className="font-semibold">Is this a potential client?</h2>
              <p className="mt-1 text-sm text-ink-soft">Researches one company and scores it out of 100, with every reason and its source.</p>
              <ActionForm action={assessFormAction} className="mt-4 space-y-4">
                <Field label="Company"><Select name="org_id" required defaultValue="">{[<option key="" value="" disabled>Choose</option>, ...orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)]}</Select></Field>
                <Submit className="w-full">Assess company</Submit>
              </ActionForm>
            </section>
          ) : null}
          {canEdit ? (
            <section className="rounded-2xl border border-line bg-surface p-5">
              <h2 className="font-semibold">Watch a company</h2>
              {orgs.length === 0 ? <p className="mt-2 text-sm text-ink-soft">Add companies first. Then come back here.</p> : (
                <form action={watchAction} className="mt-4 space-y-4">
                  <Field label="Company"><Select name="org_id" required defaultValue="">{[<option key="" value="" disabled>Choose</option>, ...orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)]}</Select></Field>
                  <Field label="How often"><Select name="tier" defaultValue="active"><option value="critical">Every week</option><option value="active">Every month</option><option value="universe">Every 3 months</option></Select></Field>
                  <Field label="Why watch" hint="Optional. For example: lease ends 2027."><Input name="reason" maxLength={300} /></Field>
                  <Button type="submit" className="w-full">Add to watchlist</Button>
                </form>
              )}
            </section>
          ) : null}
          {isAdmin ? (
            <section className="rounded-2xl border border-line bg-surface p-5">
              <h2 className="font-semibold">Limits</h2>
              <ActionForm action={saveSettingsAction} className="mt-4 space-y-4">
                <Field label="Companies per week" hint="Caps how many companies are searched each week. The monthly AI budget in Settings also applies."><Input name="weekly" type="number" min={1} max={500} defaultValue={weekly} /></Field>
                <Field label="Focus cities" hint="Comma separated. Signals outside these are marked as weaker."><Input name="cities" defaultValue={(cfg.focusCities ?? ["Pune"]).join(", ")} /></Field>
                <Submit variant="secondary">Save limits</Submit>
              </ActionForm>
              <Link href="/research/sources" className="mt-4 block text-sm text-brand hover:underline">Approved sources</Link>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
