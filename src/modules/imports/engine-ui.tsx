/* Input Engine import-dashboard pieces (spec §13C): validation report, layout changes, column mapping, batch runs. Server components. */
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { fmt } from "@/lib/util/time";
import type { RunReport, ValidationReport, LayoutChange } from "./report";
import { SeverityBadge, n } from "./ui";

export function ValidationReportCard({ v }: { v: ValidationReport | undefined }) {
  if (!v) return null;
  const real = v.checks.filter((c) => c.kind !== "duplicate_row" || c.count > 0);
  return (
    <Card title="Validation report" className="mt-4">
      <p className="mb-3 text-sm">
        {n(v.totals.rows_checked)} rows checked · {n(v.totals.rows_with_issues)} with findings ·{" "}
        <span className="text-bad">{n(v.totals.blocking)} blocking</span> · <span className="text-warn">{n(v.totals.review)} to review</span> · {n(v.totals.info)} notes
      </p>
      {real.length === 0 ? <p className="text-sm text-ok">✓ No problems found: emails, phones, dates, areas and company names all look valid.</p> : (
        <ul className="space-y-2">
          {real.map((c) => (
            <li key={c.kind}>
              <details className="rounded-xl border border-line px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm"><SeverityBadge severity={c.severity} /><b>{c.label}</b><span className="text-ink-soft">{n(c.count)}</span></summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {c.samples.map((s, i) => <li key={i}><span className="text-ink-soft">{s.locator}</span> — {s.message}</li>)}
                  {c.count > c.samples.length ? <li className="text-ink-soft">… and {n(c.count - c.samples.length)} more (see “Rows with a problem”).</li> : null}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function LayoutChangesCard({ layout, policy }: { layout: LayoutChange[] | undefined; policy?: string }) {
  if (!layout?.length) return null;
  return (
    <Card title="Column layout changed since the previous version" className="mt-4">
      <ul className="space-y-2 text-sm">
        {layout.map((l) => (
          <li key={l.sheet} className="rounded-xl bg-canvas p-3">
            <div className="font-medium">{l.sheet}{l.sheet_added ? " (new sheet)" : l.sheet_removed ? " (sheet removed)" : ""}</div>
            {l.added.length ? <div><span className="text-ink-soft">Added:</span> {l.added.join(", ")}</div> : null}
            {l.removed.length ? <div className="text-warn"><span className="text-ink-soft">Removed:</span> {l.removed.join(", ")}</div> : null}
            {l.moved.length ? <div><span className="text-ink-soft">Moved:</span> {l.moved.slice(0, 10).map((m) => `${m.header} ${m.from}→${m.to}`).join(", ")}</div> : null}
            {l.remapped.length ? <div><span className="text-ink-soft">Mapping:</span> {l.remapped.map((r) => `${r.field}: ${r.from ?? "—"} → ${r.to ?? "—"}`).join(", ")}</div> : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-soft">Columns are matched by their headers, not their position. {policy ?? ""}</p>
    </Card>
  );
}

export interface ContactsSummary {
  rows?: number; companies_new?: number; companies_linked?: number; people_new?: number; people_linked?: number; contact_methods_new?: number;
  requirement_proposals?: number; requirement_update_proposals?: number; contact_method_proposals?: number; employment_proposals?: number; company_candidates?: number;
}
export function ContactsSummaryLine({ c }: { c: ContactsSummary | undefined }) {
  if (!c?.rows) return null;
  return (
    <p className="mt-2 text-sm">
      Contacts &amp; requirements: {n(c.companies_new)} new / {n(c.companies_linked)} existing companies · {n(c.people_new)} new / {n(c.people_linked)} existing people ·{" "}
      {n((c.requirement_proposals ?? 0) + (c.requirement_update_proposals ?? 0))} requirement proposals · {n((c.contact_method_proposals ?? 0) + (c.employment_proposals ?? 0))} contact updates proposed ·{" "}
      {n(c.company_candidates)} possible duplicate companies. <Link className="underline" href="/approvals?tab=records">Review proposals</Link>
    </p>
  );
}

const RUN_TONE: Record<string, ["neutral" | "brand" | "ok" | "warn" | "bad", string]> = {
  queued: ["neutral", "Queued"], processing: ["brand", "Processing"], completed: ["ok", "Completed"], completed_with_failures: ["warn", "Completed · some failed"],
  failed: ["bad", "Failed"], partial: ["warn", "Partly processed"], duplicate: ["neutral", "Already imported"],
};
export function RunStatus({ status }: { status: string }) {
  const [tone, label] = RUN_TONE[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Progress({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function RunReportGrid({ r }: { r: RunReport }) {
  const tiles: [string, number][] = [
    ["Files received", r.files_received], ["Processed", r.files_processed], ["Partly processed", r.files_partial], ["Failed", r.files_failed],
    ["Records identified", r.records_identified], ["Records created", r.records_created], ["Existing updated / linked", r.records_updated],
    ["Potential duplicates", r.potential_duplicates], ["Conflicts", r.conflicts], ["Need your review", r.needs_review],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {tiles.map(([label, v]) => (
        <div key={label} className="rounded-xl bg-canvas p-3"><div className="text-xl font-bold tabular-nums">{n(v)}</div><div className="text-xs text-ink-soft">{label}</div></div>
      ))}
    </div>
  );
}

export function RunsList({ runs }: { runs: { id: string; label: string | null; status: string; file_count: number; report: RunReport | null; created_at: string }[] }) {
  if (!runs.length) return null;
  return (
    <Card title="Batch uploads">
      <ul className="space-y-3">
        {runs.map((r) => (
          <li key={r.id}>
            <Link href={`/imports/runs/${r.id}`} className="block rounded-xl border border-line p-3 hover:border-brand">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{r.label ?? `${r.file_count} file${r.file_count === 1 ? "" : "s"}`} · <span className="text-ink-soft">{fmt(r.created_at)}</span></div>
                <RunStatus status={r.status} />
              </div>
              {r.report ? (
                <>
                  <div className="mt-2"><Progress value={r.report.progress} /></div>
                  <div className="mt-1 text-xs text-ink-soft">
                    {n(r.report.files_processed)} processed · {n(r.report.files_partial)} partly · {n(r.report.files_failed)} failed · {n(r.report.files_pending)} waiting · {n(r.report.needs_review)} to review
                  </div>
                </>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
