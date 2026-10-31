import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, Field, Textarea, Select, inr } from "@/components/ui";
import { strategyFor, negotiationHistory } from "@/modules/intelligence/strategy/service";
import { normaliseObjections } from "@/modules/intelligence/strategy/strategist";
import { Basis } from "@/modules/intelligence/strategy/ui";
import { Flash, Disclaimer, Sev, fmtDay, label } from "@/modules/intelligence/ui";
import { strategyAction } from "../../actions";

type Row = Record<string, unknown>;

export default async function DealStrategyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  let s: Awaited<ReturnType<typeof strategyFor>>;
  try { s = await strategyFor(ctx.db, ctx.workspaceId, id); } catch { notFound(); }
  const hist = await negotiationHistory(ctx.db, ctx.workspaceId, id);
  const h = s.health;
  const objections = normaliseObjections(s.context);

  return (
    <div>
      <PageHeader title={s.context.opportunity.name} subtitle={<><Link className="text-brand" href="/insights">Insights</Link> · deal strategist · <Badge>{label(s.context.opportunity.stage)}</Badge> · <Link className="text-brand" href={`/deals/${id}`}>open deal</Link></>}
        actions={canEdit ? <form action={strategyAction}><input type="hidden" name="opportunity_id" value={id} /><Button variant="secondary" name="op" value="snapshot">Save snapshot</Button></form> : null} />
      <Disclaimer>{s.disclaimer} Nothing here is sent, offered or committed, and no stage is moved — you decide and act.</Disclaimer>
      <Flash sp={sp} />
      <p className="mb-3 text-xs text-ink-soft">Refreshes automatically (as a background snapshot) when the stage changes, a quote is revised or an objection is logged.</p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={<span>Deal health <Badge tone={h.band === "healthy" ? "ok" : h.band === "watch" ? "warn" : "bad"}>{h.score}/{h.max} · {label(h.band)}</Badge></span>}>
          <ul className="space-y-1.5 text-sm">{h.factors.map((f) => <li key={f.key}><span className="font-medium">{f.label}</span> {f.points}/{f.max} <span className="text-xs text-ink-soft">— {f.detail}</span><Basis basis={f.basis} oppId={id} /></li>)}</ul>
          <p className="mt-2 text-xs text-ink-soft">Transparent rule points, not a prediction.</p>
        </Card>
        <Card title={`Risks (${s.risks.length})`}>
          {s.risks.length === 0 ? <p className="text-sm text-ink-soft">No rule-detected risks.</p> : <ul className="space-y-1.5 text-sm">{s.risks.map((r) => <li key={r.key}><Sev s={r.severity} /> {r.detail}<Basis basis={r.basis} assumptions={r.assumptions} oppId={id} /></li>)}</ul>}
        </Card>
        <Card title={`Stakeholder gaps (${s.gaps.length})`}>
          {s.gaps.length === 0 ? <p className="text-sm text-ink-soft">No gaps detected.</p> : <ul className="space-y-1 text-sm">{s.gaps.map((g) => <li key={g.kind}><Sev s={g.severity} /> {g.detail}</li>)}</ul>}
        </Card>
        <Card title={`Evidence gaps (${s.evidence_gaps.length})`}>
          {s.evidence_gaps.length === 0 ? <p className="text-sm text-ink-soft">No unsupported claims, stale quotes or unverified availability found.</p> : <ul className="space-y-1.5 text-sm">{s.evidence_gaps.map((g) => <li key={g.key}><Sev s={g.severity} /> {g.detail}<Basis basis={g.basis} oppId={id} /></li>)}</ul>}
        </Card>
        <Card title="BATNA questions to ask" className="lg:col-span-2">
          <ul className="list-disc space-y-1.5 pl-5 text-sm">{s.batna_questions.map((q, i) => <li key={i}>{q.text}<Basis basis={q.basis} assumptions={q.assumptions} oppId={id} /></li>)}</ul>
        </Card>
        <Card title={`Objections on record (${objections.length})`} className="lg:col-span-2">
          {objections.length === 0 ? <p className="text-sm text-ink-soft">None logged. Log objections on the <Link className="text-brand" href={`/deals/${id}`}>deal</Link> — the strategist re-runs when you do.</p> : (
            <ul className="space-y-1 text-sm">{objections.map((o, i) => <li key={`${o.id}-${i}`}><Badge>{o.category ?? (o.source === "interaction" ? "from interaction" : "other")}</Badge> {o.text} <span className="text-xs text-ink-soft">{o.raised_on ?? ""}{o.outcome ? ` · ${label(o.outcome)}` : ""}</span></li>)}</ul>
          )}
        </Card>
      </div>

      <Card title="Concession ladder" className="mt-4">
        <p className="mb-2 text-xs text-ink-soft">Ordered from this deal&apos;s quote terms and objections. Values come from the finance concession-equivalence engine — never estimated here. You decide what (if anything) to offer.</p>
        {hist.concessions.length > 0 ? (
          <ul className="divide-y divide-line">{hist.concessions.map((c) => {
            const v = (c.value_json ?? {}) as Row;
            return (
              <li key={String(c.id)} className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <span className="font-medium">{String(c.step_no)}. {String(c.ask ?? "")}</span> <Badge>{label(String(c.concession_type))}</Badge>
                  {c.give ? <div className="text-xs text-ink-soft">Possible give: {String(c.give)}</div> : null}
                  <div className="text-xs text-ink-soft">{c.npv_equivalent !== null && c.npv_equivalent !== undefined ? <>NPV equivalent {inr(c.npv_equivalent as string)} ({String(c.engine_version ?? "finance engine")})</> : String(v.value_basis ?? "Compare in a finance scenario before offering.")}{c.within_approved_bounds === false ? <> · <Badge tone="bad">outside approved bounds</Badge></> : null}</div>
                  <Basis basis={Array.isArray(v.basis) ? (v.basis as never) : []} assumptions={Array.isArray(v.assumptions) ? (v.assumptions as string[]) : []} oppId={id} />
                </div>
                {canEdit ? (
                  <form action={strategyAction} className="flex shrink-0 gap-2"><input type="hidden" name="opportunity_id" value={id} /><input type="hidden" name="op" value="concession" /><input type="hidden" name="item_id" value={String(c.id)} /><input type="hidden" name="row_version" value={String(c.row_version)} />
                    <Select name="status" defaultValue={String(c.status)} aria-label="Status">{["planned", "offered", "accepted", "rejected", "withdrawn"].map((x) => <option key={x} value={x}>{x}</option>)}</Select><Button variant="secondary">Set</Button></form>
                ) : <Badge>{String(c.status)}</Badge>}
              </li>
            );
          })}</ul>
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-soft">Suggested (save a snapshot to add these as planned steps):</p>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">{s.concession_ladder.map((c) => <li key={c.rank}>{c.ask}{c.give ? <span className="text-xs text-ink-soft"> — give: {c.give}</span> : null}<Basis basis={c.basis} assumptions={c.assumptions} oppId={id} /></li>)}</ol>
          </>
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
