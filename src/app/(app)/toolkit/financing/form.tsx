"use client";
import { Field, Input, Select, MoreFields } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveFinancingAction } from "@/modules/toolkit/actions-fitout";

type Init = Record<string, string | number | null | undefined>;
export function FinancingForm({ id, title, initial, partners }: { id?: string; title?: string; initial?: Init; partners: { id: string; name: string }[] }) {
  const v = (k: string) => (initial?.[k] === null || initial?.[k] === undefined ? "" : String(initial[k]));
  return (
    <ActionForm action={saveFinancingAction} className="space-y-4">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title"><Input name="title" defaultValue={title ?? ""} placeholder="e.g. Baner fit-out — 36m loan" required /></Field>
        <Field label="Financing partner" hint="Optional. Any partner — compare several by saving one analysis each.">
          <Input name="partner" list="fin-partners" defaultValue={v("partner")} />
        </Field>
        <datalist id="fin-partners">{partners.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        <Field label="Project cost ₹"><Input name="projectCost" inputMode="decimal" defaultValue={v("projectCost")} /></Field>
        <Field label="Client contribution ₹"><Input name="clientContribution" inputMode="decimal" defaultValue={v("clientContribution")} /></Field>
        <Field label="Financed amount ₹" hint="Leave blank to use project cost − client contribution."><Input name="financedAmount" inputMode="decimal" defaultValue={v("financedAmount")} /></Field>
        <Field label="Annual interest rate %" hint="0 is allowed (EMI = amount ÷ months)."><Input name="annualRatePct" inputMode="decimal" defaultValue={v("annualRatePct")} required /></Field>
        <Field label="Tenure (EMI months)"><Input name="tenureMonths" inputMode="numeric" defaultValue={v("tenureMonths")} required /></Field>
        <Field label="Terms status"><Select name="status" defaultValue={v("status") || "estimated"}><option value="estimated">Estimated</option><option value="quoted">Quoted by partner</option><option value="approved">Approved / sanctioned</option><option value="actual">Actual (disbursed)</option></Select></Field>
      </div>
      <MoreFields label="Processing fee & moratorium">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Processing fee"><Select name="feeType" defaultValue={v("feeType") || "none"}><option value="none">None</option><option value="pct">% of financed amount</option><option value="fixed">Fixed ₹</option></Select></Field>
          <Field label="Fee value (% or ₹)"><Input name="feeValue" inputMode="decimal" defaultValue={v("feeValue")} /></Field>
          <Field label="Tax on fee %" hint="Stated explicitly — never assumed. Blank = unknown."><Input name="feeTaxPct" inputMode="decimal" defaultValue={v("feeTaxPct")} /></Field>
          <Field label="Moratorium months" hint="Months before the EMIs start."><Input name="moratoriumMonths" inputMode="numeric" defaultValue={v("moratoriumMonths")} /></Field>
          <Field label="During moratorium"><Select name="moratoriumMode" defaultValue={v("moratoriumMode") || "interest_only"}><option value="interest_only">Pay interest only</option><option value="capitalised">Interest added to loan</option></Select></Field>
        </div>
      </MoreFields>
      <Field label="Version note (optional)"><Input name="note" /></Field>
      <Submit>{id ? "Save new version" : "Calculate & save"}</Submit>
    </ActionForm>
  );
}
