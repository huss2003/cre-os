import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Help, PageHeader, Stat, StaleBanner, Table, Td } from "@/components/ui";
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
  return (
    <div className="space-y-5">
      <PageHeader title={a.title} subtitle={<>Financing · formula {src.formula_version} · version {ver ? ver.version : a.current_version}{inp.partner ? ` · ${inp.partner}` : ""} · <Badge tone={inp.status === "approved" || inp.status === "actual" ? "ok" : "neutral"}>{inp.status ?? "estimated"}</Badge> · <Link className="text-brand" href="/toolkit/financing">all analyses</Link></>} />
      {ver ? <StaleBanner>Viewing older version {ver.version}. <Link className="underline" href={`/toolkit/financing/${id}`}>Back to current</Link></StaleBanner> : null}
      {r.missing.length ? <StaleBanner>Needs information: {r.missing.join(" · ")}</StaleBanner> : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Financed amount" value={rs(r.financed)} />
        <Stat label="Monthly EMI" value={rs(r.emi)} hint={`exact ${r.emiExact}; last EMI ${rs(r.schedule.at(-1)?.payment)}`} />
        <Stat label="Total interest" value={rs(r.totals.interest)} />
        <Stat label="Total cost of financing" value={rs(r.totals.costOfFinancing)} hint={<>interest + fee {rs(r.totals.fee)} + fee tax {r.totals.feeTax === null ? "unknown" : rs(r.totals.feeTax)}</>} />
      </div>
      <Card title="Effective cost" help={<Help>Annualised monthly IRR of the money actually received (financed amount minus fees and fee tax) against every payment. Shown as a nominal annual rate so it compares with the quoted rate.</Help>}>
        <p className="text-sm">Quoted {inp.annualRatePct}% p.a. → effective <span className="font-semibold">{r.effectiveAnnualRatePct === null ? "unknown (fee tax not stated)" : `${r.effectiveAnnualRatePct}% p.a.`}</span> · total payments {rs(r.totals.payments)}</p>
      </Card>
      <Card title="Cash-flow requirement by month">
        <div className="max-h-72 overflow-y-auto">
          <Table head={["Month", "Cash out", "For"]}>{r.cashflow.map((c) => <tr key={c.month}><Td>{c.month}</Td><Td>{rs(c.amount)}</Td><Td className="text-xs text-ink-soft">{c.note}</Td></tr>)}</Table>
        </div>
      </Card>
      <Card title="Amortisation schedule">
        <div className="max-h-[32rem] overflow-y-auto">
          <Table head={["Month", "Opening", "Interest", "Principal", "Payment", "Closing"]}>
            {r.schedule.map((s) => <tr key={s.month} className={s.phase === "moratorium" ? "bg-brand-soft/50" : undefined}><Td>{s.month}{s.phase === "moratorium" ? <span className="block text-[11px] text-ink-soft">moratorium</span> : null}</Td><Td>{rs(s.opening)}</Td><Td>{rs(s.interest)}</Td><Td>{rs(s.principal)}</Td><Td>{rs(s.payment)}</Td><Td>{rs(s.closing)}</Td></tr>)}
            <tr className="font-semibold"><Td>Total</Td><Td /><Td>{rs(r.totals.interest)}</Td><Td>{rs(r.totals.principal)}</Td><Td>{rs(r.totals.payments)}</Td><Td /></tr>
          </Table>
        </div>
      </Card>
      <Card title="Versions">
        <ul className="space-y-1 text-sm">{a.versions.map((v) => <li key={v.version}><Link className="text-brand" href={`/toolkit/financing/${id}?v=${v.version}`}>v{v.version}</Link> <span className="text-xs text-ink-soft">{new Date(v.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {v.formula_version}{v.note ? ` — ${v.note}` : ""}</span>{v.version === a.current_version ? <span className="ml-1"><Badge tone="ok">current</Badge></span> : null}</li>)}</ul>
      </Card>
      <Card title="Edit — saves a new version"><FinancingForm id={id} title={a.title} initial={inp} partners={partners} /></Card>
    </div>
  );
}
