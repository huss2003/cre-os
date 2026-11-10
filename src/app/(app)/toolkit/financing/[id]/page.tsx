import Link from "next/link";
import { notFound } from "next/navigation";
import { Certainty, Legend, MissingNote, Readout, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";
import { HowCalc, Panel } from "@/modules/toolkit/ui/options/parts";
import { CollapsibleTable } from "@/modules/toolkit/ui/options/schedule";
import { requirePageContext } from "@/lib/auth/context";
import { getAnalysis, getVersion } from "@/modules/toolkit/store";
import type { LoanResult } from "@/modules/toolkit/calc/financing";
import { loadPartners } from "../../fitout/data";
import { rs } from "../../fitout/results";
import { FinancingForm } from "../form";

export default async function FinancingView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const ctx = await requirePageContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = (await getAnalysis(ctx.db, ctx.workspaceId, id)) as (Record<string, any> & { versions: Record<string, any>[] }) | null;
  if (!a || a.kind !== "financing") notFound();
  const vNum = sp.v ? Number(sp.v) : null;
  const ver = vNum && vNum !== a.current_version ? await getVersion(ctx.db, ctx.workspaceId, id, vNum) : null;
  const src = ver ?? a;
  const inp = src.inputs as Record<string, string | null>;
  const r = src.outputs as LoanResult;
  const partners = await loadPartners(ctx.db, ctx.workspaceId);
  const cert = inp.status === "actual" ? "confirmed" : inp.status === "approved" || inp.status === "quoted" ? "quoted" : "estimated";
  return (
    <div className="space-y-6">
      <ToolHeader eyebrow={`Financing · version ${ver ? ver.version : a.current_version} · formula ${src.formula_version}${inp.partner ? ` · ${inp.partner}` : ""}`} title={a.title}
        purpose="The key numbers first, then the month-by-month schedule. Edit the loan details below to save a new version."
        back={{ href: "/toolkit/financing", label: "All analyses" }} steps={["Loan details", "Calculate", "Read the schedule"]} current={2}
        action={<span className="flex items-center gap-2 text-sm text-ink-soft">Terms: <Certainty c={cert} /></span>} />
      {ver ? <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">! Viewing older version {ver.version}. <Link className={btn.link} href={`/toolkit/financing/${id}`}>Back to current</Link></div> : null}
      <MissingNote items={r.missing} />
      <Legend />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Readout label="Monthly EMI" value={rs(r.emi)} emphasis sub={`exact ${r.emiExact}; last EMI ${r.schedule.at(-1)?.payment ?? "—"}`} />
        <Readout label="Total interest" value={rs(r.totals.interest)} sub={`over ${r.schedule.length} months`} />
        <Readout label="Effective cost" value={r.effectiveAnnualRatePct === null ? "Unknown" : `${r.effectiveAnnualRatePct}% p.a.`} unknown={r.effectiveAnnualRatePct === null} sub={`Quoted ${inp.annualRatePct ?? "—"}% p.a.${r.effectiveAnnualRatePct === null ? " — add the tax on fee to see this" : " — includes fees"}`} />
        <Readout label="Total cost of financing" value={rs(r.totals.costOfFinancing)} sub={<>interest + fee {rs(r.totals.fee)} + fee tax {r.totals.feeTax === null ? "unknown" : rs(r.totals.feeTax)}</>} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Readout label="Financed amount" value={rs(r.financed)} />
        <Readout label="Total of all payments" value={rs(r.totals.payments)} />
      </div>
      <HowCalc items={["EMI = P·r·(1+r)^n ÷ ((1+r)^n − 1), where r = annual rate ÷ 12. The last EMI is adjusted by a few paise so the loan closes at exactly ₹0.", "Effective cost = annualised monthly IRR of the money actually received (financed amount minus fees and fee tax) against every payment, shown as a nominal annual rate so it compares with the quoted rate."]} />
      <Panel title="Repayment schedule" desc={r.schedule.some((x) => x.phase === "moratorium") ? "Tinted rows marked “Moratorium” are before EMIs start." : "Each month: interest is charged on the opening balance; the rest of the payment reduces the loan."}>
        <CollapsibleTable caption="Amortisation schedule" rowNoun="months" head={["Month", "Opening", "Interest", "Principal", "Payment", "Closing"]}
          rows={r.schedule.map((s) => <tr key={s.month} className={s.phase === "moratorium" ? "!bg-brand-soft/50" : undefined}><td className="px-3 py-2">{s.month}{s.phase === "moratorium" ? <span className="ml-2"><Status s="pending" label="Moratorium" /></span> : null}</td><td className="px-3 py-2 text-right">{rs(s.opening)}</td><td className="px-3 py-2 text-right">{rs(s.interest)}</td><td className="px-3 py-2 text-right">{rs(s.principal)}</td><td className="px-3 py-2 text-right font-medium">{rs(s.payment)}</td><td className="px-3 py-2 text-right">{rs(s.closing)}</td></tr>)}
          foot={<tr><td className="px-3 py-2">Total</td><td /><td className="px-3 py-2 text-right">{rs(r.totals.interest)}</td><td className="px-3 py-2 text-right">{rs(r.totals.principal)}</td><td className="px-3 py-2 text-right">{rs(r.totals.payments)}</td><td /></tr>} />
      </Panel>
      <Panel title="Cash needed by month" desc="What leaves the client's account each month, and why.">
        <CollapsibleTable caption="Cash-flow requirement by month" rowNoun="months" head={["Month", "Cash out", "For"]}
          rows={r.cashflow.map((c) => <tr key={c.month}><td className="px-3 py-2">{c.month}</td><td className="px-3 py-2 text-right">{rs(c.amount)}</td><td className="px-3 py-2 text-right text-xs text-ink-soft">{c.note}</td></tr>)} />
      </Panel>
      <Panel title="Change the loan details" desc="Saving creates a new version."><FinancingForm id={id} title={a.title} initial={inp} partners={partners} /></Panel>
      <details className="group rounded-xl border border-line bg-surface">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2 font-medium">Earlier versions ({a.versions.length}) <span aria-hidden className="transition group-open:rotate-180 motion-reduce:transition-none">▾</span></summary>
        <ul className="space-y-1 border-t border-line px-4 py-3 text-sm">{a.versions.map((v) => <li key={v.version} className="flex flex-wrap items-center gap-2"><Link className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4" href={`/toolkit/financing/${id}?v=${v.version}`}>Version {v.version}</Link> <span className="text-xs text-ink-soft">{new Date(v.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {v.formula_version}{v.note ? ` — ${v.note}` : ""}</span>{v.version === a.current_version ? <Status s="approved" label="Current" /> : null}</li>)}</ul>
      </details>
    </div>
  );
}
