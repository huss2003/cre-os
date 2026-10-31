import { Suspense } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { listQueue, type QueueTab } from "@/modules/changes/service";
import { ProposalCard } from "@/modules/changes/ui/proposal-card";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { batchUndoAction } from "@/modules/changes/actions";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

export const metadata = { title: "Approvals" };

const TABS: { key: QueueTab; label: string }[] = [
  { key: "records", label: "Record changes" },
  { key: "merges", label: "Identity merges" },
  { key: "drafts", label: "External drafts" },
  { key: "documents", label: "Documents" },
  { key: "history", label: "History & undo" },
];
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const EMPTY: Record<QueueTab, string> = {
  records: "Nothing waiting. Material changes from captures, imports, connectors and edits to identifiers, areas, budgets, dates and fees land here for approval.",
  merges: "No merge proposals. Duplicate companies, people or buildings are never merged silently — propose a merge from a record page and it appears here.",
  drafts: "No drafts awaiting review. Follow-up emails and messages drafted from captures appear here; you always send them yourself.",
  documents: "No documents waiting for approval.",
  history: "No applied changes yet. Every applied change is listed here with a one-click, conflict-aware undo.",
};

async function Body({ searchParams }: Props) {
  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "records") as QueueTab;
  const ctx = await requirePageContext();
  const q = await listQueue(ctx.db, ctx.workspaceId, tab);
  const editor = hasRole(ctx, "editor");
  return (
    <div className="space-y-4">
      <PageHeader title="Approvals" subtitle="Review before/after, approve, reject, ask to clarify, edit or undo. Approvals bind to the exact content and record version." />
      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Approval queues">
        {TABS.map((t) => (
          <Link key={t.key} href={`/approvals?tab=${t.key}`} aria-current={t.key === tab ? "page" : undefined}
            className={clsx("whitespace-nowrap rounded-lg px-3 py-2 text-sm", t.key === tab ? "bg-brand text-white" : "border border-line bg-surface")}>{t.label}</Link>
        ))}
      </nav>

      {"proposals" in q && q.proposals ? (
        q.proposals.length === 0 ? <Card><EmptyState title="All clear">{EMPTY[tab]}</EmptyState></Card> : (
          <div className="space-y-3">
            {tab === "history" && editor ? (
              <Card>
                <ActionForm id="batch-undo" action={batchUndoAction} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink-soft">Tick changes below, then undo them together (newest first; later edits are kept and reported).</span>
                  <Submit variant="secondary" confirm="Undo the selected changes?">Undo selected</Submit>
                </ActionForm>
              </Card>
            ) : null}
            {q.proposals.map((p) => <ProposalCard key={p.id} p={p} role={ctx.role} selectable={tab === "history" && editor && ["applied", "conflict"].includes(p.state)} />)}
            <p className="text-xs text-ink-soft">Undo cannot unsend messages or reverse commitments made outside CRE OS.</p>
          </div>
        )
      ) : null}

      {"drafts" in q && q.drafts ? (
        q.drafts.length === 0 ? <Card><EmptyState title="All clear">{EMPTY.drafts}</EmptyState></Card> : (
          <Card title="Drafts to review">
            <ul className="divide-y divide-line">{q.drafts.map((d) => (
              <li key={d.id} className="py-3 text-sm">
                <Link href={`/drafts/${d.id}`} className="font-medium text-brand">{d.subject ?? `${d.channel} draft`}</Link>
                <span className="ml-2"><Badge tone={d.state === "approved" && d.approved_hash === d.content_hash ? "ok" : "warn"}>{d.state === "approved" && d.approved_hash !== d.content_hash ? "approval invalidated" : d.state}</Badge></span>
                <p className="text-ink-soft">To {d.recipient_display ?? "—"} · {fmt(d.created_at)}</p>
                <p className="line-clamp-2">{d.body}</p>
              </li>
            ))}</ul>
            <p className="mt-2 text-xs text-ink-soft">Drafts are approved in the Drafts queue. CRE OS never sends anything — you open the message in your mail/WhatsApp and send it yourself.</p>
          </Card>
        )
      ) : null}

      {"documents" in q && q.documents ? (
        q.documents.length === 0 ? <Card><EmptyState title="All clear">{EMPTY.documents}</EmptyState></Card> : (
          <Card title="Documents">
            <ul className="divide-y divide-line">{(q.documents as AnyRow[]).map((d) => (
              <li key={d.id} className="py-2 text-sm"><Link className="text-brand" href={`/documents/${d.id}`}>{d.title ?? d.file_name ?? d.id}</Link>
                <span className="text-ink-soft"> · {d.status ?? "pending"} · {fmt(d.created_at)}</span></li>
            ))}</ul>
          </Card>
        )
      ) : null}
    </div>
  );
}

export default function Page(props: Props) {
  return <Suspense fallback={<div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">Loading…</div>}><Body {...props} /></Suspense>;
}
