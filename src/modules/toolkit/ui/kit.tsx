/**
 * Deal Toolkit interaction language — ONE visual vocabulary so a new user always knows what is what:
 *
 *  • Editable input  → white field, solid border, label above, pencil hint in label   (Field / inputCls)
 *  • Computed value  → no border, tinted "readout" with "Calculated" tag; never looks editable (Readout)
 *  • Clickable       → primary = solid brand button; secondary = outlined; link-style for navigation ONLY (btn.*)
 *  • Status          → one pill family with icon + word (never colour alone)                    (Status)
 *  • Data certainty  → Confirmed / Quoted / Estimated / Assumption / Missing                    (Certainty)
 *  • Next step       → a numbered "how this page works" strip at the top                         (StepGuide)
 *  • Empty / missing → dashed box that says what to do                                          (EmptyState, MissingNote)
 */
import Link from "next/link";
import type { ReactNode } from "react";

export const inputCls = "block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-[15px] text-ink shadow-[inset_0_1px_0_rgba(0,0,0,.03)] placeholder:text-slate-400 hover:border-slate-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:bg-canvas disabled:text-ink-soft";

export const btn = {
  primary: "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-5 text-sm font-semibold text-white shadow-sm hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50",
  secondary: "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-ink hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
  quiet: "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
  link: "font-medium text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand",
};

/** Labelled editable input wrapper. `hint` = one line of plain help; `unit` shown inside the field on the right. */
export function Field({ label, hint, unit, required, children, htmlFor }: { label: string; hint?: string; unit?: string; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-sm font-medium text-ink">
        <span aria-hidden className="text-slate-400">✎</span>{label}{required ? <span className="text-rose-600" aria-label="required">*</span> : <span className="text-xs font-normal text-ink-soft">optional</span>}
      </label>
      <div className="relative">{children}{unit ? <span className="pointer-events-none absolute right-3 top-0 flex h-11 items-center text-sm text-ink-soft">{unit}</span> : null}</div>
      {hint ? <p className="text-xs text-ink-soft">{hint}</p> : null}
    </div>
  );
}

/** A calculated result. Visually distinct from inputs: tinted, no border, "Calculated" tag. */
export function Readout({ label, value, sub, emphasis, unknown }: { label: string; value: ReactNode; sub?: ReactNode; emphasis?: boolean; unknown?: boolean }) {
  return (
    <div className={`rounded-xl px-4 py-3 ${emphasis ? "bg-brand-soft" : "bg-canvas"}`}>
      <p className="flex items-center justify-between gap-2 text-xs font-medium text-ink-soft"><span>{label}</span><span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">Calculated</span></p>
      <p className={`mt-1 tabular-nums ${emphasis ? "text-2xl font-bold text-brand" : "text-lg font-semibold"} ${unknown ? "italic text-ink-soft" : ""}`}>{unknown ? "Unknown — add the missing input" : value}</p>
      {sub ? <p className="mt-0.5 text-xs text-ink-soft">{sub}</p> : null}
    </div>
  );
}

