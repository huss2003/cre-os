import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, Field, Textarea, Select } from "@/components/ui";
import { strategyFor, negotiationHistory } from "@/modules/intelligence/strategy/service";
import { Flash, Disclaimer, Sev, fmtDay, label } from "@/modules/intelligence/ui";
import { strategyAction } from "../../actions";

export default async function DealStrategyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  let s: Awaited<ReturnType<typeof strategyFor>>;
  try { s = await strategyFor(ctx.db, ctx.workspaceId, id); } catch { notFound(); }
  const hist = await negotiationHistory(ctx.db, ctx.workspaceId, id);
  const h = s.health;

  return (
    <div>
      <PageHeader title={s.context.opportunity.name} subtitle={<><Link className="text-brand" href="/insights">Insights</Link> · deal strategist · <Badge>{label(s.context.opportunity.stage)}</Badge> · <Link className="text-brand" href={`/deals/${id}`}>open deal</Link></>}
        actions={canEdit ? <form action={strategyAction}><input type="hidden" name="opportunity_id" value={id} /><Button variant="secondary" name="op" value="snapshot">Save snapshot</Button></form> : null} />
      <Disclaimer>{s.disclaimer}</Disclaimer>
      <Flash sp={sp} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={<span>Deal health <Badge tone={h.band === "healthy" ? "ok" : h.band === "watch" ? "warn" : "bad"}>{h.score}/{h.max} · {label(h.band)}</Badge></span>}>
          <ul className="space-y-1 text-sm">{h.factors.map((f) => <li key={f.key}><span className="font-medium">{f.label}</span> {f.points}/{f.max} <span className="text-xs text-ink-soft">— {f.detail}</span></li>)}</ul>
          <p className="mt-2 text-xs text-ink-soft">Transparent rule points, not a prediction.</p>
        </Card>
        <Card title={`Risks (${s.risks.length})`}>
          {s.risks.length === 0 ? <p className="text-sm text-ink-soft">No rule-detected risks.</p> : <ul className="space-y-1 text-sm">{s.risks.map((r) => <li key={r.key}><Sev s={r.severity} /> {r.detail}</li>)}</ul>}
        </Card>
        <Card title={`Stakeholder gaps (${s.gaps.length})`}>
          {s.gaps.length === 0 ? <p className="text-sm text-ink-soft">No gaps detected.</p> : <ul className="space-y-1 text-sm">{s.gaps.map((g) => <li key={g.kind}><Sev s={g.severity} /> {g.detail}</li>)}</ul>}
        </Card>
        <Card title="BATNA questions to ask">
          <ul className="list-disc space-y-1 pl-5 text-sm">{s.batna_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </Card>
      </div>

      <Card title="Concession ladder" className="mt-4">
        <p className="mb-2 text-xs text-ink-soft">Ordered suggestions. Values are compared in the finance scenarios — never estimated here.</p>
        {hist.concessions.length > 0 ? (
          <ul className="divide-y divide-line">{hist.concessions.map((c) => (
            <li key={String(c.id)} className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div><span className="font-medium">{String(c.rank)}. {String(c.ask)}</span>{c.give ? <div className="text-xs text-ink-soft">Possible give: {String(c.give)}</div> : null}<div className="text-xs text-ink-soft">{String(c.value_basis)}</div></div>
              {canEdit ? (
                <form action={strategyAction} className="flex gap-2"><input type="hidden" name="opportunity_id" value={id} /><input type="hidden" name="op" value="concession" /><input type="hidden" name="item_id" value={String(c.id)} /><input type="hidden" name="row_version" value={String(c.row_version)} />
                  <Select name="status" defaultValue={String(c.status)}>{["proposed", "offered", "accepted", "rejected", "withdrawn"].map((x) => <option key={x} value={x}>{x}</option>)}</Select><Button variant="secondary">Set</Button></form>
              ) : <Badge>{String(c.status)}</Badge>}
            </li>
          ))}</ul>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-sm">{s.concession_ladder.map((c) => <li key={c.rank}>{c.ask}{c.give ? <span className="text-xs text-ink-soft"> — give: {c.give}</span> : null}</li>)}</ol>
        )}
      </Card>

      <Card title="Negotiation log" className="mt-4">
        {canEdit && (
          <form action={strategyAction} className="mb-3 space-y-2"><input type="hidden" name="opportunity_id" value={id} /><input type="hidden" name="op" value="note" />
            <Field label="Note"><Textarea name="note" required maxLength={4000} placeholder="What was offered, by whom, and what changed" /></Field><Button variant="secondary">Add note</Button></form>
        )}
        {hist.log.length === 0 ? <p className="text-sm text-ink-soft">Nothing logged yet.</p> : (
          <ul className="space-y-1 text-sm">{hist.log.map((l) => <li key={String(l.id)}><Badge>{label(String(l.kind))}</Badge> <span className="text-xs text-ink-soft">{fmtDay(String(l.created_at))} · {String(l.generated_by)}</span>{l.kind === "note" ? <div>{String((l.content as { text?: string }).text ?? "")}</div> : null}</li>)}</ul>
        )}
      </Card>
    </div>
  );
}
