import { Field, Input, MoreFields } from "@/components/ui";
import type { OfferTerms } from "@/modules/toolkit/calc/negotiation";

const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));

/** Non-financial / negotiation terms. Blank = unresolved. */
export function NonFinancialFields({ def }: { def?: Partial<OfferTerms> }) {
  return (
    <MoreFields label="Fit-out contribution, lock-in, notice, possession, restoration">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Fit-out contribution ₹" hint="Landlord contribution received at signing."><Input name="o0_fitout" inputMode="decimal" defaultValue={v(def?.fitoutContribution)} /></Field>
        <Field label="Lock-in (months)"><Input name="o0_lockin" inputMode="numeric" defaultValue={v(def?.lockInMonths)} /></Field>
        <Field label="Notice (months)"><Input name="o0_notice" inputMode="numeric" defaultValue={v(def?.noticeMonths)} /></Field>
        <Field label="Possession date"><Input type="date" name="o0_possession" defaultValue={v(def?.possessionDate)} /></Field>
        <Field label="Break clause"><Input name="o0_break" defaultValue={v(def?.breakClause)} /></Field>
        <Field label="Handover condition"><Input name="o0_handover" defaultValue={v(def?.handover)} placeholder="Warm shell" /></Field>
        <Field label="Restoration"><Input name="o0_restoration" defaultValue={v(def?.restoration)} placeholder="Bare shell at exit" /></Field>
        <Field label="Other terms"><Input name="o0_otherterms" defaultValue={v(def?.other)} /></Field>
      </div>
    </MoreFields>
  );
}
