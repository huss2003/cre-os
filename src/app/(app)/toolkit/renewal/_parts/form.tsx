import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveRenewalAction } from "@/modules/toolkit/actions-options";
import { NONFIN, NONFIN_LABEL, type RvrInput } from "@/modules/toolkit/calc/renewal";
import { Group, NumIn, OptionCard, StickyBar, TextIn } from "@/modules/toolkit/ui/options/parts";

export function RenewalForm({ id, title, inputs }: { id?: string; title?: string; inputs?: RvrInput | null }) {
  const r = inputs?.renewal; const l = inputs?.relocation;
  return (
    <ActionForm action={saveRenewalAction} className="space-y-5">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TextIn name="title" label="Name this analysis" dv={title} placeholder="e.g. Kharadi HQ — renew or move" />
        <NumIn name="comparisonMonths" label="Compare over" unit="months" dv={inputs?.comparisonMonths} hint="Blank = the renewal extension period." />
        <NumIn name="discountRatePct" label="Discount rate" unit="% per year" dv={inputs?.discountRatePct} hint="Used for present value. Enter 0 for undiscounted." />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <OptionCard n={1} title="Stay (renew)" desc="The landlord's renewal proposal for the current premises.">
          <Group title="Rent and term" open>
            <NumIn name="r_currentRentMonthly" label="Current rent" unit="₹/month" dv={r?.currentRentMonthly} />
            <NumIn name="r_proposedRentMonthly" label="Proposed rent" unit="₹/month" dv={r?.proposedRentMonthly} />
            <NumIn name="r_extensionMonths" label="Extension" unit="months" dv={r?.extensionMonths} />
            <NumIn name="r_rentFreeMonths" label="Rent-free" unit="months" dv={r?.rentFreeMonths} />
            <NumIn name="r_escPct" label="Escalation" unit="%" dv={r?.escalation?.pct} />
            <NumIn name="r_escEvery" label="Escalation every" unit="months" dv={r?.escalation?.everyMonths ?? 12} />
          </Group>
          <Group title="Other costs">
            <NumIn name="r_camMonthly" label="CAM" unit="₹/month" dv={r?.camMonthly} />
            <NumIn name="r_maintenanceMonthly" label="Maintenance" unit="₹/month" dv={r?.maintenanceMonthly} />
            <NumIn name="r_otherMonthly" label="Other recurring" unit="₹/month" dv={r?.otherMonthly} />
            <NumIn name="r_refurbishment" label="Refurbishment" unit="₹" dv={r?.refurbishment} />
            <NumIn name="r_otherOneOff" label="Other one-off" unit="₹" dv={r?.otherOneOff} />
            <NumIn name="r_depositChange" label="Deposit change (refundable)" unit="₹" dv={r?.depositChange} hint="Top-up (+) or release (−). Kept outside cost totals." />
          </Group>
        </OptionCard>

        <OptionCard n={2} title="Move (relocate)" tone="b" desc="The best relocation option you found.">
          <Group title="Rent and term" open>
            <NumIn name="l_newRentMonthly" label="New rent" unit="₹/month" dv={l?.newRentMonthly} />
            <NumIn name="l_rentFreeMonths" label="Rent-free" unit="months" dv={l?.rentFreeMonths} />
            <NumIn name="l_overlapMonths" label="Overlap paying both rents" unit="months" dv={l?.overlapMonths} />
            <NumIn name="l_escPct" label="Escalation" unit="%" dv={l?.escalation?.pct} />
            <NumIn name="l_escEvery" label="Escalation every" unit="months" dv={l?.escalation?.everyMonths ?? 12} />
            <NumIn name="l_camMonthly" label="CAM" unit="₹/month" dv={l?.camMonthly} />
            <NumIn name="l_otherMonthly" label="Other recurring" unit="₹/month" dv={l?.otherMonthly} />
          </Group>
          <Group title="Move costs and deposits">
            <NumIn name="l_fitout" label="Fit-out" unit="₹" dv={l?.fitout} />
            <NumIn name="l_moving" label="Moving" unit="₹" dv={l?.moving} />
            <NumIn name="l_restorationOld" label="Restoration of current premises" unit="₹" dv={l?.restorationOld} />
            <NumIn name="l_brokerage" label="Brokerage" unit="₹" dv={l?.brokerage} />
            <NumIn name="l_itRelocation" label="IT relocation" unit="₹" dv={l?.itRelocation} />
            <NumIn name="l_downtimeCost" label="Downtime cost" unit="₹" dv={l?.downtimeCost} />
            <NumIn name="l_employeeTransition" label="Employee transition" unit="₹" dv={l?.employeeTransition} />
            <NumIn name="l_otherOneOff" label="Other one-off" unit="₹" dv={l?.otherOneOff} />
            <NumIn name="l_deposit" label="New security deposit (refundable)" unit="₹" dv={l?.deposit} />
            <NumIn name="l_oldDepositReturned" label="Current deposit returned" unit="₹" dv={l?.oldDepositReturned} />
          </Group>
        </OptionCard>
      </div>

      <Group title="Non-money factors — score each 1 to 5" desc="1 = poor, 5 = excellent. Kept separate from cost: cheaper rent alone never decides.">
        {NONFIN.map((k) => (
          <fieldset key={k} className="grid grid-cols-2 gap-3 rounded-lg bg-canvas p-3 sm:col-span-2">
            <legend className="sr-only">{NONFIN_LABEL[k]}</legend>
            <NumIn name={`s_${k}_r`} label={`${NONFIN_LABEL[k]} — stay`} unit="1–5" dv={inputs?.scores?.[k]?.renewal} />
            <NumIn name={`s_${k}_l`} label={`${NONFIN_LABEL[k]} — move`} unit="1–5" dv={inputs?.scores?.[k]?.relocation} />
          </fieldset>
        ))}
      </Group>

      <TextIn name="note" label="Version note" placeholder="what changed (optional)" />
      <StickyBar><Submit>{id ? "Compare again & save new version" : "Compare & save"}</Submit></StickyBar>
    </ActionForm>
  );
}
