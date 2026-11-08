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
  const [q, { data: caps }] = await Promise.all([
    listQueue(ctx.db, ctx.workspaceId, tab),
    ctx.db.from("capture").select("id, kind, raw_text, transcript, source_at, extraction").eq("workspace_id", ctx.workspaceId)
      .eq("status", "needs_review").is("archived_at", null).order("created_at", { ascending: false }).limit(50),
  ]);
  const pendingCaptures = (caps ?? []) as AnyRow[];
  // Imports with rows still waiting (counted per source file); reviewed in bulk on the import summary page.
  const { data: batches } = await ctx.db.from("import_batch").select("id, file_name, created_at, source_object_id, counts").eq("workspace_id", ctx.workspaceId)
    .is("archived_at", null).order("created_at", { ascending: false }).limit(20);
  // One query for all files' waiting rows (was one count query per import).
  const srcIds = ((batches ?? []) as AnyRow[]).map((b) => b.source_object_id).filter(Boolean) as string[];
  const { data: waitRows } = srcIds.length ? await ctx.db.from("change_proposal").select("evidence_ids").eq("workspace_id", ctx.workspaceId)
    .overlaps("evidence_ids", srcIds).in("state", ["proposed", "approved", "clarify"]).is("reversal_of", null).limit(10000) : { data: [] };
  const waitBy = new Map<string, number>();
  for (const r of (waitRows ?? []) as { evidence_ids: string[] }[]) for (const id of r.evidence_ids) if (srcIds.includes(id)) waitBy.set(id, (waitBy.get(id) ?? 0) + 1);
  const importsWaiting = ((batches ?? []) as AnyRow[]).map((b) => ({ ...b, waiting: waitBy.get(b.source_object_id) ?? 0 }) as AnyRow).filter((b) => b.waiting > 0);
  const editor = hasRole(ctx, "editor");
  return (
    <div className="space-y-4">
      <PageHeader title="Review" subtitle="Everything waiting for your OK. Captures appear first — open one, check it, press Reviewed and it is added to the right sections." />
      {importsWaiting.length ? (
        <Card title={`Imports to review (${importsWaiting.length})`} help="Large files are reviewed in one place: open the import to see what it contains, add all safe rows in one click, and check only the doubtful ones.">
          <ul className="divide-y divide-line">
            {importsWaiting.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0"><p className="truncate text-sm font-medium">{b.file_name}</p>
                  <p className="text-xs text-ink-soft">{fmt(b.created_at)} · {Number(b.counts?.rows_considered ?? 0).toLocaleString("en-IN")} rows · {b.waiting.toLocaleString("en-IN")} waiting for review</p></div>
                <Link href={`/imports/${b.id}`} className="shrink-0 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-strong">Open summary</Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card title={`Captures to review (${pendingCaptures.length})`} help="Every call, meeting or visit you capture lands here first. Nothing is added to companies, people, requirements or tasks until you open it and press Reviewed.">
        {pendingCaptures.length === 0 ? <p className="text-sm text-ink-soft">No captures waiting. New captures from the Capture screen show up here.</p> : (
          <ul className="divide-y divide-line">
            {pendingCaptures.map((c) => {
              const ex = c.extraction as AnyRow | null;
              const counts = ex ? [ex.tasks?.length ? `${ex.tasks.length} task(s)` : null, (ex.facts?.length ?? 0) + (ex.details?.length ?? 0) ? `${(ex.facts?.length ?? 0) + (ex.details?.length ?? 0)} requirement detail(s)` : null].filter(Boolean).join(" · ") : "still reading…";
              return (
                <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                  <Link href={`/capture/${c.id}`} className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft"><Badge tone="brand">{c.kind === "image" ? "photo" : "note"}</Badge>{fmt(c.source_at)}{counts ? <span>· {counts}</span> : null}</div>
                    <p className="mt-1 line-clamp-2 text-sm">{(c.transcript ?? c.raw_text ?? "").slice(0, 220)}</p>
                  </Link>
                  <Link href={`/capture/${c.id}`} className="shrink-0 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-strong">Review</Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Approval queues">
        {TABS.map((t) => (
          <Link key={t.key} href={`/approvals?tab=${t.key}`} aria-current={t.key === tab ? "page" : undefined}
            className={clsx("whitespace-nowrap rounded-lg px-3 py-2 text-sm", t.key === tab ? "bg-brand text-white" : "border border-line bg-surface")}>{t.label}</Link>
        ))}
        <Link href="/approvals/conflicts" className="whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-2 text-sm">Conflicts</Link>
        <Link href="/approvals/stale" className="whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-2 text-sm">Stale records</Link>
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
