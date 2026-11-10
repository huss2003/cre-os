import { Table, Td } from "@/components/ui";
import { Certainty, MissingNote, Readout } from "@/modules/toolkit/ui/kit";
import { HowCalc, Panel, VerdictHero } from "@/modules/toolkit/ui/options/parts";
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
    <Panel title={title}>
      <ul className="divide-y divide-line text-sm">
        {o.lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-3 py-1.5">
            <span className={l.status === "excluded_double_count" ? "text-warn" : l.status === "included" ? "text-ink-soft" : ""}>{l.label}{l.status === "included" ? " (included)" : l.status === "excluded_double_count" ? " (not counted twice)" : l.status === "unknown" ? " (unknown)" : ""}</span>
            <span className="shrink-0 tabular-nums">{l.status === "included" || l.status === "excluded_double_count" ? "—" : l.monthly !== undefined ? <>{money(l.monthly)}/m</> : money(l.oneOff)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-soft">“—” = included in the price or removed to avoid double counting.</p>
    </Panel>
  );
}

const SIDE = { conventional: "Conventional lease", managed: "Managed office" } as const;

export function ManagedResults({ r }: { r: CvmResult }) {
  const c = r.conventional; const m = r.managed;
  const pref = r.recommendation.preferred;
  // Plain comparison of two already-computed totals (no arithmetic) — only when both sides are complete.
  const fin = c && m && c.complete && m.complete ? (Number(c.totalCommitment) < Number(m.totalCommitment) ? "conventional" : Number(m.totalCommitment) < Number(c.totalCommitment) ? "managed" : "equal") : null;
  const opLabel = pref === "conventional" || pref === "managed" ? SIDE[pref] : pref === "too_close" ? "Too close to call" : "Not decided yet — inputs missing";
  const finLabel = fin === "conventional" || fin === "managed" ? `${SIDE[fin]} (lower total cost)` : fin === "equal" ? "Same total cost" : "Not decided yet — some costs unknown";
  return (
    <div className="space-y-4">
      <VerdictHero items={[{ label: "Financially better", value: finLabel, known: !!fin }, { label: "Better overall (your weighted criteria)", value: opLabel, known: pref === "conventional" || pref === "managed" }]} text={r.recommendation.text}>
        {r.recommendation.reasons.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">{r.recommendation.reasons.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
      </VerdictHero>
      <MissingNote items={r.missing} />
      <Bullets title="Double counting prevented" items={r.warnings} tone="warn" />
      {c && m ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Readout label="Conventional — total" value={money(c.totalCommitment)} sub={<><Certainty c={c.complete ? "estimated" : "missing"} /> {c.complete ? `${r.comparisonMonths} months` : "known costs only"}</>} emphasis={fin === "conventional"} />
            <Readout label="Managed — total" value={money(m.totalCommitment)} sub={<><Certainty c={m.complete ? "estimated" : "missing"} /> {m.complete ? `${r.comparisonMonths} months` : "known costs only"}</>} emphasis={fin === "managed"} />
            <Readout label="Per seat / month" value={<>{money(c.costPerSeat)} <span className="text-sm font-normal text-ink-soft">vs</span> {money(m.costPerSeat)}</>} sub="Conventional vs managed" />
            <Readout label="Initial cash incl. deposit" value={<>{money(c.initialCashInclDeposit)} <span className="text-sm font-normal text-ink-soft">vs</span> {money(m.initialCashInclDeposit)}</>} sub="Conventional vs managed" />
          </div>
          <Panel title="Cost over time" desc="Each line adds up everything paid to date.">
            <CumulativeChart a={c.cumulative} b={m.cumulative} labelA="Conventional (dashed)" labelB="Managed (solid)"
              caption={fin === "conventional" ? "By the end of the period the conventional lease has cost less in total." : fin === "managed" ? "By the end of the period the managed office has cost less in total." : "Lines are drawn from known costs only — some inputs are missing."} />
          </Panel>
          <Panel title="Side by side">
            <Table head={["Measure", "Conventional", "Managed"]}>
              {ROWS.map(([k, label]) => <tr key={k}><Td>{label}</Td><Td className="tabular-nums">{money(c[k] as string | null)}</Td><Td className="tabular-nums">{money(m[k] as string | null)}</Td></tr>)}
              <tr><Td>Commitment (lock-in)</Td><Td>{c.commitmentMonths ?? "unknown"} m</Td><Td>{m.commitmentMonths ?? "unknown"} m</Td></tr>
              <tr><Td>Expansion / contraction</Td><Td className="text-ink-soft">{c.expansionNote}</Td><Td className="text-ink-soft">{m.expansionNote}</Td></tr>
            </Table>
          </Panel>
          <div className="grid gap-4 md:grid-cols-2"><Lines o={c} title="Conventional — line by line" /><Lines o={m} title="Managed — line by line" /></div>
        </>
      ) : null}
      <Panel title="Weighted criteria" desc="1.00 = the better option on that criterion.">
        <Table head={["Criterion", "Weight", "Conventional", "Managed", "Why"]}>
          {r.criteria.map((k) => <tr key={k.key}><Td>{k.label}</Td><Td>{k.weight}</Td><Td>{k.conventional ? Number(k.conventional).toFixed(2) : "—"}</Td><Td>{k.managed ? Number(k.managed).toFixed(2) : "—"}</Td><Td className="text-ink-soft">{k.reason}</Td></tr>)}
        </Table>
      </Panel>
      <Bullets title="Differences" items={r.differences} />
      <HowCalc items={[...r.assumptions,
        "Criterion scores: the better option scores 1; the other scores (best+1)/(own+1). Control = rating/5. Weighted average over scored criteria; a gap under 0.05 is reported as too close to call.",
        `Formula ${r.formula}; all arithmetic is deterministic (decimal), never AI-generated.`]} />
    </div>
  );
}
