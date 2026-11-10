import Link from "next/link";
import { Badge, Card, EmptyState, HelpFor, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { RenewalForm } from "./_parts/form";

export default async function RenewalPage() {
  const ctx = await requirePageContext();
  const rows = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "renewal_vs_relocation", limit: 30 });
  return (
    <div data-tour="toolkit-renewal" className="space-y-5">
      <PageHeader title="Renewal vs relocation" subtitle="Compare renewing the current lease with moving: totals, present value, month-by-month cumulative cost and break-even, plus a separate operational score. Blank = unknown and listed as missing, never zero." />
      <Card title={<>New analysis<HelpFor k="Renewal vs relocation" /></>}><RenewalForm /></Card>
      <Card title="Saved analyses">
        {rows.length ? (
          <ul className="divide-y divide-line text-sm">
            {rows.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><Link className="underline" href={`/toolkit/renewal/${r.id}`}>{r.title}</Link><span className="flex gap-2"><Badge tone={r.status === "ready" || r.status === "approved" ? "ok" : "warn"}>{r.status}</Badge><span className="text-ink-soft">v{r.current_version}</span></span></li>)}
          </ul>
        ) : <EmptyState title="No analyses yet">Enter the landlord renewal proposal and the best relocation option above, then save.</EmptyState>}
      </Card>
    </div>
  );
}
