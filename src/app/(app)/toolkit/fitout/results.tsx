import { Table, Td } from "@/components/ui";
import { Certainty, EmptyState, Readout, Status, btn } from "@/modules/toolkit/ui/kit";
import { HowCalc, Panel } from "@/modules/toolkit/ui/options/parts";
import { CATEGORY_LABEL, STAGES, type FitoutResult, type QuoteCompareResult, type Stage } from "@/modules/toolkit/calc/fitout";
import type { FitoutPayload } from "@/modules/toolkit/actions-fitout";

/** ₹ with paise, Indian grouping; null stays "unknown" (never 0). */
export function rs(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === "") return <span className="text-ink-soft">unknown</span>;
  return "₹" + new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
}
const STAGE_LABEL: Record<Stage, string> = { estimated: "Estimated", approved: "Approved", actual: "Actual" };
const STAGE_CERT: Record<Stage, string> = { estimated: "estimated", approved: "quoted", actual: "confirmed" };
const STAGE_TINT: Record<Stage, string> = { estimated: "bg-amber-50/60", approved: "bg-sky-50/60", actual: "bg-emerald-50/60" };
const StageHead = ({ s }: { s: Stage }) => <span className="inline-flex flex-col gap-0.5">{STAGE_LABEL[s]}<span className="normal-case tracking-normal"><Certainty c={STAGE_CERT[s]} /></span></span>;

export function FitoutResults({ budget, quotes, inputs }: { budget: FitoutResult; quotes: QuoteCompareResult; inputs: FitoutPayload }) {
  const sum = budget.totals;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {STAGES.map((s) => (
          <Readout key={s} label={`${STAGE_LABEL[s]} total — incl. tax`} value={sum[s].lines ? rs(sum[s].gross) : rs(null)} emphasis={s === "estimated"}
            sub={<><Certainty c={STAGE_CERT[s]} /> · net {rs(sum[s].net)} + tax {rs(sum[s].tax)}{sum[s].unknownLines ? ` · ${sum[s].unknownLines} line(s) unknown` : ""}{sum[s].unknownTaxLines ? ` · ${sum[s].unknownTaxLines} without tax %` : ""}{budget.perSf[s] ? <> · {rs(budget.perSf[s])}/sf</> : null}{budget.perSeat[s] ? <> · {rs(budget.perSeat[s])}/seat</> : null}</>} />
        ))}
      </div>
      <Panel title="By category" desc="Amounts exclude tax; tax is computed per line from its stated tax %. Lines without an amount for a stage count as unknown, not zero.">
        <Table head={["Category", <StageHead key="e" s="estimated" />, <StageHead key="a" s="approved" />, <StageHead key="c" s="actual" />, "Tax (est.)"]}>
          {budget.byCategory.map((c) => (
            <tr key={c.category}><Td>{c.label}</Td>{STAGES.map((s) => <Td key={s} className={STAGE_TINT[s]}>{c[s].lines ? rs(c[s].gross) : rs(null)}{c[s].unknownLines ? <span className="block text-[11px] text-ink-soft">{c[s].unknownLines} unknown</span> : null}</Td>)}<Td>{rs(c.estimated.tax)}</Td></tr>
          ))}
          <tr className="font-semibold"><Td>Total</Td>{STAGES.map((s) => <Td key={s} className={STAGE_TINT[s]}>{sum[s].lines ? rs(sum[s].gross) : rs(null)}</Td>)}<Td>{rs(sum.estimated.tax)}</Td></tr>
        </Table>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Readout label="Approved − estimated" value={rs(budget.variance.approvedVsEstimated)} sub="incl. tax" />
          <Readout label="Actual − approved" value={rs(budget.variance.actualVsApproved)} sub="incl. tax" />
          <Readout label="Actual − estimated" value={rs(budget.variance.actualVsEstimated)} sub="incl. tax" />
        </div>
      </Panel>
      <Panel title="Budget lines" desc="Estimated, approved and actual are kept separate — never merged. Quoted prices live in the quotations below.">
        <Table head={["#", "Category / item", "Vendor · quote", "Tax %", ...STAGES.map((s) => <StageHead key={s} s={s} />)]}>
          {budget.lines.map((l) => {
            const inp = inputs.lines[l.index] ?? {};
            return (
              <tr key={l.index}><Td>{l.index + 1}</Td><Td>{CATEGORY_LABEL[l.category]}<span className="block text-xs text-ink-soft">{String(inp.description ?? "")}{inp.quantity ? ` · ${inp.quantity} ${inp.unit ?? ""} × ₹${inp.unitPrice ?? "?"}` : ""}</span></Td>
                <Td className="text-xs">{String(inp.vendor || "—")}{inp.quoteRef ? ` · ${inp.quoteRef}` : ""}</Td><Td>{inp.taxPct !== "" && inp.taxPct != null ? `${inp.taxPct}%` : <Status s="needs_info" label="Not stated" />}</Td>
                {STAGES.map((s) => <Td key={s} className={STAGE_TINT[s]}>{rs(l[s].gross ?? l[s].net)}{l[s].net && !l[s].gross ? <span className="block text-[11px] text-warn">ex-tax only</span> : null}{s === "estimated" && l.estimatedSource === "derived" ? <span className="block text-[11px] text-ink-soft">qty × price</span> : null}</Td>)}
              </tr>
            );
          })}
        </Table>
      </Panel>
      <QuoteCards quotes={quotes} inputs={inputs} />
    </div>
  );
}

