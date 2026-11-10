import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveManagedAction } from "@/modules/toolkit/actions-options";
import { DEFAULT_WEIGHTS, MANAGED_SERVICES, SERVICE_LABEL, type CvmInput } from "@/modules/toolkit/calc/managed";
import { Field, inputCls } from "@/modules/toolkit/ui/kit";
import { Group, NumIn, OptionCard, StickyBar, TextIn, ToggleChips } from "@/modules/toolkit/ui/options/parts";

const WEIGHT_LABEL: Record<keyof typeof DEFAULT_WEIGHTS, string> = { cost: "Cost", flexibility: "Flexibility", commitment: "Commitment (lock-in)", speed: "Speed to occupy", control: "Control" };

export function ManagedForm({ id, title, inputs }: { id?: string; title?: string; inputs?: CvmInput | null }) {
  const c = inputs?.conventional; const m = inputs?.managed; const w = inputs?.weights;
  const inc = new Set<string>(m?.included ?? ["utilities", "housekeeping", "maintenance", "internet", "furniture", "reception", "security"]);
  const basis = (name: string, label: string, dv: string | undefined, hint?: string) => (
    <Field label={label} hint={hint} htmlFor={`f-${name}`} required>
      <select id={`f-${name}`} name={name} defaultValue={dv ?? "chargeable"} className={inputCls}><option value="chargeable">Chargeable (super built-up)</option><option value="carpet">Carpet</option></select>
    </Field>
  );
  return (
    <ActionForm action={saveManagedAction} className="space-y-5">
      {id ? <input type="hidden" name="id" value={id} /> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TextIn name="title" label="Name this comparison" dv={title} placeholder="e.g. Baner 100 seats — lease vs managed" />
        <NumIn name="comparisonMonths" label="Compare over" unit="months" dv={inputs?.comparisonMonths} hint="Both options are costed over the same months. Blank = the longer of the two terms." />
        <NumIn name="headcount" label="Headcount" unit="employees" dv={inputs?.headcount} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <OptionCard n={1} title="Conventional lease" desc="Rent a bare floor and run it yourself.">
          <Group title="Rent, area and term" open>
            <NumIn name="c_rentRate" label="Rent" unit="₹/sf/month" dv={c?.rentRate} />
            {basis("c_rentBasis", "Rent is charged on", c?.rentBasis, "Must be explicit — chargeable or carpet.")}
            <NumIn name="c_chargeableSf" label="Chargeable area" unit="sf" dv={c?.chargeableSf} />
            <NumIn name="c_carpetSf" label="Carpet area" unit="sf" dv={c?.carpetSf} />
            <NumIn name="c_seats" label="Usable seats" unit="seats" dv={c?.seats} />
            <NumIn name="c_camRate" label="CAM" unit="₹/sf/month" dv={c?.camRate} />
            {basis("c_camBasis", "CAM is charged on", c?.camBasis)}
            <NumIn name="c_tenureMonths" label="Tenure" unit="months" dv={c?.tenureMonths} />
            <NumIn name="c_lockInMonths" label="Lock-in" unit="months" dv={c?.lockInMonths} hint="Blank = same as tenure." />
            <NumIn name="c_escPct" label="Escalation" unit="%" dv={c?.escalation?.pct} />
            <NumIn name="c_escEvery" label="Escalation every" unit="months" dv={c?.escalation?.everyMonths ?? 12} />
          </Group>
          <Group title="One-off costs and deposit" desc="Paid once, at the start or exit.">
            <NumIn name="c_deposit" label="Security deposit (refundable)" unit="₹" dv={c?.deposit} />
            <NumIn name="c_fitout" label="Fit-out" unit="₹" dv={c?.fitout} />
            <NumIn name="c_furniture" label="Furniture" unit="₹" dv={c?.furniture} />
            <NumIn name="c_it" label="IT / cabling" unit="₹" dv={c?.it} />
            <NumIn name="c_restoration" label="Restoration at exit" unit="₹" dv={c?.restoration} />
          </Group>
          <Group title="Monthly running costs">
            <NumIn name="c_utilitiesMonthly" label="Utilities" unit="₹/month" dv={c?.utilitiesMonthly} />
            <NumIn name="c_housekeepingMonthly" label="Housekeeping" unit="₹/month" dv={c?.housekeepingMonthly} />
            <NumIn name="c_maintenanceMonthly" label="Maintenance" unit="₹/month" dv={c?.maintenanceMonthly} />
            <NumIn name="c_parkingMonthly" label="Parking" unit="₹/month" dv={c?.parkingMonthly} />
            <NumIn name="c_otherServicesMonthly" label="Other services (security, reception…)" unit="₹/month" dv={c?.otherServicesMonthly} />
          </Group>
          <Group title="Speed and control">
            <NumIn name="c_monthsToOccupy" label="Months until you can move in" unit="months" dv={c?.monthsToOccupy} />
            <NumIn name="c_control" label="Control over the space" unit="1–5" dv={c?.control} hint="1 = little control, 5 = full control." />
          </Group>
        </OptionCard>

        <OptionCard n={2} title="Managed office" tone="b" desc="Operator's per-seat price, services bundled.">
          <Group title="Price, seats and term" open>
            <NumIn name="m_perSeatPrice" label="Price per seat" unit="₹/seat/month" dv={m?.perSeatPrice} />
            <NumIn name="m_seats" label="Seats" unit="seats" dv={m?.seats} />
            <NumIn name="m_contractMonths" label="Contract length" unit="months" dv={m?.contractMonths} />
            <NumIn name="m_lockInMonths" label="Lock-in" unit="months" dv={m?.lockInMonths} hint="Blank = same as contract length." />
            <NumIn name="m_escPct" label="Escalation" unit="%" dv={m?.escalation?.pct} />
            <NumIn name="m_escEvery" label="Escalation every" unit="months" dv={m?.escalation?.everyMonths ?? 12} />
            <NumIn name="m_deposit" label="Security deposit (refundable)" unit="₹" dv={m?.deposit} />
            <NumIn name="m_setup" label="Setup / onboarding fee" unit="₹" dv={m?.setup} />
          </Group>
          <Group title="What the seat price already includes" open>
            <ToggleChips name="m_included" legend="Tap to mark included services" note="Ticked = already in the price, won't be counted again (even if you type an amount below)."
              options={MANAGED_SERVICES.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))} checked={inc} />
            <NumIn name="m_meetingRoomHours" label="Meeting-room allowance" unit="hours/month" dv={m?.meetingRoomHours} />
          </Group>
          <Group title="Charged separately" desc="Only fill what the operator bills on top of the seat price.">
            <NumIn name="m_internetMonthly" label="Internet" unit="₹/month" dv={m?.internetMonthly} />
            <NumIn name="m_utilitiesMonthly" label="Utilities" unit="₹/month" dv={m?.utilitiesMonthly} />
            <NumIn name="m_housekeepingMonthly" label="Housekeeping" unit="₹/month" dv={m?.housekeepingMonthly} />
            <NumIn name="m_receptionMonthly" label="Reception" unit="₹/month" dv={m?.receptionMonthly} />
            <NumIn name="m_securityMonthly" label="Security" unit="₹/month" dv={m?.securityMonthly} />
            <NumIn name="m_maintenanceMonthly" label="Maintenance" unit="₹/month" dv={m?.maintenanceMonthly} />
            <NumIn name="m_parkingMonthly" label="Parking" unit="₹/month" dv={m?.parkingMonthly} />
            <NumIn name="m_addOnsMonthly" label="Add-ons" unit="₹/month" dv={m?.addOnsMonthly} />
            <NumIn name="m_furniture" label="Furniture" unit="₹ one-off" dv={m?.furniture} />
            <NumIn name="m_it" label="IT setup" unit="₹ one-off" dv={m?.it} />
            <TextIn name="m_exclusions" label="Exclusions" area dv={m?.exclusions ?? ""} />
            <TextIn name="m_flexibilityNotes" label="Flexibility notes" area dv={m?.flexibilityNotes ?? ""} placeholder="expansion / contraction terms, notice" />
          </Group>
          <Group title="Speed and control">
            <NumIn name="m_monthsToOccupy" label="Months until you can move in" unit="months" dv={m?.monthsToOccupy} />
            <NumIn name="m_control" label="Control over the space" unit="1–5" dv={m?.control} hint="1 = little control, 5 = full control." />
          </Group>
        </OptionCard>
      </div>

      <Group title="What matters most to the client (weights)" desc="Higher number = more important. Used for the operational recommendation.">
        {(Object.keys(DEFAULT_WEIGHTS) as (keyof typeof DEFAULT_WEIGHTS)[]).map((k) => (
          <NumIn key={k} name={`w_${k}`} label={WEIGHT_LABEL[k]} unit="weight" dv={w?.[k] ?? DEFAULT_WEIGHTS[k]} />
        ))}
      </Group>

      <TextIn name="note" label="Version note" placeholder="what changed (optional)" />
      <StickyBar><Submit>{id ? "Compare again & save new version" : "Compare & save"}</Submit></StickyBar>
    </ActionForm>
  );
}
