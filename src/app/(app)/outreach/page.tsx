import Link from "next/link";
import { Suspense } from "react";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading } from "@/modules/admin/ui/parts";
import { HelpFor } from "@/components/ui";
import { suggestions, analytics } from "@/modules/outreach/service";
import { createAction, sweepAction, prepareAction } from "@/modules/outreach/actions";
import { SCENARIOS, CHANNEL_LABEL, type Channel, type Scenario } from "@/modules/outreach/rules";

export const metadata = { title: "Outreach" };
type Row = Record<string, any>;
type SP = { tab?: string; view?: string };
const MAIN = [["today", "Today"], ["messages", "Messages"], ["conversations", "Conversations"], ["paused", "Paused"], ["results", "Results"]] as const;
const SUB: Record<string, [string, string, string[]][]> = {
  messages: [["drafts", "Drafts", ["draft"]], ["pending", "Waiting approval", ["pending_approval"]], ["ready", "Ready to send", ["approved"]]],
  conversations: [["awaiting", "Awaiting reply", ["sent"]], ["responses", "Replies", ["replied", "meeting", "declined"]], ["history", "All history", []]],
};
const STATUS: Record<string, string> = { planned: "Planned", draft: "Draft", pending_approval: "Waiting approval", approved: "Ready to send", sent: "Sent", replied: "Replied", meeting: "Meeting", declined: "Declined", no_response: "No response", paused: "Paused", closed: "Closed" };
const box = "rounded-2xl border border-line bg-surface";

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center"><p className="font-semibold">{title}</p><p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{text}</p></div>;
}

