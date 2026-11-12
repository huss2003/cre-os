import { Suspense } from "react";
import Link from "next/link";
import { Field, Input, Textarea, HelpFor } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { listSignals, counts, filterOptions, syncCompletedTasks, VIEWS, type View } from "@/modules/signals/service";
import { parseFilter, toListFilter, filterHref, activeFilterCount, type UiFilter } from "@/modules/signals/ui-data";
import { ingestAction, scanAction } from "@/modules/signals/actions";
import { SignalCard, CAT_COLOR, STATUS_LABEL } from "@/modules/signals/ui/card";
import { CATEGORY_LABEL, type Category } from "@/modules/signals/engine";

export const metadata = { title: "Signals" };
type SP = Record<string, string | string[] | undefined>;
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
        <h2 className="text-sm font-semibold">Next 12 months<HelpFor k="Next 12 months" /></h2>
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
  const f = parseFilter(sp);
  const view = f.view as View;
  let rows: Awaited<ReturnType<typeof listSignals>> = []; let c: Record<string, number> = {}; let opts: FilterOpts | null = null; let failed: string | null = null;
  // Follow-up tasks completed in /tasks are written back to their signals (best effort; editors only via RLS).
  if (ctx.role !== "viewer") await syncCompletedTasks(ctx.db, ctx.workspaceId).catch(() => 0);
  try {
    [rows, c, opts] = await Promise.all([
      listSignals(ctx.db, ctx.workspaceId, toListFilter(f, ctx.userId) as never),
      counts(ctx.db, ctx.workspaceId),
      filterOptions(ctx.db, ctx.workspaceId) as Promise<FilterOpts>,
    ]);
  } catch (e) { failed = e instanceof Error ? e.message : "Unknown error"; }
  const href = (v: string) => filterHref(f, { view: v });
  const editor = ctx.role !== "viewer";
  const urgent = c.high ?? 0;
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between" data-tour="signals-header">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Signals<HelpFor k="Signals" /></h1>
          <p className="mt-1 text-ink-soft">{c.all ? <>{c.all} open{urgent ? <>, <span className="font-semibold text-rose-700">{urgent} to act on now</span></> : null}</> : "Nothing open right now."}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/signals/sources" className="inline-flex min-h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold hover:bg-surface">Sources</Link>
          {editor ? <ActionForm action={scanAction}><Submit variant="secondary">Scan now</Submit></ActionForm> : null}
        </div>
      </header>

      {editor ? (
        <details className="group rounded-2xl border border-line bg-surface" data-tour="signals-paste">
          <summary className="flex cursor-pointer list-none items-center justify-between p-4 text-sm font-semibold sm:p-5">
            Paste news or a note <span className="text-ink-soft group-open:rotate-45 transition-transform" aria-hidden>+</span>
          </summary>
          <ActionForm action={ingestAction} className="max-w-lg space-y-4 px-4 pb-5 sm:px-5">
            <Field label="Company" hint="Optional — taken from the text when left blank"><Input name="company" placeholder="ABC Technologies" /></Field>
            <Field label="Text" hint="Only scanned for events. Instructions inside it are ignored."><Textarea name="text" rows={4} required placeholder="Paste the announcement or article" /></Field>
            <Field label="Link"><Input name="url" type="url" placeholder="https://" /></Field>
            <Submit>Find signals</Submit>
          </ActionForm>
        </details>
      ) : null}

      <Suspense fallback={<div className="h-36 rounded-2xl bg-surface" />}><Horizon ws={ctx.workspaceId} db={ctx.db} /></Suspense>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Signal views" data-tour="signals-views" className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:mx-0 lg:flex-col lg:overflow-visible">
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
          <form method="get" className="flex gap-2" data-tour="signals-search">
            <HiddenFilters f={f} skip={["q"]} />
            <label className="sr-only" htmlFor="sq">Search signals</label>
            <input id="sq" name="q" aria-label="Search signals" defaultValue={f.q} placeholder="Search company, place or evidence" className="min-h-11 flex-1 rounded-xl border border-line bg-surface px-4 text-sm" />
            <button className="min-h-11 rounded-xl bg-ink px-4 text-sm font-semibold text-white">Search</button>
          </form>

          <Filters f={f} opts={opts} />

          {failed ? (
            <div role="alert" className="rounded-2xl border border-bad/30 bg-bad/10 px-5 py-4 text-sm text-bad">
              <p className="font-semibold">Signals could not be loaded.</p><p className="mt-1">{failed} — nothing below means “no signals”. Try again shortly.</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
              <p className="font-semibold">{activeFilterCount(f) || f.q ? "No signals match these filters" : "No signals in this view"}</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">{activeFilterCount(f) || f.q ? <>Loosen a filter or <Link className="underline" href={filterHref({ view: f.view })}>clear all filters</Link>.</> : "Add a lease with an expiry date, put companies on the Research watchlist, or paste a news item above."}</p>
            </div>
          ) : <div className="space-y-3">{rows.map((r) => <SignalCard key={r.id} s={r} />)}</div>}

          <p className="text-xs text-ink-soft">Bars show how strong the evidence is. Colours: {(Object.keys(CATEGORY_LABEL) as Category[]).map((k, i) => <span key={k}>{i ? ", " : ""}<span className={CAT_COLOR[k].text}>{CATEGORY_LABEL[k].toLowerCase()}</span></span>)}.</p>
        </div>
      </div>
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return <Suspense fallback={<Loading />}><Body sp={sp} /></Suspense>;
}

