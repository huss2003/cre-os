import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, ButtonLink, Skeleton } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { reviewQueue } from "@/modules/capture/input-engine/service";
import { REVIEW_LABEL, type ReviewCategory } from "@/modules/capture/input-engine/analysis";
import { ObservationList } from "@/modules/capture/input-engine/ui/observations";

export const metadata = { title: "Capture review queue" };
const ORDER: ReviewCategory[] = ["uncertain_company_match", "uncertain_contact_match", "potential_duplicate", "conflicting_commercial_value", "missing_units_or_dates", "unverified_lease_details", "material_change_approval"];

async function Body() {
  const ctx = await requirePageContext();
  const q = await reviewQueue(ctx.db, ctx.workspaceId);
  const total = ORDER.reduce((n, k) => n + q[k].length, 0);
  return (
    <div className="space-y-4">
      <PageHeader title="Review queue" subtitle="Only what needs a person: uncertain matches, duplicates, conflicting values, missing units or dates, unverified lease details and material changes." actions={<ButtonLink variant="secondary" href="/capture">Capture</ButtonLink>} />
      {total === 0 ? <Card><EmptyState title="Nothing waiting">New captures that need a decision show up here, grouped by what needs checking.</EmptyState></Card> : null}
      {ORDER.filter((k) => q[k].length).map((k) => (
        <Card key={k} title={`${REVIEW_LABEL[k]} (${q[k].length})`}>
          {k === "material_change_approval" ? (
            <ul className="divide-y divide-line text-sm">
              {q[k].map((p) => (
                <li key={p.id} className="py-2"><Link className="text-brand" href={`/approvals?tab=records`}>{p.target_type} · {p.operation}</Link> <Badge tone="warn">{p.risk}</Badge> <span className="text-xs text-ink-soft">{fmt(p.created_at)}</span><p className="text-xs text-ink-soft">{String(p.raw_text ?? "").slice(0, 200)}</p>{p.capture_id ? <Link className="text-xs text-brand" href={`/capture/${p.capture_id}`}>Open capture</Link> : null}</li>
              ))}
            </ul>
          ) : (
            <>
              <ObservationList items={q[k].map((o) => ({ ...o, fact_class: o.fact_class ?? "estimate", status: "pending_review", verification: o.verification ?? "unverified", observed_at: o.created_at }))} editor={hasRole(ctx, "editor")} />
              <p className="mt-2 text-xs text-ink-soft">Open the capture to resolve who/which record: {[...new Set(q[k].map((o) => o.capture_id ?? o.capture_document_id))].slice(0, 5).map((id, i) => (
                <Link key={id} className="mr-2 text-brand" href={q[k].find((o) => o.capture_id === id) ? `/capture/${id}` : `/capture/documents/${id}`}>#{i + 1}</Link>))}</p>
            </>
          )}
        </Card>
      ))}
    </div>
  );
}
export default function Page() {
  return <Suspense fallback={<Skeleton variant="list" />}><Body /></Suspense>;
}
