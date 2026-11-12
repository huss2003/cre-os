import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, ButtonLink, Skeleton } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { captureHistory } from "@/modules/capture/input-engine/service";

export const metadata = { title: "Capture history" };

async function Body() {
  const ctx = await requirePageContext();
  const items = await captureHistory(ctx.db, ctx.workspaceId, 100);
  return (
    <div className="space-y-4">
      <PageHeader title="Capture history" subtitle="Everything captured: original input, type, date, status, extracted records, your corrections, linked records and errors." actions={<ButtonLink variant="secondary" href="/capture">Capture</ButtonLink>} />
      <Card>
        {!items.length ? <EmptyState title="No captures yet">Type a note, record a voice note or drop a file on the Capture page.</EmptyState> : (
          <ul className="divide-y divide-line">
            {items.map((h) => (
              <li key={h.id} className="py-3">
                <Link href={h.href} className="block space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                    <Badge>{h.type}</Badge><Badge tone={h.status === "failed" ? "bad" : h.status === "needs_review" || h.status === "needs_input" ? "warn" : "neutral"}>{String(h.status).replace(/_/g, " ")}</Badge>
                    <span>{fmt(h.uploaded_at)}</span><span>{h.records} extracted</span>{h.corrections ? <span>{h.corrections} correction{h.corrections > 1 ? "s" : ""}</span> : null}
                    {h.linked.length ? <span>{h.linked.length} linked record{h.linked.length > 1 ? "s" : ""}</span> : null}
                  </div>
                  <p className="line-clamp-2 text-sm">{h.input || <span className="text-ink-soft">(no text)</span>}</p>
                  {h.error ? <p className="text-xs text-bad">{h.error}</p> : null}
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
  return <Suspense fallback={<Skeleton variant="list" />}><Body /></Suspense>;
}
