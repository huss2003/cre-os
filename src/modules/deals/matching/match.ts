/**
 * Property matching, rubric "match-v1" (spec Part I §8 "Property match", Part III acceptance test "Shortlist").
 * Pure and deterministic.
 *
 * 1. Hard eligibility first → "eligible" | "needs_verification" | "ineligible". Ranking is tiered: an ineligible
 *    space can never be promoted above an eligible/needs-verification one by a high score.
 * 2. Weighted fit: location/catchment 25, all-in cost 25, readiness/timing 20, technical 15, flexibility 10,
 *    sustainability 5 (per-requirement overrides). A criterion is "not_applicable" when the requirement sets no
 *    constraint (its weight is dropped and the rest renormalised) and "unknown" when the option's data is missing
 *    — unknown scores 0: a missing field is never scored as meeting a constraint.
 * 3. Fit score (0-100) and data-completeness score (0-100) are reported separately.
 * 4. Only space snapshots are quoted (never a building's total area). Observations past valid_until — or older
 *    than the decay window when no validity is recorded — are stale and block client release.
 */
import type { RequirementRow, RequiredSpecs } from "../requirements/contract";

export const RUBRIC_VERSION = "match-v1";
export const DEFAULT_WEIGHTS = { location: 25, cost: 25, readiness: 20, technical: 15, flexibility: 10, sustainability: 5 } as const;
export type Criterion = keyof typeof DEFAULT_WEIGHTS;
export const CRITERIA: Criterion[] = ["location", "cost", "readiness", "technical", "flexibility", "sustainability"];

export interface SpaceData {
  id: string; asset_id: string;
  floor_text?: string | null; unit?: string | null;
  carpet_sf?: number | string | null; chargeable_sf?: number | string | null; efficiency?: number | string | null;
  seats?: number | null; contiguous_group?: string | null; configuration?: string | null;
}
export interface AssetData {
  id: string; name: string;
  locality_id?: string | null; micro_market_id?: string | null;
  lat?: number | string | null; lon?: number | string | null;
  status?: string | null; completion_date?: string | null;
  certifications?: { name?: string; level?: string; verified_on?: string | null }[] | null;
  specs?: Record<string, unknown> | null;
  total_area_sf?: number | string | null;
}
export interface AvailabilityData {
  id: string; as_of: string; status: "available" | "under_offer" | "leased" | "unverified" | "withdrawn";
  available_from?: string | null;
  asking_rent_min?: number | string | null; asking_rent_max?: number | string | null;
  rent_basis?: "carpet" | "chargeable" | "seat" | null;
  fitout_basis?: string | null; valid_until?: string | null; fact_status?: string | null;
}
export interface QuoteTerms { rent?: number | string; rent_basis?: string; cam_per_sf?: number | string | null; cam_included?: boolean; lockin_months?: number; tenure_months?: number; [k: string]: unknown }
export interface QuoteData { id: string; version: number; valid_until?: string | null; superseded_by?: string | null; terms_json?: QuoteTerms | null }

export interface Candidate {
  space: SpaceData;
  asset: AssetData;
  availability: AvailabilityData | null;   // latest snapshot for the space
  quote?: QuoteData | null;                 // current quote for this space & requirement
  expansionSf?: number | null;              // other available area in the same asset (same basis as requirement)
}

export type Eligibility = "eligible" | "needs_verification" | "ineligible";
export interface CriterionResult { weight: number; status: "scored" | "unknown" | "not_applicable"; score: number | null; detail: string }
export interface OptionResult {
  spaceId: string; assetId: string; availabilityId: string | null; quoteId: string | null;
  label: string;
  eligibility: Eligibility;
  disqualifiers: string[];
  verificationNeeded: string[];
  fitScore: number;
  completenessScore: number;
  criteria: Record<Criterion, CriterionResult>;
  area: { value: number | null; basis: string | null; derived: boolean };
  allInCostPerUnit: number | null;
  flags: { vacancyUnverified: boolean; availabilityStale: boolean; quoteExpired: boolean; clientReleaseBlocked: boolean };
  rank: number;
}