function ItemList({ items }: { items: Row[] }) {
  return (
    <ul className={`divide-y divide-line overflow-hidden ${box}`}>
      {items.map((i) => (
        <li key={i.id}><Link href={`/outreach/${i.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-canvas">
          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{i.person?.full_name ?? "—"}<span className="font-normal text-ink-soft"> · {i.org?.display_name ?? ""}</span></span>
            <span className="block truncate text-xs text-ink-soft">{CHANNEL_LABEL[i.channel as Channel]} · {SCENARIOS[i.scenario as Scenario]?.label}{i.step > 1 ? ` · follow-up ${i.step - 1}` : ""} · {i.pause_reason ?? i.reason}</span></span>
          <span className="shrink-0 text-right text-xs"><span className="block rounded-full bg-canvas px-2 py-0.5">{STATUS[i.status]}</span><span className="mt-0.5 block text-ink-soft">{(i.sent_at ?? i.planned_on ?? i.updated_at)?.slice(0, 10)}</span></span>
        </Link></li>
      ))}
    </ul>
  );
}

async function Today({ db, ws, editor }: { db: Row; ws: string; editor: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [sug, { data: due }] = await Promise.all([
    suggestions(db as never, ws, 5),
    db.from("outreach_item").select("id, status, channel, scenario, step, reason, planned_on, pause_reason, updated_at, sent_at, person:person_id(full_name), org:org_id(display_name)").eq("workspace_id", ws).eq("status", "planned").lte("planned_on", today).is("archived_at", null).order("planned_on").limit(30),
  ]);
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 data-tour="outreach-today" className="flex items-center font-semibold">New conversations to start<HelpFor k="New conversations to start" /></h2>
        {!sug.length ? <Empty title="No new reasons to reach out today" text="Suggestions come from recent signals and upcoming lease dates for companies where a relevant contact is saved. Add signals in Signals, or find people in Contacts." /> : (
          <ul className="grid gap-4 md:grid-cols-2">
            {sug.map((x) => {
              const tone = x.scenario === "lease_renewal" ? "bg-sky-50 text-sky-800" : x.scenario === "expansion" || x.scenario === "gcc" ? "bg-emerald-50 text-emerald-800" : "bg-violet-50 text-violet-800";
              const ini = x.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
              const title = x.title && !/named in import/i.test(x.title) ? x.title : null;
              return (
              <li key={x.personId} className="flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm transition hover:border-brand/40 hover:shadow-md">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft font-semibold text-brand">{ini}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/contacts/${x.personId}`} className="block truncate font-semibold hover:text-brand">{x.name}</Link>
                    <p className="truncate text-sm text-ink-soft">{title ? `${title} · ` : ""}{x.org}</p>
                  </div>
                  {x.score !== null ? <span className="shrink-0 rounded-lg bg-canvas px-2 py-1 text-center leading-none" title="Lead score (0–100)"><span className="block text-base font-bold tabular-nums">{x.score}</span><span className="text-[10px] text-ink-soft">lead</span></span> : null}
                </div>
                <div className="mt-4 rounded-xl bg-canvas px-3.5 py-3">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{SCENARIOS[x.scenario].label}</span>
                  <p className="mt-1.5 text-sm font-medium">{x.reason}</p>
                  {x.why.length > 1 ? <p className="mt-0.5 text-xs text-ink-soft">{[...new Set(x.why.slice(1))].join(" · ")}</p> : null}
                </div>
                {editor ? (
                  <ActionForm action={createAction} className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <input type="hidden" name="person_id" value={x.personId} /><input type="hidden" name="scenario" value={x.scenario} />{x.signalId ? <input type="hidden" name="signal_id" value={x.signalId} /> : null}
                    <div className="flex flex-wrap gap-1.5">{([["email", "Email", true], ["whatsapp", "WhatsApp", true], ["call", "Call", false]] as const).map(([v, l, on]) => (
                      <label key={v} className="cursor-pointer"><input type="checkbox" name="channel" value={v} defaultChecked={on} className="peer sr-only" /><span className="inline-flex min-h-8 items-center rounded-full border border-line px-3 text-sm text-ink-soft peer-checked:border-brand peer-checked:bg-brand-soft peer-checked:text-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/30">{l}</span></label>))}</div>
                    <Submit>Prepare drafts</Submit>
                  </ActionForm>
                ) : null}
              </li>); })}
          </ul>
        )}
      </section>
      <section className="space-y-3">
        <h2 data-tour="outreach-followups" className="flex items-center font-semibold">Follow-ups due<HelpFor k="Follow-ups due" /></h2>
        {!(due ?? []).length ? <p className="text-sm text-ink-soft">None due today.</p> : (
          <ul className={`divide-y divide-line ${box}`}>
            {(due as Row[]).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Link href={`/outreach/${i.id}`} className="min-w-0 flex-1 hover:text-brand"><span className="block font-medium">{i.person?.full_name} · {i.org?.display_name}</span><span className="block text-xs text-ink-soft">Follow-up {i.step - 1} · {i.reason}</span></Link>
                {editor ? <ActionForm action={prepareAction.bind(null, i.id)}><Submit variant="secondary">Draft it</Submit></ActionForm> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function List({ db, ws, statuses }: { db: Row; ws: string; statuses: string[] }) {
  let q = db.from("outreach_item").select("id, status, channel, scenario, step, reason, planned_on, pause_reason, updated_at, sent_at, person:person_id(full_name), org:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null);
  if (statuses.length) q = q.in("status", statuses);
  const { data } = await q.order("updated_at", { ascending: false }).limit(200);
  if (!(data ?? []).length) return <Empty title="Nothing here" text={statuses.includes("draft") ? "Start from Today, or press New outreach." : statuses.includes("sent") ? "Messages you mark as sent appear here until they get a reply." : "Nothing in this list yet."} />;
  return <ItemList items={data as Row[]} />;
}

async function Results({ db, ws }: { db: Row; ws: string }) {
  const a = await analytics(db as never, ws, 90);
  const tiles: [string, number | string, string][] = [
    ["Messages sent", a.attempts, `${a.sentManual} marked by you · ${a.sentProvider} seen by a provider`], ["People contacted", a.contacts, `${a.companies} companies`],
    ["Replies", a.replies, `${a.replyRate} of messages sent`], ["Meaningful replies", a.meaningful, "Not just an auto-reply"],
    ["Meetings", a.meetings, `${a.meetingRate} of people contacted`], ["Drafts prepared", a.drafts, `${a.approved} approved — drafts are not outreach`],
    ["Paused", a.paused, "Stopped by a reply, a decline or a rule"], ["Prep time", `${a.prepMinutes} min`, "Time spent generating drafts"],
  ];
  return (
    <div className="space-y-3">
      <p data-tour="outreach-results" className="flex items-center text-sm text-ink-soft">Last {a.days} days. Every rate shows what it is divided by.<HelpFor k="Results" /></p>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">{tiles.map(([l, n, h]) => <div key={l} className={`${box} p-4`}><dt className="text-xs text-ink-soft">{l}</dt><dd className="mt-1 text-2xl font-bold tabular-nums">{n}</dd><dd className="mt-0.5 text-xs text-ink-soft">{h}</dd></div>)}</dl>
    </div>
  );
}

async function Body({ sp }: { sp: SP }) {
  const ctx = await requirePageContext("viewer");
  const editor = hasRole(ctx, "editor");
  const tab = MAIN.some(([k]) => k === sp.tab) ? sp.tab! : "today";
  const sub = SUB[tab]?.find(([k]) => k === sp.view) ?? SUB[tab]?.[0];
  const { data: counts } = await ctx.db.from("outreach_item").select("status").eq("workspace_id", ctx.workspaceId).is("archived_at", null).in("status", ["draft", "pending_approval", "approved", "sent", "paused"]).limit(5000);
  const n = (st: string[]) => ((counts ?? []) as Row[]).filter((c) => st.includes(c.status)).length;
  const badge: Record<string, number> = { messages: n(["draft", "pending_approval", "approved"]), conversations: n(["sent"]), paused: n(["paused"]) };
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 data-tour="outreach-heading" className="flex items-center text-2xl font-bold tracking-tight sm:text-3xl">Outreach<HelpFor k="Outreach" /></h1><p className="text-sm text-ink-soft">Who to contact, why now, and what to say. You approve and send every message yourself.</p></div>
        {editor ? <div className="flex gap-2"><ActionForm action={sweepAction}><Submit variant="secondary">Re-check follow-ups</Submit></ActionForm><Link data-tour="outreach-new" href="/outreach/new" className="inline-flex min-h-10 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white">New outreach</Link></div> : null}
      </header>
      <nav data-tour="outreach-tabs" aria-label="Outreach sections" className="grid grid-cols-3 gap-1 rounded-2xl bg-canvas p-1 sm:grid-cols-5">
        {MAIN.map(([k, l]) => <Link key={k} href={`/outreach?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm ${tab === k ? "bg-surface font-semibold shadow-sm" : "text-ink-soft hover:text-ink"}`}>{l}{badge[k] ? <span className="rounded-full bg-brand px-1.5 text-xs text-white">{badge[k]}</span> : null}</Link>)}
      </nav>
      {SUB[tab] ? <div data-tour="outreach-subtabs" className="flex flex-wrap gap-2">{SUB[tab].map(([k, l, st]) => <Link key={k} href={`/outreach?tab=${tab}&view=${k}`} aria-current={sub?.[0] === k ? "page" : undefined} className={`rounded-full px-3.5 py-1.5 text-sm ${sub?.[0] === k ? "bg-ink font-semibold text-white" : "bg-canvas text-ink-soft hover:text-ink"}`}>{l}{st.length ? ` (${n(st)})` : ""}</Link>)}</div> : null}
      {tab === "today" ? <Today db={ctx.db} ws={ctx.workspaceId} editor={editor} />
        : tab === "results" ? <Results db={ctx.db} ws={ctx.workspaceId} />
        : tab === "paused" ? <List db={ctx.db} ws={ctx.workspaceId} statuses={["paused"]} />
        : <List db={ctx.db} ws={ctx.workspaceId} statuses={sub![2]} />}
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  return <Suspense fallback={<Loading />}><Body sp={sp} /></Suspense>;
}
