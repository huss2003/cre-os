import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { Badge, Card, EmptyState, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { obligationAction } from "@/modules/leases/actions";
import { obligationTracker } from "@/modules/leases/service";
import { Flash } from "@/modules/leases/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;

/** §10 / §15E obligation tracker. Administrative tracking — not a legal compliance determination. */
export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const ctx = await requirePageContext();
  const today = localDate();
  const rows = await obligationTracker({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId }, { status: str("status") || undefined, responsible: str("responsible") || undefined });
  return (
    <div className="space-y-4">
      <PageHeader title="Obligation tracker" subtitle="Source-linked summaries of lease obligations. Not legal advice." />
      <Flash sp={sp} />
      <form action="/leases/obligations" className="flex flex-wrap gap-2">
        <Select name="status" defaultValue={str("status")} aria-label="Status"><option value="">Any status</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done</option><option value="waived">Waived</option></Select>
        <Select name="responsible" defaultValue={str("responsible")} aria-label="Responsible"><option value="">Any party</option><option value="tenant">Tenant</option><option value="landlord">Landlord</option><option value="shared">Shared</option><option value="unclear">Unclear</option></Select>
        <button className="rounded-md bg-brand px-3 py-2 text-sm text-white">Filter</button>
      </form>
      {rows.length === 0 ? <EmptyState title="No obligations">Obligations appear when an agreement is attached to a lease (extracted with page refs) or added by hand.</EmptyState> : (
        <Card>
          <Table head={["Obligation", "Lease", "Party", "Deadline", "Status", "Source clause", "Evidence"]}>
            {rows.map((o) => (
              <tr key={o.id}>
                <Td>{o.category.replace(/_/g, " ")}<div className="text-xs text-ink-soft">{o.description.slice(0, 140)}</div></Td>
                <Td><Link className="text-brand" href={`/leases/${o.lease_id}#obligations`}>{o.lease?.label ?? "Lease"}</Link></Td>
                <Td>{o.responsible === "unclear" ? <Badge tone="warn">unclear</Badge> : o.responsible}</Td>
                <Td>{o.deadline ?? "—"}{o.deadline && o.deadline < today && ["open", "in_progress"].includes(o.status) ? <Badge tone="bad">overdue</Badge> : null}</Td>
                <Td>{o.status}</Td>
                <Td className="text-xs">{o.document ? `${o.document.title} v${o.document.version}${o.page ? ` p.${o.page}` : ""}` : "manual"}</Td>
                <Td>{["open", "in_progress"].includes(o.status) ? <form action={obligationAction} className="flex gap-1"><input type="hidden" name="lease_id" value={o.lease_id} /><input type="hidden" name="obligation_id" value={o.id} /><input type="hidden" name="status" value="done" /><input type="hidden" name="return" value="/leases/obligations" /><Input name="evidence" placeholder="Evidence" aria-label="Evidence" className="w-28" /><button className="text-xs text-brand">Done</button></form> : <span className="text-xs">{o.evidence_note}</span>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
