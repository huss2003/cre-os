/**
 * ~60 fictional assets: campuses > towers, plus standalone buildings, spaces and append-only availability
 * snapshots (some fresh, some ageing, some stale/expired so availability decay is visible in the UI).
 */
import { Rng, addDays, base, did, edate, type GenContext, type Row } from "./core";
import { localityByKey, localityId, microMarketId, type MicroMarketKey } from "./geography";
import { orgId } from "./organisations";
import type { PersonDef } from "./people";

interface CampusDef { key: string; name: string; locality: string; developer: string; towers: number }
const CAMPUSES: CampusDef[] = [
  { key: "riverstone_tp", name: "Riverstone Tech Park", locality: "kharadi", developer: "riverstone", towers: 3 },
  { key: "riverstone_eg", name: "Riverstone Eastgate", locality: "kharadi", developer: "riverstone", towers: 2 },
  { key: "sahyadri_bay", name: "Sahyadri Arc Business Bay", locality: "yerwada", developer: "sahyadri_arc", towers: 2 },
  { key: "viman_aero", name: "Viman Aero Business Park", locality: "viman_nagar", developer: "bluecairn", towers: 2 },
  { key: "kalyani_crescent", name: "Kalyani Crescent Offices", locality: "kalyani_nagar", developer: "westgate_spire", towers: 2 },
  { key: "kalpa_gardens", name: "Kalpavriksha IT Gardens", locality: "hinjewadi_1", developer: "kalpavriksha", towers: 3 },
  { key: "bluecairn_kc", name: "Bluecairn Knowledge Campus", locality: "hinjewadi_2", developer: "bluecairn", towers: 3 },
  { key: "tarangan_meadows", name: "Tarangan Cyber Meadows", locality: "hinjewadi_3", developer: "tarangan", towers: 2 },
  { key: "wakad_terraces", name: "Wakad Tech Terraces", locality: "wakad", developer: "tarangan", towers: 2 },
  { key: "westgate_cp", name: "Westgate Spire Corporate Park", locality: "baner", developer: "westgate_spire", towers: 2 },
  { key: "balewadi_commons", name: "Balewadi Skyline Commons", locality: "balewadi", developer: "sahyadri_arc", towers: 2 },
  { key: "amberline_square", name: "Amberline Cyber Square", locality: "magarpatta", developer: "kalpavriksha", towers: 3 },
  { key: "hadapsar_gateway", name: "Hadapsar Gateway Park", locality: "hadapsar", developer: "tarangan", towers: 2 },
  { key: "foundry_works", name: "Pimpri Foundry Works Campus", locality: "pimpri", developer: "bluecairn", towers: 2 },
];
const BUILDINGS: Array<{ key: string; name: string; locality: string; developer: string }> = [
  { key: "shivaji_court", name: "Shivaji Court", locality: "shivajinagar", developer: "sahyadri_arc" },
  { key: "cantonment_house", name: "Cantonment House", locality: "camp", developer: "westgate_spire" },
  { key: "camp_heritage", name: "Camp Heritage Chambers", locality: "camp", developer: "kalpavriksha" },
  { key: "koregaon_atrium", name: "Koregaon Atrium", locality: "koregaon_park", developer: "westgate_spire" },
  { key: "aundh_ridge", name: "Aundh Ridge Centre", locality: "aundh", developer: "sahyadri_arc" },
  { key: "baner_summit", name: "Baner Summit", locality: "baner", developer: "kalpavriksha" },
  { key: "kharadi_pinnacle", name: "Kharadi Pinnacle", locality: "kharadi", developer: "tarangan" },
  { key: "yerwada_riverside", name: "Yerwada Riverside Tower", locality: "yerwada", developer: "riverstone" },
  { key: "viman_signature", name: "Viman Nagar Signature", locality: "viman_nagar", developer: "bluecairn" },
  { key: "chinchwad_enterprise", name: "Chinchwad Enterprise House", locality: "chinchwad", developer: "tarangan" },
  { key: "magarpatta_annex", name: "Magarpatta Cyber Annex", locality: "magarpatta", developer: "kalpavriksha" },
  { key: "hinjewadi_orbit", name: "Hinjewadi Orbit One", locality: "hinjewadi_1", developer: "riverstone" },
  { key: "balewadi_highpoint", name: "Balewadi High Point", locality: "balewadi", developer: "westgate_spire" },
  { key: "wakad_junction", name: "Wakad Junction Plaza", locality: "wakad", developer: "sahyadri_arc" },
];

/** Synthetic asking-rent baselines, INR per sf per month on chargeable area. */
export const RENT_BASE: Record<MicroMarketKey, number> = { sbd_east: 96, pbd_west: 72, sbd_west: 88, cbd: 118, hadapsar: 82, pcmc: 60 };

