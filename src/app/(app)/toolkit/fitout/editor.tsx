"use client";
import { useState } from "react";
import { Certainty, Field, btn, inputCls } from "@/modules/toolkit/ui/kit";
import { StickyBar } from "@/modules/toolkit/ui/options/parts";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveFitoutAction, type FitoutPayload } from "@/modules/toolkit/actions-fitout";
import { CATEGORY_LABEL, DEFAULT_CRITERIA, FITOUT_CATEGORIES, type FitoutCategory, type FitoutLine, type PartnerQuote } from "@/modules/toolkit/calc/fitout";

const blankLine = (): FitoutLine => ({ category: "civil", description: "", quantity: "", unit: "", unitPrice: "", vendor: "", quoteRef: "", taxPct: "", estimated: "", approved: "", actual: "" });
const blankQuote = (): PartnerQuote => ({ partnerName: "", scope: [], exclusions: [], price: "", taxPct: "", deliveryWeeks: "", paymentSchedule: "", warrantyMonths: "", validUntil: "", documentsUrl: "" });
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const cell = inputCls.replace("px-3", "px-2").replace("text-[15px]", "text-sm");
const STAGE_TINT = { estimated: "bg-amber-50/70 border-amber-300", approved: "bg-sky-50/70 border-sky-300", actual: "bg-emerald-50/70 border-emerald-300" } as const;
const STAGE_CERT = { estimated: "estimated", approved: "quoted", actual: "confirmed" } as const;
const STAGE_NAME = { estimated: "Estimated", approved: "Approved", actual: "Actual" } as const;
const chip = (on: boolean) => `inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm focus-within:ring-2 focus-within:ring-brand/30 ${on ? "border-brand bg-brand-soft text-brand" : "border-slate-300 bg-white text-ink-soft"}`;

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
    <ActionForm action={saveFitoutAction} className="min-w-0 space-y-6">
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Name this budget" required htmlFor="fo-title"><input id="fo-title" className={inputCls} name="title" defaultValue={title ?? ""} placeholder="e.g. Baner HQ fit-out" required /></Field>
        <Field label="Carpet area" unit="sf" hint="Gives cost per sf." htmlFor="fo-area"><input id="fo-area" className={`${inputCls} pr-12`} inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} placeholder="blank = unknown" /></Field>
        <Field label="Seats" unit="seats" hint="Gives cost per seat." htmlFor="fo-seats"><input id="fo-seats" className={`${inputCls} pr-16`} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} placeholder="blank = unknown" /></Field>
      </div>

      <section aria-labelledby="fo-lines" className="space-y-3">
        <div>
          <h3 id="fo-lines" className="text-lg font-semibold"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">1</span>Budget lines</h3>
          <p className="text-sm text-ink-soft">One row per item. Amounts <strong>exclude tax</strong>; tax % per line is required (never assumed). Leave unknown amounts blank. Estimated = quantity × unit price when left blank.</p>
          <p className="mt-2 flex flex-wrap gap-3 text-xs">{(["estimated", "approved", "actual"] as const).map((k) => <span key={k} className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 ${STAGE_TINT[k]}`}><strong>{STAGE_NAME[k]}</strong><Certainty c={STAGE_CERT[k]} /></span>)}</p>
        </div>
        <p className="text-xs text-ink-soft sm:hidden">Scroll the table sideways to see every column →</p>
        <div className="relative max-w-full overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-canvas text-xs text-ink-soft">
              <tr>
                <th scope="col" className="px-2 py-2 font-semibold">#</th>
                <th scope="col" className="px-2 py-2 font-semibold">Category</th>
                <th scope="col" className="px-2 py-2 font-semibold">Description</th>
                <th scope="col" className="px-2 py-2 font-semibold">Qty</th>
                <th scope="col" className="px-2 py-2 font-semibold">Unit</th>
                <th scope="col" className="px-2 py-2 font-semibold">Unit price ₹</th>
                <th scope="col" className="px-2 py-2 font-semibold">Vendor</th>
                <th scope="col" className="px-2 py-2 font-semibold">Quote ref</th>
                <th scope="col" className="px-2 py-2 font-semibold">Tax %</th>
                {(["estimated", "approved", "actual"] as const).map((k) => <th key={k} scope="col" className={`border-l px-2 py-2 font-semibold ${STAGE_TINT[k]}`}>{STAGE_NAME[k]} ₹</th>)}
                <th scope="col" className="px-2 py-2"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((l, i) => {
                const lab = (x: string) => `Line ${i + 1} ${x}`;
                return (
                  <tr key={i} className="align-top">
                    <td className="px-2 py-2 text-ink-soft">{i + 1}</td>
                    <td className="px-1 py-1.5 min-w-36"><select className={cell} value={l.category} onChange={(e) => setL(i, "category", e.target.value)} aria-label={lab("category")} name={`line_${i}_category`}>
                      {FITOUT_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                    </select></td>
                    <td className="px-1 py-1.5 min-w-48"><input className={cell} aria-label={lab("description")} name={`line_${i}_description`} placeholder="Description" value={s(l.description)} onChange={(e) => setL(i, "description", e.target.value)} /></td>
                    <td className="px-1 py-1.5 w-20"><input className={cell} aria-label={lab("quantity")} name={`line_${i}_quantity`} inputMode="decimal" value={s(l.quantity)} onChange={(e) => setL(i, "quantity", e.target.value)} /></td>
                    <td className="px-1 py-1.5 w-24"><input className={cell} aria-label={lab("unit")} name={`line_${i}_unit`} placeholder="sf, nos…" value={s(l.unit)} onChange={(e) => setL(i, "unit", e.target.value)} /></td>
                    <td className="px-1 py-1.5 w-28"><input className={cell} aria-label={lab("unit price ₹")} name={`line_${i}_unit_price`} inputMode="decimal" value={s(l.unitPrice)} onChange={(e) => setL(i, "unitPrice", e.target.value)} /></td>
                    <td className="px-1 py-1.5 w-32"><input className={cell} aria-label={lab("vendor")} name={`line_${i}_vendor`} value={s(l.vendor)} onChange={(e) => setL(i, "vendor", e.target.value)} /></td>
                    <td className="px-1 py-1.5 w-28"><input className={cell} aria-label={lab("quote ref")} name={`line_${i}_quote_ref`} value={s(l.quoteRef)} onChange={(e) => setL(i, "quoteRef", e.target.value)} /></td>
                    <td className="px-1 py-1.5 w-20"><input className={`${cell} ${s(l.taxPct) === "" ? "border-amber-400" : ""}`} aria-label={lab("tax %")} name={`line_${i}_tax`} placeholder="req." inputMode="decimal" value={s(l.taxPct)} onChange={(e) => setL(i, "taxPct", e.target.value)} /></td>
                    {(["estimated", "approved", "actual"] as const).map((k) => (
                      <td key={k} className={`w-32 border-l px-1 py-1.5 ${STAGE_TINT[k]}`}><input className={`${cell} ${STAGE_TINT[k]}`} aria-label={lab(`${STAGE_NAME[k].toLowerCase()} ₹`)} name={`line_${i}_${k}`} inputMode="decimal" placeholder={k === "estimated" ? "qty × price" : "blank = unknown"} value={s(l[k])} onChange={(e) => setL(i, k, e.target.value)} /></td>
                    ))}
                    <td className="px-1 py-1.5"><button type="button" aria-label={`Remove line ${i + 1}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-ink-soft hover:border-rose-400 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300" onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" className={btn.secondary} onClick={() => setLines((xs) => [...xs, blankLine()])}>＋ Add budget line</button>
      </section>

      <section aria-labelledby="fo-quotes" className="space-y-4">
        <div>
          <h3 id="fo-quotes" className="text-lg font-semibold"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">2</span>Partner quotations</h3>
          <p className="text-sm text-ink-soft">Every partner goes through the same comparison and ranking — no partner is treated specially.</p>
        </div>
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium text-ink">Required scope</legend>
          <p className="mb-2 text-xs text-ink-soft">Tap the categories every quote must cover. None ticked = the categories used in your budget lines.</p>
          <div className="flex flex-wrap gap-2">
            {FITOUT_CATEGORIES.map((c) => (
              <label key={c} className={chip(scope.includes(c))}>
                <input type="checkbox" className="sr-only" checked={scope.includes(c)} onChange={(e) => setScope((xs) => (e.target.checked ? [...xs, c] : xs.filter((x) => x !== c)))} /><span aria-hidden>{scope.includes(c) ? "✓" : "+"}</span>{CATEGORY_LABEL[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <datalist id="partner-names">{partners.map((p) => <option key={p.id} value={p.name} />)}</datalist>
        {quotes.length === 0 ? <p className="rounded-xl border-2 border-dashed border-slate-300 px-4 py-6 text-center text-sm text-ink-soft">No quotations yet. Press “Add partner quotation” for each partner&apos;s quote.</p> : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {quotes.map((q, i) => {
          const qid = `q${i}-`;
          return (
          <article key={i} aria-label={`Quotation ${i + 1}`} className={`space-y-3 rounded-xl border-2 bg-surface p-4 ${pref === i ? "border-brand" : "border-line"}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">Quotation {i + 1}{q.partnerName ? ` — ${q.partnerName}` : ""}</p>
              <span className="flex items-center gap-2">{pref === i ? <span className="rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold text-white">★ Preferred</span> : null}<Certainty c="quoted" /></span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Partner name" htmlFor={`${qid}name`} required><input id={`${qid}name`} name={`${qid}name`} className={inputCls} list="partner-names" value={q.partnerName} onChange={(e) => setQ(i, { partnerName: e.target.value, partnerId: byName.get(e.target.value) ?? null })} /></Field>
              <Field label="Price excluding tax" unit="₹" htmlFor={`${qid}price`} required><input id={`${qid}price`} name={`${qid}price`} className={`${inputCls} pr-10`} inputMode="decimal" value={s(q.price)} onChange={(e) => setQ(i, { price: e.target.value })} /></Field>
              <Field label="Tax" unit="%" htmlFor={`${qid}tax`} required><input id={`${qid}tax`} name={`${qid}tax`} className={`${inputCls} pr-10`} inputMode="decimal" value={s(q.taxPct)} onChange={(e) => setQ(i, { taxPct: e.target.value })} /></Field>
              <Field label="Delivery" unit="weeks" htmlFor={`${qid}wk`}><input id={`${qid}wk`} name={`${qid}wk`} className={`${inputCls} pr-16`} inputMode="numeric" value={s(q.deliveryWeeks)} onChange={(e) => setQ(i, { deliveryWeeks: e.target.value })} /></Field>
              <Field label="Warranty" unit="months" htmlFor={`${qid}wr`}><input id={`${qid}wr`} name={`${qid}wr`} className={`${inputCls} pr-20`} inputMode="numeric" value={s(q.warrantyMonths)} onChange={(e) => setQ(i, { warrantyMonths: e.target.value })} /></Field>
              <Field label="Valid until" hint="Past this date the quote is marked Expired." htmlFor={`${qid}vu`}><input id={`${qid}vu`} name={`${qid}vu`} className={inputCls} type="date" value={s(q.validUntil)} onChange={(e) => setQ(i, { validUntil: e.target.value })} /></Field>
              <Field label="Payment schedule" htmlFor={`${qid}pay`}><input id={`${qid}pay`} name={`${qid}pay`} className={inputCls} value={s(q.paymentSchedule)} onChange={(e) => setQ(i, { paymentSchedule: e.target.value })} /></Field>
              <Field label="Documents link" htmlFor={`${qid}doc`}><input id={`${qid}doc`} name={`${qid}doc`} className={inputCls} value={s(q.documentsUrl)} onChange={(e) => setQ(i, { documentsUrl: e.target.value })} /></Field>
            </div>
            <Field label="Exclusions" hint="Separate items with ;" htmlFor={`${qid}ex`}><input id={`${qid}ex`} name={`${qid}ex`} className={inputCls} value={(q.exclusions ?? []).join("; ")} onChange={(e) => setQ(i, { exclusions: e.target.value.split(";").map((x) => x.trim()) })} /></Field>
            <fieldset className="min-w-0">
              <legend className="text-sm font-medium">Scope this quote covers</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {FITOUT_CATEGORIES.map((c) => {
                  const on = (q.scope ?? []).includes(c);
                  return <button type="button" key={c} aria-pressed={on} onClick={() => setQ(i, { scope: on ? (q.scope ?? []).filter((x) => x !== c) : [...(q.scope ?? []), c] })} className={chip(on)}><span aria-hidden>{on ? "✓" : "+"}</span>{CATEGORY_LABEL[c]}</button>;
                })}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium"><input type="radio" className="h-5 w-5 accent-[var(--color-brand)]" name="pref-pick" checked={pref === i} onChange={() => setPref(i)} /> Mark as preferred partner</label>
              <button type="button" className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-3 text-sm text-ink-soft hover:border-rose-400 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300" onClick={() => { setQuotes((xs) => xs.filter((_, j) => j !== i)); setPref(null); }}>✕ Remove quotation</button>
            </div>
          </article>
          );
        })}
        </div>
        <button type="button" className={btn.secondary} onClick={() => setQuotes((xs) => [...xs, blankQuote()])}>＋ Add partner quotation</button>
        {pref !== null ? (
          <div role="status" className="space-y-3 rounded-xl border-2 border-brand/40 bg-brand-soft p-4">
            <p className="text-sm font-semibold">★ Preferred partner needs a written reason</p>
            <p className="text-sm text-ink-soft">You marked a preferred partner. Write why (at least 10 characters) — it is stored with the analysis. The ranking itself does not change.</p>
            <Field label="Why is this partner preferred?" required htmlFor="fo-reason"><textarea id="fo-reason" name="preferred_reason" rows={3} className={`${inputCls} py-2`} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} /></Field>
            <button type="button" className={btn.quiet} onClick={() => { setPref(null); setReason(""); }}>Clear preferred choice</button>
          </div>
        ) : null}
        <details className="group rounded-xl border border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-sm font-medium">Ranking weights — price {crit.price} · scope {crit.scope} · timeline {crit.timeline} · warranty {crit.warranty} <span aria-hidden className="transition group-open:rotate-180 motion-reduce:transition-none">▾</span></summary>
          <div className="grid grid-cols-2 gap-3 border-t border-line p-4 sm:grid-cols-4">
            {(["price", "scope", "timeline", "warranty"] as const).map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)} htmlFor={`w-${k}`}><input id={`w-${k}`} name={`weight_${k}`} className={inputCls} inputMode="numeric" value={crit[k]} onChange={(e) => setCrit((c) => ({ ...c, [k]: Math.max(0, Number(e.target.value) || 0) }))} /></Field>
            ))}
          </div>
        </details>
      </section>

      <Field label="Version note" htmlFor="fo-note"><input id="fo-note" className={inputCls} name="note" placeholder="What changed" /></Field>
      <StickyBar note="Press to total the budget and rank the quotes."><Submit>{id ? "Compare & save new version" : "Compare & save"}</Submit></StickyBar>
    </ActionForm>
  );
}
