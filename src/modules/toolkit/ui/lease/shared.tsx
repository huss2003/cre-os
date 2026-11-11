/** Lease / occupancy / negotiation UI helpers built on the Deal Toolkit kit (src/modules/toolkit/ui/kit.tsx). */
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { inr } from "@/components/ui";
import { Certainty, Field, Status, inputCls } from "@/modules/toolkit/ui/kit";
import { CalcInput } from "@/modules/toolkit/ui/calc-input";

/** Labelled text/number/date input. `unit` is rendered inside the field; padding keeps text clear of it. */
export function In({ label, hint, unit, required, name, ...p }: Omit<ComponentProps<"input">, "name"> & { label: string; hint?: string; unit?: string; name: string }) {
  return (
    <Field label={label} hint={hint} unit={unit} required={required} htmlFor={name}>
      <CalcInput id={name} name={name} required={required} unit={unit} label={label} className={`${inputCls} ${unit ? (unit.length > 8 ? "pr-32" : "pr-20") : ""}`} {...p} />
    </Field>
  );
}

export function Sel({ label, hint, name, children, ...p }: Omit<ComponentProps<"select">, "name"> & { label: string; hint?: string; name: string }) {
  return (
    <Field label={label} hint={hint} htmlFor={name}>
      <select id={name} name={name} className={inputCls} {...p}>{children}</select>
    </Field>
  );
}

/** One-time hint shown at the top of every form. */
export function BlankHint() {
  return (
    <p className="rounded-lg bg-canvas px-4 py-3 text-sm text-ink">
      <strong>Blank = unknown, 0 = none.</strong> <span className="text-ink-soft">Leave a box empty if you don&apos;t know it yet — it is listed as missing and never counted as zero. Type 0 only when the charge really doesn&apos;t apply.</span>
    </p>
  );
}

/** Sticky bottom bar holding the primary action, so it is always reachable on long forms. */
export function StickyBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,.06)] backdrop-blur">
      <p className="text-sm text-ink-soft">{note}</p>
      {children}
    </div>
  );
}

/** Expandable methodology. */
export function HowCalculated({ children }: { children: ReactNode }) {
  return (
    <details className="rounded-lg border border-line bg-surface px-4 py-2 text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center font-medium text-ink-soft hover:text-ink">How we calculated this <span aria-hidden className="ml-1">▾</span></summary>
      <div className="space-y-2 pb-2 text-ink-soft">{children}</div>
    </details>
  );
}

/** Certainty key from a quoted/estimated label. */
export const certOf = (label: string | null | undefined) => (label === "quoted" ? "quoted" : label === "confirmed" ? "confirmed" : "estimated");

/** A saved-analyses list using clickable rows. */
export function SavedList({ items, href, statusLabel }: { items: { id: string; title: string; current_version: number; status: string }[]; href: (id: string) => string; statusLabel?: (s: string) => string | undefined }) {
  return (
    <ul className="space-y-2">
      {items.map((a) => (
        <li key={a.id}>
          <Link href={href(a.id)} className="group flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 transition hover:border-brand/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none">
            <span className="min-w-0 flex-1 truncate font-semibold group-hover:text-brand">{a.title}</span>
            <span className="text-xs text-ink-soft">v{a.current_version}</span>
            <Status s={a.status} label={statusLabel?.(a.status)} />
            <span className="shrink-0 text-sm font-medium text-brand">Open →</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Signed ₹ delta with icon + word (never colour alone). For costs: negative = saving. */
export function Delta({ x, cost = true }: { x: string | number | null | undefined; cost?: boolean }) {
  if (x === null || x === undefined || x === "") return <span className="italic text-ink-soft">unknown</span>;
  const n = Number(x);
  if (n === 0) return <span className="text-ink-soft">= no change</span>;
  const good = cost ? n < 0 : n > 0;
  return <span className={good ? "text-emerald-700" : "text-rose-700"}><span aria-hidden>{n > 0 ? "▲ +" : "▼ −"}</span><span className="sr-only">{n > 0 ? "up " : "down "}</span>{inr(Math.abs(n))} <span className="text-xs font-medium">({good ? "cheaper" : "dearer"})</span></span>;
}

const DIFF: Record<string, { icon: string; label: string; cls: string }> = {
  improved: { icon: "✓", label: "Improved", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  worse: { icon: "✕", label: "Worse", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  unchanged: { icon: "=", label: "Unchanged", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
  unresolved: { icon: "?", label: "Unresolved", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  changed: { icon: "↔", label: "Changed", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
};
/** Negotiation term-change pill: icon + word. */
export function DiffPill({ s }: { s: string }) {
  const x = DIFF[s] ?? DIFF.changed;
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${x.cls}`}><span aria-hidden>{x.icon}</span>{x.label}</span>;
}

/** Small "completeness" marker reused on results. */
export function Completeness({ complete, label }: { complete: boolean; label: string }) {
  return <span className="inline-flex flex-wrap items-center gap-2">{complete ? <Status s="ready" label="All costs known" /> : <Status s="needs_info" label="Some costs unknown" />}<Certainty c={certOf(label)} /></span>;
}

/** Section heading inside result panels. */
export function H({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return <div><h3 className="text-lg font-semibold text-ink">{children}</h3>{sub ? <p className="text-sm text-ink-soft">{sub}</p> : null}</div>;
}

/** Plain panel. */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5 ${className}`}>{children}</section>;
}

export const offerLetter = (k: number) => String.fromCharCode(65 + k);
