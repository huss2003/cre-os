import Link from "next/link";
import clsx from "clsx";
import { Badge, Button, Card, EmptyState, Field, PageHeader, StaleBanner, Textarea } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { draftCounts, listDrafts } from "@/modules/integrations/drafts-view";
import { staleness } from "@/modules/integrations/sync";
import { importEmlAction } from "./actions";
import { DraftCard, type DraftView } from "./draft-card";
import { InboxThreads } from "./inbox-threads";
import { SequencesTab } from "./sequences-tab";

const TABS: { key: string; label: string; channels: string[] | null }[] = [
  { key: "all", label: "All", channels: null },
  { key: "email", label: "Email", channels: ["email", "introduction"] },
  { key: "whatsapp", label: "WhatsApp", channels: ["whatsapp"] },
  { key: "linkedin", label: "LinkedIn", channels: ["linkedin", "post"] },
  { key: "invites", label: "Invites", channels: ["calendar_invite"] },
  { key: "inbox", label: "Inbox triage", channels: [] },
  { key: "sequences", label: "Sequences", channels: [] },
];
const VIEWS: Record<string, { label: string; states: string[] }> = {
  open: { label: "Needs action", states: ["drafted", "approved", "opened_for_send", "paused"] },
  sent: { label: "Sent", states: ["marked_sent", "reconciled_sent"] },
  discarded: { label: "Discarded", states: ["discarded"] },
};
const NOTICES: Record<string, string> = {
  imported: "Message imported and triaged.", imported_draft: "Message imported; a reply draft is waiting below in the Email tab.",
  duplicate: "That message was already imported — nothing was duplicated.", empty: "Paste the raw message or choose an .eml file first.",
  too_large: "That file is larger than 2 MB.",
  enrolled: "Enrolled. The first touch is waiting in Drafts for your approval; activate the sequence when you are ready.",
  enrol_existing: "This person is already in that sequence — nothing was duplicated.",
  enrol_invalid: "Pick a person and write a one-line value proposition (5–200 characters).",
  enrol_collision: "A colleague is already approaching this person or account, or the weekly account cap is reached. Agree it with them, then tick the box to proceed.",
  enrol_suppressed: "This person opted out or their contact is suppressed — they cannot be enrolled.",
  enr_activate: "Sequence activated. Later steps are drafted after you send the previous one.", enr_resume: "Sequence resumed.",
  enr_pause: "Sequence paused; its unsent drafts are parked.", enr_cancel: "Sequence cancelled; unsent drafts were discarded.",
  enr_negotiation: "Not resumed: the account has an opportunity in negotiation or later, so outreach stays paused.", import_failed: "Could not read that message. Use Gmail ‘Download message’ (.eml) or ‘Show original’ and paste all of it.",
};

export default async function DraftsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const view = VIEWS[String(sp.view ?? "open")] ?? VIEWS.open;
  const canEdit = hasRole(ctx, "editor");
  const counts = await draftCounts(ctx.db, ctx.workspaceId);
  const tabCount = (t: (typeof TABS)[number]) => (t.channels === null ? Object.values(counts).reduce((a, b) => a + b, 0) : t.channels.reduce((a, c) => a + (counts[c] ?? 0), 0));
  const notice = typeof sp.notice === "string" ? NOTICES[sp.notice] : null;

  return (
    <div>
      <PageHeader title="Drafts" subtitle="Every external message is a draft. Approve it, open it in your own mail / WhatsApp / LinkedIn, send it yourself, then mark it sent. CRE OS never sends anything." />
      <nav className="-mx-1 mb-4 flex gap-1 overflow-x-auto pb-1" aria-label="Draft channels">
        {TABS.map((t) => (
          <Link key={t.key} href={`/drafts?tab=${t.key}`} className={clsx("whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium", t.key === tab.key ? "bg-brand text-white" : "bg-surface text-ink hover:bg-brand-soft")}>
            {t.label}{t.key !== "inbox" && t.key !== "sequences" && tabCount(t) ? ` (${tabCount(t)})` : ""}
          </Link>
        ))}
      </nav>
      {notice ? <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm" role="status">{notice}</p> : null}
      {tab.key === "sequences" ? <SequencesTab ctx={ctx} sp={sp} canEdit={canEdit} /> : tab.key === "inbox" ? <InboxTab ws={ctx.workspaceId} db={ctx.db} userId={ctx.userId} tz={ctx.timezone} canEdit={canEdit} view={sp.iv === "messages" ? "messages" : "threads"} /> : (
        <DraftList db={ctx.db} ws={ctx.workspaceId} tab={tab} view={view} viewKey={String(sp.view ?? "open")} tz={ctx.timezone} canEdit={canEdit} />
      )}
    </div>
  );
}