const STATUS: Record<string, { icon: string; label: string; cls: string }> = {
  draft: { icon: "✎", label: "Draft", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
  needs_info: { icon: "!", label: "Needs info", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  ready: { icon: "●", label: "Ready to review", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  approved: { icon: "✓", label: "Approved", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  pending: { icon: "◷", label: "Pending", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  expired: { icon: "✕", label: "Expired", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  archived: { icon: "–", label: "Archived", cls: "bg-slate-50 text-slate-500 ring-slate-200" },
  eligible: { icon: "✓", label: "Eligible", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  not_eligible: { icon: "✕", label: "Not eligible", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  unconfirmed: { icon: "?", label: "Unconfirmed", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
};
/** Workflow status of a record/analysis. Always icon + word. */
export function Status({ s, label }: { s: string; label?: string }) {
  const x = STATUS[s] ?? { icon: "●", label: s.replace(/_/g, " "), cls: "bg-slate-100 text-slate-700 ring-slate-200" };
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${x.cls}`}><span aria-hidden>{x.icon}</span>{label ?? x.label}</span>;
}

const CERT: Record<string, { label: string; dot: string; tip: string }> = {
  confirmed: { label: "Confirmed", dot: "bg-emerald-500", tip: "Confirmed by the client or a signed document" },
  quoted: { label: "Quoted", dot: "bg-sky-500", tip: "From a landlord/provider quote — check validity" },
  estimated: { label: "Estimated", dot: "bg-amber-500", tip: "Our estimate — not confirmed" },
  assumption: { label: "Assumption", dot: "bg-violet-500", tip: "Assumed to run the numbers" },
  missing: { label: "Missing", dot: "border border-slate-400 bg-white", tip: "Not known yet — never treated as zero" },
  na: { label: "N/A", dot: "bg-slate-300", tip: "Not applicable" },
};
/** How sure we are about a value. Small, quiet, consistent everywhere. */
export function Certainty({ c }: { c: string }) {
  const x = CERT[c] ?? CERT.estimated;
  return <span title={x.tip} className="inline-flex items-center gap-1.5 text-xs text-ink-soft"><span aria-hidden className={`h-2 w-2 rounded-full ${x.dot}`} />{x.label}</span>;
}

/** Legend explaining the visual language — put once near the top of complex pages. */
export function Legend() {
  return (
    <details className="group rounded-lg border border-line bg-surface px-4 py-2 text-sm">
      <summary className="cursor-pointer list-none font-medium text-ink-soft group-open:text-ink">How to read this page <span aria-hidden>▾</span></summary>
      <dl className="mt-3 grid gap-3 pb-1 sm:grid-cols-2">
        <div className="flex items-center gap-3"><span className="w-28 shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">✎ Type here</span><dd>White boxes with a border are things you can edit.</dd></div>
        <div className="flex items-center gap-3"><span className="w-28 shrink-0 rounded-lg bg-canvas px-2 py-1 text-xs">₹ 12,34,000</span><dd>Tinted boxes are calculated for you — change the inputs to change them.</dd></div>
        <div className="flex items-center gap-3"><span className={`${btn.primary} min-h-8 w-28 px-2 text-xs`}>Do it</span><dd>Solid buttons do the main action on the page.</dd></div>
        <div className="flex items-center gap-3"><span className="w-28"><Status s="needs_info" /></span><dd>Pills show status. “Needs info” = fill the listed gaps.</dd></div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">{Object.keys(CERT).map((k) => <Certainty key={k} c={k} />)}<dd className="text-ink-soft">— how sure a figure is.</dd></div>
      </dl>
    </details>
  );
}

/** Numbered "how this page works" strip. `current` = index of the step the user is on (0-based). */
export function StepGuide({ steps, current }: { steps: string[]; current?: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-sm" aria-label="How this page works">
      {steps.map((s, i) => (
        <li key={i} className={`flex items-center gap-2 rounded-full px-3 py-1.5 ${current === i ? "bg-brand text-white" : current !== undefined && i < current ? "bg-emerald-50 text-emerald-800" : "bg-canvas text-ink-soft"}`}>
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${current === i ? "bg-white/20" : "bg-white"}`}>{current !== undefined && i < current ? "✓" : i + 1}</span>{s}
        </li>
      ))}
    </ol>
  );
}

/** Page header: title, one-sentence purpose, optional primary action, optional steps. */
export function ToolHeader({ eyebrow, title, purpose, action, steps, current, back = { href: "/toolkit", label: "Deal toolkit" } }: { eyebrow?: string; title: string; purpose: string; action?: ReactNode; steps?: string[]; current?: number; back?: { href: string; label: string } | null }) {
  return (
    <header className="space-y-4 border-b border-line pb-5">
      {back ? <Link href={back.href} className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">← {back.label}</Link> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          {eyebrow ? <p className="text-sm font-medium text-brand">{eyebrow}</p> : null}
          <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
          <p className="mt-1.5 text-[15px] leading-relaxed text-ink-soft">{purpose}</p>
        </div>
        {action}
      </div>
      {steps ? <StepGuide steps={steps} current={current} /> : null}
    </header>
  );
}

/** Group of inputs with a heading and one-line explanation. */
export function FormSection({ title, desc, children, defaultOpen = true }: { title: string; desc?: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
        <span><span className="block font-semibold">{title}</span>{desc ? <span className="block text-sm text-ink-soft">{desc}</span> : null}</span>
        <span aria-hidden className="text-ink-soft transition group-open:rotate-180 motion-reduce:transition-none">▾</span>
      </summary>
      <div className="grid gap-4 border-t border-line px-5 py-5 sm:grid-cols-2">{children}</div>
    </details>
  );
}

export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-slate-300 px-6 py-10 text-center">
      <p className="font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{text}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** "What's missing" callout: lists gaps and tells the user what to do. */
export function MissingNote({ items, what = "Add these to complete the analysis" }: { items: string[]; what?: string }) {
  if (!items.length) return null;
  return (
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">! {items.length} input{items.length > 1 ? "s" : ""} missing — {what}</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{items.slice(0, 8).map((m, i) => <li key={i}>{m}</li>)}{items.length > 8 ? <li>and {items.length - 8} more</li> : null}</ul>
    </div>
  );
}

/** Clickable row/card for lists: whole row is a link with an explicit "Open →" affordance. */
export function OpenRow({ href, title, meta, right }: { href: string; title: ReactNode; meta?: ReactNode; right?: ReactNode }) {
  return (
    <Link href={href} className="group flex min-w-0 items-center gap-3 sm:gap-4 rounded-xl border border-line bg-surface px-4 py-3 transition hover:border-brand/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none">
      <span className="min-w-0 flex-1"><span className="block truncate font-semibold text-ink group-hover:text-brand">{title}</span>{meta ? <span className="block truncate text-sm text-ink-soft">{meta}</span> : null}</span>
      {right}
      <span className="hidden shrink-0 text-sm font-medium text-brand sm:inline">Open →</span>
    </Link>
  );
}
