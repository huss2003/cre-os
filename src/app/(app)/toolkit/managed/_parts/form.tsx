import { Field, Input, Select, Textarea } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveManagedAction } from "@/modules/toolkit/actions-options";
import { DEFAULT_WEIGHTS, MANAGED_SERVICES, SERVICE_LABEL, type CvmInput } from "@/modules/toolkit/calc/managed";
import { NumField, Section } from "./shared";

export function ManagedForm({ id, title, inputs }: { id?: string; title?: string; inputs?: CvmInput | null }) {
  const c = inputs?.conventional; const m = inputs?.managed; const w = inputs?.weights;
  const inc = new Set(m?.included ?? ["utilities", "housekeeping", "maintenance", "internet", "furniture", "reception", "security"]);
  return (
    <ActionForm action={saveManagedAction} className="space-y-3">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Title"><Input name="title" defaultValue={title ?? ""} placeholder="e.g. Baner 100 seats — lease vs managed" /></Field>
        <NumField name="comparisonMonths" label="Comparison period" suffix="months" dv={inputs?.comparisonMonths} hint="Both options are costed over the same months. Blank = the longer of the two terms." />
        <NumField name="headcount" label="Headcount" suffix="employees" dv={inputs?.headcount} />
      </div>
      <Section title="Conventional lease — rent, area, capacity" open>
        <NumField name="c_rentRate" label="Rent" suffix="₹/sf/month" dv={c?.rentRate} />
        <Field label="Rent area basis" hint="Rent is quoted on chargeable (super built-up) or carpet area — must be explicit.">
          <Select name="c_rentBasis" defaultValue={c?.rentBasis ?? "chargeable"}><option value="chargeable">Chargeable</option><option value="carpet">Carpet</option></Select>
        </Field>
        <NumField name="c_chargeableSf" label="Chargeable area" suffix="sf" dv={c?.chargeableSf} />
        <NumField name="c_carpetSf" label="Carpet area" suffix="sf" dv={c?.carpetSf} />
        <NumField name="c_seats" label="Usable seats" dv={c?.seats} />
        <NumField name="c_camRate" label="CAM" suffix="₹/sf/month" dv={c?.camRate} />
        <Field label="CAM area basis"><Select name="c_camBasis" defaultValue={c?.camBasis ?? "chargeable"}><option value="chargeable">Chargeable</option><option value="carpet">Carpet</option></Select></Field>
        <NumField name="c_tenureMonths" label="Tenure" suffix="months" dv={c?.tenureMonths} />
        <NumField name="c_lockInMonths" label="Lock-in" suffix="months" dv={c?.lockInMonths} hint="Blank = tenure." />
        <NumField name="c_escPct" label="Escalation" suffix="%" dv={c?.escalation?.pct} />
        <NumField name="c_escEvery" label="Escalation every" suffix="months" dv={c?.escalation?.everyMonths ?? 12} />
      </Section>
      <Section title="Conventional lease — one-off costs and deposit">
        <NumField name="c_deposit" label="Security deposit (refundable)" suffix="₹" dv={c?.deposit} />
        <NumField name="c_fitout" label="Fit-out" suffix="₹" dv={c?.fitout} />
        <NumField name="c_furniture" label="Furniture" suffix="₹" dv={c?.furniture} />
        <NumField name="c_it" label="IT / cabling" suffix="₹" dv={c?.it} />
        <NumField name="c_restoration" label="Restoration at exit" suffix="₹" dv={c?.restoration} />
      </Section>
      <Section title="Conventional lease — monthly running costs">
        <NumField name="c_utilitiesMonthly" label="Utilities" suffix="₹/month" dv={c?.utilitiesMonthly} />
        <NumField name="c_housekeepingMonthly" label="Housekeeping" suffix="₹/month" dv={c?.housekeepingMonthly} />
        <NumField name="c_maintenanceMonthly" label="Maintenance" suffix="₹/month" dv={c?.maintenanceMonthly} />
        <NumField name="c_parkingMonthly" label="Parking" suffix="₹/month" dv={c?.parkingMonthly} />
        <NumField name="c_otherServicesMonthly" label="Other services (security, reception…)" suffix="₹/month" dv={c?.otherServicesMonthly} />
      </Section>
      <Section title="Managed office — price, seats, term" open>
        <NumField name="m_perSeatPrice" label="Price per seat" suffix="₹/seat/month" dv={m?.perSeatPrice} />
        <NumField name="m_seats" label="Seats" dv={m?.seats} />
        <NumField name="m_contractMonths" label="Contract length" suffix="months" dv={m?.contractMonths} />
        <NumField name="m_lockInMonths" label="Lock-in" suffix="months" dv={m?.lockInMonths} hint="Blank = contract length." />
        <NumField name="m_escPct" label="Escalation" suffix="%" dv={m?.escalation?.pct} />
        <NumField name="m_escEvery" label="Escalation every" suffix="months" dv={m?.escalation?.everyMonths ?? 12} />
        <NumField name="m_deposit" label="Security deposit (refundable)" suffix="₹" dv={m?.deposit} />
        <NumField name="m_setup" label="Setup / onboarding fee" suffix="₹" dv={m?.setup} />
      </Section>
      <Section title="Managed office — included services" open>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm text-ink-soft">Tick what the seat price includes. Ticked services are never costed again, even if you enter an amount below.</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {MANAGED_SERVICES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" name="m_included" value={s} defaultChecked={inc.has(s)} />{SERVICE_LABEL[s]}</label>
            ))}
          </div>
        </fieldset>
        <NumField name="m_meetingRoomHours" label="Meeting-room allowance" suffix="hours/month" dv={m?.meetingRoomHours} />
      </Section>
      <Section title="Managed office — separately charged items">
        <NumField name="m_internetMonthly" label="Internet" suffix="₹/month" dv={m?.internetMonthly} />
        <NumField name="m_utilitiesMonthly" label="Utilities" suffix="₹/month" dv={m?.utilitiesMonthly} />
        <NumField name="m_housekeepingMonthly" label="Housekeeping" suffix="₹/month" dv={m?.housekeepingMonthly} />
        <NumField name="m_receptionMonthly" label="Reception" suffix="₹/month" dv={m?.receptionMonthly} />
        <NumField name="m_securityMonthly" label="Security" suffix="₹/month" dv={m?.securityMonthly} />
        <NumField name="m_maintenanceMonthly" label="Maintenance" suffix="₹/month" dv={m?.maintenanceMonthly} />
        <NumField name="m_parkingMonthly" label="Parking" suffix="₹/month" dv={m?.parkingMonthly} />
        <NumField name="m_addOnsMonthly" label="Add-ons" suffix="₹/month" dv={m?.addOnsMonthly} />
        <NumField name="m_furniture" label="Furniture" suffix="₹ one-off" dv={m?.furniture} />
        <NumField name="m_it" label="IT setup" suffix="₹ one-off" dv={m?.it} />
        <Field label="Exclusions"><Textarea name="m_exclusions" defaultValue={m?.exclusions ?? ""} /></Field>
        <Field label="Flexibility notes"><Textarea name="m_flexibilityNotes" defaultValue={m?.flexibilityNotes ?? ""} placeholder="expansion / contraction terms, notice" /></Field>
      </Section>
      <Section title="Decision criteria">
        <NumField name="c_monthsToOccupy" label="Conventional: months to occupy" dv={c?.monthsToOccupy} />
        <NumField name="m_monthsToOccupy" label="Managed: months to occupy" dv={m?.monthsToOccupy} />
        <NumField name="c_control" label="Conventional: control (1–5)" dv={c?.control} />
        <NumField name="m_control" label="Managed: control (1–5)" dv={m?.control} />
        {(Object.keys(DEFAULT_WEIGHTS) as (keyof typeof DEFAULT_WEIGHTS)[]).map((k) => (
          <NumField key={k} name={`w_${k}`} label={`Weight: ${k}`} dv={w?.[k] ?? DEFAULT_WEIGHTS[k]} />
        ))}
      </Section>
      <Field label="Version note"><Input name="note" placeholder="what changed (optional)" /></Field>
      <Submit>{id ? "Recalculate & save new version" : "Calculate & save"}</Submit>
    </ActionForm>
  );
}
