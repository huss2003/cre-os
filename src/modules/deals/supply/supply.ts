/**
 * Module 14 — Property Supply (pure, deterministic). Status model, commercial terms, hierarchy combination,
 * per-property match explanation and reconfirmation checks. No DB, no clock, no LLM (S5/S6).
 */
import type { RequirementRow } from "../requirements/contract";
import type { Candidate, OptionResult } from "../matching/match";

// ==================================================================== E. availability status
export const SUPPLY_STATUSES = [
  "immediately_available", "future_available", "under_negotiation", "tentatively_held", "under_offer",
  "occupied", "unconfirmed", "withdrawn", "leased",
] as const;
export type SupplyStatus = (typeof SUPPLY_STATUSES)[number];
export const SUPPLY_STATUS_LABEL: Record<SupplyStatus, string> = {
  immediately_available: "Immediately available", future_available: "Future availability", under_negotiation: "Under negotiation",
  tentatively_held: "Tentatively held", under_offer: "Under offer", occupied: "Occupied", unconfirmed: "Unconfirmed",
  withdrawn: "Withdrawn", leased: "Leased",
};
/** Statuses that can still be offered to a client (possibly after verification). */
const OFFERABLE: SupplyStatus[] = ["immediately_available", "future_available", "under_negotiation", "tentatively_held", "under_offer", "unconfirmed"];

export interface AvailabilityRow {
  as_of: string; status: string; supply_status?: string | null; available_from?: string | null;
  valid_until?: string | null; fact_status?: string | null; last_verified_on?: string | null;
}
export interface StatusContext {
  asOf: string; decayDays?: number;
  assetStatus?: string | null; assetCompletion?: string | null;
  /** A known lease expiry for the space (from lease records). Never establishes vacancy on its own. */
  leaseExpiry?: string | null;
}
export type Confidence = "high" | "medium" | "low" | "none";
export interface StatusResult {
  status: SupplyStatus; immediate: boolean; offerable: boolean; confidence: Confidence; stale: boolean;
  lastVerifiedOn: string | null; availableFrom: string | null; leaseExpiryOnly: boolean; reasons: string[];
}

