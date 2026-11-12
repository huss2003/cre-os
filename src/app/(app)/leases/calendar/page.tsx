import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { Card, EmptyState, Input, PageHeader, Select } from "@/components/ui";
import { addDays } from "@/modules/leases/dates";
import { listLeases, upcomingDates } from "@/modules/leases/service";
import { DATE_TYPE_LABEL, VerificationBadge } from "@/modules/leases/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;

/** §15C — milestones grouped by month; filters: lease, company, property, event type, assigned user, date range. */
export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const ctx = await requirePageContext();
  const w = { db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId };
  const today = localDate();
  const from = str("from") || today;
  const to = str("to") || addDays(today, 365);
  const [rows, leases] = await Promise.all([
    upcomingDates(w, { from, to, includeUnverified: str("all") === "1", leaseId: str("lease") || undefined, orgId: str("org") || undefined, assetId: str("asset") || undefined, types: str("type") ? [str("type")] : undefined, assigned: str("mine") ? ctx.userId : undefined }),
    listLeases(w),
  ]);
  const months = new Map<string, typeof rows>();
  for (const r of rows) { const k = String(r.calculated_date).slice(0, 7); months.set(k, [...(months.get(k) ?? []), r]); }
  const orgs = [...new Map(leases.filter((l) => l.tenant_org_id).map((l) => [l.tenant_org_id, l.tenant_name])).entries()];
  const assets = [...new Map(leases.filter((l) => l.asset_id).map((l) => [l.asset_id, l.asset_name])).entries()];
  return (
    <div className="space-y-4">
      <PageHeader title="Lease calendar" subtitle={`${rows.length} milestones ${from} → ${to}${str("all") === "1" ? " (incl. unverified)" : " (confirmed only)"}`} />
      <form action="/leases/calendar" className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Input type="date" name="from" defaultValue={from} aria-label="From" /><Input type="date" name="to" defaultValue={to} aria-label="To" />
        <Select name="lease" defaultValue={str("lease")} aria-label="Lease"><option value="">All leases</option>{leases.map((l) => <option key={l.id} value={l.id}>{l.label}{l.tenant_name && l.asset_name ? ` — ${l.asset_name}` : ""}</option>)}</Select>
        <Select name="org" defaultValue={str("org")} aria-label="Company"><option value="">All companies</option>{orgs.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select>
        <Select name="asset" defaultValue={str("asset")} aria-label="Property"><option value="">All properties</option>{assets.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select>
        <Select name="type" defaultValue={str("type")} aria-label="Event type"><option value="">All events</option>{Object.entries(DATE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="all" value="1" defaultChecked={str("all") === "1"} /> Include unverified</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="mine" value="1" defaultChecked={!!str("mine")} /> Assigned to me</label>
        <button className="rounded-md bg-brand px-3 py-2 text-sm text-white">Show</button>
      </form>
      {rows.length === 0 ? <EmptyState title="Nothing in this range">Confirm lease dates on a lease (or tick “Include unverified”) to see them here.</EmptyState> : [...months.entries()].map(([m, items]) => (
        <Card key={m} title={m}>
          <ul className="space-y-1 text-sm">{items.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><span className="w-24 shrink-0">{r.calculated_date}</span><span>{DATE_TYPE_LABEL[r.date_type] ?? r.date_type}</span><Link className="text-brand" href={`/leases/${r.lease_id}`}>{r.lease.label}</Link><VerificationBadge status={r.verification_status} /></li>)}</ul>
        </Card>
      ))}
    </div>
  );
}
