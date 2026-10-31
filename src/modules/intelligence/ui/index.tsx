import type { ReactNode } from "react";
import { Badge } from "@/components/ui";

/* Intelligence-module presentational helpers (server-safe, no client JS). Mobile-first. */

export function Flash({ sp }: { sp: { error?: string; notice?: string } }) {
  if (!sp.error && !sp.notice) return null;
  return sp.error
    ? <div role="alert" className="mb-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{sp.error}</div>
    : <div role="status" className="mb-4 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">{sp.notice}</div>;
}

export function Disclaimer({ children }: { children: ReactNode }) {
  return <p className="mb-4 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">{children}</p>;
}

/** Simple horizontal bar chart (CSS). Null values render as "unknown", never as zero. */
export function Bars({ rows, unit, target }: { rows: { label: string; value: number | null; note?: string; tone?: "brand" | "warn" | "accent" }[]; unit?: string; target?: { value: number; label: string } }) {
  const max = Math.max(1, target?.value ?? 0, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs sm:grid-cols-[8rem_1fr_auto]">
          <span className="truncate text-ink-soft" title={r.label}>{r.label}</span>
          <div className="relative h-4 rounded bg-canvas">
            {r.value !== null && <div className={`h-4 rounded ${r.tone === "warn" ? "bg-warn/70" : r.tone === "accent" ? "bg-accent/70" : "bg-brand/70"}`} style={{ width: `${Math.max(0, Math.min(100, (r.value / max) * 100))}%` }} />}
            {target && <div className="absolute top-0 h-4 border-l-2 border-dashed border-bad" style={{ left: `${(target.value / max) * 100}%` }} title={target.label} />}
          </div>
          <span className="whitespace-nowrap font-medium" title={r.note}>{r.value === null ? <Badge>unknown</Badge> : `${r.value}${unit ? ` ${unit}` : ""}`}</span>
        </div>
      ))}
      {target && <p className="text-xs text-ink-soft"><span className="mr-1 inline-block h-3 border-l-2 border-dashed border-bad align-middle" />{target.label}</p>}
    </div>
  );
}

export function Sev({ s }: { s: string }) {
  return <Badge tone={s === "high" ? "bad" : s === "medium" ? "warn" : "neutral"}>{s}</Badge>;
}

export const TIER_TONE: Record<string, "bad" | "warn" | "neutral"> = { critical: "bad", active: "warn", universe: "neutral" };

export function fmtDay(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d.length === 10 ? `${d}T00:00:00Z` : d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

export const label = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ");
