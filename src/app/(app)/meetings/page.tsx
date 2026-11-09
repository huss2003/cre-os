import Link from "next/link";
import { Suspense } from "react";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { HelpFor } from "@/components/ui";
import { icsAction, syncAction } from "@/modules/meetings/actions";
import { MEETING_TYPES } from "@/modules/meetings/rules";

export const metadata = { title: "Meetings" };
type Row = Record<string, any>;
const TABS = [["upcoming", "Upcoming"], ["prep", "Needs preparation"], ["past", "Past"], ["cancelled", "Cancelled"]] as const;
const STATUS: Record<string, [string, string]> = {
  scheduled: ["Scheduled", "bg-canvas"], preparation_pending: ["Needs prep", "bg-amber-50 text-amber-900"], researching: ["Preparing…", "bg-sky-50 text-sky-800"],
  brief_ready: ["Brief ready", "bg-emerald-50 text-emerald-800"], reviewed: ["Reviewed", "bg-emerald-100 text-emerald-900"], completed: ["Done", "bg-canvas text-ink-soft"],
  cancelled: ["Cancelled", "bg-rose-50 text-rose-700"], rescheduled: ["Rescheduled — re-check", "bg-amber-50 text-amber-900"],
};
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

async function Body({ tab }: { tab: string }) {
  const ctx = await requirePageContext("viewer");
  const editor = hasRole(ctx, "editor");
  const now = new Date().toISOString();
  let q = ctx.db.from("meeting_prep").select("id, status, meeting_type, readiness, purpose, meeting:meeting_visit_id!inner(title, start_at, location), org:org_id(display_name), meeting_prep_attendee(id)").eq("workspace_id", ctx.workspaceId).is("archived_at", null);
  if (tab === "upcoming") q = q.gte("meeting.start_at", now).neq("status", "cancelled");
  if (tab === "prep") q = q.gte("meeting.start_at", now).in("status", ["preparation_pending", "rescheduled", "brief_ready", "researching"]);
  if (tab === "past") q = q.lt("meeting.start_at", now).neq("status", "cancelled");
  if (tab === "cancelled") q = q.eq("status", "cancelled");
  const { data } = await q.order("start_at", { ascending: tab !== "past", referencedTable: "meeting" }).limit(200);
  const rows = ((data ?? []) as Row[]).sort((a, b) => (tab === "past" ? -1 : 1) * a.meeting.start_at.localeCompare(b.meeting.start_at));
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="flex items-center text-2xl font-bold tracking-tight sm:text-3xl">Meetings<HelpFor k="Meetings" /></h1><p className="text-sm text-ink-soft">Walk into every meeting knowing who, why, what happened before and what to ask.</p></div>
        {editor ? <Link href="/meetings/new" className="inline-flex min-h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white">New meeting</Link> : null}
      </header>
      <nav className="grid grid-cols-2 gap-1 rounded-2xl bg-canvas p-1 sm:grid-cols-4">
        {TABS.map(([k, l]) => <Link key={k} href={`/meetings?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`rounded-xl px-3 py-2.5 text-center text-sm ${tab === k ? "bg-surface font-semibold shadow-sm" : "text-ink-soft hover:text-ink"}`}>{l}</Link>)}
      </nav>
      {!rows.length ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center"><p className="font-semibold">{tab === "past" ? "No past meetings" : tab === "cancelled" ? "Nothing cancelled" : "No upcoming meetings"}</p><p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">Create one with New meeting, import an .ics file from your calendar below, or connect Google/Outlook in Settings → Connections.</p></div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {rows.map((r) => { const st = STATUS[r.status] ?? [r.status, "bg-canvas"]; return (
            <li key={r.id}><Link href={`/meetings/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas">
              <span className="w-24 shrink-0 text-xs text-ink-soft">{when(r.meeting.start_at)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{r.meeting.title}</span><span className="block truncate text-xs text-ink-soft">{MEETING_TYPES[r.meeting_type]?.label ?? r.meeting_type}{r.org ? ` · ${r.org.display_name}` : ""} · {(r.meeting_prep_attendee ?? []).length} attendee(s){r.meeting.location ? ` · ${r.meeting.location}` : ""}</span></span>
              {r.readiness !== null ? <span className="hidden shrink-0 text-xs tabular-nums sm:block" title="Meeting readiness">{r.readiness}/100</span> : null}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${st[1]}`}>{st[0]}</span>
            </Link></li>); })}
        </ul>
      )}
      {editor ? (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="flex items-center font-semibold">Import from your calendar<HelpFor k="Import from your calendar" /></h2><p className="mt-1 text-sm text-ink-soft">Export an .ics file from Google/Outlook and upload it. Re-importing the same file won't create duplicates.</p>
            <ActionForm action={icsAction} className="mt-3 flex flex-wrap items-center gap-3"><input type="file" name="file" accept=".ics,text/calendar" required className="text-sm" /><Submit variant="secondary">Import</Submit></ActionForm></section>
          <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="font-semibold">Connected calendar</h2><p className="mt-1 text-sm text-ink-soft">If Google or Outlook is connected, new meetings get a preparation page automatically every hour.</p>
            <ActionForm action={syncAction} className="mt-3"><Submit variant="secondary">Check now</Submit></ActionForm></section>
        </div>
      ) : null}
    </div>
  );
}
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "upcoming";
  return <Suspense fallback={<Loading />}><Body tab={tab} /></Suspense>;
}
