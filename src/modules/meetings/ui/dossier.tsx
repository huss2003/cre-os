import type { ReactNode } from "react";
import { HelpFor } from "@/components/ui";

/** Editorial "dossier" primitives for the meeting brief + meeting mode. Server components only. */

export const inp = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] focus-visible:outline-2 focus-visible:outline-brand";
export const linkBtn = "inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

const KIND: Record<string, [string, string]> = {
  fact: ["Confirmed", "bg-ok"],
  history: ["Historical", "bg-ink-soft"],
  inference: ["Not confirmed", "bg-warn"],
  unknown: ["Unknown", "bg-line"],
  suggestion: ["Suggestion", "bg-brand"],
};
export function Tag({ k }: { k: string }) {
  const [label, dot] = KIND[k] ?? [k, "bg-line"];
  return (
    <span className="ml-1.5 inline-flex translate-y-[-1px] items-center gap-1 whitespace-nowrap rounded-full border border-line px-1.5 py-px align-middle text-[10.5px] font-medium tracking-wide text-ink-soft">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />{label}
    </span>
  );
}

export function Dot({ tone }: { tone: "bad" | "warn" | "ok" | "muted" }) {
  const c = { bad: "bg-bad", warn: "bg-warn", ok: "bg-ok", muted: "bg-ink-soft/50" }[tone];
  return <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />;
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const s = size === "sm" ? "h-8 w-8 text-[11px]" : "h-10 w-10 text-xs";
  return <span aria-hidden className={`inline-flex ${s} shrink-0 items-center justify-center rounded-full border-2 border-surface bg-brand-soft font-semibold tracking-wide text-brand-strong`}>{initials(name)}</span>;
}
export function AvatarStack({ names }: { names: string[] }) {
  const shown = names.slice(0, 6);
  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">{shown.map((n, i) => <span key={i} title={n}><Avatar name={n} size="sm" /></span>)}</div>
      <p className="ml-3 text-sm text-ink-soft">{names.length === 0 ? "No attendees yet" : names.length <= 2 ? names.join(" & ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`}</p>
    </div>
  );
}

/** Readiness ring — pure SVG. */
export function Gauge({ score }: { score: number }) {
  const r = 42, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(score) || 0));
  const tone = v >= 75 ? "stroke-ok" : v >= 45 ? "stroke-brand" : "stroke-warn";
  return (
    <div className="relative h-28 w-28 shrink-0" role="img" aria-label={`Readiness ${v} out of 100`}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="6" className="stroke-line" />
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="6" strokeLinecap="round" className={tone} strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums tracking-tight">{v}</span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-ink-soft">ready</span>
      </div>
    </div>
  );
}

/** Numbered section with hairline rule and number in the margin. */
export function Section({ id, n, title, help, note, children }: { id: string; n?: string; title: string; help?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-8 pb-10 break-inside-avoid-page">
      <div className="flex gap-4 sm:gap-6">
        <span className="w-6 shrink-0 pt-1 text-xs font-medium tabular-nums tracking-wider text-ink-soft sm:w-8">{n ?? ""}</span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center text-xl font-semibold tracking-tight">{title}<HelpFor k={help ?? title} /></h2>
          {note ? <p className="mt-1 text-sm text-ink-soft">{note}</p> : null}
          <div className="mt-5 text-[15px] leading-relaxed">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-soft">{children}</p>;
}

export function Chip({ tone, children }: { tone: "ok" | "bad" | "muted"; children: ReactNode }) {
  const c = { ok: "border-ok/30 text-ok", bad: "border-bad/30 text-bad", muted: "border-line text-ink-soft" }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${c}`}>{children}</span>;
}

/** Calm disclosure row for the Manage area. */
export function Disclosure({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <details className="group border-b border-line">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 text-[15px] font-medium focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <span>{title}{meta ? <span className="ml-2 text-sm font-normal text-ink-soft">{meta}</span> : null}</span>
        <Chevron />
      </summary>
      <div className="pb-6 pt-1">{children}</div>
    </details>
  );
}
export function Chevron() {
  return <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-ink-soft transition-transform group-open:rotate-180 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export const OUTCOME_LABEL: Record<string, string> = { positive: "Went well", neutral: "Neutral", negative: "Not interested", no_show: "Didn't take place" };
