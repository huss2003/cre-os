import Link from "next/link";
import { Card, EmptyState, Field, Input, PageHeader, Stat, StaleBanner, Table, Td, Button, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { feeProtectionIssues, feeSummary, type FeeMilestoneRow } from "@/modules/deals/fees/fees";
import { funnel } from "@/modules/deals/pipeline/stages";
import { Flash, KV } from "@/modules/deals/ui";

export default async function FeesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = toDealsCtx(await requirePageContext());
  const [{ data: fees }, { data: opps }] = await Promise.all([
    ctx.db.from("fee_milestone").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(1000),
    ctx.db.from("opportunity").select("id, name, stage, outcome, expected_fee, credit_share, crm_external_id").eq("workspace_id", ctx.workspaceId).is("archived_at", null).limit(1000),
  ]);
  const rows = (fees ?? []) as (FeeMilestoneRow & { id: string; opportunity_id: string })[];
  const oppById = new Map((opps ?? []).map((o) => [o.id as string, o]));
  const today = new Date().toISOString().slice(0, 10);
  let total: ReturnType<typeof feeSummary> | null = null, mixed = false;
  try { total = feeSummary(rows); } catch { mixed = true; }
  const issues = (opps ?? []).flatMap((o) => feeProtectionIssues(o as never, rows.filter((r) => r.opportunity_id === o.id), today).map((i) => ({ ...i, opp: o })));
  const num = (k: string, d: number) => { const v = Number(typeof sp[k] === "string" ? sp[k] : NaN); return Number.isFinite(v) && v > 0 ? v : d; };
  const f = funnel({ annualFeeTarget: num("target", 50000000), feePerClosure: num("fee", 3000000), cohort: { approached: num("approached", 120), discussions: num("discussions", 15), closures: num("closures", 1) }, workdaysPerMonth: num("wdm", 20) });
  return (
    <div className="space-y-5">
      <PageHeader title="Fees" subtitle="Gross, credited, invoiced, recognised and collected are kept separate — each with its own date and evidence." />
      <Flash sp={sp} />
      {mixed && <StaleBanner>Fee records use more than one currency: totals are not summed.</StaleBanner>}
      {total && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Gross" value={inr(total.gross, { compact: true })} />
          <Stat label="Credited" value={inr(total.credited, { compact: true })} hint={total.creditShareUnknown ? `${total.creditShareUnknown} without credit share` : undefined} />
          <Stat label="Invoiced" value={inr(total.invoiced, { compact: true })} />
          <Stat label="Recognised" value={inr(total.recognised, { compact: true })} />
          <Stat label="Collected" value={inr(total.collected, { compact: true })} />
          <Stat label="Receivable" value={inr(total.receivable, { compact: true })} />
        </div>
      )}
      {issues.length > 0 && (
        <Card title={`Fee protection (${issues.length})`}>
          <ul className="space-y-1 text-sm">{issues.slice(0, 50).map((i, k) => <li key={k} className={i.severity === "high" ? "text-bad" : "text-warn"}><Link className="underline" href={`/deals/${i.opp.id}`}>{i.opp.name as string}</Link>: {i.issue}</li>)}</ul>
        </Card>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No fee records yet">Record fee milestones on a deal (Pipeline → deal → Fees). Invoices, recognition and collections each need a date and evidence.</EmptyState>
      ) : (
        <Table head={["Deal", "Milestone", "Gross", "Invoiced", "Recognised", "Collected", "Evidence"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td><Link className="text-brand" href={`/deals/${r.opportunity_id}`}>{(oppById.get(r.opportunity_id)?.name as string) ?? "—"}</Link></Td>
              <Td>{r.milestone ?? "—"}</Td><Td>{inr(r.gross_fee)}</Td>
              <Td>{inr(r.invoiced_amount)}{r.invoiced_on ? ` · ${r.invoiced_on}` : ""}</Td>
              <Td>{inr(r.recognised_amount)}{r.recognised_on ? ` · ${r.recognised_on}` : ""}</Td>
              <Td>{inr(r.collected_amount)}{r.collected_on ? ` · ${r.collected_on}` : ""}</Td>
              <Td className="text-xs">{r.evidence ?? "—"}</Td>
            </tr>
          ))}
        </Table>
      )}
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