type FilterOpts = { companies: { id: string; name: string }[]; industries: string[]; microMarkets: string[]; sources: string[]; subTypes: { category: string; subType: string; label: string }[]; assignees: { id: string; name: string }[] };

function HiddenFilters({ f, skip = [] }: { f: UiFilter; skip?: string[] }) {
  return <>{Object.entries(f).filter(([k, v]) => v !== undefined && !skip.includes(k) && !(k === "view" && v === "all")).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)}</>;
}

const sel = "min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm";
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-ink-soft">{label}<div className="mt-1">{children}</div></label>;
}
/** Every dashboard filter from spec §10. A plain GET form: works without JS, shareable URLs. */
function Filters({ f, opts }: { f: UiFilter; opts: FilterOpts | null }) {
  const n = activeFilterCount(f);
  const o = (xs: string[] | undefined) => (xs ?? []).map((x) => <option key={x} value={x}>{x}</option>);
  return (
    <details className="rounded-2xl border border-line bg-surface" open={n > 0}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold">
        <span>Filters{n ? <span className="ml-2 rounded-full bg-ink px-2 py-0.5 text-xs text-white">{n}</span> : null}</span>
        {n ? <Link href={filterHref({ view: f.view, q: f.q })} className="text-xs font-normal text-ink-soft underline">Clear</Link> : <span className="text-ink-soft" aria-hidden>+</span>}
      </summary>
      <form method="get" className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-3">
        <input type="hidden" name="view" value={f.view} />{f.q ? <input type="hidden" name="q" value={f.q} /> : null}
        <F label="Company"><select name="orgId" defaultValue={f.orgId ?? ""} className={sel}><option value="">Any</option>{(opts?.companies ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></F>
        <F label="Industry"><select name="industry" defaultValue={f.industry ?? ""} className={sel}><option value="">Any</option>{o(opts?.industries)}</select></F>
        <F label="Micro-market"><select name="microMarket" defaultValue={f.microMarket ?? ""} className={sel}><option value="">Any</option>{o(opts?.microMarkets)}</select></F>
        <F label="Category"><select name="category" defaultValue={f.category ?? ""} className={sel}><option value="">Any</option>{(Object.keys(CATEGORY_LABEL) as Category[]).map((k) => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}</select></F>
        <F label="Type"><select name="subType" defaultValue={f.subType ?? ""} className={sel}><option value="">Any</option>{(opts?.subTypes ?? []).filter((x) => !f.category || x.category === f.category).map((x) => <option key={x.subType} value={x.subType}>{x.label}</option>)}</select></F>
        <F label="Source"><select name="source" defaultValue={f.source ?? ""} className={sel}><option value="">Any</option>{o(opts?.sources)}</select></F>
        <F label="Event date from"><input type="date" name="eventFrom" defaultValue={f.eventFrom} className={sel} /></F>
        <F label="Event date to"><input type="date" name="eventTo" defaultValue={f.eventTo} className={sel} /></F>
        <F label="Detected from"><input type="date" name="from" defaultValue={f.from} className={sel} /></F>
        <F label="Detected to"><input type="date" name="to" defaultValue={f.to} className={sel} /></F>
        <F label="Freshness"><select name="freshDays" defaultValue={f.freshDays ? String(f.freshDays) : ""} className={sel}><option value="">Any age</option><option value="7">Evidence in last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select></F>
        <F label="Confidence"><select name="confidence" defaultValue={f.confidence ?? ""} className={sel}><option value="">Any</option><option value="high">Strong</option><option value="medium">Moderate</option><option value="low">Weak</option><option value="insufficient">Insufficient</option></select></F>
        <F label="Urgency"><select name="urgency" defaultValue={f.urgency ?? ""} className={sel}><option value="">Any</option><option value="high">Act now</option><option value="medium">This month</option><option value="low">Watch</option></select></F>
        <F label="Status"><select name="status" defaultValue={f.status ?? ""} className={sel}><option value="">Open</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></F>
        <F label="Assigned"><select name="assigned" defaultValue={f.assigned ?? ""} className={sel}><option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>{(opts?.assignees ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></F>
        <F label="Sort"><select name="sort" defaultValue={f.sort ?? ""} className={sel}><option value="">Priority</option><option value="detected">Newest detected</option><option value="event">Soonest event</option></select></F>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3"><button className="min-h-11 rounded-xl bg-ink px-5 text-sm font-semibold text-white">Apply filters</button></div>
      </form>
    </details>
  );
}
