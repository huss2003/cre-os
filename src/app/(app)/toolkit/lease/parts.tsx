import type { ReactNode } from "react";
import { inr } from "@/components/ui";
import { FormSection } from "@/modules/toolkit/ui/kit";
import { In, Sel } from "@/modules/toolkit/ui/lease/shared";
import type { LeaseTerms } from "@/modules/toolkit/calc/lease";

/** Shared lease-term fields (lease, occupancy and negotiation pages). Field names are prefixed (e.g. "o0_"). */
type Def = Partial<LeaseTerms>;
const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));

export function Money({ x, compact }: { x: string | null | undefined; compact?: boolean }) {
  return x === null || x === undefined ? <span className="inline-flex items-center gap-1 italic text-ink-soft"><span aria-hidden className="h-2 w-2 rounded-full border border-slate-400 bg-white" />unknown</span> : <>{inr(x, { compact })}</>;
}

export function LeaseTermFields({ p, def = {}, title, extra }: { p: string; def?: Def; title?: string; extra?: ReactNode }) {
  const other = def.otherRecurring?.[0];
  const nr = def.nonRecurring?.[0];
  return (
    <fieldset className="min-w-0 min-w-0 space-y-3 rounded-2xl border-2 border-line bg-white p-3 sm:p-4">
      {title ? <legend className="px-2 text-base font-bold text-ink">{title}</legend> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <In label="Offer name" name={`${p}name`} defaultValue={v(def.name)} placeholder="Building A" />
        <Sel label="Values are" name={`${p}label`} defaultValue={v(def.label) || "quoted"} hint="Quoted = from a landlord quote. Estimated = your assumption. Shown on every result."><option value="quoted">Quoted</option><option value="estimated">Estimated</option></Sel>
      </div>
      <FormSection title="Space & term" desc="How big, when it starts and for how long.">
        <In label="Area" unit="sq ft" name={`${p}area`} inputMode="decimal" defaultValue={v(def.areaSf)} />
        <Sel label="Area basis" name={`${p}basis`} defaultValue={v(def.areaBasis) || "chargeable"} hint="Rent and CAM rates apply to this area."><option value="chargeable">Chargeable</option><option value="carpet">Carpet</option></Sel>
        <In label="Tenure" unit="months" name={`${p}tenure`} inputMode="numeric" defaultValue={v(def.tenureMonths)} />
        <In label="Lease commencement" type="date" name={`${p}lc`} defaultValue={v(def.leaseCommencement)} />
        <In label="Rent commencement" type="date" name={`${p}rc`} defaultValue={v(def.rentCommencement)} hint="If rent-free is blank, rent-free = whole months between the two dates." />
        <In label="Rent-free" unit="months" name={`${p}rf`} inputMode="numeric" defaultValue={v(def.rentFreeMonths)} />
      </FormSection>
      <FormSection title="Rent & escalation" desc="Quoted rent and how often it goes up.">
        <In label="Rent" unit="₹/sf/month" name={`${p}rent`} inputMode="decimal" defaultValue={v(def.rentPerSf)} />
        <div className="hidden sm:block" />
        <In label="Escalation" unit="%" name={`${p}esc`} inputMode="decimal" defaultValue={v(def.escalationPct)} />
        <In label="…every" unit="months" name={`${p}escevery`} inputMode="numeric" defaultValue={v(def.escalationEveryMonths)} hint="36 = every three years." />
      </FormSection>
      <FormSection title="Charges" desc="CAM, parking and other monthly charges.">
        <In label="CAM" unit="₹/sf/month" name={`${p}cam`} inputMode="decimal" defaultValue={v(def.camPerSf)} hint="0 = included in rent." />
        <div className="hidden sm:block" />
        <In label="Parking slots" unit="slots" name={`${p}pslots`} inputMode="numeric" defaultValue={v(def.parkingSlots)} hint="0 = no paid parking." />
        <In label="Parking rate" unit="₹/slot/month" name={`${p}prate`} inputMode="decimal" defaultValue={v(def.parkingRatePerSlot)} />
        <In label="Other recurring — what" name={`${p}other_label`} defaultValue={v(other?.label)} placeholder="Insurance" />
        <In label="Other recurring — amount" unit="₹" name={`${p}other_amount`} inputMode="decimal" defaultValue={v(other?.amount)} />
        <Sel label="Other recurring — how often" name={`${p}other_per`} defaultValue={v(other?.periodicity) || "monthly"}><option value="monthly">Per month</option><option value="annual">Per year</option></Sel>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 self-end rounded-lg px-1 text-sm"><input type="checkbox" className="h-5 w-5 accent-brand" name={`${p}other_none`} defaultChecked={def.otherRecurringState === "none"} /> No other recurring charges</label>
        <Sel label="GST in quoted rates" name={`${p}gst`} defaultValue={v(def.gst?.treatment)}><option value="">Not specified</option><option value="included">Included</option><option value="excluded">Excluded (add)</option><option value="recoverable">Recoverable</option></Sel>
        <In label="GST rate" unit="%" name={`${p}gst_rate`} inputMode="decimal" defaultValue={v(def.gst?.ratePct)} hint="Needed only when excluded; never defaulted." />
      </FormSection>
      <FormSection title="Deposit & one-offs" desc="Refundable deposit and costs paid once at signing.">
        <In label="Security deposit" unit="months of rent" name={`${p}dep`} inputMode="decimal" defaultValue={v(def.depositMonths)} hint="Refundable — shown separately from costs." />
        <div className="hidden sm:block" />
        <In label="One-off at signing — what" name={`${p}nr_label`} defaultValue={v(nr?.label)} placeholder="Legal fees" />
        <In label="One-off amount" unit="₹" name={`${p}nr_amount`} inputMode="decimal" defaultValue={v(nr?.amount)} />
      </FormSection>
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
    <details className="rounded-lg border border-line px-4 py-2 text-sm text-ink-soft">
      <summary className="flex min-h-11 cursor-pointer items-center">{items.length} note{items.length === 1 ? "" : "s"} from the engine</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">{items.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </details>
  );
}
