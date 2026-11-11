/**
 * Forms + result tables for the §8.11 specialist models (BTS, investment). Server components on top of the toolkit kit:
 * blank = unknown, units inside fields, one sticky Calculate bar, mobile-first (single column at 375px).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveBtsAction, saveInvestmentAction } from "../actions-models";
import { AREA_BASES } from "../calc/bts";
import { MAX_TENANCY_ROWS } from "../models-service";
import { Field, Status, btn, inputCls } from "./kit";
import { Group, NumIn, StickyBar } from "./options/parts";

type Init = Record<string, any>;
const val = (o: Init | undefined, k: string) => (o?.[k] === null || o?.[k] === undefined ? "" : String(o[k]));
const BASIS_LABEL: Record<string, string> = { built_up: "Built-up", chargeable: "Chargeable", leasable: "Leasable", carpet: "Carpet" };

function Sel({ name, label, dv, options, hint, id }: { name: string; label: string; dv: string; options: [string, string][]; hint?: string; id: string }) {
  return <Field label={label} hint={hint} htmlFor={id}><select id={id} name={name} defaultValue={dv} className={inputCls}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>;
}
function Head({ id, title, requirements, requirementId, p }: { id?: string; title?: string; requirements: { id: string; title: string }[]; requirementId?: string | null; p: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <Field label="Name this analysis" required htmlFor={`${p}title`}><input id={`${p}title`} name="title" required defaultValue={title ?? ""} className={inputCls} placeholder="e.g. Chakan BTS warehouse" /></Field>
      <Sel id={`${p}req`} name="requirement_id" label="Requirement (optional)" dv={requirementId ?? ""} options={[["", "Not linked"], ...requirements.map((r) => [r.id, r.title] as [string, string])]} />
    </div>
  );
}
const basisOpts: [string, string][] = [["", "Choose basis…"], ...AREA_BASES.map((b) => [b, BASIS_LABEL[b]] as [string, string])];

export function BtsForm({ id, title, initial, requirements, requirementId }: { id?: string; title?: string; initial?: Init; requirements: { id: string; title: string }[]; requirementId?: string | null }) {
  const i = initial ?? {}; const p = id ? "e-" : "n-"; const alt = (i.alternative ?? {}) as Init;
  return (
    <ActionForm action={saveBtsAction} className="space-y-4">
      <Head id={id} title={title} requirements={requirements} requirementId={requirementId} p={p} />
      <Group title="1. Land" desc="Bought outright, or leased (land rent during construction is capitalised; after that it is recovered through rent)." open>
        <div className="grid gap-4 sm:grid-cols-3">
          <Sel id={`${p}landMode`} name="landMode" label="Land" dv={val(i.land, "mode")} options={[["", "Unknown"], ["purchase", "Purchase"], ["lease", "Lease"]]} />
          <NumIn idPrefix={p} name="landCost" label="Land cost (if purchased)" unit="₹" dv={i.land?.cost} />
          <NumIn idPrefix={p} name="landLeaseRentMonthly" label="Land lease rent (if leased)" unit="₹/month" dv={i.land?.leaseRentMonthly} />
        </div>
      </Group>
      <Group title="2. Building and construction" desc="Construction cost and rent are per SF of the SAME area basis — nothing is converted." open>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumIn idPrefix={p} name="areaSf" label="Area" unit="SF" dv={i.areaSf} required />
          <Sel id={`${p}areaBasis`} name="areaBasis" label="Area basis" dv={val(i, "areaBasis")} options={basisOpts} hint="Built-up, chargeable, leasable or carpet." />
          <NumIn idPrefix={p} name="constructionCostPerSf" label="Construction cost" unit="₹/SF" dv={i.constructionCostPerSf} />
          <NumIn idPrefix={p} name="softCostPct" label="Soft costs" unit="% of construction" dv={i.softCostPct} />
          <NumIn idPrefix={p} name="constructionMonths" label="Construction period" unit="months" dv={i.constructionMonths} />
          <Field label="Draw schedule" unit="% per month" hint="Comma-separated, one per month, adds to 100. Blank = straight-line." htmlFor={`${p}drawSchedule`}><input id={`${p}drawSchedule`} name="drawSchedule" defaultValue={(i.drawSchedulePct ?? []).join(", ")} placeholder="e.g. 10, 20, 30, 40" className={`${inputCls} pr-28`} /></Field>
          <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2"><input type="checkbox" name="includeConstructionInterest" defaultChecked={!!i.includeConstructionInterest} className="size-5 accent-[var(--color-brand)]" /> Include interest during construction (capitalised)</label>
          <NumIn idPrefix={p} name="constructionInterestPct" label="Construction finance rate" unit="% p.a." dv={i.constructionInterestPct} />
        </div>
      </Group>
      <Group title="3. Developer return" desc="Give a yield on cost to get the required rent, or a target rent to get the implied yield." open>
        <div className="grid gap-4 sm:grid-cols-3">
          <Sel id={`${p}mode`} name="mode" label="Solve for" dv={val(i, "mode") || "yield"} options={[["yield", "Required rent (I know the yield)"], ["rent", "Implied yield (I know the rent)"]]} />
          <NumIn idPrefix={p} name="yieldOnCostPct" label="Yield on cost" unit="%" dv={i.yieldOnCostPct} />
          <NumIn idPrefix={p} name="targetRentPerSfMonth" label="Target rent" unit="₹/SF/month" dv={i.targetRentPerSfMonth} />
        </div>
      </Group>
      <Group title="4. Lease to the tenant" open>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumIn idPrefix={p} name="leaseTermMonths" label="Lease term" unit="months" dv={i.leaseTermMonths} />
          <NumIn idPrefix={p} name="escalationPct" label="Escalation" unit="%" dv={i.escalationPct} hint="Enter 0 if none." />
          <NumIn idPrefix={p} name="escalationEveryMonths" label="Escalation every" unit="months" dv={i.escalationEveryMonths} />
          <NumIn idPrefix={p} name="rentFreeMonths" label="Rent-free" unit="months" dv={i.rentFreeMonths} hint="Enter 0 if none." />
          <NumIn idPrefix={p} name="depositMonths" label="Security deposit" unit="months of rent" dv={i.depositMonths} hint="Refundable — kept separate from cost." />
          <NumIn idPrefix={p} name="tenantFitout" label="Tenant fit-out" unit="₹" dv={i.tenantFitout} hint="Enter 0 if the developer provides it." />
          <NumIn idPrefix={p} name="discountRatePct" label="Discount rate" unit="% p.a." dv={i.discountRatePct} />
        </div>
      </Group>
      <Group title="5. Compare with leasing elsewhere (optional)" desc="Leave rent blank to skip. Must use the same area basis and term to be compared." open={!!alt.rentPerSfMonth}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Alternative name" htmlFor={`${p}alt_name`}><input id={`${p}alt_name`} name="alt_name" defaultValue={val(alt, "name")} className={inputCls} placeholder="e.g. Ready warehouse, Talegaon" /></Field>
          <NumIn idPrefix={p} name="alt_areaSf" label="Area" unit="SF" dv={alt.areaSf} />
          <Sel id={`${p}alt_areaBasis`} name="alt_areaBasis" label="Area basis" dv={val(alt, "areaBasis")} options={basisOpts} />
          <NumIn idPrefix={p} name="alt_rentPerSfMonth" label="Rent" unit="₹/SF/month" dv={alt.rentPerSfMonth} />
          <NumIn idPrefix={p} name="alt_escalationPct" label="Escalation" unit="%" dv={alt.escalationPct} />
          <NumIn idPrefix={p} name="alt_escalationEveryMonths" label="Escalation every" unit="months" dv={alt.escalationEveryMonths} />
          <NumIn idPrefix={p} name="alt_rentFreeMonths" label="Rent-free" unit="months" dv={alt.rentFreeMonths} />
          <NumIn idPrefix={p} name="alt_depositMonths" label="Deposit" unit="months" dv={alt.depositMonths} />
          <NumIn idPrefix={p} name="alt_fitout" label="Fit-out" unit="₹" dv={alt.fitout} />
        </div>
      </Group>
      <Field label="Version note" htmlFor={`${p}note`}><input id={`${p}note`} name="note" className={inputCls} /></Field>
      <StickyBar><Submit>{id ? "Calculate & save new version" : "Calculate & save"}</Submit></StickyBar>
    </ActionForm>
  );
}

export function InvestmentForm({ id, title, initial, requirements, requirementId }: { id?: string; title?: string; initial?: Init; requirements: { id: string; title: string }[]; requirementId?: string | null }) {
  const i = initial ?? {}; const p = id ? "e-" : "n-"; const d = (i.debt ?? {}) as Init;
  const ts = ((i.tenancies ?? []) as Init[]);
  const rows = Math.min(MAX_TENANCY_ROWS, Math.max(2, ts.length + 1));
  return (
    <ActionForm action={saveInvestmentAction} className="space-y-4">
      <Head id={id} title={title} requirements={requirements} requirementId={requirementId} p={p} />
      <Group title="1. Acquisition" open>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumIn idPrefix={p} name="purchasePrice" label="Purchase price" unit="₹" dv={i.purchasePrice} />
          <NumIn idPrefix={p} name="stampDutyPct" label="Stamp duty + registration" unit="% of price" dv={i.stampDutyPct} />
          <NumIn idPrefix={p} name="otherAcquisitionCosts" label="Other acquisition costs" unit="₹" dv={i.otherAcquisitionCosts} hint="Legal, due diligence, brokerage. 0 if none." />
          <NumIn idPrefix={p} name="leasableAreaSf" label="Leasable area" unit="SF" dv={i.leasableAreaSf} />
          <Sel id={`${p}areaBasis`} name="areaBasis" label="Area basis" dv={val(i, "areaBasis")} options={basisOpts} hint="All ₹/SF figures use this basis." />
        </div>
      </Group>
      <Group title="2. Tenancy schedule" desc="One block per tenant. Expiry is counted in months from acquisition. Completely blank blocks are ignored." open>
        <div className="space-y-4">
          {Array.from({ length: rows }, (_, k) => { const t = ts[k] ?? {}; const q = `${p}t${k}`; return (
            <fieldset key={k} className="rounded-lg border border-line p-3">
              <legend className="px-1 text-sm font-medium">Tenancy {k + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Tenant" htmlFor={`${q}-name`}><input id={`${q}-name`} name={`t${k}_name`} defaultValue={val(t, "name")} className={inputCls} /></Field>
                <NumIn idPrefix={q} name={`t${k}_areaSf`} label="Area" unit="SF" dv={t.areaSf} />
                <NumIn idPrefix={q} name={`t${k}_rentPerSfMonth`} label="Rent" unit="₹/SF/month" dv={t.rentPerSfMonth} />
                <NumIn idPrefix={q} name={`t${k}_escalationPct`} label="Escalation" unit="%" dv={t.escalationPct} />
                <NumIn idPrefix={q} name={`t${k}_escalationEveryMonths`} label="Every" unit="months" dv={t.escalationEveryMonths} />
                <NumIn idPrefix={q} name={`t${k}_expiryMonth`} label="Lease expires after" unit="months" dv={t.expiryMonth} />
                <NumIn idPrefix={q} name={`t${k}_downtimeMonths`} label="Void after expiry" unit="months" dv={t.downtimeMonths} />
                <NumIn idPrefix={q} name={`t${k}_reletRentPerSfMonth`} label="Re-letting rent" unit="₹/SF/month" dv={t.reletRentPerSfMonth} />
                <NumIn idPrefix={q} name={`t${k}_reletEscalationPct`} label="Re-let escalation" unit="%" dv={t.reletEscalationPct} hint="Blank = same as current." />
                <NumIn idPrefix={q} name={`t${k}_camRecoveryPerSfMonth`} label="CAM recovery" unit="₹/SF/month" dv={t.camRecoveryPerSfMonth} hint="0 if none." />
              </div>
            </fieldset>
          ); })}
          {rows < MAX_TENANCY_ROWS ? <p className="text-xs text-ink-soft">Need more tenants? Save, then edit — another blank block appears (up to {MAX_TENANCY_ROWS}).</p> : null}
        </div>
      </Group>
      <Group title="3. Operating costs" open>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumIn idPrefix={p} name="opexPerSfMonth" label="Landlord opex" unit="₹/SF/month" dv={i.opexPerSfMonth} hint="On leasable area. 0 if fully recovered." />
          <NumIn idPrefix={p} name="opexEscalationPct" label="Opex escalation" unit="% per year" dv={i.opexEscalationPct} />
          <NumIn idPrefix={p} name="capexReservePerSfYear" label="Capex reserve" unit="₹/SF/year" dv={i.capexReservePerSfYear} />
        </div>
      </Group>
      <Group title="4. Hold and exit" open>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumIn idPrefix={p} name="holdingYears" label="Holding period" unit="years" dv={i.holdingYears} />
          <NumIn idPrefix={p} name="exitCapRatePct" label="Exit cap rate" unit="%" dv={i.exitCapRatePct} />
          <NumIn idPrefix={p} name="saleCostsPct" label="Sale costs" unit="% of exit value" dv={i.saleCostsPct} />
          <NumIn idPrefix={p} name="discountRatePct" label="Discount rate" unit="% p.a." dv={i.discountRatePct} />
        </div>
      </Group>
      <Group title="5. Debt (optional)" open={!!i.debt}>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-3"><input type="checkbox" name="debt" defaultChecked={!!i.debt} className="size-5 accent-[var(--color-brand)]" /> Use debt</label>
          <NumIn idPrefix={p} name="ltvPct" label="Loan to value" unit="% of price" dv={d.ltvPct} />
          <NumIn idPrefix={p} name="debtRatePct" label="Interest rate" unit="% p.a." dv={d.ratePct} />
          <NumIn idPrefix={p} name="tenorYears" label="Tenor" unit="years" dv={d.tenorYears} />
          <Sel id={`${p}amortisation`} name="amortisation" label="Repayment" dv={val(d, "amortisation") || "interest_only"} options={[["interest_only", "Interest only (balloon)"], ["amortising", "Amortising (equal payments)"]]} />
        </div>
      </Group>
      <Field label="Version note" htmlFor={`${p}note`}><input id={`${p}note`} name="note" className={inputCls} /></Field>
      <StickyBar><Submit>{id ? "Calculate & save new version" : "Calculate & save"}</Submit></StickyBar>
    </ActionForm>
  );
}

/** Simple responsive table (scrolls sideways at 375px). */
export function DataTable({ caption, head, rows, foot }: { caption: string; head: string[]; rows: ReactNode[][]; foot?: ReactNode[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="min-w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-canvas text-left text-xs text-ink-soft"><tr>{head.map((h, k) => <th key={k} scope="col" className={`px-3 py-2 font-medium ${k ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} className={`px-3 py-2 tabular-nums ${j ? "text-right" : ""}`}>{c}</td>)}</tr>)}</tbody>
        {foot ? <tfoot className="border-t border-line font-medium"><tr>{foot.map((c, j) => <td key={j} className={`px-3 py-2 tabular-nums ${j ? "text-right" : ""}`}>{c}</td>)}</tr></tfoot> : null}
      </table>
    </div>
  );
}

/** Version history list (same look as other toolkit pages). */
export function Versions({ base, id, current, versions }: { base: string; id: string; current: number; versions: Init[] }) {
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2 font-medium">Earlier versions ({versions.length}) <span aria-hidden className="transition group-open:rotate-180 motion-reduce:transition-none">▾</span></summary>
      <ul className="space-y-1 border-t border-line px-4 py-3 text-sm">{versions.map((v) => <li key={v.version} className="flex flex-wrap items-center gap-2"><Link className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4" href={`${base}/${id}?v=${v.version}`}>Version {v.version}</Link> <span className="text-xs text-ink-soft">{new Date(v.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {v.formula_version}{v.note ? ` — ${v.note}` : ""}</span>{v.version === current ? <Status s="approved" label="Current" /> : null}</li>)}</ul>
    </details>
  );
}
export function OldVersionBanner({ base, id, version }: { base: string; id: string; version: number }) {
  return <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">! Viewing older version {version}. <Link className={btn.link} href={`${base}/${id}`}>Back to current</Link></div>;
}
