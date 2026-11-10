import Link from "next/link";
import { Badge, Card, EmptyState, HelpFor, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { ManagedForm } from "./_parts/form";

export default async function ManagedPage() {
  const ctx = await requirePageContext();
  const rows = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "conventional_vs_managed", limit: 30 });
  return (
    <div data-tour="toolkit-managed" className="space-y-5">
      <PageHeader title="Conventional vs managed" subtitle="Compare a conventional lease with a managed-office quote on the same period, per usable seat, with included services counted once. Leave a box blank when you don't know — it is listed as missing, never taken as zero." />
      <Card title={<>New comparison<HelpFor k="Conventional vs managed" /></>}><ManagedForm /></Card>
      <Card title="Saved comparisons">
        {rows.length ? (
          <ul className="divide-y divide-line text-sm">
            {rows.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><Link className="underline" href={`/toolkit/managed/${r.id}`}>{r.title}</Link><span className="flex gap-2"><Badge tone={r.status === "ready" || r.status === "approved" ? "ok" : "warn"}>{r.status}</Badge><span className="text-ink-soft">v{r.current_version}</span></span></li>)}
          </ul>
        ) : <EmptyState title="No comparisons yet">Fill in the form above with the lease terms and the operator&apos;s quote, then save.</EmptyState>}
      </Card>
    </div>
  );
}
