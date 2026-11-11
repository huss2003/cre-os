"use client";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import type { Block, MapPoint } from "../types";
import { projectPoints } from "../outputs/map";

type MapBlock = Extract<Block, { kind: "map" }>;
const COLOR: Record<MapPoint["kind"], string> = { building: "#1F3A5F", station: "#C8102E", company: "#0F766E", other: "#6B7280" };

/** Leaflet map with OSM tiles (client-only, loaded on demand). Falls back to an SVG scatter if Leaflet or tiles fail. */
export function MapView({ b }: { b: MapBlock }) {
  const el = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (!el.current || fallback) return;
    let map: import("leaflet").Map | null = null; let cancelled = false; let tileErrors = 0;
    import("leaflet").then((L) => {
      if (cancelled || !el.current) return;
      map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true });
      const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      tiles.on("tileerror", () => { if (++tileErrors >= 4) setFallback(true); });
      const byId = new Map(b.points.map((p) => [p.id, p]));
      const layers: import("leaflet").Layer[] = [];
      for (const p of b.points) {
        const m = L.circleMarker([p.lat, p.lon], { radius: 7, color: "#fff", weight: 2, fillColor: COLOR[p.kind], fillOpacity: 0.95 });
        const label = document.createElement("span"); label.textContent = p.label; // text only — never HTML from data
        m.bindTooltip(label); m.addTo(map); layers.push(m);
        if (p.href) m.on("click", () => { window.location.href = p.href!; });
      }
      for (const l of b.lines ?? []) { const pl = L.polyline(l.coords, { color: "#C8102E", weight: 3 }); const s = document.createElement("span"); s.textContent = l.label; pl.bindTooltip(s); pl.addTo(map); layers.push(pl); }
      for (const r of b.rings ?? []) {
        const c = byId.get(r.centerId); if (!c) continue;
        for (const km of r.radiiKm) { const ring = L.circle([c.lat, c.lon], { radius: km * 1000, color: "#1F3A5F", weight: 1, dashArray: "4 4", fill: false }); const s = document.createElement("span"); s.textContent = `${km} km straight-line`; ring.bindTooltip(s); ring.addTo(map); layers.push(ring); }
      }
      const group = L.featureGroup(layers);
      if (b.points.length === 1 && !(b.rings ?? []).length) map.setView([b.points[0].lat, b.points[0].lon], 15);
      else map.fitBounds(group.getBounds().pad(0.15));
    }).catch(() => setFallback(true));
    return () => { cancelled = true; map?.remove(); };
  }, [b, fallback]);

  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label={b.title ?? "Map"}>
      {b.title ? <h3 className="mb-2 text-sm font-semibold">{b.title}</h3> : null}
      {fallback ? <SvgScatter b={b} /> : <div ref={el} className="h-72 w-full overflow-hidden rounded-lg sm:h-96" role="application" aria-label="Interactive map" />}
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
        {(Object.keys(COLOR) as MapPoint["kind"][]).filter((k) => b.points.some((p) => p.kind === k)).map((k) => (
          <li key={k} className="flex items-center gap-1"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLOR[k] }} />{k}</li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-ink-soft">{b.note}{fallback ? " Map tiles unavailable — showing relative positions only." : ""}</p>
    </section>
  );
}

function SvgScatter({ b }: { b: MapBlock }) {
  const xy = projectPoints(b.points);
  return (
    <svg viewBox="0 0 400 260" className="h-64 w-full rounded-lg bg-canvas" role="img" aria-label="Relative positions of mapped places">
      {b.points.map((p, i) => (
        <g key={p.id}>
          <circle cx={xy[i].x * 400} cy={xy[i].y * 260} r={5} fill={COLOR[p.kind]} />
          <text x={xy[i].x * 400 + 7} y={xy[i].y * 260 + 4} fontSize={10} fill="currentColor">{p.label.slice(0, 30)}</text>
        </g>
      ))}
    </svg>
  );
}
