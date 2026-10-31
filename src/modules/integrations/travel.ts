/**
 * Deterministic travel-time ESTIMATE between two points (workflow 14). No live traffic, no routing API:
 * great-circle (haversine) distance × road factor ÷ assumed average city speed, rounded up to 5 minutes.
 * Always labelled "estimate" in the UI. Used for route clustering and travel-conflict detection.
 */
export const ROAD_FACTOR = 1.4;          // road distance vs straight line in Pune
export const CITY_SPEED_KMPH = 20;       // assumed average daytime speed
export const MIN_TRAVEL_MINUTES = 10;    // parking, lifts, security desk
export const CLUSTER_MAX_MINUTES = 25;   // visits this close are grouped into one provisional route

export interface Point { lat: number; lon: number }

export function haversineKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated door-to-door minutes (>= MIN_TRAVEL_MINUTES, multiple of 5). */
export function estimateTravelMinutes(a: Point, b: Point, speedKmph = CITY_SPEED_KMPH): number {
  const km = haversineKm(a, b) * ROAD_FACTOR;
  const raw = (km / speedKmph) * 60;
  return Math.max(MIN_TRAVEL_MINUTES, Math.ceil(raw / 5) * 5);
}

export function hasPoint(x: { lat?: number | string | null; lon?: number | string | null }): x is { lat: number; lon: number } {
  return x.lat !== null && x.lat !== undefined && x.lon !== null && x.lon !== undefined && Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lon));
}

export const toPoint = (x: { lat: number | string; lon: number | string }): Point => ({ lat: Number(x.lat), lon: Number(x.lon) });
