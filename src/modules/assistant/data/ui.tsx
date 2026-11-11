/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import Link from "next/link";
import { Badge, Button, FactBadge, Field, Input, Select, Textarea } from "@/components/ui";
import { compareLandlordOffers, landlordOfferSchema, type LandlordOffer } from "@/modules/toolkit/calc/landlord-offer";
import { listOrgLocations, LOCATION_KINDS, LOCATION_KIND_LABEL, type LocationKind } from "./locations";
import { listLandlordOffers } from "./offers";
import { addLocationAction, archiveLocationAction, backfillLocationsAction, compareOffersAction, saveOfferAction, updateLocationAction } from "./actions";

/* Server components: company "Locations" section and requirement "Landlord offers" card. Mobile-first (single column). */
type Row = Record<string, any>;
interface Ctx { db: any; workspaceId: string; userId: string }

function LocationFields({ l }: { l?: Row }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Kind"><Select name="kind" defaultValue={l?.location_kind ?? "office"} required>{LOCATION_KINDS.map((k) => <option key={k} value={k}>{LOCATION_KIND_LABEL[k]}</option>)}</Select></Field>
      <Field label="Site name" hint="optional, e.g. 'Plant 2'"><Input name="name" defaultValue={l?.name ?? ""} /></Field>
      <Field label="Area / micro-market" hint="e.g. MIDC Chakan, Hinjewadi"><Input name="area" defaultValue={l?.area ?? ""} /></Field>
      <Field label="City"><Input name="city" defaultValue={l?.city ?? ""} /></Field>
      <Field label="Address"><Input name="address" defaultValue={l?.address ?? ""} /></Field>
      <Field label="Headcount" hint="blank = unknown"><Input name="headcount" inputMode="numeric" defaultValue={l?.headcount ?? ""} /></Field>
      <Field label="Status">
        <Select name="fact_status" defaultValue={l?.fact_status ?? "reported"}>
          <option value="reported">Reported by a source</option><option value="currently_confirmed">Confirmed now</option><option value="ai_inference">Inferred</option>
        </Select>
      </Field>
      <Field label="Source" hint="link or document"><Input name="source_ref" defaultValue={l?.source_ref ?? ""} /></Field>
      <input type="hidden" name="asset_id" value={l?.asset_id ?? ""} />
      {l ? <input type="hidden" name="source" value={l.source ?? "user"} /> : null}
    </div>
  );
}

