"use client";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveFinancingAction } from "@/modules/toolkit/actions-fitout";
import { Field, inputCls } from "@/modules/toolkit/ui/kit";
import { StickyBar } from "@/modules/toolkit/ui/options/parts";

type Init = Record<string, string | number | null | undefined>;
export function FinancingForm({ id, title, initial, partners }: { id?: string; title?: string; initial?: Init; partners: { id: string; name: string }[] }) {
  const v = (k: string) => (initial?.[k] === null || initial?.[k] === undefined ? "" : String(initial[k]));
  const p = id ? `e-` : "n-";
  const num = (name: string, label: string, unit: string, opts: { hint?: string; required?: boolean; mode?: "decimal" | "numeric" } = {}) => (
    <Field label={label} unit={unit} hint={opts.hint} required={opts.required} htmlFor={`${p}${name}`}>
      <input id={`${p}${name}`} name={name} inputMode={opts.mode ?? "decimal"} defaultValue={v(name)} required={opts.required} placeholder={opts.required ? "" : "blank = unknown"} className={`${inputCls} tabular-nums ${unit.length > 3 ? "pr-20" : "pr-10"}`} />
    </Field>
  );
  const sel = (name: string, label: string, dv: string, options: [string, string][], hint?: string) => (
    <Field label={label} hint={hint} htmlFor={`${p}${name}`} required>
      <select id={`${p}${name}`} name={name} defaultValue={v(name) || dv} className={inputCls}>{options.map(([val, lab]) => <option key={val} value={val}>{lab}</option>)}</select>
    </Field>
  );
  return (
    <ActionForm action={saveFinancingAction} className="space-y-5">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <fieldset className="space-y-4">
        <legend className="mb-2 text-lg font-semibold"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">1</span>Loan details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name this analysis" required htmlFor={`${p}title`}><input id={`${p}title`} className={inputCls} name="title" defaultValue={title ?? ""} placeholder="e.g. Baner fit-out — 36m loan" required /></Field>
          <Field label="Financing partner" hint="Any partner — compare several by saving one analysis each." htmlFor={`${p}partner`}>
            <input id={`${p}partner`} className={inputCls} name="partner" list="fin-partners" defaultValue={v("partner")} />
          </Field>
          <datalist id="fin-partners">{partners.map((x) => <option key={x.id} value={x.name} />)}</datalist>
          {num("projectCost", "Project cost", "₹")}
          {num("clientContribution", "Client contribution", "₹")}
          {num("financedAmount", "Financed amount", "₹", { hint: "Blank = project cost − client contribution." })}
          {num("annualRatePct", "Interest rate", "% p.a.", { required: true, hint: "0 is allowed (EMI = amount ÷ months)." })}
          {num("tenureMonths", "Tenure (number of EMIs)", "months", { required: true, mode: "numeric" })}
          {sel("status", "How firm are these terms?", "estimated", [["estimated", "Estimated"], ["quoted", "Quoted by partner"], ["approved", "Approved / sanctioned"], ["actual", "Actual (disbursed)"]])}
        </div>
      </fieldset>
      <details className="group rounded-xl border border-line" open={!!(v("feeType") && v("feeType") !== "none") || !!v("moratoriumMonths")}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2 font-medium">Processing fee & moratorium <span className="text-sm font-normal text-ink-soft">optional ▾</span></summary>
        <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-3">
          {sel("feeType", "Processing fee", "none", [["none", "None"], ["pct", "% of financed amount"], ["fixed", "Fixed ₹"]])}
          {num("feeValue", "Fee value", "% or ₹")}
          {num("feeTaxPct", "Tax on fee", "%", { hint: "Stated explicitly — never assumed. Blank = unknown." })}
          {num("moratoriumMonths", "Moratorium", "months", { hint: "Months before the EMIs start.", mode: "numeric" })}
          {sel("moratoriumMode", "During moratorium", "interest_only", [["interest_only", "Pay interest only"], ["capitalised", "Interest added to loan"]])}
        </div>
      </details>
      <Field label="Version note" htmlFor={`${p}note`}><input id={`${p}note`} className={inputCls} name="note" /></Field>
      <StickyBar note="Step 2 — press to work out the EMI and full schedule."><Submit>{id ? "Calculate & save new version" : "Calculate & save"}</Submit></StickyBar>
    </ActionForm>
  );
}