function QuoteCards({ quotes, inputs }: { quotes: QuoteCompareResult; inputs: FitoutPayload }) {
  if (!quotes.rows.length) return <EmptyState title="No partner quotations yet" text="Add each partner's quote in the editor below — every partner is normalised and ranked the same way." />;
  const expired = quotes.rows.filter((r) => r.expired);
  const sorted = [...quotes.rows].sort((a, b) => a.rank - b.rank);
  const top = sorted[0];
  return (
    <Panel title="Partner quotations — compared on the same scope" desc={`Ranked by weighted score: price ${quotes.criteria.price} · scope ${quotes.criteria.scope} · timeline ${quotes.criteria.timeline} · warranty ${quotes.criteria.warranty}. Higher score = better.`}>
      {expired.length ? <div role="status" className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"><strong>✕ Expired quotation{expired.length > 1 ? "s" : ""}:</strong> {expired.map((r) => r.partnerName).join(", ")} — ask for a revalidated quote before relying on the price.</div> : null}
      {top ? <p className="mb-3 text-sm"><strong>Why this order:</strong> {top.partnerName || "Rank 1"} ranks first with the highest weighted score ({top.scores.total}). Each card shows how its score splits across price, scope, timeline and warranty.</p> : null}
      <ol className="grid gap-3 md:grid-cols-2">
        {sorted.map((r) => {
          const q = inputs.quotes[r.index] ?? ({} as never);
          const isPref = quotes.preferred?.index === r.index;
          return (
            <li key={r.index} className={`rounded-xl border-2 p-4 ${r.expired ? "border-rose-200 bg-rose-50/40" : isPref ? "border-brand" : "border-line bg-surface"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Rank {r.rank}</p>
                  <p className="text-lg font-bold">{r.partnerName || "Unnamed partner"}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {isPref ? <Status s="approved" label="★ Preferred" /> : null}
                  {r.expired ? <Status s="expired" /> : r.expired === null ? <Status s="unconfirmed" label="Validity unknown" /> : null}
                  <Certainty c="quoted" />
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Readout label="Incl. tax" value={rs(r.priceInclTax)} sub={<>ex-tax {rs(r.priceExTax)} + tax {rs(r.tax)}</>} emphasis={r.rank === 1} />
                <Readout label="Score" value={r.scores.total} sub={`price ${r.scores.price} · scope ${r.scores.scope} · time ${r.scores.timeline} · warranty ${r.scores.warranty}`} />
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                <div><dt className="text-xs text-ink-soft">Scope covered</dt><dd>{r.coverage !== null ? `${r.coverage}%` : "—"}</dd></div>
                <div><dt className="text-xs text-ink-soft">Delivery</dt><dd>{q.deliveryWeeks ? `${q.deliveryWeeks} weeks` : "—"}</dd></div>
                <div><dt className="text-xs text-ink-soft">Warranty</dt><dd>{q.warrantyMonths ? `${q.warrantyMonths} months` : "—"}</dd></div>
              </dl>
              {r.extraScope.length ? <p className="mt-2 text-xs text-ink-soft">Also covers: {r.extraScope.map((x) => CATEGORY_LABEL[x]).join(", ")}</p> : null}
              {r.flags.length ? <ul className="mt-2 space-y-0.5 text-sm">{r.flags.map((f, i) => <li key={i} className={f.startsWith("EXPIRED") ? "font-semibold text-rose-700" : "text-amber-800"}>! {f}</li>)}</ul> : null}
              {q.paymentSchedule ? <p className="mt-2 text-xs text-ink-soft">Payment: {q.paymentSchedule}</p> : null}
              {q.documentsUrl ? <a className={`${btn.quiet} mt-2`} href={q.documentsUrl} target="_blank" rel="noreferrer">Open documents ↗</a> : null}
              {isPref ? <p className="mt-3 rounded-lg bg-brand-soft px-3 py-2 text-sm"><strong>Reason given:</strong> {quotes.preferred?.reason}</p> : null}
            </li>
          );
        })}
      </ol>
      <div className="mt-3"><HowCalc items={[quotes.method]} /></div>
    </Panel>
  );
}
