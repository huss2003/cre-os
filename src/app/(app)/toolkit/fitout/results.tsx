import { Badge, Card, Help, Stat, Table, Td } from "@/components/ui";
import { CATEGORY_LABEL, STAGES, type FitoutResult, type QuoteCompareResult, type Stage } from "@/modules/toolkit/calc/fitout";
import type { FitoutPayload } from "@/modules/toolkit/actions-fitout";

/** ₹ with paise, Indian grouping; null stays "unknown" (never 0). */
export function rs(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === "") return <span className="text-ink-soft">unknown</span>;
  return "₹" + new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
}
const STAGE_LABEL: Record<Stage, string> = { estimated: "Estimated", approved: "Approved", actual: "Actual" };
const TONE: Record<Stage, "neutral" | "warn" | "ok"> = { estimated: "neutral", approved: "warn", actual: "ok" };

export function FitoutResults({ budget, quotes, inputs }: { budget: FitoutResult; quotes: QuoteCompareResult; inputs: FitoutPayload }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {STAGES.map((s) => (
          <Stat key={s} label={`${STAGE_LABEL[s]} — incl. tax`} value={budget.totals[s].lines ? rs(budget.totals[s].gross) : rs(null)}
            hint={<>net {rs(budget.totals[s].net)} + tax {rs(budget.totals[s].tax)}{budget.totals[s].unknownLines ? ` · ${budget.totals[s].unknownLines} line(s) unknown` : ""}{budget.totals[s].unknownTaxLines ? ` · ${budget.totals[s].unknownTaxLines} without tax %` : ""}{budget.perSf[s] ? <> · {rs(budget.perSf[s])}/sf</> : null}{budget.perSeat[s] ? <> · {rs(budget.perSeat[s])}/seat</> : null}</>} />
        ))}
      </div>
      <Card title="By category" help={<Help>Totals per category for each stage. Amounts exclude tax; tax is computed per line from its stated tax %. Lines without an amount for a stage are counted as unknown, not zero.</Help>}>
        <Table head={["Category", "Estimated", "Approved", "Actual", "Tax (est.)"]}>
          {budget.byCategory.map((c) => (
            <tr key={c.category}><Td>{c.label}</Td>{STAGES.map((s) => <Td key={s}>{c[s].lines ? rs(c[s].gross) : rs(null)}{c[s].unknownLines ? <span className="block text-[11px] text-ink-soft">{c[s].unknownLines} unknown</span> : null}</Td>)}<Td>{rs(c.estimated.tax)}</Td></tr>
          ))}
          <tr className="font-semibold"><Td>Total</Td>{STAGES.map((s) => <Td key={s}>{budget.totals[s].lines ? rs(budget.totals[s].gross) : rs(null)}</Td>)}<Td>{rs(budget.totals.estimated.tax)}</Td></tr>
        </Table>
        <p className="mt-3 text-sm text-ink-soft">Variance (incl. tax): approved − estimated {rs(budget.variance.approvedVsEstimated)} · actual − approved {rs(budget.variance.actualVsApproved)} · actual − estimated {rs(budget.variance.actualVsEstimated)}</p>
      </Card>
      <Card title="Line items">
        <Table head={["#", "Category / item", "Vendor · quote", "Tax %", ...STAGES.map((s) => STAGE_LABEL[s])]}>
          {budget.lines.map((l) => {
            const inp = inputs.lines[l.index] ?? {};
            return (
              <tr key={l.index}><Td>{l.index + 1}</Td><Td>{CATEGORY_LABEL[l.category]}<span className="block text-xs text-ink-soft">{String(inp.description ?? "")}{inp.quantity ? ` · ${inp.quantity} ${inp.unit ?? ""} × ₹${inp.unitPrice ?? "?"}` : ""}</span></Td>
                <Td className="text-xs">{String(inp.vendor || "—")}{inp.quoteRef ? ` · ${inp.quoteRef}` : ""}</Td><Td>{inp.taxPct !== "" && inp.taxPct != null ? `${inp.taxPct}%` : <Badge tone="warn">not stated</Badge>}</Td>
                {STAGES.map((s) => <Td key={s}>{rs(l[s].gross ?? l[s].net)}{l[s].net && !l[s].gross ? <span className="block text-[11px] text-warn">ex-tax only</span> : null}{s === "estimated" && l.estimatedSource === "derived" ? <span className="block text-[11px] text-ink-soft">qty × price</span> : null}</Td>)}
              </tr>
            );
          })}
        </Table>
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">{STAGES.map((s) => <Badge key={s} tone={TONE[s]}>{STAGE_LABEL[s]}</Badge>)}<span className="text-ink-soft">— labels are never merged; quoted prices live in the quotations below.</span></div>
      </Card>
      <QuoteTable quotes={quotes} inputs={inputs} />
    </div>
  );
}