export interface MatchOptions { asOf: string; areaTolerance?: number; availabilityDecayDays?: number }

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const addDays = (a: string, n: number) => new Date(Date.parse(a + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function effectiveWeights(req: RequirementRow): Record<Criterion, number> {
  const o = req.constraints?.weights ?? {};
  const w = { ...DEFAULT_WEIGHTS } as Record<Criterion, number>;
  for (const c of CRITERIA) if (typeof o[c] === "number" && o[c]! >= 0) w[c] = o[c]!;
  return w;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Space area on the requirement's basis. Converts with recorded efficiency only, flagged as derived. */
export function spaceArea(space: SpaceData, basis: string | null | undefined): { value: number | null; basis: string | null; derived: boolean } {
  const carpet = num(space.carpet_sf), charge = num(space.chargeable_sf), eff = num(space.efficiency);
  if (basis === "carpet") {
    if (carpet) return { value: carpet, basis, derived: false };
    if (charge && eff) return { value: round2(charge * eff), basis, derived: true };
    return { value: null, basis, derived: false };
  }
  if (basis === "chargeable") {
    if (charge) return { value: charge, basis, derived: false };
    if (carpet && eff) return { value: round2(carpet / eff), basis, derived: true };
    return { value: null, basis, derived: false };
  }
  return { value: charge ?? carpet, basis: charge ? "chargeable" : carpet ? "carpet" : null, derived: false };
}

export function isStale(av: AvailabilityData, asOf: string, decayDays: number): boolean {
  const until = av.valid_until ?? addDays(av.as_of, decayDays);
  return until < asOf;
}

function specValue(asset: AssetData, key: string): number | boolean | null {
  const v = asset.specs?.[key];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface SpecCheck { label: string; met: boolean | null }
function checkSpecs(req: RequiredSpecs | undefined, c: Candidate): SpecCheck[] {
  if (!req) return [];
  const out: SpecCheck[] = [];
  const cmp = (label: string, required: number | null | undefined, key: string, dir: "min" | "max") => {
    if (required === null || required === undefined) return;
    const v = specValue(c.asset, key);
    out.push({ label, met: typeof v === "number" ? (dir === "min" ? v >= required : v <= required) : null });
  };
  cmp(`power ≥ ${req.min_power_kva} kVA`, req.min_power_kva, "power_kva", "min");
  cmp(`car parks ≥ ${req.min_car_parks}`, req.min_car_parks, "car_parks", "min");
  cmp(`two-wheeler parks ≥ ${req.min_two_wheeler_parks}`, req.min_two_wheeler_parks, "two_wheeler_parks", "min");
  cmp(`metro ≤ ${req.max_metro_km} km`, req.max_metro_km, "metro_km", "max");
  if (req.operating_24x7) {
    const v = specValue(c.asset, "operating_24x7");
    out.push({ label: "24×7 operations permitted", met: typeof v === "boolean" ? v : null });
  }
  if (req.fitout_basis && req.fitout_basis.length) {
    const cfg = c.availability?.fitout_basis ?? c.space.configuration ?? null;
    out.push({ label: `fit-out basis in [${req.fitout_basis.join(", ")}]`, met: cfg ? req.fitout_basis.includes(cfg) : null });
  }
  return out;
}

function certMatch(required: string[] | undefined, asset: AssetData): { anyKnown: boolean; matched: boolean } {
  const certs = (asset.certifications ?? []).filter((x) => x && (x.name || x.level));
  if (!certs.length) return { anyKnown: false, matched: false };
  if (!required || !required.length) return { anyKnown: true, matched: true };
  const names = certs.map((x) => `${x.name ?? ""} ${x.level ?? ""}`.toLowerCase());
  return { anyKnown: true, matched: required.some((r) => names.some((n) => n.includes(r.toLowerCase()))) };
}

/** Evaluate one candidate against a requirement. */
export function evaluateOption(req: RequirementRow, c: Candidate, opts: MatchOptions): Omit<OptionResult, "rank"> {
  const decay = opts.availabilityDecayDays ?? 30;
  const tol = opts.areaTolerance ?? 0.15;
  const weights = effectiveWeights(req);
  const disq: string[] = [];
  const verify: string[] = [];
  let known = 0, needed = 0;
  const need = (ok: boolean) => { needed++; if (ok) known++; };

  // ---------------------------------------------------------------- hard eligibility
  const av = c.availability;
  let vacancyUnverified = false, stale = false;
  need(!!av);
  if (!av) { vacancyUnverified = true; verify.push("No availability snapshot: vacancy unverified"); }
  else {
    if (av.status === "leased" || av.status === "withdrawn") disq.push(`Availability status: ${av.status} (as of ${av.as_of})`);
    else if (av.status === "under_offer") verify.push(`Under offer (as of ${av.as_of})`);
    else if (av.status === "unverified") { vacancyUnverified = true; verify.push(`Vacancy unverified (as of ${av.as_of})`); }
    if (av.fact_status && av.fact_status !== "currently_confirmed" && av.status === "available") vacancyUnverified = true;
    stale = isStale(av, opts.asOf, decay);
    need(!stale);
    if (stale) verify.push(`Availability observation stale (as of ${av.as_of}${av.valid_until ? `, valid until ${av.valid_until}` : `, no validity — ${decay}-day decay`})`);
  }

  const excluded = new Set(req.excluded_geography_ids ?? []);
  if ((c.asset.locality_id && excluded.has(c.asset.locality_id)) || (c.asset.micro_market_id && excluded.has(c.asset.micro_market_id)))
    disq.push("Location is in an excluded area");

  const basis = req.area_basis ?? null;
  const area = spaceArea(c.space, basis);
  const amin = num(req.area_min_sf), amax = num(req.area_max_sf), atgt = num(req.area_target_sf);
  const lo = amin ?? (atgt !== null ? atgt * (1 - tol) : null);
  const hi = amax ?? (atgt !== null ? atgt * (1 + tol) : null);
  need(area.value !== null);
  if (lo !== null || hi !== null) {
    if (!basis) {
      // basis unknown: test both; pass on either only as needs-verification
      const a1 = spaceArea(c.space, "carpet").value, a2 = spaceArea(c.space, "chargeable").value;
      const inR = (v: number | null) => v !== null && (lo === null || v >= lo) && (hi === null || v <= hi);
      if (a1 === null && a2 === null) verify.push("Space area unknown");
      else if (!inR(a1) && !inR(a2)) disq.push(`Space area outside ${lo ?? "–"}–${hi ?? "–"} SF on any basis`);
      else verify.push("Requirement area basis not confirmed (carpet vs chargeable)");
    } else if (area.value === null) verify.push(`Space ${basis} area unknown`);
    else if ((lo !== null && area.value < lo) || (hi !== null && area.value > hi))
      disq.push(`Space ${basis} area ${area.value} SF outside ${lo !== null ? Math.round(lo) : "–"}–${hi !== null ? Math.round(hi) : "–"} SF`);
    else if (area.derived) verify.push(`${basis} area derived from efficiency — confirm`);
  }
  const smin = req.seats_min ?? null;
  if (smin && c.space.seats !== null && c.space.seats !== undefined && c.space.seats < smin) disq.push(`Seats ${c.space.seats} below minimum ${smin}`);

  const specs = req.constraints?.required_specs;
  const specChecks = checkSpecs(specs, c);
  for (const s of specChecks) {
    need(s.met !== null);
    if (s.met === false) disq.push(`Fails required spec: ${s.label}`);
    else if (s.met === null) verify.push(`Unknown: ${s.label}`);
  }
  const cert = certMatch(specs?.certifications, c.asset);
  if (specs?.certifications?.length) {
    need(cert.anyKnown);
    if (!cert.anyKnown) verify.push(`Certification unknown (required: ${specs.certifications.join(" / ")})`);
    else if (!cert.matched) disq.push(`Required certification missing (${specs.certifications.join(" / ")})`);
  }

  const quote = c.quote ?? null;
  const quoteExpired = !!quote && (!!quote.superseded_by || (!!quote.valid_until && quote.valid_until < opts.asOf));

  // ---------------------------------------------------------------- weighted fit
  const crit = {} as Record<Criterion, CriterionResult>;
  const set = (k: Criterion, status: CriterionResult["status"], score: number | null, detail: string) => {
    crit[k] = { weight: weights[k], status, score: score === null ? null : round2(Math.max(0, Math.min(1, score))), detail };
  };

  // location / catchment
  {
    const subs: { s: number | null; d: string }[] = [];
    const pref = req.preferred_geography_ids ?? [];
    if (pref.length) {
      const ids = [c.asset.locality_id, c.asset.micro_market_id].filter(Boolean) as string[];
      need(ids.length > 0);
      subs.push(ids.length ? { s: ids.some((i) => pref.includes(i)) ? 1 : 0, d: ids.some((i) => pref.includes(i)) ? "in preferred area" : "outside preferred areas" } : { s: null, d: "asset geography unknown" });
    }
    const catch_ = req.constraints?.catchments ?? [];
    if (catch_.length) {
      const lat = num(c.asset.lat), lon = num(c.asset.lon);
      need(lat !== null && lon !== null);
      if (lat === null || lon === null) subs.push({ s: null, d: "building coordinates unknown" });
      else {
        let wsum = 0, ssum = 0;
        const parts: string[] = [];
        for (const p of catch_) {
          const km = haversineKm(lat, lon, p.lat, p.lon);
          const w = p.weight ?? 1;
          wsum += w; ssum += w * Math.max(0, Math.min(1, (25 - km) / 20));
          parts.push(`${p.label} ${km.toFixed(1)} km`);
        }
        subs.push({ s: wsum ? ssum / wsum : null, d: parts.join(", ") });
      }
    }
    if (!subs.length) set("location", "not_applicable", null, "no location preference set");
    else if (subs.every((x) => x.s === null)) set("location", "unknown", 0, subs.map((x) => x.d).join("; "));
    else set("location", "scored", subs.reduce((a, x) => a + (x.s ?? 0), 0) / subs.length, subs.map((x) => x.d).join("; "));
  }

  // all-in cost
  let allIn: number | null = null;
  {
    const bmax = num(req.budget_max), bmin = num(req.budget_min);
    const bb = req.budget_basis ?? null;
    const useQuote = quote && !quoteExpired && quote.terms_json?.rent !== undefined;
    const rent = useQuote ? num(quote!.terms_json!.rent) : (num(av?.asking_rent_max) ?? num(av?.asking_rent_min));
    const rentBasis = useQuote ? (quote!.terms_json!.rent_basis ?? av?.rent_basis ?? null) : (av?.rent_basis ?? null);
    const camKnown = useQuote && (quote!.terms_json!.cam_included === true || num(quote!.terms_json!.cam_per_sf) !== null);
    const cam = camKnown ? (quote!.terms_json!.cam_included ? 0 : num(quote!.terms_json!.cam_per_sf) ?? 0) : 0;
    need(rent !== null);
    need(!!camKnown);
    if (bmax === null || !bb) set("cost", "not_applicable", null, "no budget set on requirement");
    else if (rent === null) set("cost", "unknown", 0, "rent unknown");
    else {
      let cost: number | null = null;
      let detail = "";
      if (bb === "per_sf_month") {
        if (!rentBasis || rentBasis === "seat") cost = null;
        else if (!basis || rentBasis === basis) cost = rent + cam;
        else {
          const eff = num(c.space.efficiency);
          if (eff) cost = basis === "carpet" ? (rent + cam) / eff : (rent + cam) * eff; // convert per-SF rate between bases
        }
        detail = cost === null ? "rent basis not comparable with budget basis" : `₹${round2(cost)}/SF/month on ${basis ?? rentBasis} basis`;
      } else if (bb === "per_seat_month") {
        cost = rentBasis === "seat" ? rent : null;
        detail = cost === null ? "no per-seat price" : `₹${round2(cost)}/seat/month`;
      } else if (bb === "total_month") {
        const a = rentBasis === "seat" ? (c.space.seats ?? null) : spaceArea(c.space, rentBasis).value;
        cost = a ? (rent + (rentBasis === "seat" ? 0 : cam)) * a : null;
        detail = cost === null ? "area/seats for total unknown" : `₹${Math.round(cost)}/month`;
      }
      if (cost === null) set("cost", "unknown", 0, detail);
      else {
        allIn = round2(cost);
        let s = cost <= bmax ? 1 : Math.max(0, 1 - (cost - bmax) / (0.2 * bmax));
        if (bmin !== null && cost < bmin) detail += " (below budget minimum — check specification)";
        if (!camKnown) { s = Math.min(s, 0.5); detail += "; CAM unknown — rent-only, capped at 50% credit"; }
        set("cost", "scored", s, `${detail}${useQuote ? ` (quote v${quote!.version})` : " (asking)"}`);
      }
    }
  }

  // readiness / timing
  {
    const occ = req.occupation_date ?? null;
    let from = av?.available_from ?? null;
    if (c.asset.status && /under_construction|planned/.test(c.asset.status) && c.asset.completion_date && (!from || c.asset.completion_date > from)) from = c.asset.completion_date;
    need(!!from);
    if (!occ) set("readiness", "not_applicable", null, "no occupation date on requirement");
    else if (!from) set("readiness", "unknown", 0, "available-from date unknown");
    else {
      const late = daysBetween(occ, from);
      set("readiness", "scored", late <= 0 ? 1 : 1 - late / 180, late <= 0 ? `available ${from}, before ${occ}` : `available ${from}, ${late} days after ${occ}`);
    }
  }

  // technical
  {
    const checks = [...specChecks];
    if (!checks.length) set("technical", "not_applicable", null, "no technical constraints set");
    else {
      const met = checks.filter((x) => x.met === true).length;
      set("technical", checks.every((x) => x.met === null) ? "unknown" : "scored", met / checks.length,
        checks.map((x) => `${x.label}: ${x.met === null ? "unknown" : x.met ? "yes" : "no"}`).join("; "));
    }
  }

  // flexibility / growth
  {
    const subs: { s: number | null; d: string }[] = [];
    const growthNeeded = amax !== null && area.value !== null && amax > area.value ? amax - area.value : null;
    if (growthNeeded !== null || req.constraints?.values?.expansion) {
      const ex = c.expansionSf ?? null;
      const needSf = growthNeeded ?? 0;
      subs.push(ex === null ? { s: null, d: "expansion space unknown" } : { s: needSf ? Math.min(1, ex / needSf) : ex > 0 ? 1 : 0, d: `${Math.round(ex)} SF other availability in building` });
    }
    const lockMax = num(req.constraints?.values?.lockin_months);
    if (lockMax !== null) {
      const ql = quote && !quoteExpired ? num(quote.terms_json?.lockin_months) : null;
      subs.push(ql === null ? { s: null, d: "lock-in unknown" } : { s: ql <= lockMax ? 1 : Math.max(0, 1 - (ql - lockMax) / Math.max(lockMax, 12)), d: `lock-in ${ql} vs ≤${lockMax} months` });
    }
    if (!subs.length) set("flexibility", "not_applicable", null, "no flexibility constraints set");
    else if (subs.every((x) => x.s === null)) set("flexibility", "unknown", 0, subs.map((x) => x.d).join("; "));
    else set("flexibility", "scored", subs.reduce((a, x) => a + (x.s ?? 0), 0) / subs.length, subs.map((x) => x.d).join("; "));
  }

  // sustainability
  {
    need(cert.anyKnown);
    if (!cert.anyKnown) set("sustainability", "unknown", 0, "no verified certification recorded");
    else set("sustainability", "scored", cert.matched ? 1 : 0.5, (c.asset.certifications ?? []).map((x) => `${x.name ?? ""} ${x.level ?? ""}`.trim()).join(", "));
  }

  let wsum = 0, ssum = 0;
  for (const k of CRITERIA) {
    const r = crit[k];
    if (r.status === "not_applicable" || r.weight === 0) continue;
    wsum += r.weight;
    ssum += r.weight * (r.score ?? 0);
  }
  const fitScore = wsum ? round2((ssum / wsum) * 100) : 0;
  const completenessScore = needed ? round2((known / needed) * 100) : 0;
  const eligibility: Eligibility = disq.length ? "ineligible" : verify.length ? "needs_verification" : "eligible";
  const label = [c.asset.name, c.space.floor_text ? `Floor ${c.space.floor_text}` : null, c.space.unit ? `Unit ${c.space.unit}` : null].filter(Boolean).join(" · ");
  return {
    spaceId: c.space.id, assetId: c.asset.id, availabilityId: av?.id ?? null, quoteId: quote?.id ?? null, label,
    eligibility, disqualifiers: disq, verificationNeeded: verify, fitScore, completenessScore, criteria: crit,
    area, allInCostPerUnit: allIn,
    flags: { vacancyUnverified, availabilityStale: stale, quoteExpired, clientReleaseBlocked: eligibility !== "eligible" || vacancyUnverified || stale || quoteExpired },
  };
}

const TIER: Record<Eligibility, number> = { eligible: 0, needs_verification: 1, ineligible: 2 };

/** Evaluate and rank. Tier first (eligible > needs_verification > ineligible), then fit, completeness, id. */
export function rankOptions(req: RequirementRow, candidates: Candidate[], opts: MatchOptions): OptionResult[] {
  return candidates
    .map((c) => evaluateOption(req, c, opts))
    .sort((a, b) => TIER[a.eligibility] - TIER[b.eligibility] || b.fitScore - a.fitScore || b.completenessScore - a.completenessScore || a.spaceId.localeCompare(b.spaceId))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
