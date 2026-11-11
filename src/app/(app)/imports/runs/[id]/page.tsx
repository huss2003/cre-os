import { isLegacyOfficeName, LEGACY_FORMAT_NOTE } from "@/modules/capture/input-engine/office";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Button, ButtonLink, Card, PageHeader, StaleBanner } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { importRunDetail } from "@/modules/imports/service";
import { Progress, RunReportGrid, RunStatus } from "@/modules/imports/engine-ui";
import { AutoRefresh } from "@/modules/imports/auto-refresh";
import { runIsActive } from "@/modules/imports/report";
import { Loading, n } from "@/modules/imports/ui";
import { retryRunAction } from "../../actions";

export const metadata = { title: "Batch upload" };
type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

const KIND: Record<string, string> = { spreadsheet: "Spreadsheet", document: "Document / image", unsupported: "Not supported" };

async function Body({ params, searchParams }: { params: Params; searchParams: SP }) {
  const ctx = await requirePageContext("editor");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await importRunDetail(ctx, id);
  if (!d) notFound();
  const r = d.run.report;
  const retryable = r.failed_files.filter((f) => f.retryable).length;
  return (
    <>
      <AutoRefresh active={runIsActive(r, d.items)} />
      <PageHeader
        title={d.run.label ?? `Batch of ${d.run.file_count} file${d.run.file_count === 1 ? "" : "s"}`}
        subtitle={<>Started {fmt(d.run.created_at)}{d.run.finished_at ? ` · finished ${fmt(d.run.finished_at)}` : ""}</>}
        actions={<><RunStatus status={d.run.status} /><ButtonLink variant="ghost" href="/imports">All imports</ButtonLink></>}
      />
      {typeof sp.error === "string" ? <StaleBanner>{sp.error}</StaleBanner> : null}
      {runIsActive(r, d.items) ? <StaleBanner>Processing in the background — you can keep using CRE OS; this page updates by itself. Numbers below are partial.</StaleBanner> : null}
      <Card title={r.done ? "Completion report" : "Progress"}>
        <div className="mb-3"><Progress value={r.progress} /><p className="mt-1 text-xs text-ink-soft">{Math.round(r.progress * 100)}% · {n(r.files_pending)} waiting</p></div>
        <RunReportGrid r={r} />
        {retryable ? (
          <form action={retryRunAction} className="mt-3">
            <input type="hidden" name="run_id" value={d.run.id} />
            <Button type="submit" variant="secondary">Retry {retryable} failed file{retryable > 1 ? "s" : ""}</Button>
          </form>
        ) : null}
      </Card>
      <Card title="Files" className="mt-4">
        <ul className="divide-y divide-line">
          {d.items.map((i) => (
            <li key={i.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{i.file_name}</div>
                  <div className="text-xs text-ink-soft">{KIND[i.kind] ?? i.kind}{i.size_bytes ? ` · ${n(Math.ceil(i.size_bytes / 1024))} KB` : ""}{i.attempts ? ` · retried ${i.attempts}×` : ""}</div>
                </div>
                <RunStatus status={i.live_status} />
              </div>
              {i.live_status === "failed" && i.error ? (
                <p className="mt-1 text-xs text-bad">{i.error}{i.error_kind === "temporary" ? " (temporary — can be retried)" : ""}</p>
              ) : null}
              {isLegacyOfficeName(i.file_name) && i.live_status !== "failed" ? <p className="mt-1 text-xs text-warn">{LEGACY_FORMAT_NOTE}. The original is kept; text is read best effort.</p> : null}
              <div className="mt-1 flex flex-wrap gap-3 text-sm">
                {i.batch_id ? <Link className="text-brand" href={`/imports/${i.batch_id}`}>Open import report →</Link> : null}
                {i.capture_id ? <Link className="text-brand" href={`/capture/${i.capture_id}`}>Open extraction review →</Link> : null}
                {i.live_status === "failed" && i.error_kind === "temporary" && i.batch_id ? (
                  <form action={retryRunAction}><input type="hidden" name="run_id" value={d.run.id} /><input type="hidden" name="item_id" value={i.id} /><button className="text-brand underline" type="submit">Retry this file</button></form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-soft">Every file is processed on its own: one failing file never undoes another file’s results. Duplicate files are recognised by content and not imported twice.</p>
      </Card>
    </>
  );
}

export default function Page({ params, searchParams }: { params: Params; searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body params={params} searchParams={searchParams} /></Suspense>;
}
