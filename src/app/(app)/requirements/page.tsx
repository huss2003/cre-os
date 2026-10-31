import Link from "next/link";
import { Badge, ButtonLink, EmptyState, PageHeader, Select, sf, Table, Td } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { listRequirements } from "@/modules/deals/requirements/service";
import { Flash, RequirementStatusBadge } from "@/modules/deals/ui";

export default async function RequirementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = toDealsCtx(await requirePageContext());
  const status = typeof sp.status === "string" && sp.status ? sp.status : undefined;
  const rows = await listRequirements(ctx, { status });
  return (
    <div>
      <PageHeader title="Requirements" subtitle="Client requirements, what is confirmed vs estimated, and what still needs asking."
        actions={<ButtonLink href="/requirements/new">New requirement</ButtonLink>} />
      <Flash sp={sp} />
      <form className="mb-4 flex gap-2" method="get">
        <Select name="status" defaultValue={status ?? ""} className="max-w-xs" aria-label="Filter by status">
          <option value="">All statuses</option><option value="draft">Draft</option><option value="estimated">Estimated</option>
          <option value="client_confirmed">Client confirmed</option><option value="closed">Closed</option>
        </Select>
        <button className="rounded-lg border border-line px-3 text-sm">Filter</button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No requirements yet" action={<ButtonLink href="/requirements/new">Capture a requirement</ButtonLink>}>
          Start with whatever you know (company, rough size, timing). Unknown fields stay unknown — CRE OS lists the questions to ask next.
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2 sm:hidden">
            {rows.map((r) => (
              <li key={r.id as string} className="rounded-xl border border-line bg-surface p-3">
                <Link href={`/requirements/${r.id}`} className="font-medium text-brand">{r.title as string}</Link>
                <div className="mt-1 text-xs text-ink-soft">{(r.organisation as { display_name?: string } | null)?.display_name ?? "—"}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <RequirementStatusBadge status={r.status as string} />
                  <Badge>{r.completeness.percentKnown}% known · {r.completeness.percentConfirmed}% confirmed</Badge>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <Table head={["Requirement", "Company", "Status", "Area", "Occupation", "Mandatory known / confirmed"]}>
              {rows.map((r) => (
                <tr key={r.id as string}>
                  <Td><Link href={`/requirements/${r.id}`} className="font-medium text-brand">{r.title as string}</Link></Td>
                  <Td>{(r.organisation as { display_name?: string } | null)?.display_name ?? "—"}</Td>
                  <Td><RequirementStatusBadge status={r.status as string} /></Td>
                  <Td>{r.area_target_sf ? `${sf(r.area_target_sf as number)} ${r.area_basis ?? "(basis?)"}` : "unknown"}</Td>
                  <Td>{(r.occupation_date as string) ?? "unknown"}</Td>
                  <Td>{r.completeness.percentKnown}% / {r.completeness.percentConfirmed}%</Td>
                </tr>
              ))}
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
