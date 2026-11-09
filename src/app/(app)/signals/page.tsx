import { Suspense } from "react";
import Link from "next/link";
import { Field, Input, Textarea } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { listSignals, counts, VIEWS, type View } from "@/modules/signals/service";
import { ingestAction, scanAction } from "@/modules/signals/actions";
import { SignalCard, CAT_COLOR } from "@/modules/signals/ui/card";
import { CATEGORY_LABEL, type Category } from "@/modules/signals/engine";

export const metadata = { title: "Signals" };
type SP = { view?: string; q?: string; confidence?: string; status?: string; assigned?: string; from?: string; to?: string };
const VIEW_CAT: Partial<Record<View, string>> = { expansion: "expansion", restructuring: "restructuring", lease: "lease", commercial: "commercial", leadership: "leadership", infrastructure: "infrastructure" };

/** Next 12 months as columns; each dated signal is a dot in its month, coloured by category. */
async function Horizon({ ws, db }: { ws: string; db: Awaited<ReturnType<typeof requirePageContext>>["db"] }) {
  const start = new Date(); start.setDate(1);
  const end = new Date(start); end.setMonth(end.getMonth() + 12);
  const { data } = await db.from("signal").select("id, category, event_date, title").eq("workspace_id", ws).is("archived_at", null)
    .not("status", "in", "(dismissed,rejected,known)").gte("event_date", start.toISOString().slice(0, 10)).lt("event_date", end.toISOString().slice(0, 10)).limit(5000);
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(start); d.setMonth(d.getMonth() + i); return d; });
  const by = months.map((m) => (data ?? []).filter((s) => s.event_date.slice(0, 7) === m.toISOString().slice(0, 7)));
  const max = Math.max(5, ...by.map((b) => b.length));
  return (
    <section aria-label="Dated events over the next 12 months" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Next 12 months</h2>
        <p className="text-xs text-ink-soft">{(data ?? []).length ? `${(data ?? []).length} dated events` : "No dated events yet"}</p>
      </div>
      <div className="mt-4 grid grid-cols-12 gap-1 sm:gap-2">
        {months.map((m, i) => {
          const list = by[i];
          // Up to 5 dots per month; beyond that a bar + number so a busy month never spills out.
          const cats = [...new Set(list.map((s) => s.category))];
          return (
            <div key={i} className="flex flex-col items-center">
              <div className="flex h-20 w-full flex-col-reverse items-center justify-start gap-1 overflow-hidden rounded-lg bg-canvas p-1.5">
                {list.length <= 5 ? list.map((s) => (
                  <Link key={s.id} href={`/signals/${s.id}`} title={s.title} aria-label={s.title} className={`h-2.5 w-2.5 shrink-0 rounded-full ${CAT_COLOR[s.category]?.dot ?? "bg-stone-400"} hover:ring-2 hover:ring-ink/30`} />
                )) : (
                  <Link href={`/signals?view=${cats.length === 1 ? cats[0] : "all"}`} className="flex h-full w-full flex-col-reverse items-center gap-1" title={`${list.length} events`}>
                    <span className={`w-2.5 rounded-full ${CAT_COLOR[cats[0]]?.dot ?? "bg-stone-400"}`} style={{ height: `${Math.max(20, (list.length / max) * 100)}%` }} />
                    <span className="text-[11px] font-semibold text-ink">{list.length}</span>
                  </Link>
                )}
              </div>
              <span className={`mt-1.5 text-[11px] ${i === 0 ? "font-semibold text-ink" : "text-ink-soft"}`}>{m.toLocaleString("en-IN", { month: "short" })}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

async function Body({ sp }: { sp: SP }) {
  const ctx = await requirePageContext("viewer");
  const view = (sp.view && sp.view in VIEWS ? sp.view : "all") as View;
  const [rows, c] = await Promise.all([
    listSignals(ctx.db, ctx.workspaceId, { view, q: sp.q, confidence: sp.confidence, status: sp.status, assigned: sp.assigned, userId: ctx.userId, from: sp.from, to: sp.to }),
    counts(ctx.db, ctx.workspaceId),
  ]);
  const href = (v: string) => `/signals?view=${v}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`;
  const editor = ctx.role !== "viewer";
  const urgent = c.high ?? 0;
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Signals</h1>
          <p className="mt-1 text-ink-soft">{c.all ? <>{c.all} open{urgent ? <>, <span className="font-semibold text-rose-700">{urgent} to act on now</span></> : null}</> : "Nothing open right now."}</p>
        </div>
        {editor ? <ActionForm action={scanAction}><Submit variant="secondary">Scan now</Submit></ActionForm> : null}
      </header>

      <Suspense fallback={<div className="h-36 rounded-2xl bg-surface" />}><Horizon ws={ctx.workspaceId} db={ctx.db} /></Suspense>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Signal views" className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:mx-0 lg:flex-col lg:overflow-visible">
          {(Object.keys(VIEWS) as View[]).map((v) => {
            const on = v === view; const cat = VIEW_CAT[v];
            return (
              <Link key={v} href={href(v)} aria-current={on ? "page" : undefined}
                className={`flex shrink-0 items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm ${on ? "bg-ink text-white" : "text-ink hover:bg-surface"}`}>
                <span className="flex items-center gap-2">{cat ? <span className={`h-2 w-2 rounded-full ${CAT_COLOR[cat].dot}`} aria-hidden /> : null}{VIEWS[v]}</span>
                {c[v] ? <span className={`text-xs ${on ? "text-white/70" : "text-ink-soft"}`}>{c[v]}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="min-w-0 space-y-4">
          <form method="get" className="flex gap-2">
            <input type="hidden" name="view" value={view} />
            <label className="sr-only" htmlFor="sq">Search signals</label>
            <input id="sq" name="q" defaultValue={sp.q} placeholder="Search company, place or evidence" className="min-h-11 flex-1 rounded-xl border border-line bg-surface px-4 text-sm" />
            <button className="min-h-11 rounded-xl bg-ink px-4 text-sm font-semibold text-white">Search</button>
          </form>

          {rows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
              <p className="font-semibold">No signals in this view</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">Add a lease with an expiry date, put companies on the Research watchlist, or paste a news item below.</p>
            </div>
          ) : <div className="space-y-3">{rows.map((r) => <SignalCard key={r.id} s={r} />)}</div>}

          {editor ? (
            <details className="group rounded-2xl border border-line bg-surface">
              <summary className="flex cursor-pointer list-none items-center justify-between p-4 text-sm font-semibold sm:p-5">
                Paste news or a note <span className="text-ink-soft group-open:rotate-45 transition-transform" aria-hidden>+</span>
              </summary>
              <ActionForm action={ingestAction} className="max-w-lg space-y-4 px-4 pb-5 sm:px-5">
                <Field label="Company"><Input name="company" placeholder="ABC Technologies" /></Field>
                <Field label="Text" hint="Only scanned for events. Instructions inside it are ignored."><Textarea name="text" rows={4} required placeholder="Paste the announcement or article" /></Field>
                <Field label="Link"><Input name="url" type="url" placeholder="https://" /></Field>
                <Submit>Find signals</Submit>
              </ActionForm>
            </details>
          ) : null}
          <p className="text-xs text-ink-soft">Bars show how strong the evidence is.Colours: {(Object.keys(CATEGORY_LABEL) as Category[]).map((k, i) => <span key={k}>{i ? ", " : ""}<span className={CAT_COLOR[k].text}>{CATEGORY_LABEL[k].toLowerCase()}</span></span>)}.</p>
        </div>
      </div>
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return <Suspense fallback={<Loading />}><Body sp={sp} /></Suspense>;
}
