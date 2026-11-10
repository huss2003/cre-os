/**
 * Shared building blocks for the option-comparison tools (managed, renewal, fit-out, financing).
 * Built only on the toolkit interaction kit so every page reads the same way.
 */
import type { ReactNode } from "react";
import { Field, OpenRow, Status, EmptyState, inputCls } from "../kit";

/** Editable number box. Blank = unknown (never zero). Unit shown inside the field. */
export function NumIn({ name, label, hint, dv, unit, required, idPrefix = "" }: { name: string; label: string; hint?: string; dv?: unknown; unit?: string; required?: boolean; idPrefix?: string }) {
  const v = dv === null || dv === undefined ? "" : String(dv);
  const id = `${idPrefix}f-${name}`;
  return (
    <Field label={label} hint={hint} unit={unit} required={required} htmlFor={id}>
      <input id={id} name={name} inputMode="decimal" defaultValue={v} placeholder="blank = unknown" className={`${inputCls} tabular-nums ${unit ? (unit.length > 8 ? "pr-32" : "pr-20") : ""}`} />
    </Field>
  );
}

/** Plain white card with a heading. */
export function Panel({ title, desc, children, right }: { title: ReactNode; desc?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="font-semibold text-ink">{title}</h2>{desc ? <p className="text-sm text-ink-soft">{desc}</p> : null}</div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** One side of a two-option comparison: a clearly labelled editable card. */
export function OptionCard({ n, title, desc, tone = "a", children }: { n: number; title: string; desc?: string; tone?: "a" | "b"; children: ReactNode }) {
  return (
    <section aria-label={`Option ${n} — ${title}`} className={`min-w-0 rounded-xl border-2 bg-surface ${tone === "a" ? "border-slate-300" : "border-brand/40"}`}>
      <header className={`rounded-t-[10px] px-4 py-3 ${tone === "a" ? "bg-canvas" : "bg-brand-soft"}`}>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Option {n} · you edit this</p>
        <h3 className="text-lg font-bold text-ink">{title}</h3>
        {desc ? <p className="text-sm text-ink-soft">{desc}</p> : null}
      </header>
      <div className="space-y-3 p-3 sm:p-4">{children}</div>
    </section>
  );
}

/** Collapsible group inside an option card. */
export function Group({ title, desc, open, children }: { title: string; desc?: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group rounded-lg border border-line">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
        <span><span className="block text-sm font-semibold">{title}</span>{desc ? <span className="block text-xs text-ink-soft">{desc}</span> : null}</span>
        <span aria-hidden className="text-ink-soft transition group-open:rotate-180 motion-reduce:transition-none">▾</span>
      </summary>
      <div className="grid grid-cols-1 gap-3 border-t border-line p-3 sm:grid-cols-2">{children}</div>
    </details>
  );
}

/** Sticky bottom bar holding the primary action, so "Compare" is always reachable. */
export function StickyBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{note ?? "Blank boxes are treated as unknown and listed as missing — never as zero."}</p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/** Plain-words verdict at the top of results. */
export function VerdictHero({ items, text, children }: { items: { label: string; value: string; known: boolean }[]; text?: ReactNode; children?: ReactNode }) {
  return (
    <section aria-label="Verdict" className="rounded-xl border-2 border-brand/30 bg-brand-soft p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-brand">The answer</p>
      <dl className="mt-2 grid gap-3 sm:grid-cols-2">
        {items.map((x) => (
          <div key={x.label} className="rounded-lg bg-white/80 px-4 py-3">
            <dt className="text-sm text-ink-soft">{x.label}</dt>
            <dd className={`text-xl font-bold ${x.known ? "text-ink" : "italic text-ink-soft"}`}>{x.known ? "✓ " : "? "}{x.value}</dd>
          </div>
        ))}
      </dl>
      {text ? <p className="mt-3 text-[15px] leading-relaxed text-ink">{text}</p> : null}
      {children}
    </section>
  );
}

/** "How we calculated this" — collapsed method notes. */
export function HowCalc({ items, children }: { items: string[]; children?: ReactNode }) {
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">How we calculated this <span aria-hidden className="text-ink-soft transition group-open:rotate-180 motion-reduce:transition-none">▾</span></summary>
      <div className="border-t border-line px-4 py-3">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
        {children}
      </div>
    </details>
  );
}

/** Notes list (warnings / risks / negotiation points). */
export function NoteList({ title, items, tone }: { title: string; items: string[]; tone?: "warn" | "info" }) {
  if (!items.length) return null;
  return (
    <div role={tone === "warn" ? "status" : undefined} className={`rounded-xl border px-4 py-3 text-sm ${tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-line bg-surface"}`}>
      <p className="font-semibold">{tone === "warn" ? "! " : ""}{title}</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SavedRow = Record<string, any>;
/** Saved analyses list: whole row clickable with status pill. */
export function SavedList({ rows, base, emptyTitle, emptyText }: { rows: SavedRow[]; base: string; emptyTitle: string; emptyText: string }) {
  if (!rows.length) return <EmptyState title={emptyTitle} text={emptyText} />;
  return (
    <ul className="space-y-2">
      {rows.map((r) => <li key={String(r.id)}><OpenRow href={`${base}/${r.id}`} title={String(r.title || "Untitled")} meta={`Version ${r.current_version}`} right={<Status s={String(r.status)} />} /></li>)}
    </ul>
  );
}

/** Toggle chips (checkbox group) — used for "included in the price" services. Server-safe (native checkboxes). */
export function ToggleChips({ name, options, checked, legend, note }: { name: string; options: { value: string; label: string }[]; checked: Set<string>; legend: string; note?: string }) {
  return (
    <fieldset className="sm:col-span-2">
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      {note ? <p className="mb-2 text-xs text-ink-soft">{note}</p> : null}
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label key={o.value} className="group relative inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-slate-300 bg-white px-3 text-sm text-ink-soft has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:text-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30">
            <input type="checkbox" name={name} value={o.value} defaultChecked={checked.has(o.value)} className="peer sr-only" />
            <span aria-hidden className="flex h-4 w-4 items-center justify-center rounded border border-slate-400 text-[10px] peer-checked:border-brand peer-checked:bg-brand peer-checked:text-white">
              <span className="hidden group-has-[:checked]:inline">✓</span>
            </span>
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Text field using the kit look. */
export function TextIn({ name, label, hint, dv, placeholder, area, required, idPrefix = "" }: { name: string; label: string; hint?: string; dv?: string; placeholder?: string; area?: boolean; required?: boolean; idPrefix?: string }) {
  const id = `${idPrefix}f-${name}`;
  return (
    <Field label={label} hint={hint} required={required} htmlFor={id}>
      {area
        ? <textarea id={id} name={name} defaultValue={dv ?? ""} placeholder={placeholder} rows={3} className={`${inputCls} py-2`} />
        : <input id={id} name={name} defaultValue={dv ?? ""} placeholder={placeholder} required={required} className={inputCls} />}
    </Field>
  );
}
