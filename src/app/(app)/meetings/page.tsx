import Link from "next/link";
import { Suspense } from "react";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { HelpFor } from "@/components/ui";
import { icsAction, syncAction } from "@/modules/meetings/actions";
import { MEETING_TYPES } from "@/modules/meetings/rules";
import { todayView, meetingReports } from "@/modules/meetings/more";
import { Kicker, Dot } from "@/modules/meetings/ui/dossier";

export const metadata = { title: "Meetings" };
type Row = Record<string, any>;
const TABS = [["today", "Today"], ["upcoming", "Upcoming"], ["prep", "Needs preparation"], ["past", "Past"], ["cancelled", "Cancelled"], ["reports", "Reports"]] as const;
const STATUS: Record<string, [string, string]> = {
  scheduled: ["Scheduled", "bg-canvas"], preparation_pending: ["Needs prep", "bg-amber-50 text-amber-900"], researching: ["Preparing…", "bg-sky-50 text-sky-800"],
  brief_ready: ["Brief ready", "bg-emerald-50 text-emerald-800"], reviewed: ["Reviewed", "bg-emerald-100 text-emerald-900"], completed: ["Done", "bg-canvas text-ink-soft"],
  cancelled: ["Cancelled", "bg-rose-50 text-rose-700"], rescheduled: ["Rescheduled — re-check", "bg-amber-50 text-amber-900"],
};
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

