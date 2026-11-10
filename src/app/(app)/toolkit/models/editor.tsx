"use client";
import { useState } from "react";
import type { RatingFactor, RatingRule } from "@/modules/toolkit/calc/rating";

const FIELDS: RatingRule["field"][] = ["areaSf", "rent", "cam", "occupancyCost", "microMarket", "grade", "depositMonths", "metroKm"];
const OPS: RatingRule["op"][] = ["gte", "lte", "eq", "in", "not_in"];
const cls = "rounded-lg border border-line bg-surface px-2 py-1.5 text-sm";

/** Live weight-sum validation; serialises factors/rules into hidden fields for the server action (which re-validates). */
export function ModelEditor({ initialFactors, initialRules }: { initialFactors: RatingFactor[]; initialRules: RatingRule[] }) {
  const [factors, setFactors] = useState(initialFactors);
  const [rules, setRules] = useState(initialRules);
  const sum = factors.reduce((s, f) => s + (Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0), 0);
  const ok = Math.abs(sum - 100) < 1e-9;
  const setF = (i: number, p: Partial<RatingFactor>) => setFactors(factors.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const setR = (i: number, p: Partial<RatingRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="space-y-5">
      <input type="hidden" name="factors" value={JSON.stringify(factors)} />
      <input type="hidden" name="rules" value={JSON.stringify(rules)} />
      <div>
        <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Factors</h3>
          <span className={`text-sm font-semibold ${ok ? "text-ok" : "text-bad"}`} aria-live="polite">Total {sum} / 100{ok ? "" : " — must equal 100"}</span></div>
        <div className="space-y-2">
          {factors.map((f, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_5rem_auto] items-center gap-2">
              <input aria-label="Key" className={cls} value={f.key} onChange={(e) => setF(i, { key: e.target.value })} />
              <input aria-label="Label" className={cls} value={f.label} onChange={(e) => setF(i, { label: e.target.value })} />
              <input aria-label="Weight" className={cls} inputMode="decimal" value={String(f.weight)} onChange={(e) => setF(i, { weight: e.target.value === "" ? NaN : Number(e.target.value) })} />
              <button type="button" className="text-xs text-bad" onClick={() => setFactors(factors.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>
        <button type="button" className="mt-2 text-sm text-brand" onClick={() => setFactors([...factors, { key: "custom", label: "Custom factor", weight: 0 }])}>+ Add factor</button>
        <p className="mt-1 text-xs text-ink-soft">Built-in keys: location, area, commercial, quality, connectivity, amenities. Other keys are scored manually per property.</p>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Rules</h3>
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-xl border border-line p-2 sm:grid-cols-[7rem_8rem_5rem_1fr_1fr_auto]">
              <select aria-label="Kind" className={cls} value={r.kind} onChange={(e) => setR(i, { kind: e.target.value as RatingRule["kind"] })}><option value="mandatory">mandatory</option><option value="disqualify">disqualify</option></select>
              <select aria-label="Field" className={cls} value={r.field} onChange={(e) => setR(i, { field: e.target.value as RatingRule["field"] })}>{FIELDS.map((x) => <option key={x}>{x}</option>)}</select>
              <select aria-label="Operator" className={cls} value={r.op} onChange={(e) => setR(i, { op: e.target.value as RatingRule["op"] })}>{OPS.map((x) => <option key={x}>{x}</option>)}</select>
              <input aria-label="Value" className={cls} placeholder="$areaMin, 100, A,B+" value={Array.isArray(r.value) ? r.value.join(",") : String(r.value)}
                onChange={(e) => { const t = e.target.value; setR(i, { value: t.startsWith("$") ? t : r.op === "in" || r.op === "not_in" ? t.split(",").map((x) => x.trim()).filter(Boolean) : t !== "" && Number.isFinite(Number(t)) ? Number(t) : t }); }} />
              <input aria-label="Label" className={cls} value={r.label} onChange={(e) => setR(i, { label: e.target.value })} />
              <button type="button" className="text-xs text-bad" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>
        <button type="button" className="mt-2 text-sm text-brand" onClick={() => setRules([...rules, { kind: "disqualify", field: "grade", op: "in", value: ["C"], label: "No grade C" }])}>+ Add rule</button>
        <p className="mt-1 text-xs text-ink-soft">Values starting with $ read the requirement: $areaMin, $areaMax, $budgetMax, $microMarkets. Failing a mandatory rule or hitting a disqualifier makes a property “Not eligible”.</p>
      </div>
    </div>
  );
}
