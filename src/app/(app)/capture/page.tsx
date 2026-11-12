import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { listCaptures } from "@/modules/capture/service";
import { QuickCapture } from "@/modules/capture/ui/quick-capture";
import { StatusBadge } from "@/modules/capture/ui/parts";
import { DropZone } from "@/modules/capture/docs/drop-zone";
import { linkOptions, listDocuments } from "@/modules/capture/docs/service";
import { TYPE_LABEL, type DocType } from "@/modules/capture/docs/detect";
import { dashboardCounts, loadPermissions } from "@/modules/capture/input-engine/service";
import { PermissionsForm } from "@/modules/capture/input-engine/ui/permissions-form";
import { RecordingForm } from "@/modules/capture/input-engine/ui/recording-form";
import { captureKindLabel } from "@/modules/capture/input-engine/ui/labels";

const DOC_STATUS: Record<string, [string, "neutral" | "brand" | "ok" | "warn" | "bad"]> = {
  received: ["Received", "neutral"], processing: ["Reading", "brand"], needs_review: ["In Review", "warn"], needs_input: ["Needs your input", "warn"],
  done: ["Done", "ok"], failed: ["Failed", "bad"], unsupported: ["Not supported", "bad"],
};

export const metadata = { title: "Capture" };

async function Body() {
  const ctx = await requirePageContext();
  const editor = hasRole(ctx, "editor");
  const [recent, docs, options, dash] = await Promise.all([listCaptures(ctx.db, ctx.workspaceId), listDocuments(ctx.db, ctx.workspaceId), editor ? linkOptions(ctx.db, ctx.workspaceId) : null, dashboardCounts(ctx.db, ctx.workspaceId)]);
  return (
    <div className="space-y-4">
      <PageHeader title="Capture" subtitle="Tell CRE OS what happened after a call, meeting or site visit. It files the meeting, creates follow-up tasks and asks before changing any record." />
      <Card title="Capture dashboard">
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <a className="rounded-lg border border-line p-2" href="#new-capture">Type a note</a>
          <a className="rounded-lg border border-line p-2" href="#new-capture">Record a voice note</a>
          <a className="rounded-lg border border-line p-2" href="#add-files">Upload image / business card / document</a>
          <Link className="rounded-lg border border-line p-2" href="/imports">Upload a spreadsheet</Link>
          <a className="rounded-lg border border-line p-2" href="#recording">Upload a permitted recording</a>
          <Link className="rounded-lg border border-line p-2" href="/capture/review">Pending reviews {dash.pending ? <Badge tone="warn">{dash.pending}</Badge> : null}</Link>
          <Link className="rounded-lg border border-line p-2" href="/capture/history">Capture history</Link>
          <span className="rounded-lg border border-line p-2">Processing: {dash.processing} · failed {dash.failed}</span>
        </div>
      </Card>
      {editor ? (
        <Card title="New capture"><div id="new-capture" /><QuickCapture workspaceId={ctx.workspaceId} /></Card>
      ) : (
        <Card><p className="text-sm text-ink-soft">Viewers can read captures but not create them. Ask an admin for editor access.</p></Card>
      )}
      {editor && options ? (
        <Card title="Add files" className="scroll-mt-4" help="Any file in one place. CRE OS works out what it is and sends it to the right reader. Nothing changes a record until you approve it in Review; the original file is always kept.">
          <div id="add-files" /><DropZone workspaceId={ctx.workspaceId} options={options} />
        </Card>
      ) : null}
      {editor && options ? (
        <Card title="Permitted meeting recording" help="Only upload recordings everyone agreed to. The audio is kept, the transcript keeps timestamps, and meeting content goes to the meeting's notes.">
          <div id="recording" /><RecordingForm meetings={options.meeting} />
        </Card>
      ) : null}
      {hasRole(ctx, "admin") ? (
        <Card title="Automation permissions" help="Material record changes and uncertain matches always wait for review, whatever is ticked here.">
          <PermissionsForm p={await loadPermissions(ctx.db, ctx.workspaceId)} />
        </Card>
      ) : null}
      {docs.length ? (
        <Card title="Recent files">
          <ul className="divide-y divide-line">
            {docs.map((d) => {
              const [label, tone] = DOC_STATUS[d.status] ?? [d.status, "neutral"];
              return (
                <li key={d.id} className="py-3">
                  <Link href={`/capture/documents/${d.id}`} className="block space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                      <Badge tone={tone}>{label}</Badge><Badge>{TYPE_LABEL[d.detected_type as DocType] ?? d.detected_type}</Badge><span>{fmt(d.created_at)}</span>
                      {d.result?.proposal_ids?.length ? <Badge tone="brand">{d.result.proposal_ids.length} for approval</Badge> : null}
                    </div>
                    <p className="truncate text-sm">{d.file_name}</p>
                    {d.error ? <p className={`text-xs ${d.status === "failed" || d.status === "unsupported" ? "text-bad" : "text-ink-soft"}`}>{d.error}</p> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
      <Card title="Recent captures">
        {recent.length === 0 ? (
          <EmptyState title="No captures yet">
            Type or dictate what happened after a call or visit — for example <em>“spoke to Raj at Acme; 20k by March; maybe Baner; send options Friday”</em>.
            CRE OS splits it into an interaction, a tentative requirement for approval, a due task and a draft, and asks about anything ambiguous.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((c) => (
              <li key={c.id} className="py-3">
                <Link href={`/capture/${c.id}`} className="block space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                    <StatusBadge status={c.status} />
                    <Badge>{captureKindLabel(c.kind)}</Badge>
                    <span>{fmt(c.source_at)}</span>
                    {c.open ? <Badge tone="warn">{c.open} question{c.open > 1 ? "s" : ""}</Badge> : null}
                    {c.proposals ? <Badge tone="brand">{c.proposals} for approval</Badge> : null}
                    {c.tasks ? <Badge>{c.tasks} task{c.tasks > 1 ? "s" : ""}</Badge> : null}
                  </div>
                  <p className="line-clamp-2 text-sm">{c.preview || <span className="text-ink-soft">(no text — {captureKindLabel(c.kind)})</span>}</p>
                  {c.error ? <p className="text-xs text-bad">{c.error}</p> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Skeleton variant="list" />}><Body /></Suspense>;
}
