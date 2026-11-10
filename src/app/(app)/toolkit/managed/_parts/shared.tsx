import Link from "next/link";
import type { ReactNode } from "react";
import { inr } from "@/components/ui";
import { Status } from "@/modules/toolkit/ui/kit";
import { Group, NoteList, NumIn } from "@/modules/toolkit/ui/options/parts";

/** Number field: blank = unknown (never zero). Kept for compatibility — delegates to the toolkit kit. */
export function NumField({ name, label, hint, dv, suffix }: { name: string; label: string; hint?: string; dv?: unknown; suffix?: string }) {
  return <NumIn name={name} label={label} hint={hint} dv={dv} unit={suffix} />;
}

export function Section({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return <Group title={title} open={open}>{children}</Group>;
}

export const money = (x: string | null | undefined) => (x === null || x === undefined ? <span className="text-warn">unknown</span> : inr(x));

/** Inline SVG cumulative-cost chart for two series (no client JS). */
export function CumulativeChart({ a, b, labelA, labelB, marker, caption }: { a: string[]; b: string[]; labelA: string; labelB: string; marker?: number | null; caption?: string }) {
  const W = 640, H = 220, pl = 8, pr = 8, pt = 10, pb = 22;
  const n = Math.max(a.length, b.length);
  if (n < 1) return null;
  const max = Math.max(...a.map(Number), ...b.map(Number), 1);
  const x = (i: number) => pl + (n === 1 ? 0 : (i / (n - 1)) * (W - pl - pr));
  const y = (v: number) => pt + (1 - v / max) * (H - pt - pb);
  const path = (s: string[]) => s.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(v)).toFixed(1)}`).join(" ");
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Cumulative cost: ${labelA} vs ${labelB}`}>
        <line x1={pl} x2={W - pr} y1={H - pb} y2={H - pb} stroke="var(--color-line)" />
        {marker ? <line x1={x(marker - 1)} x2={x(marker - 1)} y1={pt} y2={H - pb} stroke="var(--color-accent)" strokeDasharray="4 4" /> : null}
        <path d={path(a)} fill="none" stroke="var(--color-ink-soft)" strokeWidth={2} strokeDasharray="6 4" />
        <path d={path(b)} fill="none" stroke="var(--color-brand)" strokeWidth={2} />
        <text x={pl} y={H - 6} fontSize={11} fill="var(--color-ink-soft)">Month 1</text>
        <text x={W - pr} y={H - 6} fontSize={11} fill="var(--color-ink-soft)" textAnchor="end">Month {n}</text>
        <text x={pl} y={pt + 10} fontSize={11} fill="var(--color-ink-soft)">{inr(max, { compact: true })}</text>
      </svg>
      {caption ? <p className="mt-2 text-sm text-ink">{caption}</p> : null}
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-dashed border-ink-soft" />{labelA}</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-brand" />{labelB}</span>
        {marker ? <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-accent" />break-even (month {marker})</span> : null}
      </figcaption>
    </figure>
  );
}

export function Bullets({ title, items, tone }: { title: string; items: string[]; tone?: "warn" | "bad" }) {
  return <NoteList title={title} items={items} tone={tone ? "warn" : "info"} />;
}

export function VersionList({ base, id, versions, current, viewing }: { base: string; id: string; versions: VersionRow[]; current: number; viewing: number }) {
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2 font-medium">Earlier versions ({versions.length}) <span aria-hidden className="text-ink-soft transition group-open:rotate-180 motion-reduce:transition-none">▾</span></summary>
      <ul className="space-y-1 border-t border-line px-4 py-3 text-sm">
        {versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-center gap-2">
            <Link aria-current={v.version === viewing ? "page" : undefined} className={`inline-flex min-h-11 items-center ${v.version === viewing ? "font-semibold text-ink" : "font-medium text-brand underline underline-offset-4"}`} href={`${base}/${id}?v=${v.version}`}>Version {v.version}{v.version === viewing ? " (showing)" : ""}</Link>
            <span className="text-ink-soft">{new Date(v.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {v.formula_version}</span>
            {v.version === current ? <Status s="approved" label="Current" /> : null}
            {v.note ? <span className="text-ink-soft">— {v.note}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export type VersionRow = { version: number; formula_version: string | null; note: string | null; created_at: string };
export type StoredAnalysis = { id: string; kind: string; title: string; current_version: number; inputs: unknown; outputs: unknown; formula_version: string | null; versions: VersionRow[] };