async function DraftList({ db, ws, tab, view, viewKey, tz, canEdit }: { db: Awaited<ReturnType<typeof requirePageContext>>["db"]; ws: string; tab: (typeof TABS)[number]; view: { label: string; states: string[] }; viewKey: string; tz: string; canEdit: boolean }) {
  const all = await listDrafts(db, ws, { states: view.states });
  const drafts = tab.channels ? all.filter((d) => tab.channels!.includes(d.channel)) : all;
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {Object.entries(VIEWS).map(([k, v]) => (
          <Link key={k} href={`/drafts?tab=${tab.key}&view=${k}`} className={clsx("rounded-full border px-3 py-1", k === viewKey ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-soft")}>{v.label}</Link>
        ))}
      </div>
      {drafts.length === 0 ? (
        <EmptyState title={viewKey === "open" ? "Nothing waiting for approval" : `No ${view.label.toLowerCase()} drafts`}>
          Drafts appear here from inbox triage (reply suggestions), outreach sequences, calendar invites and the network module.
          Connect your mailbox in <Link className="text-brand underline" href="/settings/connections">Settings → Connections</Link> or import a single email in the <Link className="text-brand underline" href="/drafts?tab=inbox">Inbox triage</Link> tab.
        </EmptyState>
      ) : (
        <div className="grid gap-4">
          {drafts.map((d) => (
            <DraftCard key={`${d.id}:${d.row_version}`} canEdit={canEdit} d={{ ...d, updated_label: `Updated ${fmt(d.updated_at, "dd MMM, HH:mm", tz)}` } as DraftView} />
          ))}
        </div>
      )}
    </>
  );
}

const CAT_TONE: Record<string, "neutral" | "brand" | "ok" | "warn" | "bad" | "accent"> = {
  near_term_visit: "bad", commercial_decision: "bad", expiring_offer: "bad", critical_deadline: "bad", new_requirement: "brand",
  reply: "neutral", opt_out: "warn", wrong_contact: "warn", newsletter: "neutral", suspicious: "bad", other: "neutral",
};

async function InboxTab({ db, ws, userId, tz, canEdit, view }: { db: Awaited<ReturnType<typeof requirePageContext>>["db"]; ws: string; userId: string; tz: string; canEdit: boolean; view: "threads" | "messages" }) {
  const threadView = view === "threads" ? await InboxThreads({ db, ws, tz, catTone: CAT_TONE }) : null;
  const { data: msgs } = await db.from("inbound_message").select("id, provider, from_name, from_address, subject, received_at, triage, triage_status, is_backfill, import_method, matched_person_ids")
    .eq("workspace_id", ws).eq("folder", "inbox").is("archived_at", null).order("received_at", { ascending: false }).limit(50);
  const { data: accounts } = await db.from("connector_account").select("id, provider, status").eq("workspace_id", ws).eq("user_id", userId);
  const { data: cursors } = await db.from("connector_cursor").select("resource, last_success_at, last_error").eq("workspace_id", ws).in("connector_account_id", (accounts ?? []).map((a) => a.id));
  const stale = (accounts ?? []).length > 0 ? staleness(cursors ?? []).find((s) => s.resource === "inbox" && s.stale) : null;
  const broken = (accounts ?? []).filter((a) => a.status === "expired" || a.status === "revoked" || a.status === "error");
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-3">
        {broken.length ? <StaleBanner>Mailbox connection {broken.map((b) => `${b.provider} (${b.status})`).join(", ")} needs attention — the list below may be incomplete. <Link className="underline" href="/settings/connections">Reconnect</Link>.</StaleBanner> : null}
        {stale && !broken.length ? <StaleBanner>Inbox last synced {stale.lastSuccessAt ? fmt(stale.lastSuccessAt, "dd MMM, HH:mm", tz) : "never"}{stale.error ? ` · ${stale.error}` : ""}. Messages since then are not shown yet.</StaleBanner> : null}
        {(msgs ?? []).length ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {[["threads", "Threads"], ["messages", "Messages"]].map(([k, l]) => (
              <Link key={k} href={`/drafts?tab=inbox&iv=${k}`} className={clsx("rounded-full border px-3 py-1", k === view ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-soft")}>{l}</Link>
            ))}
          </div>
        ) : null}
        {threadView ? threadView : (msgs ?? []).length === 0 ? (
          <EmptyState title="No emails triaged yet">
            Connect Microsoft 365 or Google (read-only) in <Link className="text-brand underline" href="/settings/connections">Settings → Connections</Link>, or import one email using the form.
            {(accounts ?? []).length === 0 ? " No mailbox is connected, so this is not the same as “no replies”." : ""}
          </EmptyState>
        ) : (msgs ?? []).map((m) => {
          const t = m.triage as { summary?: string; category?: string; buying_signals?: { signal: string; evidence: string }[]; next_actions?: string[]; injection_suspected?: boolean } | null;
          return (
            <Card key={m.id}>
              <div className="flex flex-wrap items-center gap-2">
                {t?.category ? <Badge tone={CAT_TONE[t.category] ?? "neutral"}>{t.category.replace(/_/g, " ")}</Badge> : <Badge>{m.triage_status}</Badge>}
                {t?.injection_suspected ? <Badge tone="bad" title="Contains instructions aimed at automated systems; nothing was acted on">suspicious content</Badge> : null}
                {m.is_backfill ? <Badge title="Older history: logged only, no alerts or sequence changes">history</Badge> : null}
                {m.provider === "mock" ? <Badge tone="accent">mock data</Badge> : null}
                {m.import_method === "manual_import" ? <Badge>imported</Badge> : null}
                {(m.matched_person_ids ?? []).length ? <Badge tone="ok">known contact</Badge> : null}
                <span className="ml-auto text-xs text-ink-soft">{fmt(m.received_at, "dd MMM, HH:mm", tz)}</span>
              </div>
              <div className="mt-2 text-sm font-medium break-words">{m.subject ?? "(no subject)"}</div>
              <div className="text-xs text-ink-soft break-words">{m.from_name ?? ""} {m.from_address ? `<${m.from_address}>` : ""}</div>
              {t?.summary ? <p className="mt-2 text-sm">{t.summary}</p> : null}
              {t?.buying_signals?.length ? (
                <ul className="mt-2 space-y-1 text-sm">{t.buying_signals.map((s, i) => <li key={i}><span className="font-medium">{s.signal}</span>{s.evidence ? <span className="text-ink-soft"> — “{s.evidence}”</span> : null}</li>)}</ul>
              ) : null}
              {t?.next_actions?.length ? <p className="mt-2 text-xs text-ink-soft">Next: {t.next_actions.join(" · ")}</p> : null}
            </Card>
          );
        })}
      </div>
      <Card title="Import one email">
        {canEdit ? (
          <form action={importEmlAction} className="space-y-3" encType="multipart/form-data">
            <p className="text-sm text-ink-soft">Gmail: open the email → ⋮ → “Download message” and choose the .eml file, or “Show original” and paste everything. Outlook: save the message as .eml. Only this one message is read.</p>
            <Field label=".eml file"><input name="file" type="file" accept=".eml,message/rfc822,text/plain" className="block w-full text-sm" /></Field>
            <Field label="…or paste the raw message"><Textarea name="raw" rows={6} placeholder="From: …&#10;Subject: …&#10;&#10;Hello…" /></Field>
            <Button type="submit">Import and triage</Button>
          </form>
        ) : <p className="text-sm text-ink-soft">Editors can import emails.</p>}
      </Card>
    </div>
  );
}
