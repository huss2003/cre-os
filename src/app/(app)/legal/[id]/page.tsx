import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { PageHeader, Card, Badge, EmptyState, StaleBanner } from "@/components/ui";
import { legalDocument } from "@/modules/intelligence/legal/queries";
import { exposureChecklist, CLAUSE_LABEL, type ExtractedClause, type ClauseType } from "@/modules/intelligence/legal/clauses";
import { LEGAL_DISCLAIMER } from "@/modules/intelligence/common";
import { Flash, Disclaimer, Sev, label } from "@/modules/intelligence/ui";

export default async function LegalDocPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  const { doc, clauses, comparisons } = await legalDocument(ctx.db, ctx.workspaceId, id);
  if (!doc) notFound();
  const checklist = exposureChecklist(clauses as unknown as ExtractedClause[]);

  return (
    <div>
      <PageHeader title={`${String(doc.title)} · v${String(doc.version)}`} subtitle={<><Link className="text-brand" href="/legal">Legal desk</Link> · {label(String(doc.doc_kind))} · {String(doc.family_key)}</>} />
      <Disclaimer>{LEGAL_DISCLAIMER}</Disclaimer>
      <Flash sp={sp} />
      {doc.ocr_unverified ? <StaleBanner>OCR text — every clause must be checked against the scanned original before use.</StaleBanner> : null}
      {comparisons.length > 0 && <p className="mb-3 text-sm">Redlines: {comparisons.map((c, i) => <span key={String(c.id)}>{i ? ", " : ""}<Link className="text-brand" href={`/legal/compare/${c.id}`}>comparison {i + 1}</Link></span>)}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={`Extracted clauses (${clauses.length})`}>
          {clauses.length === 0 ? <EmptyState title="No clauses recognised">Headings like “Rent”, “Lock-in”, “Security Deposit” or numbered clauses help the extractor.</EmptyState> : (
            <ul className="space-y-3">
              {clauses.map((c) => {
                const loc = (c.locator ?? {}) as Record<string, unknown>;
                return (
                  <li key={String(c.id)} className="rounded-lg border border-line p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-1"><Badge tone="brand">{CLAUSE_LABEL[c.clause_type as ClauseType] ?? String(c.clause_type)}</Badge>{c.heading ? <span className="font-medium">{String(c.heading)}</span> : null}
                      <span className="text-xs text-ink-soft">lines {String(loc.line_start)}–{String(loc.line_end)}{loc.page ? ` · p.${String(loc.page)}` : ""} · {String(c.extraction_method)}</span>{c.needs_review ? <Badge tone="warn">needs review</Badge> : null}</div>
                    <p className="mt-1 whitespace-pre-wrap break-words">{String(c.clause_text)}</p>
                    {Object.keys((c.extracted_values ?? {}) as object).length > 0 && <p className="mt-1 break-words text-xs text-ink-soft">Parsed: {Object.entries(c.extracted_values as Record<string, unknown>).map(([k, v]) => `${label(k)} ${JSON.stringify(v)}`).join(" · ")}</p>}
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
                <div className="flex flex-wrap items-center gap-1"><Sev s={it.severity} /><Badge>{CLAUSE_LABEL[it.clause_type]}</Badge><Badge tone="accent">pending legal review</Badge></div>
                <p className="mt-1">{it.exposure}</p>
                <p className="text-xs text-ink-soft"><span className="font-medium">Ask:</span> {it.question}</p>
                <p className="text-xs text-ink-soft"><span className="font-medium">Possible alternative:</span> {it.alternative}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <details className="mt-4 rounded-xl border border-line bg-surface p-3"><summary className="cursor-pointer text-sm font-medium">Source text</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{String(doc.text_content)}</pre></details>
    </div>
  );
}
