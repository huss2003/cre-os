import { DeckPanel } from "@/modules/toolkit/ui/deck-button";
import Decimal from "decimal.js";
import { Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { leaseEconomicsAction } from "@/modules/toolkit/actions-lease";
import { getAnalysis, listAnalyses } from "@/modules/toolkit/store";
import type { LeaseEconomics, LeaseTerms, OfferComparison } from "@/modules/toolkit/calc/lease";
import { Certainty, EmptyState, Legend, MissingNote, Readout, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";
import { BlankHint, Completeness, H, HowCalculated, In, Panel, SavedList, StickyBar, certOf, offerLetter } from "@/modules/toolkit/ui/lease/shared";
import { LeaseTermFields, Money, Warnings } from "./parts";

type Out = { mode: "single"; result: LeaseEconomics } | { mode: "compare"; comparison: OfferComparison };
const STEPS = ["Enter the offer", "Calculate", "Read the cost breakdown", "Compare offers"];

/** Average rent per sf per month over the tenure, after rent-free and escalation (display only, deterministic). */
function effectiveRent(r: LeaseEconomics): string | null {
  const tenure = r.years.length ? r.years[r.years.length - 1].toMonth : 0;
  if (!tenure || !Number(r.areaSf)) return null;
  return new Decimal(r.totals.rent).div(r.areaSf).div(tenure).toDecimalPlaces(2).toString();
}

function OfferResult({ r }: { r: LeaseEconomics }) {
  const eff = effectiveRent(r);
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <H sub={<>{inr(r.areaSf).replace("₹", "")} sq ft {r.areaBasis} · rent-free {r.rentFreeMonths} months</>}>{r.name}</H>
        <Completeness complete={r.complete} label={r.label} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Readout label="Monthly rent (starting)" value={<Money x={r.monthly.baseRent} />} sub={<>per year <Money x={r.annual.baseRent} /></>} />
        <Readout label="Monthly CAM" value={<Money x={r.monthly.cam} />} unknown={r.monthly.cam === null} sub={<>parking / month <Money x={r.monthly.parking} /></>} />
        <Readout label="Total before other charges (rent + CAM)" value={<Money x={r.monthly.totalBeforeOther ?? null} />} unknown={r.monthly.totalBeforeOther == null} sub={<>CAM escalation: {r.camEscalation ?? "none"} · Other charges: {r.otherCharges ?? "not provided"}</>} />
        <Readout label="Effective rent" value={eff ? `₹${eff} /sf/month` : "—"} unknown={!eff} sub="average after rent-free and escalation" />
        <Readout emphasis label="Total cost over tenure" value={<Money x={r.totals.contractualExpenditure} />} sub={<>present value <Money x={r.totals.npv} /> · <Certainty c={r.complete ? certOf(r.label) : "missing"} /></>} />
        <Readout label="Rent-free benefit" value={<Money x={r.rentFreeBenefit} />} sub="rent you don't pay during rent-free" />
        <div className="rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 px-4 py-3">
          <p className="flex items-center justify-between gap-2 text-xs font-medium text-emerald-900"><span>Refundable deposit</span><span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-800">Not a cost</span></p>
          {r.deposit ? (
            <><p className="mt-1 text-lg font-semibold tabular-nums">{inr(r.deposit.amount)}</p><p className="mt-0.5 text-xs text-emerald-900"><span aria-hidden>↺ </span>Comes back to you — paid at signing, refunded month {r.deposit.refundMonth}.</p></>
          ) : <p className="mt-1 text-sm italic text-ink-soft">Unknown or none — add deposit months to see it.</p>}
        </div>
      </div>
      <MissingNote items={r.gaps} what="the totals above exclude these until you add them" />

      <div className="space-y-2">
        <H sub="Each row is one lease year. Costs only — the deposit column is money that comes back.">Year by year</H>
        <div className="overflow-x-auto">
          <Table head={["Year", "Months", "Rent", "CAM", "Parking", "Other", "One-off", "Total cost", "Deposit (refundable)"]}>
            {r.years.map((y) => <tr key={y.year}><Td className="font-medium">Year {y.year}</Td><Td>{y.fromMonth}–{y.toMonth}</Td><Td>{inr(y.rent)}</Td><Td>{inr(y.cam)}</Td><Td>{inr(y.parking)}</Td><Td>{inr(y.other)}</Td><Td>{inr(y.nonRecurring)}</Td><Td className="font-semibold">{inr(y.expenditure)}</Td><Td className="text-emerald-800">{inr(y.deposit)}</Td></tr>)}
          </Table>
        </div>
      </div>

      <HowCalculated>
        <p>Formula lease-1.0 on the fin-1.0 engine — fixed, deterministic arithmetic (no AI). Blank inputs are unknown and excluded from totals, never treated as zero.</p>
        <p className="font-medium text-ink">Rent by period</p>
        <ul className="list-disc space-y-1 pl-5">{r.rentSteps.map((s) => <li key={s.fromMonth}>Months {s.fromMonth}–{s.toMonth}: ₹{s.ratePerSf}/sf · {inr(s.monthlyRent)}/month · {inr(s.annualRent)}/year</li>)}</ul>
        <p className="font-medium text-ink">Over the tenure</p>
        <dl className="grid max-w-md grid-cols-2 gap-y-1">
          <dt>Rent</dt><dd className="text-right"><Money x={r.totals.rent} /></dd>
          <dt>CAM</dt><dd className="text-right"><Money x={r.totals.cam} /></dd>
          <dt>Parking</dt><dd className="text-right"><Money x={r.totals.parking} /></dd>
          <dt>Other recurring</dt><dd className="text-right"><Money x={r.totals.other} /></dd>
          <dt>One-off</dt><dd className="text-right"><Money x={r.totals.nonRecurring} /></dd>
          <dt className="border-t border-line pt-1 font-semibold text-ink">Total contractual cost</dt><dd className="border-t border-line pt-1 text-right font-semibold text-ink"><Money x={r.totals.contractualExpenditure} /></dd>
        </dl>
        <p>Present value discounts each month&apos;s payment at your discount rate and includes the deposit going out and coming back. Effective rent = total rent ÷ (area × tenure months).</p>
        <p>{r.totalsLabel}</p>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center font-medium hover:text-brand">Month by month ({r.months.length})</summary>
          <div className="overflow-x-auto"><Table head={["Month", "Date", "Rent", "CAM", "Parking", "Other", "Total"]}>
            {r.months.map((m) => <tr key={m.month}><Td>{m.month}</Td><Td>{m.date}</Td><Td>{inr(m.rent)}</Td><Td>{inr(m.cam)}</Td><Td>{inr(m.parking)}</Td><Td>{inr(m.other)}</Td><Td>{inr(m.total)}</Td></tr>)}
          </Table></div>
        </details>
      </HowCalculated>
      <Warnings items={r.warnings} />
    </Panel>
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
  const step = cur && out ? (out.mode === "compare" ? 3 : 2) : 0;
  return (
    <div data-tour="toolkit-lease" className="mx-auto max-w-6xl space-y-6 pb-16">
      <ToolHeader eyebrow="Deal toolkit" title="Lease economics" purpose="What an offer really costs: rent, escalation, rent-free, CAM, parking and deposit over the whole tenure. Add up to four offers to compare them side by side." steps={STEPS} current={step} />
      {sp.id ? <DeckPanel db={ctx.db} ws={ctx.workspaceId} analysisId={sp.id} /> : null}
      <Legend />

      {cur && out ? (
        <section className="space-y-4" aria-label="Results">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold">{cur.title}</h2>
            <span className="text-xs text-ink-soft">version {cur.current_version} · {cur.formula_version}</span>
            <Status s={cur.status ?? "draft"} />
          </div>
          {out.mode === "compare" ? (
            <div className="space-y-6">
              <Panel>
                <H sub={`All offers over the same ${out.comparison.horizonMonths} months, same start date and discount rate. Lowest present value ranks first.`}>Offers compared</H>
                <div className="overflow-x-auto">
                  <Table head={["Rank", "Offer", "Total cost (nominal)", "Present value", "vs first offer (PV)", "Costs"]}>
                    {out.comparison.rows.map((r) => <tr key={r.name}><Td className="font-bold">#{r.rank}</Td><Td className="font-medium">{r.name}</Td><Td>{inr(r.nominalTco)}</Td><Td>{inr(r.npv)}</Td><Td>{inr(r.incrementalNpvVsBaseline)}</Td><Td>{r.complete ? <Status s="ready" label="Complete" /> : <Status s="needs_info" label="Incomplete" />}</Td></tr>)}
                  </Table>
                </div>
                <p className="text-xs text-ink-soft">Nominal total includes the deposit paid and refunded (nets to zero).</p>
              </Panel>
              {out.comparison.offers.map((o) => <OfferResult key={o.name} r={o} />)}
            </div>
          ) : <OfferResult r={out.result} />}
          {cur.versions?.length > 1 && <p className="text-xs text-ink-soft">Earlier versions are kept: {cur.versions.map((v: { version: number }) => `v${v.version}`).join(", ")}.</p>}
        </section>
      ) : null}

      {ctx.role !== "viewer" && (
        <section className="space-y-4" aria-labelledby="lease-form-h">
          <H sub={cur ? "Change any term and recalculate — this saves a new version; earlier ones are kept." : "Area, rent, tenure and start date are enough to start."}><span id="lease-form-h">{cur ? "Change the terms" : "1 · Enter the offer"}</span></H>
          <ActionForm action={leaseEconomicsAction} className="space-y-5" dataTour="lease-form">
            {cur ? <input type="hidden" name="id" value={cur.id} /> : null}
            <BlankHint />
            <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2">
              <In label="Analysis title" name="title" defaultValue={cur?.title ?? ""} placeholder="Baner shortlist — lease terms" />
              <In label="Discount rate" unit="% per year" name="discount" inputMode="decimal" defaultValue={String(discount)} required hint="Used for present value. 0 = undiscounted." />
            </div>
            <div className="grid gap-5 xl:grid-cols-2">
              <LeaseTermFields p="o0_" def={offers[0]} title="Offer A" />
              {[1, 2, 3].map((k) => (
                <details key={k} open={!!offers[k]} className="group min-w-0">
                  <summary className={`${btn.secondary} w-full list-none border-dashed group-open:mb-3`}><span aria-hidden>＋</span> Add offer {offerLetter(k)} <span className="font-normal text-ink-soft group-open:hidden">(compare side by side)</span><span className="hidden font-normal text-ink-soft group-open:inline">— open</span></summary>
                  <LeaseTermFields p={`o${k}_`} def={offers[k]} title={`Offer ${offerLetter(k)}`} />
                </details>
              ))}
            </div>
            <StickyBar note="Calculates with fixed formulas and saves the analysis.">
              <Submit dataTour="lease-save">{cur ? "Recalculate & save new version" : "Calculate & save"}</Submit>
            </StickyBar>
          </ActionForm>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="lease-saved-h">
        <H><span id="lease-saved-h">Saved lease analyses</span></H>
        {saved.length === 0 ? <EmptyState title="Nothing saved yet" text="Enter an offer above — area, rent ₹/sf/month, dates and tenure are enough to start. Add up to three more offers to compare." /> : (
          <SavedList items={saved as any} href={(id) => `/toolkit/lease?id=${id}`} />
        )}
      </section>
    </div>
  );
}
