import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, Field, Input, inr } from "@/components/ui";

/** Number field: blank = unknown (never zero). */
export function NumField({ name, label, hint, dv, suffix }: { name: string; label: string; hint?: string; dv?: unknown; suffix?: string }) {
  const v = dv === null || dv === undefined ? "" : String(dv);
  return (
    <Field label={suffix ? `${label} (${suffix})` : label} hint={hint}>
      <Input name={name} inputMode="decimal" defaultValue={v} placeholder="blank = unknown" />
    </Field>
  );
}

export function Section({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group rounded-2xl border border-line bg-surface p-4">
      <summary className="cursor-pointer list-none text-sm font-semibold">
        <span className="group-open:hidden">＋ </span><span className="hidden group-open:inline">－ </span>{title}
      </summary>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </details>
  );
}

export const money = (x: string | null | undefined) => (x === null || x === undefined ? <span className="text-warn">unknown</span> : inr(x));

/** Inline SVG cumulative-cost chart for two series (no client JS). */
export function CumulativeChart({ a, b, labelA, labelB, marker }: { a: string[]; b: string[]; labelA: string; labelB: string; marker?: number | null }) {
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
        <path d={path(a)} fill="none" stroke="var(--color-ink-soft)" strokeWidth={2} />
        <path d={path(b)} fill="none" stroke="var(--color-brand)" strokeWidth={2} />
        <text x={pl} y={H - 6} fontSize={11} fill="var(--color-ink-soft)">Month 1</text>
        <text x={W - pr} y={H - 6} fontSize={11} fill="var(--color-ink-soft)" textAnchor="end">Month {n}</text>
        <text x={pl} y={pt + 10} fontSize={11} fill="var(--color-ink-soft)">{inr(max, { compact: true })}</text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-ink-soft" />{labelA}</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-brand" />{labelB}</span>
        {marker ? <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-accent" />break-even (month {marker})</span> : null}
      </figcaption>
    </figure>
  );
}

export function Bullets({ title, items, tone }: { title: string; items: string[]; tone?: "warn" | "bad" }) {
  if (!items.length) return null;
  return (
    <Card title={title}>
      <ul className={`list-disc space-y-1 pl-5 text-sm ${tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : ""}`}>
        {items.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
    </Card>
  );
}

export function VersionList({ base, id, versions, current, viewing }: { base: string; id: string; versions: VersionRow[]; current: number; viewing: number }) {
  return (
    <Card title="Versions">
      <ul className="space-y-1 text-sm">
        {versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-center gap-2">
            <Link className={v.version === viewing ? "font-semibold" : "underline"} href={`${base}/${id}?v=${v.version}`}>v{v.version}</Link>
            <span className="text-ink-soft">{new Date(v.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {v.formula_version}</span>
            {v.version === current ? <Badge tone="ok">current</Badge> : null}
            {v.note ? <span className="text-ink-soft">— {v.note}</span> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export type VersionRow = { version: number; formula_version: string | null; note: string | null; created_at: string };
export type StoredAnalysis = { id: string; kind: string; title: string; current_version: number; inputs: unknown; outputs: unknown; formula_version: string | null; versions: VersionRow[] };
