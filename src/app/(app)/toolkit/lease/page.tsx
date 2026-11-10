import Link from "next/link";
import { Badge, Card, EmptyState, Field, HelpFor, Input, PageHeader, Stat, Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { leaseEconomicsAction } from "@/modules/toolkit/actions-lease";
import { getAnalysis, listAnalyses } from "@/modules/toolkit/store";
import type { LeaseEconomics, LeaseTerms, OfferComparison } from "@/modules/toolkit/calc/lease";
import { LeaseTermFields, Money, Warnings } from "./parts";

type Out = { mode: "single"; result: LeaseEconomics } | { mode: "compare"; comparison: OfferComparison };

function OfferResult({ r }: { r: LeaseEconomics }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-serif text-xl">{r.name}</h3>
        <Badge tone={r.label === "quoted" ? "ok" : "warn"}>{r.label}</Badge>
        <Badge tone={r.complete ? "ok" : "warn"}>{r.totalsLabel}</Badge>
        <span className="text-xs text-ink-soft">{inr(r.areaSf).replace("₹", "")} sf {r.areaBasis} · rent-free {r.rentFreeMonths} mo</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Base rent / month" value={<Money x={r.monthly.baseRent} />} hint={<>per year <Money x={r.annual.baseRent} /></>} />
        <Stat label="CAM / month" value={<Money x={r.monthly.cam} />} hint={<>per year <Money x={r.annual.cam} /></>} />
        <Stat label="Parking / month" value={<Money x={r.monthly.parking} />} hint={<>other / month <Money x={r.monthly.other} /></>} />
        <Stat label="Rent-free benefit" value={<Money x={r.rentFreeBenefit} compact />} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-line p-4 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Over the tenure</p>
          <dl className="mt-2 grid grid-cols-2 gap-y-1">
            <dt>Rent</dt><dd className="text-right"><Money x={r.totals.rent} /></dd>
            <dt>CAM</dt><dd className="text-right"><Money x={r.totals.cam} /></dd>
            <dt>Parking</dt><dd className="text-right"><Money x={r.totals.parking} /></dd>
            <dt>Other recurring</dt><dd className="text-right"><Money x={r.totals.other} /></dd>
            <dt>Non-recurring</dt><dd className="text-right"><Money x={r.totals.nonRecurring} /></dd>
            <dt className="border-t border-line pt-1 font-semibold">Total contractual occupancy expenditure</dt><dd className="border-t border-line pt-1 text-right font-semibold"><Money x={r.totals.contractualExpenditure} /></dd>
            <dt className="text-ink-soft">Present value (incl. deposit timing)</dt><dd className="text-right text-ink-soft"><Money x={r.totals.npv} /></dd>
          </dl>
        </div>
        <div className="rounded-2xl border border-line p-4 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Security deposit — refundable, not an expense</p>
          {r.deposit ? <p className="mt-2"><span className="text-lg font-semibold">{inr(r.deposit.amount)}</span><br /><span className="text-ink-soft">paid at signing (month 0), refunded month {r.deposit.refundMonth}</span></p> : <p className="mt-2"><Badge tone="warn">unknown or none</Badge></p>}
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Escalated rent by period</p>
          <ul className="mt-1 space-y-1">{r.rentSteps.map((s) => <li key={s.fromMonth}>Months {s.fromMonth}–{s.toMonth}: ₹{s.ratePerSf}/sf · {inr(s.monthlyRent)}/mo · {inr(s.annualRent)}/yr</li>)}</ul>
        </div>
      </div>
      <Table head={["Year", "Months", "Rent", "CAM", "Parking", "Other", "One-off", "Expenditure", "Deposit (refundable)"]}>
        {r.years.map((y) => <tr key={y.year}><Td>{y.year}</Td><Td>{y.fromMonth}–{y.toMonth}</Td><Td>{inr(y.rent)}</Td><Td>{inr(y.cam)}</Td><Td>{inr(y.parking)}</Td><Td>{inr(y.other)}</Td><Td>{inr(y.nonRecurring)}</Td><Td className="font-medium">{inr(y.expenditure)}</Td><Td className="text-ink-soft">{inr(y.deposit)}</Td></tr>)}
      </Table>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-ink-soft hover:text-brand">Month by month ({r.months.length})</summary>
        <div className="mt-2"><Table head={["Month", "Date", "Rent", "CAM", "Parking", "Other", "Total"]}>
          {r.months.map((m) => <tr key={m.month}><Td>{m.month}</Td><Td>{m.date}</Td><Td>{inr(m.rent)}</Td><Td>{inr(m.cam)}</Td><Td>{inr(m.parking)}</Td><Td>{inr(m.other)}</Td><Td>{inr(m.total)}</Td></tr>)}
        </Table></div>
      </details>
      <Warnings items={r.warnings} />
    </section>
  );
}