export interface AssetDef {
  key: string; id: string; name: string; kind: "campus" | "tower" | "building";
  locality: string; microMarket: MicroMarketKey; developer: string; lat: number; lon: number;
  status: string; parentKey: string | null;
}
export interface SpaceDef { id: string; key: string; assetKey: string; carpet: number; chargeable: number; config: string; latestStatus: string }

export const assetId = (key: string) => did("asset", key);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function buildAssets(ctx: GenContext, roster: PersonDef[]) {
  const rng = new Rng("assets");
  const assets: Row[] = [];
  const defs: AssetDef[] = [];
  const zeroAreaKeys = new Set(["cantonment_house", "foundry_works:B"]);

  const mk = (d: Omit<AssetDef, "id" | "lat" | "lon" | "microMarket">, latLon?: [number, number], extra: Row = {}) => {
    const loc = localityByKey(d.locality);
    const [lat, lon] = latLon ?? [loc.lat + rng.float(-0.004, 0.004, 6), loc.lon + rng.float(-0.004, 0.004, 6)];
    const def: AssetDef = { ...d, id: assetId(d.key), lat, lon, microMarket: loc.microMarket as MicroMarketKey };
    defs.push(def);
    const floorMin = rng.step(12000, 30000, 500);
    const floorMax = floorMin + rng.step(0, 14000, 500);
    const floors = rng.int(6, 18);
    const sourceZero = zeroAreaKeys.has(d.key);
    const completion = d.status === "ready" ? `${rng.int(2008, 2024)}-${String(rng.pick([3, 6, 9, 12])).padStart(2, "0")}-01` : edate(ctx.today, rng.int(5, 30));
    assets.push({
      ...base(), id: def.id, parent_asset_id: d.parentKey ? assetId(d.parentKey) : null, asset_kind: d.kind, name: d.name,
      locality_id: localityId(d.locality), micro_market_id: microMarketId(def.microMarket),
      address: `${d.name}, ${loc.name}, Pune (synthetic address)`,
      lat, lon, coord_accuracy: "approximate (synthetic)",
      developer_org_id: orgId(d.developer), owner_org_id: rng.chance(0.7) ? orgId(d.developer) : null, operator_org_id: null,
      status: d.status,
      completion_date: d.kind === "campus" ? null : completion,
      completion_precision: d.kind === "campus" ? "unknown" : d.status === "ready" ? rng.pick(["month", "quarter", "year"]) : "quarter",
      total_area_sf: sourceZero ? null : d.kind === "campus" ? null : floors * Math.round((floorMin + floorMax) / 2),
      total_area_source_zero: sourceZero,
      floor_size_min_sf: d.kind === "campus" ? null : floorMin,
      floor_size_max_sf: d.kind === "campus" ? null : floorMax,
      floor_size_text: d.kind === "campus" ? null : `${floorMin.toLocaleString("en-IN")}–${floorMax.toLocaleString("en-IN")} sf`,
      floors: d.kind === "campus" ? null : floors,
      grade: d.kind === "campus" ? null : rng.pick(["A", "A", "A+", "B+"]),
      certifications: d.kind !== "campus" && rng.chance(0.45) ? [{ name: "LEED", level: rng.pick(["Gold", "Platinum"]), verified_on: null }] : [],
      specs: d.kind === "campus" ? { synthetic: true } : {
        synthetic: true,
        power_backup: rng.pick(["100%", "100%", "80%", null]),
        parking_ratio: rng.pick(["1:1000 sf", "1:800 sf", "1:1200 sf"]),
        metro_walk_min: rng.chance(0.4) ? rng.int(4, 18) : null,
      },
      natural_key: `${norm(d.name)}|${d.locality}`,
      ...extra,
    });
    return def;
  };

  for (const c of CAMPUSES) {
    const campus = mk({ key: c.key, name: c.name, kind: "campus", locality: c.locality, developer: c.developer, status: "ready", parentKey: null });
    for (let t = 0; t < c.towers; t++) {
      const letter = "ABC"[t];
      const status = t === c.towers - 1 && rng.chance(0.25) ? rng.pick(["under_construction", "under_construction", "planned"]) : "ready";
      mk(
        { key: `${c.key}:${letter}`, name: `${c.name} – Tower ${letter}`, kind: "tower", locality: c.locality, developer: c.developer, status, parentKey: c.key },
        [campus.lat + rng.float(-0.0012, 0.0012, 6), campus.lon + rng.float(-0.0012, 0.0012, 6)],
      );
    }
  }
  for (const b of BUILDINGS) mk({ key: b.key, name: b.name, kind: "building", locality: b.locality, developer: b.developer, status: "ready", parentKey: null });
  // the two zero-area flags must exist
  for (const k of zeroAreaKeys) if (!defs.find((d) => d.key === k)) throw new Error(`zero-area asset ${k} missing`);

  // ---------------------------------------------------------------- spaces + availability snapshots
  const spaces: Row[] = [];
  const spaceDefs: SpaceDef[] = [];
  const availability: Row[] = [];
  // space_unit_uq: (asset, lower(floor_text), lower(unit)) must be unique while unit is set.
  const usedUnits = new Set<string>();
  const leasingContact = (devKey: string) => roster.find((p) => p.orgKey === devKey && p.title.fn === "leasing")?.id ?? null;

  for (const a of defs.filter((d) => d.kind !== "campus")) {
    const n = a.status === "ready" ? rng.int(1, 3) : 1;
    for (let s = 0; s < n; s++) {
      const key = `${a.key}#${s + 1}`;
      const config = rng.pick(["bare_shell", "warm_shell", "warm_shell", "fitted", "managed"]);
      const carpet = config === "managed" ? rng.step(3000, 15000, 250) : rng.step(8000, 60000, 500);
      const eff = rng.float(0.68, 0.76, 4);
      const chargeable = Math.round(carpet / eff);
      const floorNo = rng.int(2, 15);
      const spaceId = did("space", key);
      spaces.push({
        ...base(), id: spaceId, asset_id: a.id,
        floor_text: carpet > 30000 ? `Floors ${floorNo}–${floorNo + 1}` : `Floor ${floorNo}`,
        unit: rng.pick(["Entire floor", "Wing A", "Wing B", "Part floor", null]),
        carpet_sf: carpet, chargeable_sf: chargeable, efficiency: eff,
        seats: config === "managed" || config === "fitted" ? Math.round(carpet / rng.int(60, 80)) : null,
        contiguous_group: carpet > 30000 ? `${a.key}:stack` : null,
        configuration: config,
      });
      {
        // Deterministic de-dupe (no extra rng draws, so every other generated value is unchanged): move up a floor.
        const sp = spaces[spaces.length - 1];
        let f = floorNo;
        const k = () => `${a.id}|${String(sp.floor_text).toLowerCase()}|${String(sp.unit).toLowerCase()}`;
        while (sp.unit && usedUnits.has(k())) { f++; sp.floor_text = carpet > 30000 ? `Floors ${f}–${f + 1}` : `Floor ${f}`; }
        if (sp.unit) usedUnits.add(k());
      }

      // snapshot history (append-only). freshness: fresh / ageing / stale(expired)
      const freshness = rng.pick(["fresh", "fresh", "ageing", "stale"]);
      const latestAsOf =
        freshness === "fresh" ? addDays(ctx.today, -rng.int(1, 25)) : freshness === "ageing" ? addDays(ctx.today, -rng.int(45, 85)) : addDays(ctx.today, -rng.int(120, 420));
      const latestStatus = a.status !== "ready" ? "available" : rng.pick(["available", "available", "available", "under_offer", "leased", "unverified", "withdrawn"]);
      const history = rng.int(0, 2);
      const rentBase = RENT_BASE[a.microMarket];
      for (let h = history; h >= 0; h--) {
        const asOf = h === 0 ? latestAsOf : addDays(latestAsOf, -h * rng.int(60, 150));
        const status = h === 0 ? latestStatus : rng.pick(["available", "available", "unverified"]);
        const seatBased = config === "managed";
        const rentKnown = status !== "withdrawn" && rng.chance(0.85);
        const rmin = seatBased ? rng.step(8500, 15500, 250) : Math.round(rentBase * rng.float(0.88, 1.12));
        availability.push({
          ...base(), id: did("availability", `${key}@${h}`), space_id: spaceId, as_of: asOf, status,
          available_from: status === "available" ? (a.status === "ready" ? (rng.chance(0.6) ? asOf : addDays(asOf, rng.int(30, 180))) : edate(ctx.today, rng.int(6, 24))) : null,
          quote_id: null,
          asking_rent_min: rentKnown ? rmin : null,
          asking_rent_max: rentKnown ? (seatBased ? rmin + rng.step(500, 2500, 250) : rmin + rng.int(0, 12)) : null,
          rent_basis: rentKnown ? (seatBased ? "seat" : rng.chance(0.85) ? "chargeable" : "carpet") : null,
          fitout_basis: config === "bare_shell" ? "bare" : config,
          contact_person_id: rng.chance(0.7) ? leasingContact(a.developer) : null,
          source_object_id: ctx.sourceObjectId,
          valid_until: freshness === "stale" ? addDays(asOf, 60) : freshness === "ageing" ? addDays(asOf, 90) : addDays(asOf, rng.int(45, 75)),
          fact_status: h > 0 ? "historical_observed" : freshness === "fresh" && rng.chance(0.5) ? "currently_confirmed" : "reported",
        });
        {
          // availability_dates_chk: a quote cannot expire before the space is available — keep it open 30 days past availability.
          const av = availability[availability.length - 1];
          const from = av.available_from as string | null;
          if (from && (av.valid_until as string) < from) av.valid_until = addDays(from, 30);
        }
      }
      spaceDefs.push({ id: spaceId, key, assetKey: a.key, carpet, chargeable, config, latestStatus });
    }
  }
  return { assets, defs, spaces, spaceDefs, availability };
}
