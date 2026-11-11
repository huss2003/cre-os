import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { PageHeader, Card, Badge, EmptyState, StaleBanner } from "@/components/ui";
import { legalDocument } from "@/modules/intelligence/legal/queries";
import { exposureChecklist, locatorLabel, CLAUSE_LABEL, type ExtractedClause, type ClauseType, type Locator, type ClauseValidation } from "@/modules/intelligence/legal/clauses";
import { LEGAL_DISCLAIMER } from "@/modules/intelligence/common";
import { Flash, Disclaimer, Sev, label } from "@/modules/intelligence/ui";

const VALUE_WORDS: Record<string, string> = { per_sf: "per sq ft", per_sqft: "per sq ft", per_seat: "per seat", per_month: "per month", lump_sum: "lump sum" };
/** "36", "true" -> "yes", objects as k v; null/blank values are skipped (unknown, not "null"). */
function parsedValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return VALUE_WORDS[v] ?? (/^[a-z]+(_[a-z]+)+$/.test(v) ? v.replace(/_/g, " ") : v);
  if (Array.isArray(v)) { const xs = v.map(parsedValue).filter(Boolean); return xs.length ? xs.join(", ") : null; }
  return JSON.stringify(v);
}
function parsedSummary(values: Record<string, unknown>): string {
  return Object.entries(values).flatMap(([k, v]) => { const s = parsedValue(v); return s === null ? [] : [`${label(k)} ${s}`]; }).join(" · ");
}
/** PDF text can glue a page footer to the sentence ("notice.Page 3"); put the space back. */
const spacePageMarkers = (s: string) => s.replace(/([^\s])(Page \d+)/g, "$1 $2");

export default async function LegalDocPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  const { doc, clauses, comparisons } = await legalDocument(ctx.db, ctx.workspaceId, id);
  if (!doc) notFound();
  const version = Number(doc.version);
  const checklist = exposureChecklist(clauses as unknown as ExtractedClause[], undefined, { document: { id, title: String(doc.title), version }, ocrUnverified: !!doc.ocr_unverified });
  const notes = Array.isArray(doc.extraction_notes) ? (doc.extraction_notes as string[]) : [];

  return (
    <div>
      <PageHeader title={`${String(doc.title)} · v${version}`} subtitle={<><Link className="text-brand" href="/legal">Legal desk</Link> · {label(String(doc.doc_kind))} · family {String(doc.family_key)} · {String(doc.file_kind ?? "text").toUpperCase()}{doc.page_count ? ` · ${String(doc.page_count)} pages` : ""}{doc.source_object_id ? <> · <a className="text-brand" href={`/api/v1/legal/documents/${id}/file`} target="_blank" rel="noopener noreferrer">open original</a></> : " · pasted text"}</>} />
      <Disclaimer>{LEGAL_DISCLAIMER} CRE OS never signs documents; legal approval happens outside the tool.</Disclaimer>
      <Flash sp={sp} />
      {doc.ocr_status === "ocr_needed" ? <StaleBanner>No text layer — this looks like a scanned document. OCR is needed: no clauses were extracted. Add a text PDF/DOCX or paste verified OCR text as the next version.</StaleBanner>
        : doc.ocr_unverified ? <StaleBanner>OCR / partial text — every clause must be checked against the original before use.</StaleBanner> : null}
      <p className="mb-3 text-xs text-ink-soft">Related: {doc.lease_id ? "lease ✓" : "no lease"} · {doc.org_id ? "company ✓" : "no company"} · {doc.asset_id ? "building ✓" : "no building"}{!doc.org_id || !doc.asset_id ? " — Lease Radar can only use these clauses when company and building are set (choose them on the next upload)." : ""}</p>
      {notes.length > 0 && <ul className="mb-3 list-disc pl-5 text-xs text-ink-soft">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {comparisons.length > 0 && <p className="mb-3 text-sm">Redlines: {comparisons.map((c, i) => <span key={String(c.id)}>{i ? ", " : ""}<Link className="text-brand" href={`/legal/compare/${c.id}`}>v{String(c.base_version ?? "?")} → v{String(c.compare_version ?? "?")}{c.same_family === false ? " (cross-family)" : ""}</Link></span>)}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={`Extracted clauses (${clauses.length})`}>
          {clauses.length === 0 ? <EmptyState title="No clauses recognised">{doc.ocr_status === "ocr_needed" ? "Text is needed first (see above)." : "Headings like “Rent”, “Lock-in”, “Security Deposit” or numbered clauses help the extractor."}</EmptyState> : (
            <ul className="space-y-3">
              {clauses.map((c) => {
                const val = (c.validation ?? {}) as Partial<ClauseValidation>;
                return (
                  <li key={String(c.id)} className="rounded-lg border border-line p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-1"><Badge tone="brand">{CLAUSE_LABEL[c.clause_type as ClauseType] ?? String(c.clause_type)}</Badge>{c.heading ? <span className="font-medium">{String(c.heading)}</span> : null}
                      <span className="text-xs text-ink-soft">{locatorLabel(c.locator as Locator, version)} · {String(c.extraction_method)}</span>{c.needs_review ? <Badge tone="warn">needs review</Badge> : null}
                      {val.status === "values_corrected" ? <Badge tone="warn" title="Model values were re-checked against the clause wording">values corrected</Badge> : val.status === "verified" ? <Badge tone="ok">verified vs source</Badge> : null}</div>
                    <p className="mt-1 whitespace-pre-wrap break-words">{spacePageMarkers(String(c.clause_text))}</p>
                    {parsedSummary((c.extracted_values ?? {}) as Record<string, unknown>) && <p className="mt-1 break-words text-xs text-ink-soft">Parsed from the wording: {parsedSummary(c.extracted_values as Record<string, unknown>)}</p>}
                    {(val.dropped?.length ?? 0) > 0 && <p className="text-xs text-bad">Dropped (not in the wording): {val.dropped!.map((d) => d.key).join(", ")}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card title={`Exposure checklist (${checklist.length})`}>
          <ul className="space-y-3">
            {checklist.map((it, i) => (
              <li key={i} className="text-sm">
                <div className="flex flex-wrap items-center gap-1"><Sev s={it.severity} /><Badge>{CLAUSE_LABEL[it.clause_type]}</Badge><Badge tone="accent">pending legal review</Badge>
                  {it.certainty === "not_found" ? <Badge tone="warn">not found in v{version}</Badge> : it.certainty === "ocr_unverified" ? <Badge tone="warn">OCR — verify</Badge> : null}</div>
                {it.locator && <p className="text-xs text-ink-soft">{String(doc.title)} · {locatorLabel(it.locator, it.document?.version ?? version)}</p>}
                <p className="mt-1">{it.exposure}</p>
                <p className="text-xs text-ink-soft"><span className="font-medium">Ask:</span> {it.question}</p>
                <p className="text-xs text-ink-soft"><span className="font-medium">Possible alternative wording for the legal team:</span> {it.alternative}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <details className="mt-4 rounded-xl border border-line bg-surface p-3"><summary className="cursor-pointer text-sm font-medium">Extracted text (v{version}) with line numbers</summary>
        <ol className="mt-2 max-h-96 overflow-auto font-mono text-xs">{String(doc.text_content ?? "").split("\n").map((l, i) => <li key={i} className="grid grid-cols-[3rem_1fr] gap-2"><span className="select-none text-right text-ink-soft">{i + 1}</span><span className="whitespace-pre-wrap break-words">{l.includes("\f") ? `— page break —${l.replace(/\f/g, "")}` : l}</span></li>)}</ol>
      </details>
    </div>
  );
}
