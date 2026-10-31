/**
 * Chart and schematic-map data for documents (Design Studio). Pure: everything is derived from already-computed model
 * values (finance engine outputs, space snapshots, requirement contract) — no arithmetic on money beyond formatting,
 * and no network: the map is a schematic plot of stored coordinates, never map tiles.
 */
import type { DocModel } from "./model";

export interface ChartSeries { name: string; values: number[] }
export interface ChartSpec { key: "cost_comparison" | "tco_npv" | "area_vs_target" | "cost_vs_budget"; title: string; categories: string[]; series: ChartSeries[]; unit: string; notes: string[] }

const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function chartSpecs(m: DocModel): ChartSpec[] {
  const out: ChartSpec[] = [];
  if (m.comparison.length) {
    const rows = m.comparison.filter((c) => num(c.equivalentMonthly) !== null);
    if (rows.length) out.push({ key: "cost_comparison", title: "Equivalent monthly cost (₹, engine fin-1.0)", unit: "₹ / month", categories: rows.map((c) => short(c.name)),
      series: [{ name: "Equivalent monthly", values: rows.map((c) => num(c.equivalentMonthly)!) }], notes: ["Equal horizon, base date and discount rate across scenarios."] });
    const both = m.comparison.filter((c) => num(c.npv) !== null && num(c.nominalTco) !== null);
    if (both.length) out.push({ key: "tco_npv", title: "Nominal TCO vs NPV over the horizon (₹)", unit: "₹", categories: both.map((c) => short(c.name)),
      series: [{ name: "Nominal TCO", values: both.map((c) => num(c.nominalTco)!) }, { name: "NPV", values: both.map((c) => num(c.npv)!) }], notes: [] });
  }
  const t = m.targets;
  const opts = m.options.filter((o) => o.eligibility !== "ineligible").slice(0, 10);
  if (opts.length && t) {
    const withArea = opts.filter((o) => o.areaSf !== null && o.areaSf !== undefined);
    const target = t.areaTargetSf ?? t.areaMaxSf ?? t.areaMinSf ?? null;
    if (withArea.length && target !== null) {
      const notes = [`Target ${target.toLocaleString("en-IN")} SF${t.areaBasis ? ` (${t.areaBasis})` : ""}${t.areaMinSf || t.areaMaxSf ? `; range ${t.areaMinSf ?? "?"}–${t.areaMaxSf ?? "?"} SF` : ""}.`];
      if (withArea.length < opts.length) notes.push(`${opts.length - withArea.length} option(s) with unknown area are not plotted.`);
      out.push({ key: "area_vs_target", title: "Option area vs requirement (SF)", unit: "SF", categories: withArea.map((o) => short(`${o.rank}. ${o.label}`)),
        series: [{ name: "Option area (space snapshot)", values: withArea.map((o) => o.areaSf!) }, { name: "Requirement target", values: withArea.map(() => target) }], notes });
    }
    const withCost = opts.filter((o) => o.costPerUnit !== null && o.costPerUnit !== undefined);
    if (withCost.length && t.budgetMax !== null && t.budgetMax !== undefined) {
      const notes = [`Budget basis: ${t.budgetBasis ?? "unknown"} — compare like-for-like only.`];
      if (withCost.length < opts.length) notes.push(`${opts.length - withCost.length} option(s) with unknown cost are not plotted.`);
      out.push({ key: "cost_vs_budget", title: "All-in cost per unit vs budget ceiling", unit: "₹ / unit / month", categories: withCost.map((o) => short(`${o.rank}. ${o.label}`)),
        series: [{ name: "All-in cost / unit / month", values: withCost.map((o) => o.costPerUnit!) }, { name: "Budget ceiling", values: withCost.map(() => t.budgetMax!) }], notes });
    }
  }
  return out;
}

// ---------------------------------------------------------------- schematic location map
export interface MapPointIn { label: string; lat: number | null; lon: number | null; kind: "option" | "preferred_area" }
export interface MapPoint { label: string; lat: number; lon: number; kind: MapPointIn["kind"]; x: number; y: number }  // x,y in 0..1 (y down)
export interface MapModel { points: MapPoint[]; missing: string[]; widthKm: number; scaleKm: number; scaleFraction: number; aspect: number; note: string }

const R = 6371.0088;
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const niceScale = (maxKm: number) => {
  const p = 10 ** Math.floor(Math.log10(maxKm));
  for (const m of [5, 2, 1]) if (m * p <= maxKm) return m * p;
  return p / 2;
};

/** Equirectangular projection around the points' mid-latitude (fine at city scale), 10 % padding, aspect preserved. */
export function buildMapModel(input: MapPointIn[]): MapModel | null {
  const valid = input.filter((p) => p.lat !== null && p.lon !== null && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat!) <= 90 && Math.abs(p.lon!) <= 180) as (MapPointIn & { lat: number; lon: number })[];
  const missing = input.filter((p) => !valid.includes(p as never)).map((p) => p.label);
  if (!valid.length) return null;
  const latMid = (Math.min(...valid.map((p) => p.lat)) + Math.max(...valid.map((p) => p.lat))) / 2;
  const k = Math.cos((latMid * Math.PI) / 180);
  const xs = valid.map((p) => p.lon * k), ys = valid.map((p) => p.lat);
  let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const minSpan = 0.01;                                   // ≈1.1 km: single point or co-located points
  if (x1 - x0 < minSpan) { const c = (x0 + x1) / 2; x0 = c - minSpan / 2; x1 = c + minSpan / 2; }
  if (y1 - y0 < minSpan) { const c = (y0 + y1) / 2; y0 = c - minSpan / 2; y1 = c + minSpan / 2; }
  const padX = (x1 - x0) * 0.1, padY = (y1 - y0) * 0.1;
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  const aspect = (x1 - x0) / (y1 - y0);                   // width / height in projected degrees
  const points = valid.map((p) => ({ label: p.label, lat: p.lat, lon: p.lon, kind: p.kind, x: (p.lon * k - x0) / (x1 - x0), y: 1 - (p.lat - y0) / (y1 - y0) }));
  const widthKm = haversineKm({ lat: latMid, lon: x0 / k }, { lat: latMid, lon: x1 / k });
  const scaleKm = niceScale(widthKm * 0.3);
  return {
    points, missing, widthKm, scaleKm, scaleFraction: scaleKm / widthKm, aspect,
    note: `Schematic plot of stored coordinates (equirectangular, ≈${widthKm.toFixed(1)} km across) — not a navigation map; no map tiles used.${missing.length ? ` Not plotted (no coordinates): ${missing.join(", ")}.` : ""}`,
  };
}

/** Fit a map of the given aspect inside a box; returns the inner drawing rectangle. */
export function fitBox(aspect: number, box: { x: number; y: number; w: number; h: number }) {
  let w = box.w, h = box.w / aspect;
  if (h > box.h) { h = box.h; w = box.h * aspect; }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
