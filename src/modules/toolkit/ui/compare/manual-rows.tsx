"use client";
import { useState } from "react";
import { Field, btn, inputCls } from "@/modules/toolkit/ui/kit";

const MAX = 6; // the server action reads m0..m5

/** Manual building cards. All 6 rows are always in the form (hidden ones stay blank and are skipped by the server). */
export function ManualRows() {
  const [count, setCount] = useState(1);
  const [gen, setGen] = useState<number[]>(() => Array(MAX).fill(0)); // bump to remount = clear a removed row
  return (
    <div className="space-y-4">
      {Array.from({ length: MAX }, (_, i) => (
        <fieldset key={`${i}-${gen[i]}`} hidden={i >= count} className="rounded-xl border border-slate-300 bg-white p-4">
          <legend className="px-1 text-sm font-semibold text-ink">✎ Building {i + 1}</legend>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Building name" htmlFor={`m${i}_name`} hint="Rows without a name are ignored."><input id={`m${i}_name`} name={`m${i}_name`} className={inputCls} placeholder="e.g. EON Free Zone T2" /></Field>
            <Field label="Micro-market" htmlFor={`m${i}_mm`}><input id={`m${i}_mm`} name={`m${i}_mm`} className={inputCls} placeholder="e.g. Kharadi" /></Field>
            <Field label="Grade" htmlFor={`m${i}_grade`}><select id={`m${i}_grade`} name={`m${i}_grade`} defaultValue="" className={inputCls}><option value="">Unknown</option>{["A+", "A", "B+", "B", "C"].map((g) => <option key={g}>{g}</option>)}</select></Field>
            <Field label="Area basis" htmlFor={`m${i}_basis`}><select id={`m${i}_basis`} name={`m${i}_basis`} defaultValue="" className={inputCls}><option value="">Unknown</option><option value="chargeable">Chargeable</option><option value="carpet">Carpet</option></select></Field>
            <Field label="Area" unit="sq ft" htmlFor={`m${i}_area`}><input id={`m${i}_area`} name={`m${i}_area`} inputMode="decimal" className={`${inputCls} pr-14`} /></Field>
            <Field label="Rent" unit="₹/sf/month" htmlFor={`m${i}_rent`}><input id={`m${i}_rent`} name={`m${i}_rent`} inputMode="decimal" className={`${inputCls} pr-24`} /></Field>
            <Field label="CAM" unit="₹/sf/month" htmlFor={`m${i}_cam`}><input id={`m${i}_cam`} name={`m${i}_cam`} inputMode="decimal" className={`${inputCls} pr-24`} /></Field>
            <Field label="Deposit" unit="months" hint="Refundable — shown separately, never part of cost." htmlFor={`m${i}_dep`}><input id={`m${i}_dep`} name={`m${i}_dep`} inputMode="decimal" className={`${inputCls} pr-16`} /></Field>
            <Field label="Rent-free" unit="months" htmlFor={`m${i}_rf`}><input id={`m${i}_rf`} name={`m${i}_rf`} inputMode="decimal" className={`${inputCls} pr-16`} /></Field>
            <Field label="Escalation" unit="%" htmlFor={`m${i}_esc`}><input id={`m${i}_esc`} name={`m${i}_esc`} inputMode="decimal" className={`${inputCls} pr-8`} /></Field>
            <Field label="Escalation every" unit="years" htmlFor={`m${i}_escyears`}><input id={`m${i}_escyears`} name={`m${i}_escyears`} inputMode="decimal" className={`${inputCls} pr-14`} /></Field>
            <Field label="Distance to metro" unit="km" htmlFor={`m${i}_metro`}><input id={`m${i}_metro`} name={`m${i}_metro`} inputMode="decimal" className={`${inputCls} pr-10`} /></Field>
            <Field label="Where the figures come from" htmlFor={`m${i}_evidence`}><select id={`m${i}_evidence`} name={`m${i}_evidence`} defaultValue="manual" className={inputCls}><option value="quoted">Quoted by landlord</option><option value="estimated">Estimated</option><option value="manual">Manual / unverified</option></select></Field>
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        {count < MAX ? <button type="button" className={btn.secondary} onClick={() => setCount(count + 1)}>+ Add another building</button> : <p className="text-sm text-ink-soft">Maximum of {MAX} manual buildings.</p>}
        {count > 1 ? <button type="button" className={btn.secondary} onClick={() => { setGen(gen.map((g, j) => (j === count - 1 ? g + 1 : g))); setCount(count - 1); }}>Remove building {count}</button> : null}
      </div>
    </div>
  );
}