const addDays = (a: string, n: number) => new Date(Date.parse(a + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function availabilityStatus(av: AvailabilityRow | null, c: StatusContext): StatusResult {
  const reasons: string[] = [];
  if (!av) {
    // Rule: lease expiry does not establish vacancy.
    if (c.leaseExpiry) reasons.push(`Only a lease expiry (${c.leaseExpiry}) is known — lease expiry does not establish vacancy`);
    else reasons.push("No availability observation recorded");
    return { status: "unconfirmed", immediate: false, offerable: true, confidence: "none", stale: true, lastVerifiedOn: null,
      availableFrom: null, leaseExpiryOnly: !!c.leaseExpiry, reasons };
  }
  let status: SupplyStatus;
  if (av.supply_status && (SUPPLY_STATUSES as readonly string[]).includes(av.supply_status)) status = av.supply_status as SupplyStatus;
  else status = av.status === "available" ? "immediately_available" : av.status === "under_offer" ? "under_offer"
    : av.status === "leased" ? "leased" : av.status === "withdrawn" ? "withdrawn" : "unconfirmed";
  let from = av.available_from ?? null;
  // Rule: future supply is not immediate availability.
  if (c.assetStatus && /planned|under_construction/.test(c.assetStatus)) {
    if (c.assetCompletion && (!from || c.assetCompletion > from)) from = c.assetCompletion;
    if (status === "immediately_available") { status = "future_available"; reasons.push(`Building is ${c.assetStatus.replace("_", " ")} — future supply, not immediate`); }
  }
  if (status === "immediately_available" && from && from > c.asOf) { status = "future_available"; reasons.push(`Available from ${from}, after ${c.asOf}`); }
  const until = av.valid_until ?? addDays(av.last_verified_on ?? av.as_of, c.decayDays ?? 30);
  const stale = until < c.asOf;
  if (stale) reasons.push(`Observation stale (as of ${av.as_of}${av.last_verified_on ? `, verified ${av.last_verified_on}` : ""})`);
  const confirmed = av.fact_status === "currently_confirmed";
  let confidence: Confidence = !OFFERABLE.includes(status) ? "none"
    : status === "unconfirmed" ? "low"
    : confirmed && !stale && status === "immediately_available" ? "high"
    : confirmed && !stale ? "medium" : "low";
  if (!confirmed && av.fact_status) reasons.push(`Fact status: ${av.fact_status}`);
  if (status === "under_negotiation" || status === "tentatively_held" || status === "under_offer") reasons.push(`${SUPPLY_STATUS_LABEL[status]} — may be lost`);
  if (!av.last_verified_on) { reasons.push("Never verified"); if (confidence === "high") confidence = "medium"; }
  return { status, immediate: status === "immediately_available", offerable: OFFERABLE.includes(status), confidence, stale,
    lastVerifiedOn: av.last_verified_on ?? null, availableFrom: from, leaseExpiryOnly: false, reasons };
}

// ==================================================================== D. commercial terms
export type TermStatus = "known" | "missing" | "historical";
export interface Term { value: number | string | null; status: TermStatus; source: "quote" | "availability" | null }
export interface TermsRow extends AvailabilityRow {
  asking_rent_min?: number | string | null; asking_rent_max?: number | string | null; rent_basis?: string | null;
  cam_psf_month?: number | string | null; deposit_months?: number | string | null; escalation_pct?: number | string | null;
  escalation_every_months?: number | null; rent_free_months?: number | string | null; lockin_months?: number | string | null;
  lease_term_months?: number | string | null; parking_charge_month?: number | string | null; fitout_cost_psf?: number | string | null;
  brokerage_terms?: string | null; other_charges?: unknown;
}
export interface QuoteRow { id: string; version: number; valid_until?: string | null; superseded_by?: string | null; terms_json?: Record<string, unknown> | null }
export const TERM_KEYS = ["rent", "cam", "deposit_months", "escalation", "lockin_months", "lease_term_months", "rent_free_months", "parking", "fitout_cost_psf", "brokerage", "other_charges"] as const;
export type TermKey = (typeof TERM_KEYS)[number];
export interface CommercialTerms { terms: Record<TermKey, Term>; pricingCurrent: boolean; quoteStatus: "none" | "current" | "expired" | "superseded"; notes: string[] }

export function commercialTerms(av: TermsRow | null, quote: QuoteRow | null | undefined, o: { asOf: string; pricingMaxAgeDays?: number }): CommercialTerms {
  const notes: string[] = [];
  const quoteStatus = !quote ? "none" : quote.superseded_by ? "superseded" : quote.valid_until && quote.valid_until < o.asOf ? "expired" : "current";
  const q = quoteStatus === "current" ? (quote!.terms_json ?? {}) : null;
  if (quoteStatus === "expired" || quoteStatus === "superseded") notes.push(`Quote v${quote!.version} ${quoteStatus} — kept for history, not used as current pricing`);
  const age = o.pricingMaxAgeDays ?? 90;
  const historicalAv = !!av && (av.fact_status === "historical_observed" || addDays(av.last_verified_on ?? av.as_of, age) < o.asOf);
  if (av && historicalAv) notes.push(`Availability pricing observed ${av.last_verified_on ?? av.as_of} is historical, not current`);
  const fromAv = (v: unknown): Term => { const n = typeof v === "string" && !Number.isFinite(Number(v)) ? v : num(v); return n === null ? { value: null, status: "missing", source: null } : { value: n, status: historicalAv ? "historical" : "known", source: "availability" }; };
  const pick = (qv: unknown, avv: unknown): Term => {
    const n = num(qv);
    if (q && n !== null) return { value: n, status: "known", source: "quote" };
    return fromAv(avv);
  };
  const terms = {} as Record<TermKey, Term>;
  terms.rent = pick(q?.rent, av?.asking_rent_max ?? av?.asking_rent_min);
  // Missing CAM is not zero: only "cam_included: true" on a current quote yields 0.
  terms.cam = q && q.cam_included === true ? { value: 0, status: "known", source: "quote" } : pick(q?.cam_per_sf, av?.cam_psf_month);
  terms.deposit_months = pick(q?.deposit_months, av?.deposit_months);
  terms.escalation = pick(q?.escalation_pct, av?.escalation_pct);
  terms.lockin_months = pick(q?.lockin_months, av?.lockin_months);
  terms.lease_term_months = pick(q?.tenure_months, av?.lease_term_months);
  terms.rent_free_months = pick(q?.rent_free_months, av?.rent_free_months);
  terms.parking = pick(q?.parking_charge_month, av?.parking_charge_month);
  terms.fitout_cost_psf = pick(q?.fitout_cost_psf, av?.fitout_cost_psf);
  terms.brokerage = av?.brokerage_terms ? { value: av.brokerage_terms, status: historicalAv ? "historical" : "known", source: "availability" } : { value: null, status: "missing", source: null };
  terms.other_charges = Array.isArray(av?.other_charges) && (av!.other_charges as unknown[]).length ? { value: JSON.stringify(av!.other_charges), status: historicalAv ? "historical" : "known", source: "availability" } : { value: null, status: "missing", source: null };
  if (terms.cam.status === "missing") notes.push("CAM unknown — not assumed to be zero");
  const pricingCurrent = terms.rent.status === "known";
  return { terms, pricingCurrent, quoteStatus, notes };
}

// ==================================================================== A. hierarchy: contiguous / divisible
export interface HierSpace { id: string; asset_id: string; floor_text?: string | null; contiguous_group?: string | null; carpet_sf?: number | string | null; chargeable_sf?: number | string | null; divisible?: boolean | null; min_divisible_sf?: number | string | null }
export interface SpaceGroup { key: string; assetId: string; spaceIds: string[]; carpetSf: number | null; chargeableSf: number | null; contiguous: boolean }

/** Combine spaces only when they share asset + contiguous_group. Spaces without a group are never combined. */
export function combineSpaces(spaces: HierSpace[]): { groups: SpaceGroup[]; refused: string[] } {
  const groups = new Map<string, SpaceGroup>();
  const refused: string[] = [];
  const sum = (a: number | null, v: unknown) => { const n = num(v); return a === null || n === null ? null : a + n; };
  for (const s of spaces) {
    const key = s.contiguous_group ? `${s.asset_id}:${s.contiguous_group}` : `${s.asset_id}:single:${s.id}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { key, assetId: s.asset_id, spaceIds: [s.id], carpetSf: num(s.carpet_sf), chargeableSf: num(s.chargeable_sf), contiguous: true });
    else { g.spaceIds.push(s.id); g.carpetSf = sum(g.carpetSf, s.carpet_sf); g.chargeableSf = sum(g.chargeableSf, s.chargeable_sf); }
  }
  const byAsset = new Map<string, number>();
  for (const g of groups.values()) byAsset.set(g.assetId, (byAsset.get(g.assetId) ?? 0) + 1);
  for (const [a, n] of byAsset) if (n > 1) refused.push(`Building ${a}: ${n} non-contiguous blocks are not combined into one option`);
  return { groups: [...groups.values()], refused };
}

/** Can a space serve `needSf` (on its recorded basis) by division? null = unknown. */
export function canDivide(s: HierSpace, needSf: number): boolean | null {
  const area = num(s.chargeable_sf) ?? num(s.carpet_sf);
  if (area === null) return null;
  if (needSf >= area) return true;
  if (s.divisible === false) return false;
  if (s.divisible == null) return null;
  const min = num(s.min_divisible_sf);
  return min === null ? null : needSf >= min;
}

// ==================================================================== B. categories
export const DEFAULT_CATEGORIES = ["conventional_office", "managed_office", "coworking", "commercial_campus", "business_park"];

// ==================================================================== H. explanation
export interface Explanation {
  why: string; satisfies: string[]; fails: string[]; advantages: string[]; disadvantages: string[];
  missing: string[]; availabilityConfidence: Confidence; verificationRequired: string[];
}
export function explainOption(r: OptionResult, c: Candidate & { availability: (Candidate["availability"] & TermsRow) | null }, req: RequirementRow, o: { asOf: string; status?: StatusResult; extraFails?: string[] }): Explanation {
  const st = o.status ?? availabilityStatus(c.availability, { asOf: o.asOf, assetStatus: c.asset.status, assetCompletion: c.asset.completion_date });
  const terms = commercialTerms(c.availability ?? null, c.quote as QuoteRow | null, { asOf: o.asOf });
  const fails = [...r.disqualifiers, ...(o.extraFails ?? [])];
  const advantages: string[] = [], disadvantages: string[] = [], missing: string[] = [];
  for (const [k, v] of Object.entries(r.criteria)) {
    if (v.status === "unknown") missing.push(`${k}: ${v.detail}`);
    else if (v.status === "scored" && v.score !== null) {
      if (v.score >= 0.8) advantages.push(`${k}: ${v.detail}`);
      else if (v.score < 0.5) disadvantages.push(`${k}: ${v.detail}`);
    }
  }
  const bmax = num(req.budget_max);
  if (r.allInCostPerUnit !== null && bmax !== null && r.allInCostPerUnit < bmax) advantages.push(`All-in ${r.allInCostPerUnit} under budget ${bmax}`);
  if (terms.terms.rent_free_months.status === "known" && Number(terms.terms.rent_free_months.value) > 0) advantages.push(`Rent-free ${terms.terms.rent_free_months.value} months`);
  for (const k of ["rent", "cam", "deposit_months", "lockin_months", "escalation"] as TermKey[]) if (terms.terms[k].status === "missing") missing.push(`${k.replace("_", " ")} not recorded`);
  for (const n of terms.notes) disadvantages.push(n);
  if (!st.immediate && st.offerable) disadvantages.push(`${SUPPLY_STATUS_LABEL[st.status]}${st.availableFrom ? ` from ${st.availableFrom}` : ""}`);
  const verificationRequired = [...r.verificationNeeded];
  if (st.stale && !verificationRequired.some((x) => /stale/i.test(x))) verificationRequired.push("Availability needs reconfirmation (stale)");
  const why = fails.length
    ? `Does not meet ${fails.length} hard requirement(s): ${fails[0]}${fails.length > 1 ? " …" : ""}`
    : `Meets all hard requirements${r.qualifies.length ? ` (${r.qualifies.slice(0, 2).join("; ")})` : ""}; fit ${r.fitScore}/100${verificationRequired.length ? `, ${verificationRequired.length} item(s) to verify` : ""}`;
  return { why, satisfies: r.qualifies, fails, advantages, disadvantages, missing, availabilityConfidence: st.confidence, verificationRequired };
}

// ==================================================================== J. reconfirmation
export interface ReconfirmItem { code: "stale_availability" | "outdated_pricing" | "expired_quote" | "missing_technical" | "status_not_offerable"; text: string }
export const TECH_KEYS = ["power_kva", "car_parks", "floor_plate_sf", "ac_type", "fire_noc"];
export function reconfirmationChecks(c: { availability: TermsRow | null; quote?: QuoteRow | null; asset: { status?: string | null; completion_date?: string | null; specs?: Record<string, unknown> | null } },
  o: { asOf: string; pricingMaxAgeDays?: number; decayDays?: number; requiredTech?: string[] }): ReconfirmItem[] {
  const out: ReconfirmItem[] = [];
  const st = availabilityStatus(c.availability, { asOf: o.asOf, decayDays: o.decayDays, assetStatus: c.asset.status, assetCompletion: c.asset.completion_date });
  if (!st.offerable) out.push({ code: "status_not_offerable", text: `Status is ${SUPPLY_STATUS_LABEL[st.status]}` });
  if (st.stale || st.status === "unconfirmed") out.push({ code: "stale_availability", text: st.reasons[0] ?? "Availability not currently confirmed" });
  const t = commercialTerms(c.availability, c.quote ?? null, { asOf: o.asOf, pricingMaxAgeDays: o.pricingMaxAgeDays });
  if (t.terms.rent.status !== "known") out.push({ code: "outdated_pricing", text: t.terms.rent.status === "historical" ? "Pricing is historical — obtain current pricing" : "No current pricing recorded" });
  if (t.quoteStatus === "expired" || t.quoteStatus === "superseded") out.push({ code: "expired_quote", text: `Quote ${t.quoteStatus} — request a fresh quotation` });
  const specs = c.asset.specs ?? {};
  const miss = (o.requiredTech ?? TECH_KEYS.slice(0, 2)).filter((k) => specs[k] === undefined || specs[k] === null || specs[k] === "");
  if (miss.length) out.push({ code: "missing_technical", text: `Missing technical details: ${miss.join(", ")}` });
  return out;
}

/** B9: "cantonment_house:stack" → "stacked floors"; other group codes as plain words. Never the raw code. */
export function contiguousLabel(group: string | null | undefined): string | null {
  if (!group) return null;
  const last = group.split(":").pop()!.trim();
  if (/^stack(ed)?$/i.test(last)) return "stacked floors";
  const t = last.replace(/[_-]+/g, " ").trim();
  return t || null;
}
