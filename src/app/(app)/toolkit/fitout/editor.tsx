"use client";
import { useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveFitoutAction, type FitoutPayload } from "@/modules/toolkit/actions-fitout";
import { CATEGORY_LABEL, DEFAULT_CRITERIA, FITOUT_CATEGORIES, type FitoutCategory, type FitoutLine, type PartnerQuote } from "@/modules/toolkit/calc/fitout";

const blankLine = (): FitoutLine => ({ category: "civil", description: "", quantity: "", unit: "", unitPrice: "", vendor: "", quoteRef: "", taxPct: "", estimated: "", approved: "", actual: "" });
const blankQuote = (): PartnerQuote => ({ partnerName: "", scope: [], exclusions: [], price: "", taxPct: "", deliveryWeeks: "", paymentSchedule: "", warrantyMonths: "", validUntil: "", documentsUrl: "" });
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const small = "!py-1.5 !px-2 text-xs";

export function FitoutEditor({ id, title, initial, partners }: { id?: string; title?: string; initial?: FitoutPayload; partners: { id: string; name: string }[] }) {
  const [lines, setLines] = useState<FitoutLine[]>(initial?.lines?.length ? initial.lines : [blankLine()]);
  const [quotes, setQuotes] = useState<PartnerQuote[]>(initial?.quotes ?? []);
  const [scope, setScope] = useState<FitoutCategory[]>(initial?.requiredScope ?? []);
  const [area, setArea] = useState(s(initial?.areaSf));
  const [seats, setSeats] = useState(s(initial?.seats));
  const [crit, setCrit] = useState(initial?.criteria ?? DEFAULT_CRITERIA);
  const [pref, setPref] = useState<number | null>(initial?.preferredIndex ?? null);
  const [reason, setReason] = useState(initial?.preferredReason ?? "");
  const payload: FitoutPayload = { areaSf: area, seats, lines, quotes, requiredScope: scope, criteria: crit, preferredIndex: pref, preferredReason: reason };
  const setL = (i: number, k: keyof FitoutLine, v: string) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const setQ = (i: number, patch: Partial<PartnerQuote>) => setQuotes((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const byName = new Map(partners.map((p) => [p.name, p.id]));

  return (
    <ActionForm action={saveFitoutAction} className="space-y-6">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title"><Input name="title" defaultValue={title ?? ""} placeholder="e.g. Baner HQ fit-out" required /></Field>
        <Field label="Carpet area (sf)" hint="Optional — gives cost per sf."><Input inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} /></Field>
        <Field label="Seats" hint="Optional — gives cost per seat."><Input inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} /></Field>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Line items <span className="font-normal text-ink-soft">— amounts excluding tax; tax % per line is required (never assumed). Leave unknown amounts blank.</span></h3>
        {lines.map((l, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              <Select className={small} value={l.category} onChange={(e) => setL(i, "category", e.target.value)} aria-label="Category">
                {FITOUT_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </Select>
              <Input className={`${small} col-span-1 sm:col-span-2`} placeholder="Description" value={s(l.description)} onChange={(e) => setL(i, "description", e.target.value)} />
              <Input className={small} placeholder="Qty" inputMode="decimal" value={s(l.quantity)} onChange={(e) => setL(i, "quantity", e.target.value)} />
              <Input className={small} placeholder="Unit (sf, nos…)" value={s(l.unit)} onChange={(e) => setL(i, "unit", e.target.value)} />
              <Input className={small} placeholder="Unit price ₹" inputMode="decimal" value={s(l.unitPrice)} onChange={(e) => setL(i, "unitPrice", e.target.value)} />
              <Input className={small} placeholder="Vendor" value={s(l.vendor)} onChange={(e) => setL(i, "vendor", e.target.value)} />
              <Input className={small} placeholder="Quote ref" value={s(l.quoteRef)} onChange={(e) => setL(i, "quoteRef", e.target.value)} />
              <Input className={small} placeholder="Tax %" inputMode="decimal" value={s(l.taxPct)} onChange={(e) => setL(i, "taxPct", e.target.value)} />
              <Input className={small} placeholder="Estimated ₹ (or qty×price)" inputMode="decimal" value={s(l.estimated)} onChange={(e) => setL(i, "estimated", e.target.value)} />
              <Input className={small} placeholder="Approved ₹" inputMode="decimal" value={s(l.approved)} onChange={(e) => setL(i, "approved", e.target.value)} />
              <Input className={small} placeholder="Actual ₹" inputMode="decimal" value={s(l.actual)} onChange={(e) => setL(i, "actual", e.target.value)} />
            </div>
            <button type="button" className="mt-2 text-xs text-ink-soft hover:text-bad" onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))}>Remove line</button>
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setLines((xs) => [...xs, blankLine()])}>＋ Add line</Button>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Partner quotations <span className="font-normal text-ink-soft">— every partner goes through the same comparison.</span></h3>
        <div>
          <p className="mb-1 text-xs text-ink-soft">Required scope (blank = categories used in the line items)</p>
          <div className="flex flex-wrap gap-1.5">
            {FITOUT_CATEGORIES.map((c) => (
              <label key={c} className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${scope.includes(c) ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-soft"}`}>
                <input type="checkbox" className="sr-only" checked={scope.includes(c)} onChange={(e) => setScope((xs) => (e.target.checked ? [...xs, c] : xs.filter((x) => x !== c)))} />{CATEGORY_LABEL[c]}
              </label>
            ))}
          </div>
        </div>
        <datalist id="partner-names">{partners.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        {quotes.map((q, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-line bg-surface p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Input className={small} list="partner-names" placeholder="Partner name" value={q.partnerName} onChange={(e) => setQ(i, { partnerName: e.target.value, partnerId: byName.get(e.target.value) ?? null })} />
              <Input className={small} placeholder="Price ex-tax ₹" inputMode="decimal" value={s(q.price)} onChange={(e) => setQ(i, { price: e.target.value })} />
              <Input className={small} placeholder="Tax %" inputMode="decimal" value={s(q.taxPct)} onChange={(e) => setQ(i, { taxPct: e.target.value })} />
              <Input className={small} placeholder="Delivery (weeks)" inputMode="numeric" value={s(q.deliveryWeeks)} onChange={(e) => setQ(i, { deliveryWeeks: e.target.value })} />
              <Input className={small} placeholder="Warranty (months)" inputMode="numeric" value={s(q.warrantyMonths)} onChange={(e) => setQ(i, { warrantyMonths: e.target.value })} />
              <label className="text-xs text-ink-soft">Valid until<Input className={small} type="date" value={s(q.validUntil)} onChange={(e) => setQ(i, { validUntil: e.target.value })} /></label>
              <Input className={small} placeholder="Payment schedule" value={s(q.paymentSchedule)} onChange={(e) => setQ(i, { paymentSchedule: e.target.value })} />
              <Input className={small} placeholder="Documents link" value={s(q.documentsUrl)} onChange={(e) => setQ(i, { documentsUrl: e.target.value })} />
            </div>
            <Input className={small} placeholder="Exclusions (separate with ;)" value={(q.exclusions ?? []).join("; ")} onChange={(e) => setQ(i, { exclusions: e.target.value.split(";").map((x) => x.trim()) })} />
            <div className="flex flex-wrap gap-1">
              {FITOUT_CATEGORIES.map((c) => {
                const on = (q.scope ?? []).includes(c);
                return <button type="button" key={c} onClick={() => setQ(i, { scope: on ? (q.scope ?? []).filter((x) => x !== c) : [...(q.scope ?? []), c] })} className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-brand bg-brand-soft text-brand" : "border-line text-ink-soft"}`}>{CATEGORY_LABEL[c]}</button>;
              })}
            </div>
            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center gap-1.5"><input type="radio" name="pref-pick" checked={pref === i} onChange={() => setPref(i)} /> Mark as preferred</label>
              <button type="button" className="text-ink-soft hover:text-bad" onClick={() => { setQuotes((xs) => xs.filter((_, j) => j !== i)); setPref(null); }}>Remove quote</button>
            </div>
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setQuotes((xs) => [...xs, blankQuote()])}>＋ Add quotation</Button>
        {pref !== null ? (
          <div className="space-y-2">
            <Field label="Why is this partner preferred?" hint="Required, stored with the analysis. The ranking itself is unchanged."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} /></Field>
            <button type="button" className="text-xs text-ink-soft underline" onClick={() => { setPref(null); setReason(""); }}>Clear preferred choice</button>
          </div>
        ) : null}
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-soft">Ranking weights (price {crit.price} · scope {crit.scope} · timeline {crit.timeline} · warranty {crit.warranty})</summary>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {(["price", "scope", "timeline", "warranty"] as const).map((k) => (
              <label key={k}>{k}<Input className={small} inputMode="numeric" value={crit[k]} onChange={(e) => setCrit((c) => ({ ...c, [k]: Math.max(0, Number(e.target.value) || 0) }))} /></label>
            ))}
          </div>
        </details>
      </section>

      <Field label="Version note (optional)"><Input name="note" placeholder="What changed" /></Field>
      <Submit>{id ? "Save new version" : "Calculate & save"}</Submit>
    </ActionForm>
  );
}
