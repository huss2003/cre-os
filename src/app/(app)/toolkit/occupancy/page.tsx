import { Fragment } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, Field, HelpFor, Input, PageHeader, Stat, Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { occupancyAction } from "@/modules/toolkit/actions-lease";
import { getAnalysis, listAnalyses } from "@/modules/toolkit/store";
import type { Extras, LeaseTerms, OccupancyResult, SensitivityOverrides, occupancySensitivity } from "@/modules/toolkit/calc/lease";
import { CumulativeChart, LeaseTermFields, Money, Warnings } from "../lease/parts";

type Out = { result: OccupancyResult; sensitivity: ReturnType<typeof occupancySensitivity> | null };
type In = { terms: LeaseTerms; extras: Extras; overrides: SensitivityOverrides | null };
const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));

export default async function OccupancyPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const [saved, cur] = await Promise.all([
    listAnalyses(ctx.db, ctx.workspaceId, { kind: "occupancy", limit: 20 }),
    sp.id ? (getAnalysis(ctx.db, ctx.workspaceId, sp.id) as Promise<Record<string, any> | null>) : Promise.resolve(null),
  ]);
  const out = cur?.outputs as Out | undefined;
  const inp = cur?.inputs as In | undefined;
  const r = out?.result;
  const so = inp?.overrides ?? {};
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      <PageHeader title="Occupancy economics" subtitle="Nominal vs effective rent, cash needed up front, present value and peak cash. Formula occ-1.0 on the fin-1.0 engine; sensitivities recalculate on the server." />
      {cur && r ? (
        <Card title={<span>{cur.title} <span className="text-xs font-normal text-ink-soft">v{cur.current_version} · {cur.formula_version}</span></span>}>
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2"><Badge tone={r.label === "quoted" ? "ok" : "warn"}>{r.label}</Badge><Badge tone={r.complete ? "ok" : "warn"}>{r.totalsLabel}</Badge></div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Nominal rent" value={`₹${r.nominalRentPerSf}`} hint="per sf per month, as quoted" />
              <Stat label="Effective rent" value={`₹${r.effectiveRentPerSf}`} hint={<>after rent-free & escalation (average){r.pvEffectiveRentPerSf ? <> · PV-level ₹{r.pvEffectiveRentPerSf}</> : null}</>} />
              <Stat label="Present value" value={<Money x={r.presentValue} compact />} hint={<>nominal <Money x={r.nominalTotal} compact /></>} />
              <Stat label="Peak cash requirement" value={<Money x={r.peakCashRequirement} compact />} hint={`highest month: ${inr(r.peakMonthlyOutflow, { compact: true })} (month ${r.peakMonthlyOutflowMonth})`} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-line p-4 text-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Cash funding at signing</p>
                <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1">
                  {r.cashFunding.map((c) => <Fragment key={c.label}><dt>{c.label}</dt><dd className="text-right"><Money x={c.amount} /></dd></Fragment>)}
                  <dt className="border-t border-line pt-1 font-semibold">Total{r.cashFundingComplete ? "" : " (known items only)"}</dt><dd className="border-t border-line pt-1 text-right font-semibold">{inr(r.cashFundingTotal)}</dd>
                </dl>
              </div>
              <div className="rounded-2xl border border-line p-4"><CumulativeChart series={r.cumulative} label="Cumulative cash out, month 0 → end (deposit refund shows as the final drop)" /></div>
            </div>
            {out!.sensitivity ? (
              <Table head={["Your sensitivity", "Base", "Adjusted", "Change"]}>
                <tr><Td>Present value</Td><Td>{inr(out!.sensitivity.base.presentValue)}</Td><Td>{inr(out!.sensitivity.adjusted.presentValue)}</Td><Td className="font-medium">{inr(out!.sensitivity.change.presentValue)}</Td></tr>
                <tr><Td>Nominal total</Td><Td>{inr(out!.sensitivity.base.nominalTotal)}</Td><Td>{inr(out!.sensitivity.adjusted.nominalTotal)}</Td><Td className="font-medium">{inr(out!.sensitivity.change.nominalTotal)}</Td></tr>
                <tr><Td>Peak cash</Td><Td>{inr(out!.sensitivity.base.peakCash)}</Td><Td>{inr(out!.sensitivity.adjusted.peakCash)}</Td><Td className="font-medium">{inr(out!.sensitivity.change.peakCash)}</Td></tr>
                <tr><Td>Effective rent ₹/sf</Td><Td>{out!.sensitivity.base.effectiveRentPerSf}</Td><Td>{out!.sensitivity.adjusted.effectiveRentPerSf}</Td><Td /></tr>
              </Table>
            ) : null}
            <Table head={["Standard sensitivity", "PV", "Change"]}>
              {r.standardSensitivities.map((x) => <tr key={x.label}><Td>{x.label}</Td><Td>{inr(x.npv)}</Td><Td>{inr(x.npvChange)}</Td></tr>)}
            </Table>
            <Warnings items={r.warnings} />
          </div>
        </Card>
      ) : null}

      {ctx.role !== "viewer" && (
        <Card title={<span className="flex items-center">{cur ? "Adjust and recalculate (new version)" : "New occupancy analysis"}<HelpFor k="Occupancy economics" /></span>}>
          <ActionForm action={occupancyAction} className="space-y-4">
            {cur ? <input type="hidden" name="id" value={cur.id} /> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Title"><Input name="title" defaultValue={cur?.title ?? ""} placeholder="Option A — all-in" /></Field>
              <Field label="Discount % p.a."><Input name="discount" inputMode="decimal" required defaultValue={v(inp?.terms.discountRatePct)} /></Field>
            </div>
            <LeaseTermFields p="o0_" def={inp?.terms} title="Lease terms" />
            <fieldset className="grid grid-cols-2 gap-3 rounded-2xl border border-line p-4">
              <legend className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Cash at signing (blank = unknown)</legend>
              <Field label="Advance rent (months)" hint="Paid at signing and adjusted against the first rent-paying months."><Input name="adv" inputMode="decimal" defaultValue={v(inp?.extras.advanceRentMonths)} /></Field>
              <Field label="Fit-out ₹"><Input name="fitout" inputMode="decimal" defaultValue={v(inp?.extras.fitoutCost)} /></Field>
              <Field label="Moving ₹"><Input name="moving" inputMode="decimal" defaultValue={v(inp?.extras.movingCost)} /></Field>
              <Field label="Initial charges ₹" hint="Stamp duty, registration, legal, brokerage."><Input name="initial" inputMode="decimal" defaultValue={v(inp?.extras.initialCharges)} /></Field>
            </fieldset>
            <fieldset className="grid grid-cols-2 gap-3 rounded-2xl border border-line p-4 sm:grid-cols-4">
              <legend className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">Sensitivity — try other values (optional)</legend>
              <Field label="Rent ₹/sf"><Input name="s_rent" inputMode="decimal" defaultValue={v(so.rentPerSf)} /></Field>
              <Field label="Escalation %"><Input name="s_esc" inputMode="decimal" defaultValue={v(so.escalationPct)} /></Field>
              <Field label="Tenure (mo)"><Input name="s_tenure" inputMode="numeric" defaultValue={v(so.tenureMonths)} /></Field>
              <Field label="Rent-free (mo)"><Input name="s_rf" inputMode="numeric" defaultValue={v(so.rentFreeMonths)} /></Field>
              <Field label="CAM ₹/sf"><Input name="s_cam" inputMode="decimal" defaultValue={v(so.camPerSf)} /></Field>
              <Field label="Discount %"><Input name="s_disc" inputMode="decimal" defaultValue={v(so.discountRatePct)} /></Field>
              <Field label="Deposit (mo)"><Input name="s_dep" inputMode="decimal" defaultValue={v(so.depositMonths)} /></Field>
              <Field label="Other ₹/month"><Input name="s_other" inputMode="decimal" defaultValue={v(so.otherMonthly)} /></Field>
            </fieldset>
            <Submit>{cur ? "Recalculate & save new version" : "Calculate & save"}</Submit>
          </ActionForm>
        </Card>
      )}

      <Card title="Saved occupancy analyses">
        {saved.length === 0 ? <EmptyState title="Nothing saved yet">Enter the lease terms and whatever you know of the up-front costs. Unknown costs are listed, never counted as zero.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">
            {saved.map((a) => <li key={a.id} className="flex items-center justify-between gap-2 py-2"><Link className="text-brand" href={`/toolkit/occupancy?id=${a.id}`}>{a.title}</Link><span className="flex gap-1.5 text-xs text-ink-soft">v{a.current_version} <Badge tone={a.status === "needs_info" ? "warn" : "neutral"}>{a.status === "needs_info" ? "needs info" : a.status}</Badge></span></li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
