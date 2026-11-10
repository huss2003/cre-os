import Link from "next/link";
import { Suspense } from "react";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { adapterLabel, listBatches, listSources } from "@/modules/imports/service";
import { type Counts, Loading, ReconcileLine, StatusBadge, n } from "@/modules/imports/ui";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Imports" };

async function Body() {
  const ctx = await requirePageContext("editor");
  const [batches, sources] = await Promise.all([listBatches(ctx), listSources(ctx)]);
  const waiting = sources.reduce((a, s) => a + s.waiting, 0);
  return (
    <>
      <div data-tour="imports-header">
      <PageHeader
        title="Imports"
        subtitle="Originals are hashed and kept read-only. Every row is staged with its cell locator, reconciled, and linked to buildings, companies, leases and market series."
      />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="order-2 space-y-3 lg:order-1">
          {batches.length === 0 ? (
            <EmptyState title="No imports yet">
              Upload the asset list, lease-expiry workbooks, transaction trackers or market CSVs. Each file is recognised by its column
              headers (not its name); anything unfamiliar is held for a quick mapping review instead of being guessed. Uploading the same
              file twice changes nothing.
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {batches.map((b) => {
                const c = (b.counts ?? {}) as Counts;
                const so = (Array.isArray(b.source_object) ? b.source_object[0] : b.source_object) as { version?: number; sha256?: string } | null;
                return (
                  <li key={b.id}>
                    <Link href={`/imports/${b.id}`} className="block rounded-xl border border-line bg-surface p-4 shadow-sm hover:border-brand">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{b.file_name}</div>
                          <div className="text-xs text-ink-soft">
                            v{so?.version ?? 1} · {String(so?.sha256 ?? "").slice(0, 10)} · {fmt(b.created_at)} · {adapterLabel(b.adapter)}
                          </div>
                        </div>
                        <StatusBadge status={b.status} />
                      </div>
                      <div className="mt-2 text-sm"><ReconcileLine c={c} /></div>
                      {c.rows_considered !== undefined ? (
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
                          <span>Duplicates {n(c.duplicates)}</span>
                          <span>New masters {n(Object.values(c.masters ?? {}).reduce((a, m) => a + m.new, 0))}</span>
                          <span>Linked to existing {n(Object.values(c.masters ?? {}).reduce((a, m) => a + m.existing_linked, 0))}</span>
                          <span>Open review items {n(c.exceptions)}</span>
                          {b.diff ? <span>Changed vs previous {n((b.diff as { changed?: number }).changed)}</span> : null}
                        </div>
                      ) : null}
                      {b.error ? <p className="mt-2 text-xs text-bad">{b.error}</p> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="order-1 lg:order-2">
          <div data-tour="imports-upload"><Card title="Upload" actions={<Link className="text-sm text-brand" href="/imports/sources">Sources{waiting ? ` (${waiting} waiting)` : ""}</Link>}>
            <UploadForm sources={sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, approved: s.approved, is_default: s.is_default }))} />
          </Card></div>
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Body /></Suspense>;
}
