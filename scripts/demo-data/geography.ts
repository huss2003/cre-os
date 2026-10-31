/** Pune geography tree: city > corridor > micro_market > locality (coordinates approximate, public knowledge). */
import { base, did, type Row } from "./core";

export interface Locality {
  key: string;
  name: string;
  microMarket: string;
  lat: number;
  lon: number;
  aliases: string[];
}

export const CORRIDORS = [
  { key: "east", name: "East corridor", lat: 18.553, lon: 73.915 },
  { key: "west", name: "West corridor", lat: 18.582, lon: 73.755 },
  { key: "central", name: "Central corridor", lat: 18.527, lon: 73.865 },
  { key: "south_east", name: "South-East corridor", lat: 18.512, lon: 73.926 },
  { key: "north_west", name: "North-West corridor (PCMC)", lat: 18.637, lon: 73.796 },
] as const;

export const MICRO_MARKETS = [
  { key: "sbd_east", name: "SBD East", corridor: "east", aliases: ["SBD-East", "Secondary Business District East"], lat: 18.554, lon: 73.918 },
  { key: "pbd_west", name: "PBD West", corridor: "west", aliases: ["PBD-West", "Hinjewadi IT Park belt"], lat: 18.589, lon: 73.723 },
  { key: "sbd_west", name: "SBD West", corridor: "west", aliases: ["SBD-West", "Baner-Aundh belt"], lat: 18.564, lon: 73.791 },
  { key: "cbd", name: "CBD", corridor: "central", aliases: ["Central Business District", "Pune CBD"], lat: 18.527, lon: 73.873 },
  { key: "hadapsar", name: "Magarpatta–Hadapsar", corridor: "south_east", aliases: ["Magarpatta-Hadapsar", "SBD South-East"], lat: 18.512, lon: 73.926 },
  { key: "pcmc", name: "Pimpri-Chinchwad", corridor: "north_west", aliases: ["PCMC"], lat: 18.637, lon: 73.796 },
] as const;
export type MicroMarketKey = (typeof MICRO_MARKETS)[number]["key"];

export const LOCALITIES: Locality[] = [
  { key: "kharadi", name: "Kharadi", microMarket: "sbd_east", lat: 18.5515, lon: 73.9442, aliases: ["Kharadi Bypass"] },
  { key: "viman_nagar", name: "Viman Nagar", microMarket: "sbd_east", lat: 18.5679, lon: 73.9143, aliases: ["Vimannagar"] },
  { key: "yerwada", name: "Yerwada", microMarket: "sbd_east", lat: 18.5525, lon: 73.8889, aliases: ["Yerawada", "Yeravda"] },
  { key: "kalyani_nagar", name: "Kalyani Nagar", microMarket: "sbd_east", lat: 18.5463, lon: 73.9033, aliases: ["Kalyaninagar"] },
  { key: "hinjewadi_1", name: "Hinjewadi Phase 1", microMarket: "pbd_west", lat: 18.5912, lon: 73.7389, aliases: ["Hinjawadi Ph 1", "Hinjewadi Ph-I"] },
  { key: "hinjewadi_2", name: "Hinjewadi Phase 2", microMarket: "pbd_west", lat: 18.5866, lon: 73.7006, aliases: ["Hinjawadi Ph 2", "Hinjewadi Ph-II"] },
  { key: "hinjewadi_3", name: "Hinjewadi Phase 3", microMarket: "pbd_west", lat: 18.5826, lon: 73.6787, aliases: ["Hinjawadi Ph 3", "Hinjewadi Ph-III"] },
  { key: "wakad", name: "Wakad", microMarket: "pbd_west", lat: 18.5989, lon: 73.7613, aliases: [] },
  { key: "baner", name: "Baner", microMarket: "sbd_west", lat: 18.559, lon: 73.7868, aliases: ["Baner Road"] },
  { key: "balewadi", name: "Balewadi", microMarket: "sbd_west", lat: 18.5764, lon: 73.779, aliases: ["Balewadi High Street"] },
  { key: "aundh", name: "Aundh", microMarket: "sbd_west", lat: 18.558, lon: 73.8075, aliases: [] },
  { key: "shivajinagar", name: "Shivajinagar", microMarket: "cbd", lat: 18.5308, lon: 73.8475, aliases: ["Shivaji Nagar"] },
  { key: "camp", name: "Camp", microMarket: "cbd", lat: 18.515, lon: 73.878, aliases: ["Pune Camp", "Cantonment"] },
  { key: "koregaon_park", name: "Koregaon Park", microMarket: "cbd", lat: 18.5362, lon: 73.894, aliases: ["KP", "Koregaon Pk"] },
  { key: "magarpatta", name: "Magarpatta", microMarket: "hadapsar", lat: 18.5146, lon: 73.9265, aliases: ["Magarpatta City"] },
  { key: "hadapsar", name: "Hadapsar", microMarket: "hadapsar", lat: 18.5089, lon: 73.926, aliases: [] },
  { key: "pimpri", name: "Pimpri", microMarket: "pcmc", lat: 18.6298, lon: 73.7997, aliases: [] },
  { key: "chinchwad", name: "Chinchwad", microMarket: "pcmc", lat: 18.6446, lon: 73.7915, aliases: [] },
];

export const geoId = (level: string, key: string) => did("geography", `${level}:${key}`);
export const localityId = (key: string) => geoId("locality", key);
export const microMarketId = (key: string) => geoId("micro_market", key);
export const localityByKey = (key: string) => {
  const l = LOCALITIES.find((x) => x.key === key);
  if (!l) throw new Error(`unknown locality ${key}`);
  return l;
};

export function buildGeography(): Row[] {
  const rows: Row[] = [];
  const g = (level: string, key: string, name: string, parent: string | null, lat: number, lon: number, aliases: readonly string[] = []) =>
    rows.push({ ...base("public"), id: geoId(level, key), level, name, parent_id: parent, aliases: [...aliases], lat, lon, valid_from: null, valid_to: null });

  g("city", "pune", "Pune", null, 18.5204, 73.8567, ["Poona", "Pune Metropolitan Region"]);
  for (const c of CORRIDORS) g("corridor", c.key, c.name, geoId("city", "pune"), c.lat, c.lon);
  for (const m of MICRO_MARKETS) g("micro_market", m.key, m.name, geoId("corridor", m.corridor), m.lat, m.lon, m.aliases);
  for (const l of LOCALITIES) g("locality", l.key, l.name, microMarketId(l.microMarket), l.lat, l.lon, l.aliases);
  return rows;
}
