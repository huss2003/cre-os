import { DeckPanel } from "@/modules/toolkit/ui/deck-button";
import { Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { occupancyAction } from "@/modules/toolkit/actions-lease";
import { getAnalysis, listAnalyses } from "@/modules/toolkit/store";
import type { Extras, LeaseTerms, OccupancyResult, SensitivityOverrides, occupancySensitivity } from "@/modules/toolkit/calc/lease";
import { EmptyState, FormSection, Legend, MissingNote, Readout, Status, ToolHeader } from "@/modules/toolkit/ui/kit";
import { BlankHint, Completeness, Delta, H, HowCalculated, In, Panel, SavedList, StickyBar } from "@/modules/toolkit/ui/lease/shared";
import { CumulativeChart, LeaseTermFields, Money, Warnings } from "../lease/parts";

type Out = { result: OccupancyResult; sensitivity: ReturnType<typeof occupancySensitivity> | null };
type In_ = { terms: LeaseTerms; extras: Extras; overrides: SensitivityOverrides | null };
const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));
const STEPS = ["Enter lease terms", "Add cash at signing", "Try “What if…”", "Calculate & read"];

export default async function OccupancyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const [saved, cur] = await Promise.all([
    listAnalyses(ctx.db, ctx.workspaceId, { kind: "occupancy", limit: 20 }),
    sp.id ? (getAnalysis(ctx.db, ctx.workspaceId, sp.id) as Promise<Record<string, any> | null>) : Promise.resolve(null),
  ]);
  const out = cur?.outputs as Out | undefined;
  const inp = cur?.inputs as In_ | undefined;
  const r = out?.result;
  const so = inp?.overrides ?? {};
  const sens = out?.sensitivity;
  return (
    <div data-tour="toolkit-occupancy" className="mx-auto max-w-5xl space-y-6 pb-16">
      <ToolHeader eyebrow="Deal toolkit" title="Occupancy economics" purpose="Nominal vs effective rent, cash needed up front, present value and peak cash — plus “what if” checks that show how much each change moves the numbers." steps={STEPS} current={cur && r ? 3 : 0} />
      {sp.id ? <DeckPanel db={ctx.db} ws={ctx.workspaceId} analysisId={sp.id} /> : null}
      <Legend />

      {cur && r ? (
        <section className="space-y-4" aria-label="Results">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold">{cur.title}</h2>
            <span className="text-xs text-ink-soft">version {cur.current_version} · {cur.formula_version}</span>
            <Status s={cur.status ?? "draft"} />
          </div>
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-2"><H>Summary</H><Completeness complete={r.complete} label={r.label} /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Readout label="Nominal rent" value={`₹${r.nominalRentPerSf} /sf/month`} sub="as quoted" />
              <Readout emphasis label="Effective rent" value={`₹${r.effectiveRentPerSf} /sf/month`} sub={<>after rent-free & escalation{r.pvEffectiveRentPerSf ? <> · PV-level ₹{r.pvEffectiveRentPerSf}</> : null}</>} />
              <Readout label="Present value" value={<Money x={r.presentValue} compact />} sub={<>nominal <Money x={r.nominalTotal} compact /></>} />
              <Readout label="Peak cash needed" value={<Money x={r.peakCashRequirement} compact />} sub={`highest month: ${inr(r.peakMonthlyOutflow, { compact: true })} (month ${r.peakMonthlyOutflowMonth})`} />
            </div>
            <MissingNote items={r.gaps} what="totals exclude these until you add them" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl bg-canvas p-4 text-sm">
                <p className="font-semibold">Cash needed at signing</p>
                <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1.5">
                  {r.cashFunding.map((c) => <div key={c.label} className="contents"><dt>{c.label}{c.refundable ? <span className="ml-1 text-xs text-emerald-800">(↺ comes back to you)</span> : null}</dt><dd className="text-right tabular-nums"><Money x={c.amount} /></dd></div>)}
                  <dt className="border-t border-line pt-1 font-semibold">Total{r.cashFundingComplete ? "" : " (known items only)"}</dt><dd className="border-t border-line pt-1 text-right font-semibold tabular-nums">{inr(r.cashFundingTotal)}</dd>
                </dl>
              </div>
              <div className="rounded-xl bg-canvas p-4"><CumulativeChart series={r.cumulative} label="Cumulative cash out, month 0 → end (deposit refund shows as the final drop)" /></div>
            </div>
          </Panel>

          {sens ? (
            <Panel>
              <H sub="Your “What if…” values compared with the base case. ▼ = cheaper, ▲ = dearer.">What if… — result</H>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Readout label="Present value" value={inr(sens.adjusted.presentValue)} sub={<><Delta x={sens.change.presentValue} /><br />base {inr(sens.base.presentValue)}</>} />
                <Readout label="Nominal total" value={inr(sens.adjusted.nominalTotal)} sub={<><Delta x={sens.change.nominalTotal} /><br />base {inr(sens.base.nominalTotal)}</>} />
                <Readout label="Peak cash" value={inr(sens.adjusted.peakCash)} sub={<><Delta x={sens.change.peakCash} /><br />base {inr(sens.base.peakCash)}</>} />
                <Readout label="Effective rent" value={`₹${sens.adjusted.effectiveRentPerSf} /sf`} sub={`base ₹${sens.base.effectiveRentPerSf} /sf`} />
              </div>
              {sens.note ? <p role="status" className="text-sm text-amber-900"><span aria-hidden>! </span>{sens.note}</p> : null}
            </Panel>
          ) : null}

          <Panel>
            <H sub="Standard checks run automatically on every analysis.">Standard what-ifs</H>
            <div className="overflow-x-auto">
              <Table head={["If…", "Present value", "Change"]}>
                {r.standardSensitivities.map((x) => <tr key={x.label}><Td>{x.label}</Td><Td>{inr(x.npv)}</Td><Td><Delta x={x.npvChange} /></Td></tr>)}
              </Table>
            </div>
            <HowCalculated>
              <p>Formula occ-1.0 on the fin-1.0 engine — fixed, deterministic arithmetic (no AI). What-ifs recalculate on the server.</p>
              <p>Effective rent = total rent paid ÷ (area × tenure months). PV-level rent is the flat rent with the same present value.</p>
              <p>Peak cash is the highest cumulative cash out at any month, including the deposit before it is refunded.</p>
              <p>{r.totalsLabel}</p>
            </HowCalculated>
            <Warnings items={r.warnings} />
          </Panel>
        </section>
      ) : null}

      {ctx.role !== "viewer" && (
        <section className="space-y-4" aria-labelledby="occ-form-h">
          <H sub={cur ? "Change anything and recalculate — this saves a new version." : "Lease terms plus whatever you know of the up-front costs."}><span id="occ-form-h">{cur ? "Adjust and recalculate" : "New occupancy analysis"}</span></H>
          <ActionForm action={occupancyAction} className="space-y-5">
            {cur ? <input type="hidden" name="id" value={cur.id} /> : null}
            <BlankHint />
            <div className="grid grid-cols-1 gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2">
              <In label="Analysis title" name="title" defaultValue={cur?.title ?? ""} placeholder="Option A — all-in" />
              <In label="Discount rate" unit="% per year" name="discount" inputMode="decimal" required defaultValue={v(inp?.terms.discountRatePct)} />
            </div>
            <LeaseTermFields p="o0_" def={inp?.terms} title="Lease terms" />
            <FormSection title="Cash at signing" desc="Money going out before or at move-in.">
              <In label="Advance rent" unit="months" name="adv" inputMode="decimal" defaultValue={v(inp?.extras.advanceRentMonths)} hint="Adjusted against the first rent-paying months." />
              <In label="Fit-out" unit="₹" name="fitout" inputMode="decimal" defaultValue={v(inp?.extras.fitoutCost)} />
              <In label="Moving" unit="₹" name="moving" inputMode="decimal" defaultValue={v(inp?.extras.movingCost)} />
              <In label="Initial charges" unit="₹" name="initial" inputMode="decimal" defaultValue={v(inp?.extras.initialCharges)} hint="Stamp duty, registration, legal, brokerage." />
            </FormSection>
            <FormSection title="What if… (optional)" desc="Type a different value to see how much it changes the result. Leave blank to keep the base value." defaultOpen={!!inp?.overrides}>
              <In label="What if rent were" unit="₹/sf/month" name="s_rent" inputMode="decimal" defaultValue={v(so.rentPerSf)} />
              <In label="What if escalation were" unit="%" name="s_esc" inputMode="decimal" defaultValue={v(so.escalationPct)} />
              <In label="What if tenure were" unit="months" name="s_tenure" inputMode="numeric" defaultValue={v(so.tenureMonths)} />
              <In label="What if rent-free were" unit="months" name="s_rf" inputMode="numeric" defaultValue={v(so.rentFreeMonths)} />
              <In label="What if CAM were" unit="₹/sf/month" name="s_cam" inputMode="decimal" defaultValue={v(so.camPerSf)} />
              <In label="What if discount rate were" unit="%" name="s_disc" inputMode="decimal" defaultValue={v(so.discountRatePct)} />
              <In label="What if deposit were" unit="months" name="s_dep" inputMode="decimal" defaultValue={v(so.depositMonths)} />
              <In label="What if other charges were" unit="₹/month" name="s_other" inputMode="decimal" defaultValue={v(so.otherMonthly)} />
            </FormSection>
            <StickyBar note="Calculates with fixed formulas and saves the analysis.">
              <Submit>{cur ? "Recalculate & save new version" : "Calculate & save"}</Submit>
            </StickyBar>
          </ActionForm>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="occ-saved-h">
        <H><span id="occ-saved-h">Saved occupancy analyses</span></H>
        {saved.length === 0 ? <EmptyState title="Nothing saved yet" text="Enter the lease terms and whatever you know of the up-front costs. Unknown costs are listed, never counted as zero." /> : (
          <SavedList items={saved as any} href={(id) => `/toolkit/occupancy?id=${id}`} />
        )}
      </section>
    </div>
  );
}