function QuoteTable({ quotes, inputs }: { quotes: QuoteCompareResult; inputs: FitoutPayload }) {
  if (!quotes.rows.length) return <Card title="Partner quotations"><p className="text-sm text-ink-soft">No quotations yet. Add each partner&apos;s quote in the editor — every partner is normalised and ranked the same way.</p></Card>;
  const expired = quotes.rows.filter((r) => r.expired);
  const sorted = [...quotes.rows].sort((a, b) => a.rank - b.rank);
  return (
    <Card title="Partner quotations — compared on the same scope" help={<Help>{quotes.method}</Help>}>
      {expired.length ? <div className="mb-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">Expired quotation{expired.length > 1 ? "s" : ""}: {expired.map((r) => r.partnerName).join(", ")} — ask for a revalidated quote before relying on the price.</div> : null}
      <Table head={["Rank", "Partner", "Price ex-tax", "Tax", "Incl. tax", "Scope", "Weeks", "Warranty", "Score", "Flags"]}>
        {sorted.map((r) => {
          const q = inputs.quotes[r.index] ?? ({} as never);
          return (
            <tr key={r.index} className={r.expired ? "bg-bad/5" : undefined}>
              <Td className="font-semibold">{r.rank}</Td>
              <Td>{r.partnerName}{quotes.preferred?.index === r.index ? <span className="ml-1"><Badge tone="warn">preferred</Badge></span> : null}{r.expired ? <span className="ml-1"><Badge tone="bad">expired</Badge></span> : null}<span className="block"><Badge tone="neutral">quoted</Badge></span>{q.documentsUrl ? <a className="block text-xs text-brand underline" href={q.documentsUrl} target="_blank" rel="noreferrer">documents</a> : null}</Td>
              <Td>{rs(r.priceExTax)}</Td><Td>{rs(r.tax)}</Td><Td>{rs(r.priceInclTax)}</Td>
              <Td>{r.coverage !== null ? `${r.coverage}%` : "—"}{r.extraScope.length ? <span className="block text-[11px] text-ink-soft">+ {r.extraScope.map((x) => CATEGORY_LABEL[x]).join(", ")}</span> : null}</Td>
              <Td>{q.deliveryWeeks || "—"}</Td><Td>{q.warrantyMonths ? `${q.warrantyMonths} mo` : "—"}</Td>
              <Td><span title={`price ${r.scores.price} · scope ${r.scores.scope} · timeline ${r.scores.timeline} · warranty ${r.scores.warranty}`}>{r.scores.total}</span></Td>
              <Td className="text-xs">{r.flags.length ? <ul className="space-y-0.5">{r.flags.map((f, i) => <li key={i} className={f.startsWith("EXPIRED") ? "font-semibold text-bad" : "text-warn"}>{f}</li>)}</ul> : "—"}{q.paymentSchedule ? <span className="block text-ink-soft">Pay: {q.paymentSchedule}</span> : null}</Td>
            </tr>
          );
        })}
      </Table>
      <p className="mt-2 text-xs text-ink-soft">Weights: price {quotes.criteria.price} · scope {quotes.criteria.scope} · timeline {quotes.criteria.timeline} · warranty {quotes.criteria.warranty}. Hover a score for its parts.</p>
      {quotes.preferred ? <p className="mt-2 rounded-lg border border-line bg-brand-soft px-3 py-2 text-sm"><span className="font-medium">Preferred: {quotes.rows[quotes.preferred.index]?.partnerName}</span> — {quotes.preferred.reason}</p> : null}
    </Card>
  );
}
