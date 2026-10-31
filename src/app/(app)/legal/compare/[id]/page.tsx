import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { PageHeader, Card, Badge } from "@/components/ui";
import { clauseComparison } from "@/modules/intelligence/legal/queries";
import { CLAUSE_LABEL, type ClauseDiff, type ExposureItem } from "@/modules/intelligence/legal/clauses";
import { Flash, Disclaimer, Sev } from "@/modules/intelligence/ui";

export default async function ComparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  const r = await clauseComparison(ctx.db, ctx.workspaceId, id);
  if (!r) notFound();
  const diff = (r.cmp.diff ?? []) as ClauseDiff[];
  const items = (r.cmp.exposure_checklist ?? []) as ExposureItem[];
  const name = (docId: unknown) => { const d = r.docs.find((x) => x.id === docId); return d ? `${String(d.title)} v${String(d.version)}` : "(restricted)"; };

  return (
    <div>
      <PageHeader title="Redline" subtitle={<><Link className="text-brand" href="/legal">Legal desk</Link> · <Link className="text-brand" href={`/legal/${r.cmp.base_document_id}`}>{name(r.cmp.base_document_id)}</Link> → <Link className="text-brand" href={`/legal/${r.cmp.compare_document_id}`}>{name(r.cmp.compare_document_id)}</Link></>} />
      <Disclaimer>{String(r.cmp.disclaimer)} Status: {String(r.cmp.reviewer_status).replace(/_/g, " ")}.</Disclaimer>
      <Flash sp={sp} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Clause changes">
          <ul className="space-y-3">
            {diff.map((d) => (
              <li key={d.clause_type} className="text-sm">
                <div className="flex items-center gap-1"><Badge tone="brand">{CLAUSE_LABEL[d.clause_type]}</Badge><Badge tone={d.change === "unchanged" ? "neutral" : d.change === "changed" ? "warn" : "bad"}>{d.change}</Badge></div>
                {d.change !== "unchanged" && <p className="mt-1 whitespace-pre-wrap break-words">{d.ops.map((o, i) => o.op === "eq" ? <span key={i}>{o.text}</span> : o.op === "del" ? <del key={i} className="bg-bad/10 text-bad">{o.text}</del> : <ins key={i} className="bg-ok/10 text-ok no-underline">{o.text}</ins>)}</p>}
                {d.value_changes.length > 0 && <p className="text-xs text-ink-soft">{d.value_changes.map((v) => `${v.key}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join(" · ")}</p>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`Exposure checklist (${items.length})`}>
          <ul className="space-y-3">
            {items.map((it, i) => (
              <li key={i} className="text-sm"><div className="flex flex-wrap gap-1"><Sev s={it.severity} /><Badge>{CLAUSE_LABEL[it.clause_type]}</Badge></div>
                <p className="mt-1">{it.exposure}</p><p className="text-xs text-ink-soft"><span className="font-medium">Ask:</span> {it.question}</p><p className="text-xs text-ink-soft"><span className="font-medium">Possible alternative:</span> {it.alternative}</p></li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
