/**
 * Map blocks (upgrade 11). Coordinates come from stored records only; anything without coordinates is listed as missing,
 * never placed or guessed. Rings are straight-line radii (not travel time) — the note says so.
 */
import type { Block, MapPoint } from "../types";

export interface MapCandidate { id: string; label: string; lat: unknown; lon: unknown; kind: MapPoint["kind"]; href?: string }

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
export function validCoord(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const a = num(lat), o = num(lon);
  if (a === null || o === null || a < -90 || a > 90 || o < -180 || o > 180 || (a === 0 && o === 0)) return null; // 0,0 = placeholder, not a place
  return { lat: a, lon: o };
}

export function buildMapBlock(cands: MapCandidate[], o: { title?: string; centerId?: string | null; radiiKm?: number[]; lines?: { label: string; coords: [number, number][] }[] } = {}): { block: Extract<Block, { kind: "map" }> | null; missing: string[]; placed: number } {
  const points: MapPoint[] = []; const missing: string[] = []; const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c.id)) continue; seen.add(c.id);
    const xy = validCoord(c.lat, c.lon);
    if (!xy) { missing.push(`No coordinates recorded for ${c.label}`); continue; }
    points.push({ id: c.id, label: c.label, lat: xy.lat, lon: xy.lon, kind: c.kind, ...(c.href ? { href: c.href } : {}) });
  }
  const radii = [...new Set((o.radiiKm ?? []).filter((r) => r > 0 && r <= 100))].sort((a, b) => a - b);
  const center = o.centerId && points.some((p) => p.id === o.centerId) ? o.centerId : null;
  if (o.centerId && radii.length && !center) missing.push("Rings not drawn: the centre has no coordinates");
  const note = [
    "Positions from stored record coordinates only.",
    center && radii.length ? `Rings are straight-line radii (${radii.join(", ")} km) — not road distance or travel time.` : null,
    missing.length ? `${missing.length} record(s) not shown — no coordinates.` : null,
  ].filter(Boolean).join(" ");
  if (!points.length) return { block: null, missing, placed: 0 };
  return {
    placed: points.length, missing,
    block: { kind: "map", ...(o.title ? { title: o.title } : {}), points, ...(o.lines?.length ? { lines: o.lines } : {}), ...(center && radii.length ? { rings: [{ centerId: center, radiiKm: radii }] } : {}), note },
  };
}

/** Equirectangular projection for the SVG fallback (fine at city scale). Returns 0..1 coords. */
export function projectPoints(points: { lat: number; lon: number }[]): { x: number; y: number }[] {
  if (!points.length) return [];
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((maxLon - minLon) * k, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6), span = Math.max(spanX, spanY);
  return points.map((p) => ({ x: 0.5 + ((p.lon - (minLon + maxLon) / 2) * k) / span * 0.9, y: 0.5 - (p.lat - (minLat + maxLat) / 2) / span * 0.9 }));
}
