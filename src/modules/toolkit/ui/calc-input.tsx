"use client";
import { useState, type ComponentProps } from "react";
import { checkValue, kindForUnit } from "../calc/validate";

/**
 * Number input for toolkit calculators: validates against the shared bounds for its unit
 * (e.g. "%" → 0–100) and shows the error inline under the field; the form will not submit while invalid.
 * Blank stays allowed (= unknown). The server re-checks the same rules.
 */
export function CalcInput({ unit, label, onChange, onBlur, className, ...p }: ComponentProps<"input"> & { unit?: string; label: string }) {
  const [err, setErr] = useState<string | null>(null);
  const kind = kindForUnit(unit);
  const check = (el: HTMLInputElement) => {
    const m = kind ? checkValue(el.value, kind, label.replace(/\s*\(.*\)$/, "")) : null;
    el.setCustomValidity(m ?? "");
    setErr(m);
  };
  const errId = p.id ? `${p.id}-err` : undefined;
  return (
    <>
      <input {...p} className={`${className ?? ""} ${err ? "border-rose-500 ring-1 ring-rose-500" : ""}`} aria-invalid={err ? true : undefined} aria-describedby={err ? errId : undefined}
        onChange={(e) => { if (err) check(e.currentTarget); onChange?.(e); }}
        onBlur={(e) => { check(e.currentTarget); onBlur?.(e); }}
        onInvalid={(e) => check(e.currentTarget)} />
      {err ? <p id={errId} role="alert" className="mt-1 text-xs font-medium text-rose-700">{err}</p> : null}
    </>
  );
}
