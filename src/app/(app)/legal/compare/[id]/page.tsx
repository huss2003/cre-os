import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { PageHeader, Card, Badge, StaleBanner } from "@/components/ui";
import { clauseComparison } from "@/modules/intelligence/legal/queries";
import { CLAUSE_LABEL, locatorLabel, type ClauseDiff, type ExposureItem, type DocumentRedline, type Locator, type WordOp } from "@/modules/intelligence/legal/clauses";
import { Flash, Disclaimer, Sev } from "@/modules/intelligence/ui";

function Ops({ ops }: { ops: WordOp[] }) {
  return <>{ops.map((o, i) => o.op === "eq" ? <span key={i}>{o.text}</span> : o.op === "del" ? <del key={i} className="bg-bad/10 text-bad">{o.text}</del> : <ins key={i} className="bg-ok/10 text-ok no-underline">{o.text}</ins>)}</>;
}

export default async function ComparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  const r = await clauseComparison(ctx.db, ctx.workspaceId, id);
  if (!r) notFound();
  const diff = (r.cmp.diff ?? []) as ClauseDiff[];
  const items = (r.cmp.exposure_checklist ?? []) as ExposureItem[];
  const full = (r.cmp.full_redline ?? {}) as Partial<DocumentRedline>;
  const bv = r.cmp.base_version ?? r.docs.find((d) => d.id === r.cmp.base_document_id)?.version;
  const nv = r.cmp.compare_version ?? r.docs.find((d) => d.id === r.cmp.compare_document_id)?.version;
  const name = (docId: unknown) => { const d = r.docs.find((x) => x.id === docId); return d ? `${String(d.title)} v${String(d.version)}` : "(restricted)"; };
  const locs = (ls: Locator[] | undefined, one: Locator | null, v: unknown) => (ls && ls.length ? ls : one ? [one] : []).map((l) => locatorLabel(l, v as number)).join("; ");

  return (
    <div>
      <PageHeader title={`Redline v${String(bv)} → v${String(nv)}`} subtitle={<><Link className="text-brand" href="/legal">Legal desk</Link> · <Link className="text-brand" href={`/legal/${r.cmp.base_document_id}`}>{name(r.cmp.base_document_id)}</Link> → <Link className="text-brand" href={`/legal/${r.cmp.compare_document_id}`}>{name(r.cmp.compare_document_id)}</Link></>} />
      <Disclaimer>{String(r.cmp.disclaimer)} Status: {String(r.cmp.reviewer_status).replace(/_/g, " ")}. A redline is not legal approval; CRE OS never signs.</Disclaimer>
      <Flash sp={sp} />
      {r.cmp.same_family === false && <StaleBanner>Cross-family comparison (confirmed by a user): these are different documents, so many differences are expected.</StaleBanner>}
      {r.docs.some((d) => d.ocr_unverified) && <StaleBanner>At least one version is OCR / partial text — verify every finding against the original.</StaleBanner>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Clause changes">
          <ul className="space-y-3">
            {diff.map((d) => (
              <li key={d.clause_type} className="text-sm">
                <div className="flex flex-wrap items-center gap-1"><Badge tone="brand">{CLAUSE_LABEL[d.clause_type] ?? d.clause_type}</Badge><Badge tone={d.change === "unchanged" ? "neutral" : d.change === "changed" ? "warn" : "bad"}>{d.change}</Badge></div>
                <p className="text-xs text-ink-soft">{d.base_locator ? `Was: ${locs(d.base_locators, d.base_locator, bv)}` : `Not in v${String(bv)}`} · {d.new_locator ? `Now: ${locs(d.new_locators, d.new_locator, nv)}` : `Not in v${String(nv)}`}</p>
                {d.change !== "unchanged" && <p className="mt-1 whitespace-pre-wrap break-words"><Ops ops={d.ops} /></p>}
                {d.value_changes.length > 0 && <p className="text-xs text-ink-soft">{d.value_changes.map((v) => `${v.key}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join(" · ")}</p>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`Exposure checklist (${items.length})`}>
          <ul className="space-y-3">
            {items.map((it, i) => (
              <li key={i} className="text-sm"><div className="flex flex-wrap gap-1"><Sev s={it.severity} /><Badge>{CLAUSE_LABEL[it.clause_type] ?? it.clause_type}</Badge><Badge tone="accent">pending legal review</Badge>{it.certainty === "not_found" ? <Badge tone="warn">not found</Badge> : null}</div>
                <p className="text-xs text-ink-soft">
                  {it.locator ? `${it.document ? `${it.document.title} ` : ""}${locatorLabel(it.locator, it.document?.version ?? (nv as number))}` : it.base_locator ? "" : `Not found in v${String(nv)}`}
                  {it.base_locator ? `${it.locator ? " · " : ""}was ${locatorLabel(it.base_locator, it.base_document?.version ?? (bv as number))}` : ""}
                </p>
                <p className="mt-1">{it.exposure}</p><p className="text-xs text-ink-soft"><span className="font-medium">Ask:</span> {it.question}</p><p className="text-xs text-ink-soft"><span className="font-medium">Possible alternative wording for the legal team:</span> {it.alternative}</p></li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Full-document redline" className="mt-4">
        {!full.hunks ? <p className="text-sm text-ink-soft">This comparison was built before full-document redlines existed — compare the versions again to get one.</p> : full.hunks.length === 0 ? <p className="text-sm text-ink-soft">The two texts are identical line-for-line.</p> : (
          <>
            <p className="mb-2 text-xs text-ink-soft">{full.stats?.removed ?? 0} line(s) removed · {full.stats?.added ?? 0} added · {full.stats?.unchanged ?? 0} unchanged.{full.coarse ? " Large change: shown as block replace." : ""}{full.truncated ? " Truncated — open both versions for the rest." : ""}</p>
            <div className="space-y-3 overflow-x-auto">
              {full.hunks.map((h, i) => (
                <div key={i} className="rounded border border-line">
                  <div className="bg-canvas px-2 py-1 text-xs text-ink-soft">v{String(bv)} line {h.base_start || "—"} · v{String(nv)} line {h.new_start || "—"}</div>
                  <ol className="font-mono text-xs">
                    {h.lines.map((l, k) => (
                      <li key={k} className={`grid grid-cols-[2.5rem_2.5rem_1fr] gap-1 px-1 ${l.op === "del" ? "bg-bad/5" : l.op === "ins" ? "bg-ok/5" : ""}`}>
                        <span className="text-right text-ink-soft" title={l.base_page ? `v${String(bv)} p.${l.base_page}` : undefined}>{l.base_line ?? ""}</span>
                        <span className="text-right text-ink-soft" title={l.new_page ? `v${String(nv)} p.${l.new_page}` : undefined}>{l.new_line ?? ""}</span>
                        <span className="whitespace-pre-wrap break-words">{l.op === "del" ? "− " : l.op === "ins" ? "+ " : "  "}{l.ops ? <Ops ops={l.ops} /> : l.op === "del" ? <del className="text-bad">{l.text}</del> : l.op === "ins" ? <ins className="text-ok no-underline">{l.text}</ins> : l.text}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
