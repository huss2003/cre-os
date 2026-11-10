import type { ReactNode } from "react";
import { Badge, Field, Input, MoreFields, Select, inr } from "@/components/ui";
import type { LeaseTerms } from "@/modules/toolkit/calc/lease";

/** Shared lease-term fields (lease, occupancy and negotiation pages). Field names are prefixed (e.g. "o0_"). */
type Def = Partial<LeaseTerms>;
const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));

export function Money({ x, compact }: { x: string | null | undefined; compact?: boolean }) {
  return x === null || x === undefined ? <Badge tone="warn">unknown</Badge> : <>{inr(x, { compact })}</>;
}

export function LeaseTermFields({ p, def = {}, title, extra }: { p: string; def?: Def; title?: string; extra?: ReactNode }) {
  const other = def.otherRecurring?.[0];
  const nr = def.nonRecurring?.[0];
  return (
    <fieldset className="space-y-3 rounded-2xl border border-line p-4">
      {title ? <legend className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-ink-soft">{title}</legend> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Offer name"><Input name={`${p}name`} defaultValue={v(def.name)} placeholder="Building A" /></Field>
        <Field label="Values are" hint="Quoted = from a landlord quote. Estimated = your assumption. Shown on every result.">
          <Select name={`${p}label`} defaultValue={v(def.label) || "quoted"}><option value="quoted">Quoted</option><option value="estimated">Estimated</option></Select>
        </Field>
        <Field label="Area (sf)"><Input name={`${p}area`} inputMode="decimal" defaultValue={v(def.areaSf)} /></Field>
        <Field label="Area basis" hint="Rent and CAM rates apply to this area.">
          <Select name={`${p}basis`} defaultValue={v(def.areaBasis) || "chargeable"}><option value="chargeable">Chargeable</option><option value="carpet">Carpet</option></Select>
        </Field>
        <Field label="Rent ₹/sf/month"><Input name={`${p}rent`} inputMode="decimal" defaultValue={v(def.rentPerSf)} /></Field>
        <Field label="Tenure (months)"><Input name={`${p}tenure`} inputMode="numeric" defaultValue={v(def.tenureMonths)} /></Field>
        <Field label="Lease commencement"><Input type="date" name={`${p}lc`} defaultValue={v(def.leaseCommencement)} /></Field>
        <Field label="Rent commencement" hint="Optional. If rent-free months is blank, rent-free = whole months between the two dates.">
          <Input type="date" name={`${p}rc`} defaultValue={v(def.rentCommencement)} />
        </Field>
        <Field label="Rent-free (months)"><Input name={`${p}rf`} inputMode="numeric" defaultValue={v(def.rentFreeMonths)} /></Field>
        <Field label="Deposit (months of rent)" hint="Blank = unknown. 0 = no deposit. Refundable — shown separately from expenses."><Input name={`${p}dep`} inputMode="decimal" defaultValue={v(def.depositMonths)} /></Field>
        <Field label="Escalation %"><Input name={`${p}esc`} inputMode="decimal" defaultValue={v(def.escalationPct)} /></Field>
        <Field label="…every (months)" hint="36 = every three years. First escalated month = this + 1."><Input name={`${p}escevery`} inputMode="numeric" defaultValue={v(def.escalationEveryMonths)} /></Field>
        <Field label="CAM ₹/sf/month" hint="Blank = unknown (result marked incomplete). 0 = included in rent."><Input name={`${p}cam`} inputMode="decimal" defaultValue={v(def.camPerSf)} /></Field>
        <Field label="Parking slots" hint="Blank = unknown. 0 = no paid parking."><Input name={`${p}pslots`} inputMode="numeric" defaultValue={v(def.parkingSlots)} /></Field>
        <Field label="Parking ₹/slot/month"><Input name={`${p}prate`} inputMode="decimal" defaultValue={v(def.parkingRatePerSlot)} /></Field>
      </div>
      <MoreFields label="Other charges, one-offs, GST">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Other recurring — label"><Input name={`${p}other_label`} defaultValue={v(other?.label)} placeholder="Insurance" /></Field>
          <Field label="Amount ₹"><Input name={`${p}other_amount`} inputMode="decimal" defaultValue={v(other?.amount)} /></Field>
          <Field label="Periodicity"><Select name={`${p}other_per`} defaultValue={v(other?.periodicity) || "monthly"}><option value="monthly">Per month</option><option value="annual">Per year</option></Select></Field>
          <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name={`${p}other_none`} defaultChecked={def.otherRecurringState === "none"} /> No other recurring charges</label>
          <Field label="One-off at signing — label"><Input name={`${p}nr_label`} defaultValue={v(nr?.label)} placeholder="Legal fees" /></Field>
          <Field label="Amount ₹"><Input name={`${p}nr_amount`} inputMode="decimal" defaultValue={v(nr?.amount)} /></Field>
          <Field label="GST in quoted rates">
            <Select name={`${p}gst`} defaultValue={v(def.gst?.treatment)}><option value="">Not specified</option><option value="included">Included</option><option value="excluded">Excluded (add)</option><option value="recoverable">Recoverable</option></Select>
          </Field>
          <Field label="GST rate %" hint="Needed only when excluded; never defaulted."><Input name={`${p}gst_rate`} inputMode="decimal" defaultValue={v(def.gst?.ratePct)} /></Field>
        </div>
      </MoreFields>
      {extra}
    </fieldset>
  );
}

/** Cumulative cash chart — inline SVG, no library. Values are pre-computed strings from the engine. */
export function CumulativeChart({ series, label }: { series: string[]; label: string }) {
  const vals = series.map(Number);
  if (!vals.length) return null;
  const W = 600, H = 200, pad = 28;
  const max = Math.max(...vals, 0), min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / Math.max(1, vals.length - 1)) * (W - pad * 2);
  const y = (val: number) => H - pad - ((val - min) / span) * (H - pad * 2);
  const path = vals.map((val, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(" ");
  const peakI = vals.indexOf(max);
  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full text-brand">
        <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity="0.2" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx={x(peakI)} cy={y(max)} r="4" fill="currentColor" />
        <text x={pad} y={14} fontSize="11" fill="currentColor" fillOpacity="0.7">{inr(max, { compact: true })} peak</text>
        <text x={pad} y={H - 8} fontSize="11" fill="currentColor" fillOpacity="0.6">month 0</text>
        <text x={W - pad} y={H - 8} fontSize="11" textAnchor="end" fill="currentColor" fillOpacity="0.6">month {vals.length - 1}</text>
      </svg>
      <figcaption className="mt-1 text-xs text-ink-soft">{label}</figcaption>
    </figure>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <details className="rounded-xl border border-line px-3 py-2 text-xs text-ink-soft">
      <summary className="cursor-pointer">{items.length} note{items.length === 1 ? "" : "s"} from the engine</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">{items.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </details>
  );
}
