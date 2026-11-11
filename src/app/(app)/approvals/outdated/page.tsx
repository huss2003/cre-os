import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { StewardNav } from "@/modules/changes/ui/steward-ui";
import { markAction } from "@/modules/orchestrator/ui/actions";
import { markLabel } from "@/modules/orchestrator/ui/labels";
import { listExceptions } from "@/modules/orchestrator/ui/service";

export const metadata = { title: "Outdated proposals" };

async function Body() {
  const ctx = await requirePageContext();
  const rows = await listExceptions({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId, role: ctx.role });
  const editor = hasRole(ctx, "editor");
  const outdated = rows.filter((r) => r.mark === "outdated_warning" || r.mark === "review");
  const refresh = rows.filter((r) => r.mark !== "outdated_warning" && r.mark !== "review");
  const list = (items: typeof rows) => (
    <ul className="divide-y divide-line">
      {items.map((r) => (
        <li key={r.id} className="py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={markLabel(r as never).tone}>{r.label}</Badge>
            <Badge>{r.record?.typeLabel ?? r.entity_type}</Badge>
            {r.record?.href ? <Link className="font-medium text-brand" href={r.record.href}>{r.record.label ?? "Open"}</Link> : <span className="font-medium">{r.record?.label ?? "Record"}</span>}
          </div>
          <p className="mt-1">{r.reason}</p>
          <p className="text-xs text-ink-soft">Flagged {fmt(r.created_at, "dd MMM, HH:mm", ctx.timezone)}{r.run_id ? <> · <Link className="underline" href={`/automation/runs/${r.run_id}`}>what changed</Link></> : null}</p>
          {editor ? (
            <ActionForm action={markAction} className="mt-2 flex flex-wrap gap-2">
              <input type="hidden" name="id" value={r.id} />
              {r.recalculated
                ? (r.record?.href ? <Link className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm font-medium" href={r.record.href}>Review</Link> : null)
                : r.mark !== "outdated_warning" ? <Submit name="op" value="refresh" variant="secondary">Refresh</Submit> : null}
              <Submit name="op" value="dismiss" variant="ghost">Dismiss</Submit>
            </ActionForm>
          ) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-4">
      <PageHeader title="Outdated proposals" subtitle="Analyses, proposals and documents built from figures that have since changed. Approved or shared ones are never changed automatically — review them here." />
      <StewardNav current="outdated" />
      <Card title="Approved or shared — review needed">
        {outdated.length ? list(outdated) : <EmptyState title="Nothing outdated">When a quote, requirement or contact changes after a proposal was approved or shared, it is listed here.</EmptyState>}
      </Card>
      <Card title="Needs a refresh">
        {refresh.length ? list(refresh) : <EmptyState title="Everything is up to date">Drafts and analyses that depend on changed figures are listed here with a Refresh button.</EmptyState>}
      </Card>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">Loading…</div>}><Body /></Suspense>;
}
