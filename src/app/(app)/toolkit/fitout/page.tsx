import Link from "next/link";
import { Badge, Card, EmptyState, Help, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { FitoutEditor } from "./editor";
import { loadPartners } from "./data";


export default async function FitoutPage() {
  const ctx = await requirePageContext();
  const [saved, partners] = await Promise.all([listAnalyses(ctx.db, ctx.workspaceId, { kind: "fitout" }), loadPartners(ctx.db, ctx.workspaceId)]);
  return (
    <div data-tour="toolkit-fitout" className="space-y-5">
      <PageHeader title="Fit-out budget & quotations" subtitle="Estimated, approved and actual costs by category with tax shown separately, plus a like-for-like comparison of partner quotations. Formula fitout-1.0 — deterministic, no AI arithmetic." />
      <Card title="Saved budgets">
        {saved.length === 0 ? <EmptyState title="No fit-out budgets yet">Add line items below (amounts excluding tax, with each line&apos;s tax %), then add partner quotations to compare.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">
            {saved.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2"><Link className="text-brand" href={`/toolkit/fitout/${a.id}`}>{a.title}</Link><span className="flex gap-1.5 text-xs text-ink-soft">v{a.current_version} <Badge tone={a.status === "approved" ? "ok" : a.status === "ready" ? "neutral" : "warn"}>{a.status === "needs_info" ? "needs info" : a.status}</Badge></span></li>)}
          </ul>
        )}
      </Card>
      <Card title="New fit-out budget" help={<Help>Leave unknown amounts blank — they are shown as unknown, never as zero. Estimated defaults to quantity × unit price when blank.</Help>}>
        <FitoutEditor partners={partners} />
      </Card>
    </div>
  );
}
