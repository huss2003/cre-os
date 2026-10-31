import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, PageHeader, Stat, StaleBanner, Table, Td, inr } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { approveScenarioAction } from "@/modules/deals/actions";
import { checkQuoteRefs, concessions, runEngine } from "@/modules/deals/finance/service";
import { sensitivities, type Concession } from "@/modules/deals/finance/engine";
import type { FinanceInput } from "@/modules/deals/finance/types";
import { Flash, KV } from "@/modules/deals/ui";

export default async function ScenarioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const { data: sc } = await ctx.db.from("finance_scenario").select("*").eq("id", id).maybeSingle();
  if (!sc) notFound();
  const input = sc.input_json as FinanceInput;
  const r = runEngine(input);
  const reproduces = r.outputHash === sc.output_hash;
  const quoteIssues = await checkQuoteRefs(ctx, input);
  const sens = (() => { try { return sensitivities(input); } catch { return []; } })();
  const conc: Concession[] = [];
  if (input.rent) conc.push({ type: "rent_free", months: 1 }, { type: "rent_rate", rate: -5 });
  if (input.rent?.escalation) conc.push({ type: "escalation_pct", pct: -1 });
  conc.push({ type: "capex_support", amount: 1000000 });
  if (input.deposit && input.deposit.amount === undefined) conc.push({ type: "deposit_months", months: -1 });
  const cv = (() => { try { return concessions(input, conc); } catch { return []; } })();
  const byPeriod = r.periodTotals.map((v, p) => ({ p, v })).filter((x) => Number(x.v) !== 0);
  const t = r.totals;
  return (
    <div className="space-y-5">
      <PageHeader title={r.name} subtitle={<>{r.kind} · {r.horizonMonths} months from {r.baseDate} · engine {r.engineVersion} · {sc.approved_at ? <Badge tone="ok">approved</Badge> : <Badge>not approved</Badge>}</>}
        actions={sc.requirement_id ? <Link className="text-sm text-brand underline" href={`/requirements/${sc.requirement_id}`}>Requirement</Link> : null} />
      <Flash sp={sp} />
      {!reproduces && <StaleBanner>Stored result no longer reproduces with the current engine — re-run before using it.</StaleBanner>}
      {quoteIssues.length > 0 && <StaleBanner>Quote provenance: {quoteIssues.join(" · ")}</StaleBanner>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="NPV" value={inr(t.npv, { compact: true })} hint={`monthly rate ${r.monthlyDiscountRate}`} />
        <Stat label="Nominal TCO" value={inr(t.nominalTco, { compact: true })} />
        <Stat label="Equivalent monthly" value={inr(t.equivalentMonthly, { compact: true })} />
        <Stat label="Peak cumulative outflow" value={inr(t.peakCumulativeOutflow, { compact: true })} hint={`peak month ${t.peakMonthlyOutflowPeriod}`} />
      </div>
      <Card title="Unit costs">
        <KV items={[["₹/chargeable SF/month", t.perChargeableSfMonth ? inr(t.perChargeableSfMonth) : "—"], ["₹/carpet SF/month", t.perCarpetSfMonth ? inr(t.perCarpetSfMonth) : "—"], ["₹/planned seat/month", t.perPlannedSeatMonth ? inr(t.perPlannedSeatMonth) : "—"], ["Effective rent ₹/SF/month", t.effectiveRentPerSfMonth ? inr(t.effectiveRentPerSfMonth) : "—"], ["Financing interest", t.financingInterestTotal ? inr(t.financingInterestTotal) : "—"], ["Output hash", r.outputHash.slice(0, 16)]]} />
        {r.warnings.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-warn">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        {hasRole(app, "admin") && !sc.approved_at && reproduces && (
          <form action={approveScenarioAction} className="mt-3"><input type="hidden" name="id" value={id} /><Button type="submit">Approve scenario</Button></form>
        )}
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="By category (nominal)">
          <Table head={["Category", "Total"]}>{Object.entries(r.categoryTotals).map(([k, v]) => <tr key={k}><Td>{k.replaceAll("_", " ")}</Td><Td>{inr(v)}</Td></tr>)}</Table>
        </Card>
        <Card title="Sensitivities (NPV)">
          <Table head={["Change", "NPV", "Δ NPV"]}>{sens.map((s) => <tr key={s.label}><Td>{s.label}</Td><Td>{inr(s.npv)}</Td><Td>{inr(s.npvChange)}</Td></tr>)}</Table>
        </Card>
      </div>
      {cv.length > 0 && (
        <Card title="Concession equivalence (value to occupier)">
          <Table head={["Concession", "NPV value", "≈ rent reduction ₹/unit/month", "≈ rent-free months"]}>
            {cv.map((c, i) => <tr key={i}><Td>{c.concession.type.replaceAll("_", " ")} {JSON.stringify(Object.fromEntries(Object.entries(c.concession).filter(([k]) => k !== "type")))}</Td><Td>{inr(c.npvValue)}</Td><Td>{c.equivalentRateReduction ?? "—"}</Td><Td>{c.equivalentRentFreeMonths ?? "—"}</Td></tr>)}
          </Table>
        </Card>
      )}
      <Card title="Monthly cash flow (non-zero periods)">
        <Table head={["Period", "Date", "Total"]}>{byPeriod.slice(0, 120).map((x) => <tr key={x.p}><Td>{x.p}</Td><Td>{r.cashflows.find((c) => c.period === x.p)?.date}</Td><Td>{inr(x.v)}</Td></tr>)}</Table>
      </Card>
    </div>
  );
}
