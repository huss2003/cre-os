import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { listConflicts } from "@/modules/changes/steward";
import { conflictAction } from "@/modules/changes/steward-actions";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { StewardNav, show } from "@/modules/changes/ui/steward-ui";

export const metadata = { title: "Conflicts" };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

async function Body({ searchParams }: Props) {
  const sp = await searchParams;
  const all = sp.status === "all";
  const ctx = await requirePageContext();
  const rows = await listConflicts(ctx.db, ctx.workspaceId, { status: all ? "all" : "open" });
  const editor = hasRole(ctx, "editor");
  return (
    <div className="space-y-4">
      <PageHeader title="Source vs record conflicts" subtitle="Every field where an imported source disagrees with the record. Records are never overwritten by an import — propose a fix (goes to approval with the source row as evidence) or keep the record value." />
      <StewardNav current="conflicts" />
      <div className="flex gap-3 text-sm">
        <Link className={all ? "text-brand" : "font-medium"} href="/approvals/conflicts">Open</Link>
        <Link className={all ? "font-medium" : "text-brand"} href="/approvals/conflicts?status=all">All (incl. resolved)</Link>
      </div>
      {rows.length === 0 ? (
        <Card><EmptyState title="No conflicts">When a re-imported or newer file says something different from a record (area, status, rent, tenure…), it appears here with both values and the exact source row.</EmptyState></Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => (
            <li key={c.id}>
              <Card>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link className="font-medium text-brand" href={`/approvals/evidence?type=${c.entity_type}&id=${c.entity_id}`}>{c.entity_label ?? c.entity_type}</Link>
                  <Badge>{c.entity_type}</Badge><span className="font-mono text-xs">{c.field}</span>
                  {c.material ? <Badge tone="warn">material</Badge> : null}
                  <Badge tone={c.status === "open" ? "warn" : c.status === "proposed" ? "brand" : "neutral"}>{c.status}{c.proposal_state ? ` · proposal ${c.proposal_state}` : ""}</Badge>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-lg border border-line p-2"><dt className="text-xs text-ink-soft">Record says now</dt><dd>{show(c.master_value_now)}</dd>
                    {show(c.master_value_then) !== show(c.master_value_now) ? <dd className="text-xs text-ink-soft">when detected: {show(c.master_value_then)}</dd> : null}</div>
                  <div className="rounded-lg border border-line p-2"><dt className="text-xs text-ink-soft">Source says</dt><dd>{show(c.source_value)}</dd>
                    <dd className="text-xs text-ink-soft">{c.source_label ?? "source"} · {c.source_locator ?? "—"} · {fmt(c.observed_at)}</dd></div>
                </dl>
                {editor && c.still_disagrees && c.status !== "dismissed" ? (
                  <ActionForm action={conflictAction} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={c.id} />
                    {c.status === "open" || !c.change_proposal_id ? <Submit name="op" value="propose">Propose fix</Submit> : <Link className="text-sm text-brand" href="/approvals?tab=records">Open the proposal</Link>}
                    <Submit variant="ghost" name="op" value="dismiss">Keep record value</Submit>
                  </ActionForm>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Page(props: Props) {
  return <Suspense fallback={<div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">Loading…</div>}><Body {...props} /></Suspense>;
}
