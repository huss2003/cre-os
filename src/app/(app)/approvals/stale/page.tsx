import { FOCUS_MODE } from "@/lib/nav";
import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmtDate } from "@/lib/util/time";
import { listStale, loadWindows } from "@/modules/changes/steward";
import { markVerifiedAction } from "@/modules/changes/steward-actions";
import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { StewardNav } from "@/modules/changes/ui/steward-ui";

export const metadata = { title: "Stale records" };
const TYPE: Record<string, string> = { organisation: "Company", person: "Person", asset: "Building", availability: "Availability" };
const HREF: Record<string, string> = { organisation: "/companies", person: "/people", asset: "/buildings" };

async function Body() {
  const ctx = await requirePageContext();
  const [rows, windows] = await Promise.all([listStale(ctx.db, ctx.workspaceId), loadWindows(ctx.db, ctx.workspaceId)]);
  const editor = hasRole(ctx, "editor");
  return (
    <div className="space-y-4">
      <PageHeader title="Stale records" subtitle={`Key facts not verified within their window (companies ${windows.organisation}d, people ${windows.person}d, buildings ${windows.asset}d, availability ${windows.availability}d). The daily check creates one review task per record; windows are set in workspace setting "steward.freshness_windows".`} />
      <StewardNav current="stale" />
      {rows.length === 0 ? (
        <Card><EmptyState title="Nothing stale">The daily steward check flags companies, people, buildings and availability whose facts have not been confirmed, approved or re-observed recently. Flagged records appear here with a review task.</EmptyState></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{TYPE[r.entity_type] ?? r.entity_type}</Badge>
                  {HREF[r.entity_type] ? <Link className="font-medium text-brand" href={`${HREF[r.entity_type]}/${r.entity_id}`}>{r.label}</Link> : <span className="font-medium">{r.label}</span>}
                  <Badge tone="warn">verified {r.last_verified_at ? fmtDate(r.last_verified_at) : "never"}</Badge>
                </div>
                <p className="text-xs text-ink-soft">Basis: {String(r.basis ?? "—").replace(/_/g, " ")} · window {r.window_days} days · stale since {fmtDate(r.stale_since)}
                  {" · "}<Link className="underline" href={`/approvals/evidence?type=${r.entity_type}&id=${r.entity_id}`}>why do we believe this?</Link>
                  {r.task_id && !FOCUS_MODE ? <> · <Link className="underline" href="/tasks">review task</Link></> : null}</p>
                {editor ? (
                  <ActionForm action={markVerifiedAction} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={r.entity_id} /><input type="hidden" name="type" value={r.entity_type} />
                    <input name="note" aria-label="How was it verified" placeholder="How was it verified? (optional)" className="min-h-10 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm" maxLength={500} />
                    <Submit variant="secondary">Mark verified</Submit>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton variant="list" />}><Body /></Suspense>;
}