async function Body({ tab }: { tab: string }) {
  const ctx = await requirePageContext("viewer");
  const editor = hasRole(ctx, "editor");
  const now = new Date().toISOString();
  const head = (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 data-tour="meetings-heading" className="flex items-center text-2xl font-bold tracking-tight sm:text-3xl">Meetings<HelpFor k="Meetings" /></h1><p className="text-sm text-ink-soft">Walk into every meeting knowing who, why, what happened before and what to ask.</p></div>
        {editor ? <Link data-tour="meetings-new" href="/meetings/new" className="inline-flex min-h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white">New meeting</Link> : null}
      </header>
      <nav data-tour="meetings-tabs" className="grid grid-cols-3 gap-1 rounded-2xl bg-canvas p-1 sm:grid-cols-6">
        {TABS.map(([k, l]) => <Link key={k} href={`/meetings?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`rounded-xl px-3 py-2.5 text-center text-sm ${tab === k ? "bg-surface font-semibold shadow-sm" : "text-ink-soft hover:text-ink"}`}>{l}</Link>)}
      </nav>
    </>
  );
  if (tab === "today") return <div className="mx-auto max-w-5xl space-y-6">{head}<Today db={ctx.db} ws={ctx.workspaceId} /></div>;
  if (tab === "reports") return <div className="mx-auto max-w-5xl space-y-6">{head}<Reports db={ctx.db} ws={ctx.workspaceId} /></div>;
  let q = ctx.db.from("meeting_prep").select("id, status, meeting_type, readiness, purpose, meeting:meeting_visit_id!inner(title, start_at, location), org:org_id(display_name), meeting_prep_attendee(id)").eq("workspace_id", ctx.workspaceId).is("archived_at", null);
  if (tab === "upcoming") q = q.gte("meeting.start_at", now).neq("status", "cancelled");
  if (tab === "prep") q = q.gte("meeting.start_at", now).in("status", ["preparation_pending", "rescheduled", "brief_ready", "researching"]);
  if (tab === "past") q = q.lt("meeting.start_at", now).neq("status", "cancelled");
  if (tab === "cancelled") q = q.eq("status", "cancelled");
  const { data } = await q.order("start_at", { ascending: tab !== "past", referencedTable: "meeting" }).limit(200);
  const rows = ((data ?? []) as Row[]).sort((a, b) => (tab === "past" ? -1 : 1) * a.meeting.start_at.localeCompare(b.meeting.start_at));
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {head}
      {!rows.length ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center"><p className="font-semibold">{tab === "past" ? "No past meetings" : tab === "cancelled" ? "Nothing cancelled" : "No upcoming meetings"}</p><p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">Create one with New meeting, import an .ics file from your calendar below, or connect Google/Outlook in Settings → Connections.</p></div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {rows.map((r) => { const st = STATUS[r.status] ?? [r.status, "bg-canvas"]; return (
            <li key={r.id}><Link data-tour={/\(tutorial\)/.test(String(r.meeting.title ?? "")) ? "meeting-practice-row" : undefined} href={`/meetings/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas">
              <span className="w-24 shrink-0 text-xs text-ink-soft">{when(r.meeting.start_at)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{r.meeting.title}</span><span className="block truncate text-xs text-ink-soft">{MEETING_TYPES[r.meeting_type]?.label ?? r.meeting_type}{r.org ? ` · ${r.org.display_name}` : ""} · {(r.meeting_prep_attendee ?? []).length} attendee(s){r.meeting.location ? ` · ${r.meeting.location}` : ""}</span></span>
              {r.readiness !== null ? <span className="hidden shrink-0 text-xs tabular-nums sm:block" title="Meeting readiness">{r.readiness}/100</span> : null}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${st[1]}`}>{st[0]}</span>
            </Link></li>); })}
        </ul>
      )}
      {editor ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <section data-tour="meetings-import" className="min-w-0 rounded-2xl border border-line bg-surface p-5"><h2 className="flex items-center font-semibold">Import from your calendar<HelpFor k="Import from your calendar" /></h2><p className="mt-1 text-sm text-ink-soft">Export an .ics file from Google/Outlook and upload it. Re-importing the same file won't create duplicates.</p>
            <ActionForm action={icsAction} className="mt-3 flex flex-wrap items-center gap-3"><input type="file" name="file" accept=".ics,text/calendar" required aria-label="Calendar file (.ics)" className="w-full min-w-0 max-w-full text-sm" /><Submit variant="secondary">Import</Submit></ActionForm></section>
          <section data-tour="meetings-connect" className="min-w-0 rounded-2xl border border-line bg-surface p-5"><h2 className="font-semibold">Connected calendar</h2><p className="mt-1 text-sm text-ink-soft">If Google or Outlook is connected, new meetings get a preparation page automatically every hour.</p>
            <div className="mt-3 flex flex-wrap gap-2"><Link href="/settings/connections" className="inline-flex min-h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white">Connect Google / Outlook</Link><ActionForm action={syncAction}><Submit variant="secondary">Check now</Submit></ActionForm></div></section>
        </div>
      ) : null}
    </div>
  );
}
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "today";
  return <Suspense fallback={<Loading />}><Body tab={tab} /></Suspense>;
}

type Db = Awaited<ReturnType<typeof requirePageContext>>["db"];
const PREP_TONE: Record<string, string> = { "No brief yet": "bg-amber-50 text-amber-900", "Brief out of date": "bg-amber-50 text-amber-900", "Brief ready": "bg-emerald-50 text-emerald-800", Reviewed: "bg-emerald-100 text-emerald-900", Done: "bg-canvas text-ink-soft" };
async function Today({ db, ws }: { db: Db; ws: string }) {
  const v = await todayView(db, ws);
  return (
    <div className="space-y-8">
      <section>
        <h2 className="flex items-center text-lg font-semibold tracking-tight">Today&apos;s meetings<HelpFor k="Today's meetings" /></h2>
        {!v.meetings.length ? <p className="mt-2 rounded-2xl border border-dashed border-line px-6 py-8 text-center text-sm text-ink-soft">No meetings today. Briefs are prepared automatically about an hour before each meeting.</p> : (
          <ol className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{v.meetings.map((m) => (
            <li key={m.id}><Link href={`/meetings/${m.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas">
              <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">{time(m.start)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{m.title}</span><span className="block truncate text-xs text-ink-soft">{m.type}{m.org ? ` · ${m.org}` : ""} · {m.attendees} attendee(s){m.location ? ` · ${m.location}` : ""}{m.critical ? ` · ${m.critical} critical gap(s)` : ""}</span></span>
              {m.readiness !== null ? <span className="shrink-0 text-xs tabular-nums" title="Meeting readiness">{m.readiness}/100</span> : null}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${PREP_TONE[m.prep] ?? "bg-canvas"}`}>{m.prep}</span>
            </Link></li>))}</ol>)}
      </section>
      <section>
        <h2 className="flex items-center text-lg font-semibold tracking-tight">Pending follow-ups<HelpFor k="Pending follow-ups" /></h2>
        {!v.followups.length ? <p className="mt-2 text-sm text-ink-soft">Nothing pending. Tasks you create when applying a meeting&apos;s outcome show here until done.</p> : (
          <ul className="mt-3 space-y-3">{v.followups.map((f) => (
            <li key={f.id} className="rounded-2xl border border-line bg-surface p-4">
              <Link href={`/meetings/${f.id}`} className="font-medium hover:text-brand">{f.title}</Link><span className="ml-2 text-xs text-ink-soft">{f.date}{f.org ? ` · ${f.org}` : ""}</span>
              <ul className="mt-2 space-y-1 text-sm">{f.tasks.map((t) => <li key={t.id} className={`flex gap-2 ${t.overdue ? "text-bad" : ""}`}><Dot tone={t.overdue ? "bad" : "muted"} /><span>{t.title}{t.due ? <span className={t.overdue ? "font-semibold" : "text-ink-soft"}> · {t.overdue ? "overdue since" : "due"} {t.due.slice(0, 10)}</span> : null}</span></li>)}</ul>
            </li>))}</ul>)}
      </section>
    </div>
  );
}
const outcomes = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(" · ");
async function Reports({ db, ws }: { db: Db; ws: string }) {
  const r = await meetingReports(db, ws);
  if (!r.total) return <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-ink-soft">No past meetings yet. Reports fill in once meetings have taken place and their outcomes are recorded.</p>;
  const Table = ({ title, rows }: { title: string; rows: typeof r.byCompany }) => (
    <section><Kicker>{title}</Kicker>
      {!rows.length ? <p className="mt-2 text-sm text-ink-soft">None.</p> : <div className="mt-2 overflow-x-auto rounded-2xl border border-line bg-surface"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-ink-soft"><th className="px-4 py-2 font-medium">Name</th><th className="px-2 py-2 font-medium">Meetings</th><th className="px-2 py-2 font-medium">Last</th><th className="px-4 py-2 font-medium">Outcomes</th></tr></thead>
        <tbody className="divide-y divide-line">{rows.slice(0, 25).map((x) => <tr key={x.key}><td className="px-4 py-2">{x.label}</td><td className="px-2 py-2 tabular-nums">{x.count}</td><td className="px-2 py-2 tabular-nums">{x.last}</td><td className="px-4 py-2 text-ink-soft">{outcomes(x.outcomes)}</td></tr>)}</tbody></table></div>}
    </section>
  );
  return (
    <div className="space-y-8">
      <section><h2 className="flex items-center text-lg font-semibold tracking-tight">Meeting reports<HelpFor k="Meeting reports" /></h2><p className="text-sm text-ink-soft">{r.total} past meeting(s). Every rate shows its count and denominator.</p>
        <dl className="mt-3 grid gap-px overflow-hidden rounded-xl bg-line sm:grid-cols-2">{r.rates.map((x) => <div key={x.label} className="bg-surface p-4"><dt className="text-xs text-ink-soft">{x.label}</dt><dd className="mt-1 font-semibold tabular-nums">{x.value}</dd></div>)}</dl></section>
      <Table title="By company" rows={r.byCompany} />
      <Table title="By contact" rows={r.byContact} />
      <Table title="By property" rows={r.byProperty} />
      <section><Kicker>Created after meeting (within 30 days)</Kicker>
        {!r.createdAfter.length ? <p className="mt-2 text-sm text-ink-soft">None.</p> : <ul className="mt-2 space-y-1 text-sm">{r.createdAfter.map((c) => <li key={c.id} className="flex gap-2"><Dot tone="ok" /><span>{c.kind}: {c.label} <span className="text-ink-soft">· created {c.created} · after meeting</span></span></li>)}</ul>}
      </section>
      <section><Kicker>Overdue actions ({r.overdue.length})</Kicker>
        {!r.overdue.length ? <p className="mt-2 text-sm text-ink-soft">None.</p> : <ul className="mt-2 space-y-1 text-sm text-bad">{r.overdue.map((t) => <li key={t.id} className="flex gap-2"><Dot tone="bad" /><span>{t.title} · due {t.due?.slice(0, 10)} · <Link href={`/meetings/${t.prepId}`} className="underline underline-offset-4">{t.meeting}</Link></span></li>)}</ul>}
      </section>
      <section><Kicker>Pending commitments ({r.pending.length})</Kicker>
        {!r.pending.length ? <p className="mt-2 text-sm text-ink-soft">None.</p> : <ul className="mt-2 space-y-1 text-sm">{r.pending.map((t) => <li key={t.id} className="flex gap-2"><Dot tone="muted" /><span>{t.title}{t.due ? ` · due ${t.due.slice(0, 10)}` : ""} · <Link href={`/meetings/${t.prepId}`} className="underline underline-offset-4">{t.meeting}</Link></span></li>)}</ul>}
      </section>
    </div>
  );
}
