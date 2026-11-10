"use client";
import { useState } from "react";
import type { RatingFactor, RatingRule } from "@/modules/toolkit/calc/rating";
import { btn, inputCls } from "@/modules/toolkit/ui/kit";

const FIELD_LABEL: Record<RatingRule["field"], string> = { areaSf: "Area (sf)", rent: "Rent (₹/sf/month)", cam: "CAM (₹/sf/month)", occupancyCost: "Effective cost (₹/sf/month)", microMarket: "Micro-market", grade: "Grade", depositMonths: "Deposit (months)", metroKm: "Distance to metro (km)" };
const FIELDS = Object.keys(FIELD_LABEL) as RatingRule["field"][];
const OP_LABEL: Record<RatingRule["op"], string> = { gte: "at least", lte: "at most", eq: "exactly", in: "one of", not_in: "not one of" };
const OPS = Object.keys(OP_LABEL) as RatingRule["op"][];
const VARS: Record<string, string> = { $areaMin: "requirement minimum area", $areaMax: "requirement maximum area", $budgetMax: "requirement budget", $microMarkets: "requirement micro-markets" };
const small = `${inputCls} w-auto`;

const valueText = (v: RatingRule["value"]) => (Array.isArray(v) ? v.join(", ") : String(v));
const valueWords = (v: RatingRule["value"]) => { const t = valueText(v); return VARS[t] ? `[${VARS[t]}]` : t || "…"; };
export function ruleSentence(r: RatingRule) {
  return r.kind === "mandatory" ? `${FIELD_LABEL[r.field]} must be ${OP_LABEL[r.op]} ${valueWords(r.value)}` : `Not eligible if ${FIELD_LABEL[r.field]} is ${OP_LABEL[r.op]} ${valueWords(r.value)}`;
}

