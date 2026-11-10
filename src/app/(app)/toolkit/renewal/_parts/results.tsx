import { Table, Td } from "@/components/ui";
import { Certainty, MissingNote, Readout } from "@/modules/toolkit/ui/kit";
import { HowCalc, Panel, VerdictHero } from "@/modules/toolkit/ui/options/parts";
import type { RvrResult, SideResult } from "@/modules/toolkit/calc/renewal";
import { Bullets, CumulativeChart, money } from "../../managed/_parts/shared";

const ROWS: [keyof SideResult, string][] = [
  ["recurringTotal", "Recurring costs over period"], ["oneOffTotal", "One-off costs"], ["total", "Total over period"], ["annualAverage", "Average annual cost"],
  ["pv", "Present value"], ["initialCash", "Initial cash (month 1, excl. deposit)"], ["depositNet", "Net deposit (refundable)"], ["initialCashInclDeposit", "Initial cash incl. deposit"],
];

function Lines({ s, title }: { s: SideResult; title: string }) {
  return (
    <Panel title={title}>
      <ul className="divide-y divide-line text-sm">
        {s.lines.map((l, i) => <li key={i} className="flex justify-between gap-3 py-1.5"><span>{l.label}</span><span className="shrink-0 tabular-nums">{money(l.amount)}{l.kind === "monthly" ? "/m" : ""}</span></li>)}
      </ul>
    </Panel>
  );
}

const WORD = { renewal: "Stay (renew)", relocation: "Move (relocate)", equal: "No clear difference" } as const;

export function RenewalResults({ r }: { r: RvrResult }) {
  const a = r.renewal; const b = r.relocation;
  const f = r.financiallyPreferable; const o = r.operationallyPreferable;
  return (
    <div className="space-y-4">
      <VerdictHero items={[
        { label: "Financially better", value: f ? WORD[f] : "Not decided yet — inputs missing", known: !!f },
        { label: "Operationally better", value: o ? WORD[o] : "Not scored yet — add the 1–5 scores", known: !!o },
      ]} text={r.verdict} />
      <MissingNote items={r.missing} />
      {a && b && r.difference ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Readout label="Stay — total" value={money(a.total)} emphasis={f === "renewal"} sub={<><Certainty c={a.complete ? "estimated" : "missing"} /> {a.complete ? `${r.comparisonMonths} months` : "known costs only"}</>} />
            <Readout label="Move — total" value={money(b.total)} emphasis={f === "relocation"} sub={<><Certainty c={b.complete ? "estimated" : "missing"} /> {b.complete ? `${r.comparisonMonths} months` : "known costs only"}</>} />
            <Readout label="Initial cash incl. deposit" value={<>{money(a.initialCashInclDeposit)} <span className="text-sm font-normal text-ink-soft">vs</span> {money(b.initialCashInclDeposit)}</>} sub="Stay vs move" />
            <Readout label="Break-even" value={r.breakEven?.month ? `Month ${r.breakEven.month}` : "None in period"} sub={r.breakEven?.text} />
          </div>
          <Readout label="Present-value difference (move − stay)" value={money(r.difference.pv)} sub="Positive = moving costs more in today's money." />
          <Panel title="Cost over time" desc="Each line adds up everything paid to date.">
            <CumulativeChart a={a.cumulative} b={b.cumulative} labelA="Stay (dashed)" labelB="Move (solid)" marker={r.breakEven?.month}
              caption={r.breakEven?.month ? `Moving costs more at first (move costs), then becomes cheaper in total from month ${r.breakEven.month}.` : "The move line stays above the stay line — moving does not pay back within this period."} />
          </Panel>
          <Panel title="Side by side">
            <Table head={["Measure", "Stay", "Move"]}>
              {ROWS.map(([k, label]) => <tr key={k}><Td>{label}</Td><Td className="tabular-nums">{money(a[k] as string | null)}</Td><Td className="tabular-nums">{money(b[k] as string | null)}</Td></tr>)}
              <tr><Td>Saving from relocating (undiscounted)</Td><td colSpan={2} className="px-3 py-2">{money(String(-Number(r.difference.total)))}{Number(r.difference.total) > 0 ? " (negative = relocation costs more)" : ""}</td></tr>
            </Table>
          </Panel>
          <div className="grid gap-4 md:grid-cols-2"><Lines s={a} title="Stay — line by line" /><Lines s={b} title="Move — line by line" /></div>
        </>
      ) : null}
      <Panel title="Non-money factors" desc="Scores 1–5 as you entered them.">
        <Table head={["Criterion", "Stay", "Move"]}>
          {r.nonFinancial.rows.map((x) => <tr key={x.key}><Td>{x.label}</Td><Td>{x.renewal ?? "—"}</Td><Td>{x.relocation ?? "—"}</Td></tr>)}
          <tr><Td className="font-medium">Average ({r.nonFinancial.scored} scored)</Td><Td className="font-medium">{r.nonFinancial.renewalAvg ?? "—"}</Td><Td className="font-medium">{r.nonFinancial.relocationAvg ?? "—"}</Td></tr>
        </Table>
      </Panel>
      <Bullets title="Risks" items={r.risks} tone="warn" />
      <Bullets title="Negotiation points" items={r.negotiation} />
      <HowCalc items={[...r.assumptions,
        `Rent in month m = rent × (1+e)^floor((m−1)/interval); zero during rent-free months. PV discounts month m by (1+r)^−(m−1)/12 at the annual rate ${r.discountRatePct ?? "—"}%.`,
        "Break-even = first month from which relocation's cumulative cost stays at or below renewal's for the rest of the period.",
        `Financial and operational preference are reported separately; lower rent alone never makes relocation the recommendation. Formula ${r.formula}, deterministic decimal arithmetic.`]} />
    </div>
  );
}
