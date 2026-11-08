import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { listCaptures } from "@/modules/capture/service";
import { QuickCapture } from "@/modules/capture/ui/quick-capture";
import { StatusBadge } from "@/modules/capture/ui/parts";

export const metadata = { title: "Capture" };

async function Body() {
  const ctx = await requirePageContext();
  const recent = await listCaptures(ctx.db, ctx.workspaceId);
  return (
    <div className="space-y-4">
      <PageHeader title="Capture" subtitle="Tell CRE OS what happened after a call, meeting or site visit. It files the meeting, creates follow-up tasks and asks before changing any record." />
      {hasRole(ctx, "editor") ? (
        <Card title="New capture"><QuickCapture workspaceId={ctx.workspaceId} /></Card>
      ) : (
        <Card><p className="text-sm text-ink-soft">Viewers can read captures but not create them. Ask an admin for editor access.</p></Card>
      )}
      <Card title="Recent captures">
        {recent.length === 0 ? (
          <EmptyState title="No captures yet">
            Type or dictate what happened after a call or visit — for example <em>“spoke to Raj at Acme; 20k by March; maybe Baner; send options Friday”</em>.
            CRE OS splits it into an interaction, a tentative requirement for approval, a due task and a draft, and asks about anything ambiguous.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((c) => (
              <li key={c.id} className="py-3">
                <Link href={`/capture/${c.id}`} className="block space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                    <StatusBadge status={c.status} />
                    <Badge>{c.kind}</Badge>
                    <span>{fmt(c.source_at)}</span>
                    {c.open ? <Badge tone="warn">{c.open} question{c.open > 1 ? "s" : ""}</Badge> : null}
                    {c.proposals ? <Badge tone="brand">{c.proposals} for approval</Badge> : null}
                    {c.tasks ? <Badge>{c.tasks} task{c.tasks > 1 ? "s" : ""}</Badge> : null}
                  </div>
                  <p className="line-clamp-2 text-sm">{c.preview || <span className="text-ink-soft">(no text — {c.kind})</span>}</p>
                  {c.error ? <p className="text-xs text-bad">{c.error}</p> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">Loading…</div>}><Body /></Suspense>;
}
