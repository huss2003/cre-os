import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { renewalPipeline } from "@/modules/leases/service";
import { VerificationBadge } from "@/modules/leases/ui";

const COLS: [string, string[]][] = [["Discussion", ["upcoming", "discussion"]], ["Proposals pending", ["proposal_pending"]], ["Negotiation", ["negotiation", "approval_pending"]], ["Agreed", ["agreed"]], ["Completed", ["completed"]], ["At risk", ["at_risk"]]];

/** §5.4 / §15D renewal pipeline. */
export default async function Page() {
  const ctx = await requirePageContext();
  const today = localDate();
  const p = await renewalPipeline({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId }, today);
  const urgent = p.renewals.filter((r) => r.immediate);
  return (
    <div className="space-y-4">
      <PageHeader title="Renewal pipeline" subtitle="Expiry is a potential conversation, not proof the tenant will move or renew." />
      {urgent.length > 0 && <Card title="Needs immediate attention (deadline ≤ 30 days)"><ul className="text-sm">{urgent.map((r) => <li key={r.id}><Link className="text-brand" href={`/leases/${r.lease_id}#renewal`}>{r.lease?.label ?? "Lease"}</Link> — {r.nextDeadline?.calculated_date} ({r.daysToDeadline} days)</li>)}</ul></Card>}
      <Card title="Upcoming renewals (expiry within 12 months, no renewal record yet)">
        {p.upcomingWithoutRecord.length === 0 ? <p className="text-sm text-ink-soft">None.</p> : <ul className="space-y-1 text-sm">{p.upcomingWithoutRecord.map((d) => <li key={d.id} className="flex flex-wrap gap-2"><Link className="text-brand" href={`/leases/${d.lease_id}#renewal`}>{d.lease.label}</Link> expires {d.calculated_date} <VerificationBadge status={d.verification_status} /></li>)}</ul>}
      </Card>
      {p.renewals.length === 0 ? <EmptyState title="No renewals in progress">Open a lease and press “Start renewal review”.</EmptyState> : (
        <div className="grid gap-3 md:grid-cols-3">
          {COLS.map(([label, stages]) => {
            const items = p.renewals.filter((r) => stages.includes(r.stage) || (label === "At risk" && r.atRisk && r.stage !== "at_risk"));
            return (
              <Card key={label} title={`${label} (${items.length})`}>
                <ul className="space-y-1 text-sm">{items.map((r) => <li key={r.id}><Link className="text-brand" href={`/leases/${r.lease_id}#renewal`}>{r.lease?.label ?? "Lease"}</Link>{r.nextDeadline ? <span className="text-xs text-ink-soft"> · next deadline {r.nextDeadline.calculated_date}</span> : null}{r.atRisk ? <Badge tone="bad">at risk</Badge> : null}</li>)}</ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
