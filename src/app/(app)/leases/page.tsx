import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { Badge, ButtonLink, Card, EmptyState, Input, PageHeader, Select, Skeleton, Stat, Table, Td } from "@/components/ui";
import { addDays } from "@/modules/leases/dates";
import { overdue, portfolioView, upcomingDates } from "@/modules/leases/service";
import { CATEGORY_LABEL, LEASE_STATUSES, STATUS_LABEL, type LeaseStatus } from "@/modules/leases/status";
import { DATE_TYPE_LABEL, Flash, VerificationBadge } from "@/modules/leases/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Skeleton variant="cards" />}><Body searchParams={searchParams} /></Suspense>;
}

const WINDOWS: Record<string, number> = { "30": 30, "90": 90, "180": 180, "365": 365, "730": 730 };

async function Body({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  // old links: /leases?lease=<id> | ?id=<id> → detail; radar filters → radar tab
  if (str("lease") || str("id")) redirect(`/leases/${str("lease") || str("id")}`);
  if (str("window") || str("review")) redirect(`/leases/radar?${new URLSearchParams(Object.entries(sp).filter(([, v]) => typeof v === "string") as [string, string][]).toString()}`);
  const ctx = await requirePageContext();
  const w = { db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId };
  const today = localDate();
  const days = WINDOWS[str("days")] ?? 365;
  const filt = { q: str("q") || undefined, status: str("status") || undefined, category: str("category") || undefined, microMarket: str("mm") || undefined, assigned: str("mine") ? ctx.userId : undefined };
  const [pv, soon, od] = await Promise.all([
    portfolioView(w, today, filt),
    upcomingDates(w, { from: today, to: addDays(today, days), includeUnverified: true, status: filt.status, assigned: filt.assigned, types: str("type") ? [str("type")] : undefined }),
    overdue(w, today),
  ]);
  const leaseIds = new Set(pv.leases.map((l) => l.id));
  const upcoming = soon.filter((d) => leaseIds.has(d.lease_id));
  const attention = pv.portfolio.incomplete.slice(0, 12);
  const name = (id: string) => pv.leases.find((l) => l.id === id)?.label ?? "Lease";

  return (
    <div className="space-y-4">
      <PageHeader title="Leases" subtitle={`Lease lifecycle · dates as of ${today}. Only human-reviewed dates are confirmed contractual deadlines.`} actions={<ButtonLink href="/leases/new">New lease</ButtonLink>} />
      <Flash sp={sp} />
      {pv.leases.length === 0 && !filt.q && !filt.status ? (
        <EmptyState title="No leases yet" action={<ButtonLink href="/leases/new">Add a lease</ButtonLink>}>
          Add a lease (or import a lease schedule under Imports), then attach the executed agreement. Dates, notice conditions and
          escalations are read from the document by code with page references; you confirm each one before it drives reminders.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Active leases" value={pv.portfolio.activeCount} />
            <Stat label="Expiries (12 mo)" value={pv.upcoming.expiries} hint="confirmed dates" />
            <Stat label="Renewal deadlines" value={pv.upcoming.renewalDeadlines} />
            <Stat label="Escalations" value={pv.upcoming.escalations} />
            <Stat label="Lock-in completions" value={pv.upcoming.lockins} />
            <Stat label="Break options" value={pv.upcoming.breaks} />
            <Stat label="Pending obligations" value={pv.pendingObligations} />
            <Stat label="Dates awaiting review" value={pv.datesAwaitingReview} hint="not yet contractual" />
          </div>

          <form className="grid grid-cols-2 gap-2 md:grid-cols-6" action="/leases">
            <Input name="q" aria-label="Search" placeholder="Tenant, landlord, building" defaultValue={str("q")} className="col-span-2" />
            <Select name="status" aria-label="Status" defaultValue={str("status")}><option value="">Any status</option>{LEASE_STATUSES.map((x) => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}</Select>
            <Select name="category" aria-label="Category" defaultValue={str("category")}><option value="">Any category</option>{Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Select name="type" aria-label="Event" defaultValue={str("type")}><option value="">Any event</option>{Object.entries(DATE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Select name="days" aria-label="Window" defaultValue={str("days") || "365"}>{Object.keys(WINDOWS).map((k) => <option key={k} value={k}>Next {k} days</option>)}</Select>
            <Input name="mm" aria-label="Micro-market" placeholder="Micro-market" defaultValue={str("mm")} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="mine" value="1" defaultChecked={!!str("mine")} /> Assigned to me</label>
            <button className="rounded-md bg-brand px-3 py-2 text-sm text-white">Filter</button>
          </form>

          {(od.reminders.length > 0 || od.obligations.length > 0) && (
            <Card title="Overdue milestones">
              <ul className="space-y-1 text-sm">
                {od.reminders.slice(0, 10).map((r) => <li key={r.id}><Link className="text-brand" href={`/leases/${r.lease_id}`}>{name(r.lease_id)}</Link> — {DATE_TYPE_LABEL[r.date_type] ?? r.date_type} was {r.target_date}; follow-up not marked done</li>)}
                {od.obligations.slice(0, 10).map((o) => <li key={o.id}><Link className="text-brand" href={`/leases/${o.lease_id}#obligations`}>{name(o.lease_id)}</Link> — {o.description.slice(0, 80)} (due {o.deadline})</li>)}
              </ul>
            </Card>
          )}

          <Card title={`Upcoming milestones (next ${days} days)`}>
            {upcoming.length === 0 ? <p className="text-sm text-ink-soft">No milestones in this window. Attach executed agreements and confirm dates to populate it.</p> : (
              <Table head={["Date", "Event", "Lease", "Status", "Source"]}>
                {upcoming.slice(0, 60).map((d) => (
                  <tr key={d.id}>
                    <Td className="whitespace-nowrap">{d.calculated_date}</Td>
                    <Td>{DATE_TYPE_LABEL[d.date_type] ?? d.date_type}</Td>
                    <Td><Link className="text-brand" href={`/leases/${d.lease_id}`}>{d.lease.label}</Link><div className="text-xs text-ink-soft">{d.lease.asset_name ?? ""}</div></Td>
                    <Td><VerificationBadge status={d.verification_status} /></Td>
                    <Td className="text-xs">{d.page ? `p.${d.page}` : d.method}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="Leases">
            <Table head={["Tenant", "Property", "Category", "Status", "Needs"]}>
              {pv.leases.slice(0, 200).map((l) => (
                <tr key={l.id}>
                  <Td><Link className="text-brand" href={`/leases/${l.id}`}>{l.label}</Link>{l.reference ? <div className="text-xs text-ink-soft">{l.reference}</div> : null}</Td>
                  <Td>{l.asset_name ?? "—"}{l.micro_market ? <div className="text-xs text-ink-soft">{l.micro_market}</div> : null}</Td>
                  <Td className="text-xs">{CATEGORY_LABEL[l.category as keyof typeof CATEGORY_LABEL] ?? l.category}</Td>
                  <Td><Badge>{STATUS_LABEL[l.lifecycle_status as LeaseStatus] ?? l.lifecycle_status}</Badge></Td>
                  <Td className="text-xs">{attention.find((a) => a.id === l.id)?.missing.join(", ") ?? ""}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
