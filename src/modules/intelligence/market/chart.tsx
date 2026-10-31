import { Badge } from "@/components/ui";
import type { SeriesView } from "./analysis";

/* Market chart (server-safe, CSS only, 375px-friendly). Acceptance: every chart shows PERIOD, UNIT and SOURCE (name +
   release date). One unit per axis: if the points carry more than one unit the chart refuses to draw. */

const fmtDate = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "date unknown");

export function chartUnits(s: Pick<SeriesView, "points">): string[] {
  return [...new Set(s.points.filter((p) => p.value !== null).map((p) => p.unit ?? "unit unknown"))];
}

export function ChartCaption({ s }: { s: Pick<SeriesView, "periodLabel" | "unit" | "sources" | "sampleSize"> }) {
  return (
    <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 text-xs text-ink-soft">
      <dt className="font-medium">Period</dt><dd>{s.periodLabel}</dd>
      <dt className="font-medium">Unit</dt><dd>{s.unit}</dd>
      <dt className="font-medium">Source</dt>
      <dd>{s.sources.length === 0 ? "none" : s.sources.map((x, i) => <span key={`${x.key}@${x.release_date}`}>{i ? "; " : ""}{x.name} (released {fmtDate(x.release_date)}){x.licensed ? " · licensed" : ""}</span>)}</dd>
      <dt className="font-medium">Sample</dt><dd>{s.sampleSize} observation(s) — not a comprehensive market view</dd>
    </dl>
  );
}

export function MarketChart({ s }: { s: SeriesView }) {
  const units = chartUnits(s);
  if (units.length > 1) {
    return <div role="alert" className="rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">Mixed units ({units.join(", ")}) — not drawn on one axis. Split the series by unit.</div>;
  }
  const max = Math.max(1, ...s.points.map((p) => Math.abs(p.value ?? 0)));
  return (
    <figure>
      <div className="space-y-1.5" role="img" aria-label={`${s.metric} ${s.geographyLabel} in ${s.unit}, ${s.periodLabel}`}>
        {s.points.map((p) => (
          <div key={p.label} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs sm:grid-cols-[8rem_1fr_auto]">
            <span className="truncate text-ink-soft" title={p.label}>{p.label}</span>
            <div className="relative h-4 rounded bg-canvas">
              {p.value !== null && <div className={`h-4 rounded ${p.is_forecast ? "border border-dashed border-accent bg-accent/30" : p.period_type === "ytd" ? "bg-warn/70" : "bg-brand/70"}`} style={{ width: `${Math.max(0, Math.min(100, (Math.abs(p.value) / max) * 100))}%` }} />}
            </div>
            <span className="whitespace-nowrap font-medium" title={p.note}>{p.value === null ? <Badge>unknown</Badge> : <>{p.value} {s.unit}{p.is_forecast ? <> <Badge tone="accent">forecast</Badge></> : null}</>}</span>
          </div>
        ))}
      </div>
      <figcaption>
        <ChartCaption s={s} />
        {(s.hasForecast || s.points.some((p) => p.period_type === "ytd")) && (
          <p className="mt-1 text-xs text-ink-soft">{s.hasForecast ? "Dashed bars = the source's forecast (labelled, not CRE OS's). " : ""}{s.points.some((p) => p.period_type === "ytd") ? "Amber = year-to-date, not a full year." : ""}</p>
        )}
      </figcaption>
    </figure>
  );
}
