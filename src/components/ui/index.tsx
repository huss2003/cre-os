import Link from "next/link";
import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";
import { helpFor } from "./help-text";

/* Shared, dependency-free UI primitives. Mobile-first: everything must work at 375px width. */

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-2xl text-sm text-ink-soft">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** "?" icon that explains a section on hover, keyboard focus or tap. */
export function Help({ children }: { children: ReactNode }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button type="button" aria-label="What is this?" className="ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-canvas text-[11px] font-bold text-ink-soft transition hover:border-brand hover:text-brand focus:border-brand focus:text-brand">?</button>
      <span role="tooltip" className="pointer-events-none invisible absolute left-1/2 top-7 z-30 w-72 -translate-x-1/2 rounded-xl bg-ink px-3 py-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-white opacity-0 shadow-xl transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        {children}
      </span>
    </span>
  );
}

export function Card({ title, actions, children, className, help }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; help?: ReactNode }) {
  return (
    <section className={clsx("rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title ? <h2 className="flex items-center text-base font-semibold">{title}{(help ?? helpFor(title)) ? <Help>{help ?? helpFor(title)}</Help> : null}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-brand text-white shadow-sm hover:bg-brand-strong",
  secondary: "border border-line bg-surface text-ink shadow-sm hover:border-brand/40 hover:text-brand",
  danger: "bg-bad text-white shadow-sm hover:opacity-90",
  ghost: "text-brand hover:bg-brand-soft",
};
const btnBase = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

export function Button({ variant = "primary", className, ...p }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button {...p} className={clsx(btnBase, variants[variant], className)} />;
}
export function ButtonLink({ variant = "primary", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link {...p} className={clsx(btnBase, variants[variant], className)} />;
}

type Tone = "neutral" | "brand" | "ok" | "warn" | "bad" | "accent";
const tones: Record<Tone, string> = {
  neutral: "bg-canvas text-ink-soft border-line",
  brand: "bg-brand-soft text-brand border-brand/20",
  ok: "bg-ok/10 text-ok border-ok/20",
  warn: "bg-warn/10 text-warn border-warn/30",
  bad: "bg-bad/10 text-bad border-bad/20",
  accent: "bg-accent/10 text-accent border-accent/30",
};
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span title={title} className={clsx("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

/** Fact status label — keep "reported" / "confirmed" / "AI inference" visually distinct everywhere. */
export function FactBadge({ status }: { status?: string | null }) {
  const map: Record<string, [Tone, string]> = {
    currently_confirmed: ["ok", "Confirmed"],
    historical_observed: ["neutral", "Historical"],
    reported: ["warn", "Reported"],
    ai_inference: ["accent", "AI inference"],
    unknown: ["neutral", "Unknown"],
  };
  const [tone, label] = map[status ?? "unknown"] ?? ["neutral", status ?? "Unknown"];
  return <Badge tone={tone}>{label}</Badge>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-canvas/60 px-5 py-6 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-ink-soft">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      {/* Hints live behind the "?" so the form shows only labels and boxes. */}
      <span className="mb-1.5 flex items-center font-medium">{label}{hint ? <Help>{hint}</Help> : null}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10";
export function Input(p: ComponentProps<"input">) {
  return <input {...p} className={clsx(inputCls, p.className)} />;
}
export function Textarea(p: ComponentProps<"textarea">) {
  return <textarea {...p} className={clsx(inputCls, "min-h-24", p.className)} />;
}
export function Select(p: ComponentProps<"select">) {
  return <select {...p} className={clsx(inputCls, p.className)} />;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="bg-canvas text-xs uppercase tracking-wide text-ink-soft">
          <tr>{head.map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={clsx("px-3 py-2 align-top", className)}>{children}</td>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="text-xs font-medium text-ink-soft">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint ? <div className="mt-1 text-xs text-ink-soft">{hint}</div> : null}
    </div>
  );
}

/** Banner for stale / unavailable sources. Never hide a failed source. */
export function StaleBanner({ children }: { children: ReactNode }) {
  return <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">{children}</div>;
}

export function inr(n: number | string | null | undefined, opts: { compact?: boolean } = {}) {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (opts.compact) {
    if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
    if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  }
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v);
}
export function sf(n: number | string | null | undefined) {
  if (n === null || n === undefined || n === "") return "—";
  return `${new Intl.NumberFormat("en-IN").format(Number(n))} sf`;
}

/** Optional fields folded away: essentials stay visible, the rest opens on click. Use inside any form. */
export function MoreFields({ children, label = "More details (optional)" }: { children: ReactNode; label?: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none py-1 text-sm font-medium text-ink-soft hover:text-brand">
        <span className="group-open:hidden">＋ </span><span className="hidden group-open:inline">－ </span>{label}
      </summary>
      <div className="mt-3 space-y-4">{children}</div>
    </details>
  );
}
