import { Field, Input } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveRenewalAction } from "@/modules/toolkit/actions-options";
import { NONFIN, NONFIN_LABEL, type RvrInput } from "@/modules/toolkit/calc/renewal";
import { NumField, Section } from "../../managed/_parts/shared";

export function RenewalForm({ id, title, inputs }: { id?: string; title?: string; inputs?: RvrInput | null }) {
  const r = inputs?.renewal; const l = inputs?.relocation;
  return (
    <ActionForm action={saveRenewalAction} className="space-y-3">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Title"><Input name="title" defaultValue={title ?? ""} placeholder="e.g. Kharadi HQ — renew or move" /></Field>
        <NumField name="comparisonMonths" label="Comparison period" suffix="months" dv={inputs?.comparisonMonths} hint="Blank = renewal extension period." />
        <NumField name="discountRatePct" label="Discount rate" suffix="% per year" dv={inputs?.discountRatePct} hint="Used for present value. Enter 0 for undiscounted." />
      </div>
      <Section title="Renewal — rent and term" open>
        <NumField name="r_currentRentMonthly" label="Current rent" suffix="₹/month" dv={r?.currentRentMonthly} />
        <NumField name="r_proposedRentMonthly" label="Proposed rent" suffix="₹/month" dv={r?.proposedRentMonthly} />
        <NumField name="r_extensionMonths" label="Extension" suffix="months" dv={r?.extensionMonths} />
        <NumField name="r_rentFreeMonths" label="Rent-free" suffix="months" dv={r?.rentFreeMonths} />
        <NumField name="r_escPct" label="Escalation" suffix="%" dv={r?.escalation?.pct} />
        <NumField name="r_escEvery" label="Escalation every" suffix="months" dv={r?.escalation?.everyMonths ?? 12} />
      </Section>
      <Section title="Renewal — other costs">
        <NumField name="r_camMonthly" label="CAM" suffix="₹/month" dv={r?.camMonthly} />
        <NumField name="r_maintenanceMonthly" label="Maintenance" suffix="₹/month" dv={r?.maintenanceMonthly} />
        <NumField name="r_otherMonthly" label="Other recurring" suffix="₹/month" dv={r?.otherMonthly} />
        <NumField name="r_refurbishment" label="Refurbishment" suffix="₹" dv={r?.refurbishment} />
        <NumField name="r_otherOneOff" label="Other one-off" suffix="₹" dv={r?.otherOneOff} />
        <NumField name="r_depositChange" label="Deposit change (refundable)" suffix="₹" dv={r?.depositChange} hint="Top-up (+) or release (−). Kept outside cost totals." />
      </Section>
      <Section title="Relocation — rent and term" open>
        <NumField name="l_newRentMonthly" label="New rent" suffix="₹/month" dv={l?.newRentMonthly} />
        <NumField name="l_rentFreeMonths" label="Rent-free" suffix="months" dv={l?.rentFreeMonths} />
        <NumField name="l_overlapMonths" label="Overlap paying both rents" suffix="months" dv={l?.overlapMonths} />
        <NumField name="l_escPct" label="Escalation" suffix="%" dv={l?.escalation?.pct} />
        <NumField name="l_escEvery" label="Escalation every" suffix="months" dv={l?.escalation?.everyMonths ?? 12} />
        <NumField name="l_camMonthly" label="CAM" suffix="₹/month" dv={l?.camMonthly} />
        <NumField name="l_otherMonthly" label="Other recurring" suffix="₹/month" dv={l?.otherMonthly} />
      </Section>
      <Section title="Relocation — move costs and deposits">
        <NumField name="l_fitout" label="Fit-out" suffix="₹" dv={l?.fitout} />
        <NumField name="l_moving" label="Moving" suffix="₹" dv={l?.moving} />
        <NumField name="l_restorationOld" label="Restoration of current premises" suffix="₹" dv={l?.restorationOld} />
        <NumField name="l_brokerage" label="Brokerage" suffix="₹" dv={l?.brokerage} />
        <NumField name="l_itRelocation" label="IT relocation" suffix="₹" dv={l?.itRelocation} />
        <NumField name="l_downtimeCost" label="Downtime cost" suffix="₹" dv={l?.downtimeCost} />
        <NumField name="l_employeeTransition" label="Employee transition" suffix="₹" dv={l?.employeeTransition} />
        <NumField name="l_otherOneOff" label="Other one-off" suffix="₹" dv={l?.otherOneOff} />
        <NumField name="l_deposit" label="New security deposit (refundable)" suffix="₹" dv={l?.deposit} />
        <NumField name="l_oldDepositReturned" label="Current deposit returned" suffix="₹" dv={l?.oldDepositReturned} />
      </Section>
      <Section title="Non-financial scores (1 = poor, 5 = excellent)">
        {NONFIN.map((k) => (
          <div key={k} className="grid grid-cols-2 gap-2 sm:col-span-2">
            <NumField name={`s_${k}_r`} label={`${NONFIN_LABEL[k]} — renewal`} dv={inputs?.scores?.[k]?.renewal} />
            <NumField name={`s_${k}_l`} label={`${NONFIN_LABEL[k]} — relocation`} dv={inputs?.scores?.[k]?.relocation} />
          </div>
        ))}
      </Section>
      <Field label="Version note"><Input name="note" placeholder="what changed (optional)" /></Field>
      <Submit>{id ? "Recalculate & save new version" : "Calculate & save"}</Submit>
    </ActionForm>
  );
}