export async function CompanyLocations({ ctx, orgId, canEdit }: { ctx: Ctx; orgId: string; canEdit: boolean }) {
  let rows: Row[] = []; let failed = false;
  try { rows = await listOrgLocations(ctx.db, ctx.workspaceId, orgId); } catch { failed = true; }
  return (
    <div className="space-y-3">
      {failed ? <p className="text-sm text-bad">Locations could not be loaded — this does not mean the company has none.</p> : null}
      {!failed && !rows.length ? <p className="text-sm text-ink-soft">No locations recorded. Add the HQ, offices, factories or warehouses you know of{canEdit ? ", or pull office sites from this company's leases" : ""}. An empty list means unknown, not &quot;no sites&quot;.</p> : null}
      {rows.length ? (
        <ul className="divide-y divide-line text-sm">
          {rows.map((l) => (
            <li key={l.id} className="py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={["factory", "plant", "warehouse"].includes(l.location_kind) ? "warn" : "brand"}>{LOCATION_KIND_LABEL[l.location_kind as LocationKind]}</Badge>
                <span className="font-medium">{l.asset_id ? <Link className="text-brand" href={`/buildings/${l.asset_id}`}>{l.name ?? "Building"}</Link> : l.name ?? l.area ?? l.city ?? "Site"}</span>
                <span className="text-ink-soft">{[l.area, l.city].filter(Boolean).join(", ") || "place unknown"}{l.headcount != null ? ` · ${l.headcount} people` : ""}</span>
                <FactBadge status={l.fact_status} />
              </div>
              <p className="text-xs text-ink-soft">Source: {l.source === "lease" ? "lease record" : l.source}{l.source_ref ? <> · {/^https?:\/\//.test(l.source_ref) ? <a className="underline" href={l.source_ref} target="_blank" rel="noreferrer noopener">link</a> : l.source_ref}</> : null}{l.observed_at ? ` · ${l.observed_at}` : ""}</p>
              {canEdit ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-brand">Edit or remove</summary>
                  <form action={updateLocationAction} className="mt-2 space-y-3">
                    <input type="hidden" name="org_id" value={orgId} /><input type="hidden" name="id" value={l.id} /><input type="hidden" name="row_version" value={l.row_version} />
                    <LocationFields l={l} />
                    <Button type="submit" variant="secondary">Save changes</Button>
                  </form>
                  <form action={archiveLocationAction} className="mt-2">
                    <input type="hidden" name="org_id" value={orgId} /><input type="hidden" name="id" value={l.id} /><input type="hidden" name="row_version" value={l.row_version} />
                    <Button type="submit" variant="secondary">Remove location</Button>
                  </form>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div className="space-y-2">
          <details>
            <summary className="cursor-pointer text-sm font-medium">+ Add a location</summary>
            <form action={addLocationAction} className="mt-3 space-y-3">
              <input type="hidden" name="org_id" value={orgId} />
              <LocationFields />
              <Button type="submit">Add location</Button>
            </form>
          </details>
          <form action={backfillLocationsAction}><input type="hidden" name="org_id" value={orgId} /><Button type="submit" variant="secondary">Pull office sites from leases</Button></form>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- landlord offers
const v = (o: Row | undefined, k: string) => (o?.[k] ?? "") as string | number;
const CONFIRMABLE: [string, string][] = [["rentPerSf", "Rent"], ["areaSf", "Area"], ["termMonths", "Term"], ["rentFreeMonths", "Rent-free"], ["camPerSf", "CAM"], ["securityDepositMonths", "Deposit"]];

function OfferForm({ requirementId, quote }: { requirementId: string; quote?: Row }) {
  const o = quote?.offer as Row | undefined;
  const numField = (k: string, label: string, hint?: string) => <Field label={label} hint={hint}><Input name={k} inputMode="decimal" defaultValue={v(o, k)} /></Field>;
  return (
    <form action={saveOfferAction} className="mt-3 space-y-4">
      <input type="hidden" name="requirement_id" value={requirementId} />
      {quote ? <input type="hidden" name="quote_id" value={quote.id} /> : null}
      <input type="hidden" name="asset_id" value={v(o, "assetId")} /><input type="hidden" name="space_id" value={v(o, "spaceId") || (quote?.space_id ?? "")} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Option name"><Input name="name" required defaultValue={v(o, "name")} placeholder="Tower B, 6th floor" /></Field>
        <Field label="Building"><Input name="building_name" defaultValue={v(o, "buildingName")} /></Field>
        <Field label="Floor / unit"><Input name="floor_unit" defaultValue={v(o, "floorUnit")} /></Field>
        {numField("areaSf", "Area (SF)")}
        <Field label="Area basis"><Select name="areaBasis" defaultValue={v(o, "areaBasis") || ""}><option value="">unknown</option><option value="chargeable">Chargeable</option><option value="carpet">Carpet</option></Select></Field>
        {numField("efficiencyPct", "Efficiency %", "carpet ÷ chargeable")}
        {numField("rentPerSf", "Rent ₹/SF/month")}
        {numField("escalationPct", "Escalation %", "0 = none")}
        {numField("escalationEveryMonths", "Escalation every (months)")}
        {numField("termMonths", "Term (months)")}
        {numField("lockInMonths", "Lock-in (months)")}
        {numField("rentFreeMonths", "Rent-free (months)")}
        {numField("securityDepositMonths", "Security deposit (months)")}
        {numField("fitoutAllowanceInr", "Fit-out allowance ₹ (total)", "0 = none")}
        {numField("camPerSf", "CAM ₹/SF/month", "0 = included")}
        {numField("carParks", "Car parks (slots)")}
        {numField("carParkRatePerSlot", "Car park ₹/slot/month", "0 = free")}
        {numField("seats", "Seats", "for cost per seat")}
        <Field label="Power backup"><Input name="powerBackup" defaultValue={v(o, "powerBackup")} placeholder="100% DG" /></Field>
        <Field label="Possession date"><Input type="date" name="possessionDate" defaultValue={v(o, "possessionDate")} /></Field>
        <Field label="Lease commencement"><Input type="date" name="leaseCommencement" defaultValue={v(o, "leaseCommencement")} /></Field>
        <Field label="Offer valid until"><Input type="date" name="validUntil" defaultValue={v(o, "validUntil")} /></Field>
        <Field label="Source document"><Input name="sourceDoc" defaultValue={v(o, "sourceDoc")} placeholder="LOI 12 Nov.pdf" /></Field>
        <Field label="Page"><Input name="sourcePage" defaultValue={v(o, "sourcePage")} /></Field>
        <Field label="Values are">
          <Select name="factStatus" defaultValue={v(o, "factStatus") || "reported"}><option value="reported">Reported (from the landlord / document)</option><option value="currently_confirmed">Confirmed now</option><option value="ai_inference">Inferred</option></Select>
        </Field>
      </div>
      <fieldset className="text-sm"><legend className="mb-1 text-ink-soft">Confirmed in writing (overrides the status above)</legend>
        <div className="flex flex-wrap gap-3">{CONFIRMABLE.map(([k, label]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" name="confirmed" value={k} defaultChecked={(o?.fieldStatus as Row | undefined)?.[k] === "currently_confirmed"} />{label}</label>)}</div>
      </fieldset>
      <Field label="Notes"><Textarea name="notes" rows={2} defaultValue={v(o, "notes")} /></Field>
      <p className="text-xs text-ink-soft">Leave a field blank if the offer does not say — it stays unknown and is listed as a gap, never treated as 0.</p>
      <Button type="submit">{quote ? `Save as v${Number(quote.version) + 1}` : "Save offer"}</Button>
    </form>
  );
}

export async function LandlordOffersCard({ ctx, requirementId, canEdit }: { ctx: Ctx; requirementId: string; canEdit: boolean }) {
  let quotes: Row[] = []; let failed = false;
  try { quotes = await listLandlordOffers(ctx, requirementId); } catch { failed = true; }
  const offers = quotes.map((q) => landlordOfferSchema.safeParse(q.offer)).filter((p) => p.success).map((p) => p.data as LandlordOffer);
  const dates = offers.map((o) => o.leaseCommencement ?? o.possessionDate).filter(Boolean).sort() as string[];
  let cmp: ReturnType<typeof compareLandlordOffers> | null = null; let cmpErr: string | null = null;
  if (offers.length) { try { cmp = compareLandlordOffers(offers, { discountRatePct: 10, baseDate: dates[0] ?? new Date().toISOString().slice(0, 10) }); } catch (e) { cmpErr = (e as Error).message; } }
  return (
    <div className="space-y-3">
      {failed ? <p className="text-sm text-bad">Offers could not be loaded.</p> : null}
      {!failed && !quotes.length ? <p className="text-sm text-ink-soft">No landlord offers yet. Record each landlord&apos;s commercial offer (from the LOI / term sheet) to compare them line by line.</p> : null}
      {cmp ? (
        <div className="-mx-1 overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead><tr><th className="sticky left-0 bg-surface p-1 text-left">Line</th>{cmp.names.map((n, i) => <th key={i} className="p-1 text-left">{n} <span className="font-normal text-ink-soft">v{quotes[i]?.version}</span></th>)}</tr></thead>
            <tbody>{cmp.lines.map((l) => (
              <tr key={l.key} className="border-t border-line">
                <td className="sticky left-0 bg-surface p-1 text-ink-soft">{l.label}{l.unit ? ` (${l.unit})` : ""}</td>
                {l.values.map((x, i) => <td key={i} className={`p-1 ${l.best === i && cmp!.names.length > 1 ? "font-semibold text-ok" : ""}`}>{x === null ? <span className="italic text-ink-soft">unknown</span> : String(x)}{l.status[i] === "currently_confirmed" ? " ✓" : l.status[i] === "ai_inference" ? " ~" : ""}</td>)}
              </tr>))}</tbody>
          </table>
          <p className="mt-1 text-xs text-ink-soft">Costs at 10% discount from a common start {cmp.baseDate} (offer-cmp-1.0 on lease-1.0). Bold = best on the line · ✓ confirmed · ~ inferred.</p>
          {cmp.missing.length ? <ul className="mt-1 list-disc pl-4 text-xs text-warn">{cmp.missing.map((m) => <li key={m}>{m}</li>)}</ul> : null}
        </div>
      ) : cmpErr ? <p className="text-sm text-bad">Comparison failed: {cmpErr}</p> : null}
      {canEdit && quotes.length ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Save comparison as an analysis</summary>
          <form action={compareOffersAction} className="mt-3 space-y-3">
            <input type="hidden" name="requirement_id" value={requirementId} />
            <div className="flex flex-wrap gap-3 text-sm">{quotes.map((q) => <label key={q.id} className="flex items-center gap-1"><input type="checkbox" name="quote_ids" value={q.id} defaultChecked />{(q.offer as Row)?.name} v{q.version}</label>)}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Discount rate % p.a."><Input name="discount" inputMode="decimal" defaultValue="10" /></Field>
              <Field label="Common start date" hint="blank = earliest stated"><Input type="date" name="base_date" /></Field>
            </div>
            <Button type="submit" variant="secondary">Compare and save</Button>
          </form>
        </details>
      ) : null}
      {canEdit ? (
        <>
          <details><summary className="cursor-pointer text-sm font-medium">+ Record a landlord offer</summary><OfferForm requirementId={requirementId} /></details>
          {quotes.map((q) => <details key={q.id}><summary className="cursor-pointer text-sm">Revise &quot;{(q.offer as Row)?.name}&quot; (new version)</summary><OfferForm requirementId={requirementId} quote={q} /></details>)}
        </>
      ) : null}
    </div>
  );
}
