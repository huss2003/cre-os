import Link from "next/link";
import { Badge, Card, EmptyState, Help, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { loadPartners } from "../fitout/data";
import { FinancingForm } from "./form";

export default async function FinancingPage() {
  const ctx = await requirePageContext();
  const [saved, partners] = await Promise.all([listAnalyses(ctx.db, ctx.workspaceId, { kind: "financing" }), loadPartners(ctx.db, ctx.workspaceId)]);
  return (
    <div data-tour="toolkit-financing" className="space-y-5">
      <PageHeader title="Fit-out financing" subtitle="EMI, full amortisation schedule, total interest, fees and month-by-month cash requirement. Formula loan-1.0 — deterministic, rounded to paise only per row." />
      <Card title="Saved financing analyses">
        {saved.length === 0 ? <EmptyState title="No financing analyses yet">Enter the amount, rate and tenure below. To compare partners, save one analysis per partner&apos;s terms.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">{saved.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2"><Link className="text-brand" href={`/toolkit/financing/${a.id}`}>{a.title}</Link><span className="flex gap-1.5 text-xs text-ink-soft">v{a.current_version} <Badge tone={a.status === "approved" ? "ok" : a.status === "ready" ? "neutral" : "warn"}>{a.status === "needs_info" ? "needs info" : a.status}</Badge></span></li>)}</ul>
        )}
      </Card>
      <Card title="New financing analysis" help={<Help>EMI = P·r·(1+r)^n ÷ ((1+r)^n − 1), r = annual rate ÷ 12. The last EMI is adjusted by a few paise so the loan closes at exactly ₹0.</Help>}>
        <FinancingForm partners={partners} />
      </Card>
    </div>
  );
}
