import type { OfferTerms } from "@/modules/toolkit/calc/negotiation";
import { FormSection } from "@/modules/toolkit/ui/kit";
import { In } from "@/modules/toolkit/ui/lease/shared";

const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));

/** Non-financial / negotiation terms. Blank = unresolved. */
export function NonFinancialFields({ def }: { def?: Partial<OfferTerms> }) {
  return (
    <FormSection title="Other negotiated terms" desc="Fit-out contribution, lock-in, notice, possession, restoration. Blank = still unresolved." defaultOpen={false}>
      <In label="Fit-out contribution" unit="₹" name="o0_fitout" inputMode="decimal" defaultValue={v(def?.fitoutContribution)} hint="Landlord contribution received at signing." />
      <In label="Lock-in" unit="months" name="o0_lockin" inputMode="numeric" defaultValue={v(def?.lockInMonths)} />
      <In label="Notice" unit="months" name="o0_notice" inputMode="numeric" defaultValue={v(def?.noticeMonths)} />
      <In label="Possession date" type="date" name="o0_possession" defaultValue={v(def?.possessionDate)} />
      <In label="Break clause" name="o0_break" defaultValue={v(def?.breakClause)} />
      <In label="Handover condition" name="o0_handover" defaultValue={v(def?.handover)} placeholder="Warm shell" />
      <In label="Restoration" name="o0_restoration" defaultValue={v(def?.restoration)} placeholder="Bare shell at exit" />
      <In label="Other terms" name="o0_otherterms" defaultValue={v(def?.other)} />
    </FormSection>
  );
}