/** Live weight-sum validation; serialises factors/rules into hidden fields for the server action (which re-validates). */
export function ModelEditor({ initialFactors, initialRules }: { initialFactors: RatingFactor[]; initialRules: RatingRule[] }) {
  const [factors, setFactors] = useState(initialFactors);
  const [rules, setRules] = useState(initialRules);
  const sum = factors.reduce((s, f) => s + (Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0), 0);
  const ok = Math.abs(sum - 100) < 1e-9;
  const setF = (i: number, p: Partial<RatingFactor>) => setFactors(factors.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const setR = (i: number, p: Partial<RatingRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="space-y-8">
      <input type="hidden" name="factors" value={JSON.stringify(factors)} />
      <input type="hidden" name="rules" value={JSON.stringify(rules)} />

      <section aria-labelledby="w-h">
        <h3 id="w-h" className="font-semibold">1. What matters most (weights)</h3>
        <p className="mt-1 text-sm text-ink-soft">Share 100 points between the factors. A factor with 25 points counts five times as much as one with 5. If a building&apos;s data for a factor is unknown, that factor is left out — not scored as zero.</p>
        <p role="status" aria-live="polite" className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-inset ${ok ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-rose-50 text-rose-700 ring-rose-200"}`}>
          {ok ? <>✓ Total 100 / 100</> : <>✕ Total {sum} — must be 100</>}
        </p>
        <ul className="mt-3 space-y-3">
          {factors.map((f, i) => (
            <li key={i} className="grid grid-cols-[1fr_6.5rem] gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_10rem_7rem_auto] sm:items-end">
              <label className="space-y-1 text-sm"><span className="font-medium">✎ Factor name</span><input className={inputCls} value={f.label} onChange={(e) => setF(i, { label: e.target.value })} /></label>
              <label className="order-3 col-span-2 space-y-1 text-sm sm:order-none sm:col-span-1"><span className="font-medium">✎ Key <span className="text-xs font-normal text-ink-soft">(technical)</span></span><input className={inputCls} value={f.key} onChange={(e) => setF(i, { key: e.target.value })} /></label>
              <label className="space-y-1 text-sm"><span className="font-medium">✎ Points</span><input className={inputCls} inputMode="decimal" value={Number.isFinite(f.weight) ? String(f.weight) : ""} onChange={(e) => setF(i, { weight: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
              <button type="button" aria-label={`Remove factor ${f.label}`} className={`${btn.secondary} order-4 col-span-2 text-rose-700 hover:border-rose-400 hover:text-rose-700 sm:order-none sm:col-span-1`} onClick={() => setFactors(factors.filter((_, j) => j !== i))}>✕ Remove</button>
            </li>
          ))}
        </ul>
        <button type="button" className={`${btn.secondary} mt-3`} onClick={() => setFactors([...factors, { key: "custom", label: "Custom factor", weight: 0 }])}>+ Add factor</button>
        <p className="mt-2 text-xs text-ink-soft">Built-in keys: location, area, commercial, quality, connectivity, amenities. Other keys are scored manually per property.</p>
      </section>

      <section aria-labelledby="r-h">
        <h3 id="r-h" className="font-semibold">2. Must-have rules</h3>
        <p className="mt-1 text-sm text-ink-soft">A building that breaks a rule is marked “Not eligible”, whatever its score. Use a requirement value (e.g. its minimum area) so one model works for every client.</p>
        <ul className="mt-3 space-y-3">
          {rules.map((r, i) => (
            <li key={i} className="rounded-xl border border-line p-3">
              <p className="mb-2 text-sm font-medium text-ink">“{ruleSentence(r)}”</p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <select aria-label="Rule type" className={small} value={r.kind} onChange={(e) => setR(i, { kind: e.target.value as RatingRule["kind"] })}><option value="mandatory">Must have</option><option value="disqualify">Not eligible if</option></select>
                <select aria-label="Field" className={small} value={r.field} onChange={(e) => setR(i, { field: e.target.value as RatingRule["field"] })}>{FIELDS.map((x) => <option key={x} value={x}>{FIELD_LABEL[x]}</option>)}</select>
                <span>{r.kind === "mandatory" ? "must be" : "is"}</span>
                <select aria-label="Comparison" className={small} value={r.op} onChange={(e) => setR(i, { op: e.target.value as RatingRule["op"] })}>{OPS.map((x) => <option key={x} value={x}>{OP_LABEL[x]}</option>)}</select>
                <input aria-label="Value" list="rule-vars" className={`${inputCls} w-full sm:w-56`} placeholder="$areaMin, 100, A,B+" value={valueText(r.value)}
                  onChange={(e) => { const t = e.target.value; setR(i, { value: t.startsWith("$") ? t : r.op === "in" || r.op === "not_in" ? t.split(",").map((x) => x.trim()).filter(Boolean) : t !== "" && Number.isFinite(Number(t)) ? Number(t) : t }); }} />
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex-1 space-y-1 text-sm"><span className="font-medium">✎ Label shown on results</span><input className={inputCls} value={r.label} onChange={(e) => setR(i, { label: e.target.value })} /></label>
                <button type="button" aria-label={`Remove rule ${r.label}`} className={`${btn.secondary} text-rose-700 hover:border-rose-400 hover:text-rose-700`} onClick={() => setRules(rules.filter((_, j) => j !== i))}>✕ Remove</button>
              </div>
            </li>
          ))}
        </ul>
        <datalist id="rule-vars">{Object.entries(VARS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</datalist>
        <button type="button" className={`${btn.secondary} mt-3`} onClick={() => setRules([...rules, { kind: "disqualify", field: "grade", op: "in", value: ["C"], label: "No grade C" }])}>+ Add rule</button>
        <p className="mt-2 text-xs text-ink-soft">Requirement values: $areaMin (minimum area), $areaMax (maximum area), $budgetMax (budget), $microMarkets (preferred micro-markets). For “one of”, separate values with commas.</p>
      </section>
    </div>
  );
}
