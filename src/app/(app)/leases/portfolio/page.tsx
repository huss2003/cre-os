import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { Card, EmptyState, Input, PageHeader, Select, Stat, inr, sf } from "@/components/ui";
import { portfolioView } from "@/modules/leases/service";
import { CATEGORY_LABEL, STATUS_LABEL, type LeaseStatus } from "@/modules/leases/status";
import { LeaseTabs } from "@/modules/leases/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;

/** §12 / §15F portfolio. Totals include only compatible, known values; exclusions are listed. */
export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const ctx = await requirePageContext();
  const w = { db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId };
  const v = await portfolioView(w, localDate(), { q: str("q") || undefined, category: str("category") || undefined, microMarket: str("mm") || undefined, assigned: str("mine") ? ctx.userId : undefined });
  const p = v.portfolio;
  const name = (id: string) => v.leases.find((l) => l.id === id)?.tenant_name ?? id.slice(0, 8);
  return (
    <div className="space-y-4">
      <LeaseTabs active="portfolio" />
      <PageHeader title="Lease portfolio" subtitle="Aggregates use only known, compatible values. Missing data is listed, never treated as zero." />
      <form action="/leases/portfolio" className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Input name="q" placeholder="Tenant / landlord / building" defaultValue={str("q")} aria-label="Search" />
        <Select name="category" defaultValue={str("category")} aria-label="Category"><option value="">Any category</option>{Object.entries(CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Input name="mm" placeholder="Micro-market" defaultValue={str("mm")} aria-label="Micro-market" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="mine" value="1" defaultChecked={!!str("mine")} /> Mine</label>
        <button className="rounded-md bg-brand px-3 py-2 text-sm text-white">Filter</button>
      </form>
      {v.leases.length === 0 ? <EmptyState title="No leases">Add leases to see portfolio metrics.</EmptyState> : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Active or executed leases" value={p.activeCount} />
            <Stat label={`Leased area (${p.leasedArea.basis ?? "—"})`} value={p.leasedArea.total ? sf(p.leasedArea.total) : "—"} hint={`${p.leasedArea.included} included, ${p.leasedArea.excluded.length} excluded`} />
            <Stat label="Monthly rent (known)" value={p.monthlyRent.total ? inr(p.monthlyRent.total) : "—"} hint={`${p.monthlyRent.included} included, ${p.monthlyRent.excluded.length} excluded`} />
            <Stat label="Annual rent (known)" value={p.annualRent ? inr(p.annualRent) : "—"} />
            <Stat label="Expiries (12 mo)" value={v.upcoming.expiries} /><Stat label="Renewal deadlines" value={v.upcoming.renewalDeadlines} />
            <Stat label="Escalations" value={v.upcoming.escalations} /><Stat label="Lock-in completions" value={v.upcoming.lockins} />
            <Stat label="Termination pipeline" value={v.terminationPipeline} /><Stat label="Pending obligations" value={v.pendingObligations} />
          </div>
          <Card title="By status"><ul className="flex flex-wrap gap-3 text-sm">{Object.entries(p.byStatus).map(([s, c]) => <li key={s}>{STATUS_LABEL[s as LeaseStatus] ?? s}: {c}</li>)}</ul></Card>
          <Card title="Excluded from totals">
            <ul className="text-sm">{[...p.leasedArea.excluded.map((e) => ({ ...e, what: "area" })), ...p.monthlyRent.excluded.map((e) => ({ ...e, what: "rent" }))].map((e, i) => <li key={i}><Link className="text-brand" href={`/leases/${e.id}`}>{name(e.id)}</Link> — {e.what}: {e.reason}</li>)}</ul>
          </Card>
          <Card title={`Leases with incomplete information (${p.incomplete.length})`}>
            <ul className="text-sm">{p.incomplete.slice(0, 100).map((x) => <li key={x.id}><Link className="text-brand" href={`/leases/${x.id}`}>{name(x.id)}</Link> — {x.missing.join(", ")}</li>)}</ul>
          </Card>
        </>
      )}
    </div>
  );
}
