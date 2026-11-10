import { Badge, Card, Stat, Table, Td } from "@/components/ui";
import type { CvmResult, OptionResult } from "@/modules/toolkit/calc/managed";
import { Bullets, CumulativeChart, money } from "./shared";

const ROWS: [keyof OptionResult, string][] = [
  ["month1Monthly", "Monthly cost (month 1)"], ["averageMonthly", "Average monthly running cost"], ["annual", "Annual running cost"],
  ["oneOffTotal", "One-off costs"], ["totalCommitment", "Total over comparison period"], ["effectiveMonthly", "Effective monthly (incl. one-offs)"],
  ["costPerSeat", "Cost per usable seat / month"], ["costPerEmployee", "Cost per employee / month"], ["fitoutInvestment", "Fit-out investment"],
  ["initialCashExDeposit", "Initial cash (excl. deposit)"], ["refundableDeposit", "Refundable deposit"], ["initialCashInclDeposit", "Initial cash incl. deposit"],
];

function Lines({ o, title }: { o: OptionResult; title: string }) {
  return (
    <Card title={title}>
      <ul className="divide-y divide-line text-sm">
        {o.lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-3 py-1.5">
            <span className={l.status === "excluded_double_count" ? "text-warn" : l.status === "included" ? "text-ink-soft" : ""}>{l.label}</span>
            <span className="shrink-0 tabular-nums">{l.status === "included" || l.status === "excluded_double_count" ? "—" : l.monthly !== undefined ? <>{money(l.monthly)}/m</> : money(l.oneOff)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ManagedResults({ r }: { r: CvmResult }) {
  const c = r.conventional; const m = r.managed;
  const pref = r.recommendation.preferred;
  return (
    <div className="space-y-4">
      <Card title="Recommendation">
        <p className="text-sm"><Badge tone={pref === "too_close" || !pref ? "warn" : "brand"}>{pref === "conventional" ? "Conventional lease" : pref === "managed" ? "Managed office" : pref === "too_close" ? "Too close to call" : "Incomplete"}</Badge> {r.recommendation.text}</p>
        {r.recommendation.reasons.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">{r.recommendation.reasons.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
      </Card>
      <Bullets title="Double counting prevented" items={r.warnings} tone="warn" />
      <Bullets title="Missing information" items={r.missing} tone="warn" />
      {c && m ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Conventional total" value={money(c.totalCommitment)} hint={c.complete ? `${r.comparisonMonths} months` : "known costs only"} />
            <Stat label="Managed total" value={money(m.totalCommitment)} hint={m.complete ? `${r.comparisonMonths} months` : "known costs only"} />
            <Stat label="Conv. per seat" value={money(c.costPerSeat)} />
            <Stat label="Managed per seat" value={money(m.costPerSeat)} />
          </div>
          <Table head={["Measure", "Conventional", "Managed"]}>
            {ROWS.map(([k, label]) => <tr key={k}><Td>{label}</Td><Td className="tabular-nums">{money(c[k] as string | null)}</Td><Td className="tabular-nums">{money(m[k] as string | null)}</Td></tr>)}
            <tr><Td>Commitment (lock-in)</Td><Td>{c.commitmentMonths ?? "unknown"} m</Td><Td>{m.commitmentMonths ?? "unknown"} m</Td></tr>
            <tr><Td>Expansion / contraction</Td><Td className="text-ink-soft">{c.expansionNote}</Td><Td className="text-ink-soft">{m.expansionNote}</Td></tr>
          </Table>
          <Card title="Cumulative cost"><CumulativeChart a={c.cumulative} b={m.cumulative} labelA="Conventional" labelB="Managed" /></Card>
          <div className="grid gap-4 md:grid-cols-2"><Lines o={c} title="Conventional breakdown" /><Lines o={m} title="Managed breakdown" /></div>
        </>
      ) : null}
      <Table head={["Criterion", "Weight", "Conventional", "Managed", "Why"]}>
        {r.criteria.map((k) => <tr key={k.key}><Td>{k.label}</Td><Td>{k.weight}</Td><Td>{k.conventional ? Number(k.conventional).toFixed(2) : "—"}</Td><Td>{k.managed ? Number(k.managed).toFixed(2) : "—"}</Td><Td className="text-ink-soft">{k.reason}</Td></tr>)}
      </Table>
      <Bullets title="Differences" items={r.differences} />
      <Card title="Methodology">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
          {r.assumptions.map((s, i) => <li key={i}>{s}</li>)}
          <li>Criterion scores: the better option scores 1; the other scores (best+1)/(own+1). Control = rating/5. Weighted average over scored criteria; a gap under 0.05 is reported as too close to call.</li>
          <li>Formula {r.formula}; all arithmetic is deterministic (decimal), never AI-generated.</li>
        </ul>
      </Card>
    </div>
  );
}
