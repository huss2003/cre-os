import Link from "next/link";
import { Badge, ButtonLink, Card, EmptyState, Field, Input, PageHeader, Stat, StaleBanner, Table, Td, Button, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { toDealsCtx } from "@/modules/deals/api";
import { feeProtectionIssues, type FeeMilestoneRow } from "@/modules/deals/fees/fees";
import { AGING_BUCKETS, AGING_LABEL, FUNNEL_STAGES, MONEY_STAGES, MONEY_STAGE_LABEL } from "@/modules/deals/fees/ledger";
import { revenueReport } from "@/modules/deals/fees/report-service";
import { funnel, STAGE_LABEL, type Stage } from "@/modules/deals/pipeline/stages";
import { LedgerTable } from "@/modules/deals/closing-ui";
import { Flash, KV } from "@/modules/deals/ui";

export default async function FeesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = toDealsCtx(await requirePageContext());
  const today = localDate();
  const rep = await revenueReport(ctx, today);
  const oppName = new Map(rep.register.map((r) => [r.opp.id, r.opp.name]));
  const feeRows = rep.register.flatMap((r) => r.lines.filter((l) => l.transaction.feeMilestoneId));
  const issues = rep.register.flatMap((r) => feeProtectionIssues(r.opp as never, r.rows as FeeMilestoneRow[], today).map((i) => ({ ...i, opp: r.opp })));
  const num = (k: string, d: number) => { const v = Number(typeof sp[k] === "string" ? sp[k] : NaN); return Number.isFinite(v) && v > 0 ? v : d; };
  const f = funnel({ annualFeeTarget: num("target", 50000000), feePerClosure: num("fee", 3000000), cohort: { approached: num("approached", 120), discussions: num("discussions", 15), closures: num("closures", 1) }, workdaysPerMonth: num("wdm", 20) });
  return (
    <div className="space-y-5">
      <PageHeader title="Fees & revenue" subtitle="Expected (forecast), contractual, attributed, invoiced, recognised and collected are kept separate — each with its own status, date, evidence and deal link. Official finance records stay authoritative."
        actions={<ButtonLink variant="secondary" href="/fees/reconcile">Reconcile with finance</ButtonLink>} />
      <Flash sp={sp} />
      {rep.mixedCurrency && <StaleBanner>Fee records use more than one currency: totals are not summed.</StaleBanner>}
      {rep.totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {MONEY_STAGES.map((s) => <Stat key={s} label={MONEY_STAGE_LABEL[s]} value={inr(rep.totals![s].amount, { compact: true })} hint={s === "expected" ? "forecast — not revenue" : rep.totals![s].unknownCount ? `${rep.totals![s].unknownCount} unknown` : undefined} />)}
        </div>
      )}
      {issues.length > 0 && (
        <Card title={`Fee protection (${issues.length})`}>
          <ul className="space-y-1 text-sm">{issues.slice(0, 50).map((i, k) => <li key={k} className={i.severity === "high" ? "text-bad" : "text-warn"}><Link className="underline" href={`/deals/${i.opp.id}`}>{i.opp.name}</Link>: {i.issue}</li>)}</ul>
        </Card>
      )}

      <Card title="Forecast (expected fees on open deals)">
        {rep.forecast.length === 0 ? <p className="text-sm text-ink-soft">No open deals with an expected fee. Add one on the deal page.</p> : (
          <Table head={["Deal", "Stage", "Expected fee", "Expected close", "Status"]}>
            {rep.forecast.map((o) => <tr key={o.id}><Td><Link className="text-brand" href={`/deals/${o.id}`}>{o.name}</Link></Td><Td>{STAGE_LABEL[o.stage as Stage] ?? o.stage}</Td><Td>{inr(o.expectedFee)}</Td><Td>{o.expectedClose ?? "unknown"}</Td><Td><Badge tone="warn">forecast — not collected</Badge></Td></tr>)}
          </Table>
        )}
      </Card>

      <Card title="Fee attribution register">
        {feeRows.length === 0 ? (
          <EmptyState title="No fee records yet">Record fee milestones on a deal (Pipeline → deal → Fees). Contractual terms need the agreement reference; invoices, recognition and collections each need a date and evidence.</EmptyState>
        ) : (
          <div className="space-y-4">
            {rep.register.filter((r) => r.lines.some((l) => l.transaction.feeMilestoneId)).slice(0, 50).map((r) => (
              <details key={r.opp.id} className="rounded-lg border border-line p-2">
                <summary className="cursor-pointer text-sm"><span className="font-medium">{r.opp.name}</span> <span className="text-xs text-ink-soft">{STAGE_LABEL[r.opp.stage as Stage] ?? r.opp.stage}{r.opp.crm_external_id ? ` · CRM ${r.opp.crm_external_id}` : " · no CRM id"}</span></summary>
                <div className="mt-2"><LedgerTable lines={r.lines} /></div>
              </details>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Outstanding receivables (aging by invoice due date)">
          <KV items={AGING_BUCKETS.map((b) => [AGING_LABEL[b], inr(rep.aging.buckets[b])])} />
          <p className="mt-2 text-xs text-ink-soft">Total outstanding {inr(rep.aging.total)}. Invoices without a due date are not guessed — add the due date (or reconcile with finance).</p>
          {rep.aging.items.filter((i) => i.bucket !== "not_due").slice(0, 10).map((i) => (
            <div key={`${i.feeMilestoneId}`} className="text-xs"><Link className="underline" href={`/deals/${i.opportunityId}`}>{oppName.get(i.opportunityId ?? "") ?? "deal"}</Link> · {i.invoiceNo ?? "no invoice no."} · {inr(i.outstanding)} · {i.daysPastDue === null ? "due date unknown" : `${i.daysPastDue} days past due`}</div>
          ))}
        </Card>
        <Card title="Slippage (expected close moved or passed)">
          {rep.slippage.rows.length === 0 ? <p className="text-sm text-ink-soft">No slipped or overdue deals. Changes to expected close are recorded automatically.</p> : (
            <>
              <p className="mb-2 text-xs text-ink-soft">{rep.slippage.slippingCount} deal(s) pushed out ({rep.slippage.totalSlippedDays} days in total) · {rep.slippage.passedCount} past the expected close without signing.</p>
              <Table head={["Deal", "First → now", "Pushes", "Days slipped", "Passed"]}>
                {rep.slippage.rows.slice(0, 20).map((r) => <tr key={r.opportunityId}><Td><Link className="text-brand" href={`/deals/${r.opportunityId}`}>{r.name}</Link></Td><Td>{r.firstExpected ?? "—"} → {r.currentExpected ?? "—"}</Td><Td>{r.pushes}</Td><Td>{r.slippedDays}</Td><Td>{r.passedWithoutClose ? <Badge tone="bad">{r.daysPastExpected}d ago</Badge> : "—"}</Td></tr>)}
              </Table>
            </>
          )}
        </Card>
      </div>

      <Card title="Cohort funnel (from actual stage history)">
        {rep.cohorts.length === 0 ? <p className="text-sm text-ink-soft">No opportunities yet.</p> : (
          <Table head={["Cohort (first seen)", "Deals", ...FUNNEL_STAGES.map((s) => STAGE_LABEL[s as Stage]), "Won", "Lost"]}>
            {rep.cohorts.slice(0, 18).map((c) => (
              <tr key={c.cohort}><Td>{c.cohort}</Td><Td>{c.opportunities}</Td>{FUNNEL_STAGES.map((s) => <Td key={s}>{c.reached[s]} <span className="text-xs text-ink-soft">({c.conversionPct[s]}%)</span></Td>)}<Td>{c.won}</Td><Td>{c.lost}</Td></tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-ink-soft">Each deal counts once in the month it first entered the pipeline; “reached” uses the furthest stage in its history, so deals that later moved back still count.</p>
      </Card>

      <Card title="Funnel & revenue feasibility (planning assumptions)">
        <form method="get" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-6">
          <Field label="Annual credited fee target ₹"><Input name="target" defaultValue={String(num("target", 50000000))} inputMode="numeric" /></Field>
          <Field label="Credited fee per deal ₹"><Input name="fee" defaultValue={String(num("fee", 3000000))} inputMode="numeric" /></Field>
          <Field label="Approached"><Input name="approached" defaultValue={String(num("approached", 120))} inputMode="numeric" /></Field>
          <Field label="Discussions"><Input name="discussions" defaultValue={String(num("discussions", 15))} inputMode="numeric" /></Field>
          <Field label="Closures"><Input name="closures" defaultValue={String(num("closures", 1))} inputMode="numeric" /></Field>
          <Field label="Workdays / month"><Input name="wdm" defaultValue={String(num("wdm", 20))} inputMode="numeric" /></Field>
          <div className="col-span-2 sm:col-span-6"><Button variant="secondary" type="submit">Recalculate</Button></div>
        </form>
        <KV items={[
          ["Closures / year", `${f.closuresPerYear} (${inr(f.attributedRevenue, { compact: true })})`],
          ["Approach → discussion → close", `${f.approachToDiscussion}% → ${f.discussionToClose}% (overall ${f.approachToClose}%)`],
          ["Approaches / month", f.approachesPerMonth], ["Discussions / month", f.discussionsPerMonth],
          ["Approaches / workday (monthly basis)", f.approachesPerWorkdayAtMonth], ["Approaches / week (52-wk mean)", f.approachesPerWeek],
          ["6-month approach envelope", f.sixMonthApproachEnvelope], ["Discussion WIP envelope (6-month lag)", f.discussionWipEnvelope],
        ]} />
        <p className="mt-2 text-xs text-ink-soft">These are planning assumptions you supply, not calibrated conversion rates. Count distinct company approaches, not follow-ups.</p>
      </Card>
    </div>
  );
}