export default async function LeasePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const [saved, cur] = await Promise.all([
    listAnalyses(ctx.db, ctx.workspaceId, { kind: "lease_economics", limit: 20 }),
    sp.id ? (getAnalysis(ctx.db, ctx.workspaceId, sp.id) as Promise<Record<string, any> | null>) : Promise.resolve(null),
  ]);
  const out = cur?.outputs as Out | undefined;
  const offers: LeaseTerms[] = (cur?.inputs as { offers?: LeaseTerms[] } | undefined)?.offers ?? [];
  const discount = offers[0]?.discountRatePct ?? "";
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      <PageHeader title="Lease economics" subtitle="Rent, escalation, rent-free, CAM, parking and deposit over the tenure. Formula lease-1.0 on the fin-1.0 engine — deterministic; blanks are unknown, never zero." />
      {cur && out ? (
        <Card title={<span>{cur.title} <span className="text-xs font-normal text-ink-soft">v{cur.current_version} · {cur.formula_version}</span></span>}>
          {out.mode === "compare" ? (
            <div className="space-y-8">
              <Table head={["Rank", "Offer", "Nominal total", "Present value", "vs first offer (PV)", "Costs"]}>
                {out.comparison.rows.map((r) => <tr key={r.name}><Td>{r.rank}</Td><Td className="font-medium">{r.name}</Td><Td>{inr(r.nominalTco)}</Td><Td>{inr(r.npv)}</Td><Td>{inr(r.incrementalNpvVsBaseline)}</Td><Td>{r.complete ? <Badge tone="ok">complete</Badge> : <Badge tone="warn">incomplete</Badge>}</Td></tr>)}
              </Table>
              <p className="text-xs text-ink-soft">All offers compared over the same {out.comparison.horizonMonths} months, same start date and discount rate. Nominal total includes the deposit paid and refunded (nets to zero).</p>
              {out.comparison.offers.map((o) => <OfferResult key={o.name} r={o} />)}
            </div>
          ) : <OfferResult r={out.result} />}
          {cur.versions?.length > 1 && <p className="mt-4 text-xs text-ink-soft">Earlier versions are kept: {cur.versions.map((v: { version: number }) => `v${v.version}`).join(", ")}.</p>}
        </Card>
      ) : null}

      {ctx.role !== "viewer" && (
        <Card title={<span className="flex items-center">{cur ? "Change the terms (saves a new version)" : "New lease analysis"}<HelpFor k="Lease economics" /></span>}>
          <ActionForm action={leaseEconomicsAction} className="space-y-4">
            {cur ? <input type="hidden" name="id" value={cur.id} /> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Title"><Input name="title" defaultValue={cur?.title ?? ""} placeholder="Baner shortlist — lease terms" /></Field>
              <Field label="Discount % p.a." hint="Used for present value. 0 = undiscounted."><Input name="discount" inputMode="decimal" defaultValue={String(discount)} required /></Field>
            </div>
            <LeaseTermFields p="o0_" def={offers[0]} title="Offer 1" />
            {[1, 2, 3].map((k) => (
              <details key={k} open={!!offers[k]} className="group">
                <summary className="cursor-pointer text-sm font-medium text-ink-soft hover:text-brand">＋ Offer {k + 1} (compare side by side)</summary>
                <div className="mt-3"><LeaseTermFields p={`o${k}_`} def={offers[k]} title={`Offer ${k + 1}`} /></div>
              </details>
            ))}
            <Submit>{cur ? "Recalculate & save new version" : "Calculate & save"}</Submit>
          </ActionForm>
        </Card>
      )}

      <Card title="Saved lease analyses">
        {saved.length === 0 ? <EmptyState title="Nothing saved yet">Enter an offer above — area, rent ₹/sf/month, dates and tenure are enough to start. Add up to three more offers to compare.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">
            {saved.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2"><Link className="text-brand" href={`/toolkit/lease?id=${a.id}`}>{a.title}</Link><span className="flex gap-1.5 text-xs text-ink-soft">v{a.current_version} <Badge tone={a.status === "needs_info" ? "warn" : "neutral"}>{a.status === "needs_info" ? "needs info" : a.status}</Badge></span></li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
