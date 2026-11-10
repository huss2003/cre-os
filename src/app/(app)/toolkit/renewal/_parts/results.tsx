import { Badge, Card, Stat, Table, Td } from "@/components/ui";
import type { RvrResult, SideResult } from "@/modules/toolkit/calc/renewal";
import { Bullets, CumulativeChart, money } from "../../managed/_parts/shared";

const ROWS: [keyof SideResult, string][] = [
  ["recurringTotal", "Recurring costs over period"], ["oneOffTotal", "One-off costs"], ["total", "Total over period"], ["annualAverage", "Average annual cost"],
  ["pv", "Present value"], ["initialCash", "Initial cash (month 1, excl. deposit)"], ["depositNet", "Net deposit (refundable)"], ["initialCashInclDeposit", "Initial cash incl. deposit"],
];
const cap = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "Not determined");

function Lines({ s, title }: { s: SideResult; title: string }) {
  return (
    <Card title={title}>
      <ul className="divide-y divide-line text-sm">
        {s.lines.map((l, i) => <li key={i} className="flex justify-between gap-3 py-1.5"><span>{l.label}</span><span className="shrink-0 tabular-nums">{money(l.amount)}{l.kind === "monthly" ? "/m" : ""}</span></li>)}
      </ul>
    </Card>
  );
}

export function RenewalResults({ r }: { r: RvrResult }) {
  const a = r.renewal; const b = r.relocation;
  return (
    <div className="space-y-4">
      <Card title="Verdict">
        <div className="mb-2 flex flex-wrap gap-2 text-sm">
          <span>Financially: <Badge tone="brand">{cap(r.financiallyPreferable)}</Badge></span>
          <span>Operationally: <Badge tone="accent">{cap(r.operationallyPreferable)}</Badge></span>
        </div>
        <p className="text-sm">{r.verdict}</p>
      </Card>
      <Bullets title="Missing information" items={r.missing} tone="warn" />
      {a && b && r.difference ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Renewal total" value={money(a.total)} hint={a.complete ? `${r.comparisonMonths} months` : "known costs only"} />
            <Stat label="Relocation total" value={money(b.total)} hint={b.complete ? `${r.comparisonMonths} months` : "known costs only"} />
            <Stat label="PV difference" value={money(r.difference.pv)} hint="relocation − renewal" />
            <Stat label="Break-even" value={r.breakEven?.month ? `Month ${r.breakEven.month}` : "None"} hint={r.breakEven?.text} />
          </div>
          <Table head={["Measure", "Renewal", "Relocation"]}>
            {ROWS.map(([k, label]) => <tr key={k}><Td>{label}</Td><Td className="tabular-nums">{money(a[k] as string | null)}</Td><Td className="tabular-nums">{money(b[k] as string | null)}</Td></tr>)}
            <tr><Td>Saving from relocating (undiscounted)</Td><td colSpan={2} className="px-3 py-2">{money(String(-Number(r.difference.total)))}{Number(r.difference.total) > 0 ? " (negative = relocation costs more)" : ""}</td></tr>
          </Table>
          <Card title="Cumulative cost"><CumulativeChart a={a.cumulative} b={b.cumulative} labelA="Renewal" labelB="Relocation" marker={r.breakEven?.month} /></Card>
          <div className="grid gap-4 md:grid-cols-2"><Lines s={a} title="Renewal inputs" /><Lines s={b} title="Relocation inputs" /></div>
        </>
      ) : null}
      <Table head={["Criterion", "Renewal", "Relocation"]}>
        {r.nonFinancial.rows.map((x) => <tr key={x.key}><Td>{x.label}</Td><Td>{x.renewal ?? "—"}</Td><Td>{x.relocation ?? "—"}</Td></tr>)}
        <tr><Td className="font-medium">Average ({r.nonFinancial.scored} scored)</Td><Td className="font-medium">{r.nonFinancial.renewalAvg ?? "—"}</Td><Td className="font-medium">{r.nonFinancial.relocationAvg ?? "—"}</Td></tr>
      </Table>
      <Bullets title="Risks" items={r.risks} />
      <Bullets title="Negotiation points" items={r.negotiation} />
      <Card title="Methodology">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
          {r.assumptions.map((s, i) => <li key={i}>{s}</li>)}
          <li>Rent in month m = rent × (1+e)^floor((m−1)/interval); zero during rent-free months. PV discounts month m by (1+r)^−(m−1)/12 at the annual rate {r.discountRatePct ?? "—"}%.</li>
          <li>Break-even = first month from which relocation&apos;s cumulative cost stays at or below renewal&apos;s for the rest of the period.</li>
          <li>Financial and operational preference are reported separately; lower rent alone never makes relocation the recommendation. Formula {r.formula}, deterministic decimal arithmetic.</li>
        </ul>
      </Card>
    </div>
  );
}
