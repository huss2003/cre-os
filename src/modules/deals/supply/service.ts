/**
 * Module 14 — Property Supply services (DB, user-scoped ctx.db; RLS enforced). See docs/property-supply/CONTRACT.md.
 */
import { type DealsCtx, DealsError, dbError, must, owned, today } from "../ctx";
import type { RequirementRow } from "../requirements/contract";
import { rankOptions, type Candidate, type OptionResult } from "../matching/match";
import { loadCandidates, withExpansion } from "../matching/service";
import {
  availabilityStatus, explainOption, reconfirmationChecks, type Explanation, type ReconfirmItem, type StatusResult, type SupplyStatus,
} from "./supply";

const NIL = "00000000-0000-0000-0000-000000000000";
export interface SupplyMatch extends OptionResult { supplyStatus: StatusResult; explanation: Explanation; category: string | null }
const TIER = { eligible: 0, needs_verification: 1, ineligible: 2 } as const;
/** Below this data completeness an otherwise-eligible option is "needs verification", not "eligible". */
export const LOW_DATA_PCT = 40;

async function decayDays(ctx: DealsCtx): Promise<number> {
  const s = await ctx.db.from("workspace_setting").select("value").eq("workspace_id", ctx.workspaceId).eq("key", "deals.availability_decay_days").maybeSingle();
  return typeof s.data?.value === "number" ? (s.data.value as number) : 30;
}

/**
 * Pure core shared by matchRequirement / findAlternatives: supply-status + property-type hard filters are applied
 * on top of match-v1 hard eligibility, then everything is re-tiered so no score can lift a hard-filter failure.
 */
export function matchCandidates(req: RequirementRow, cands: Candidate[], o: { asOf: string; decayDays?: number; propertyTypes?: string[] | null }): SupplyMatch[] {
  const byId = new Map(cands.map((c) => [c.space.id, c]));
  const types = o.propertyTypes?.length ? o.propertyTypes : null;
  return rankOptions(req, cands, { asOf: o.asOf, availabilityDecayDays: o.decayDays }).map((r) => {
    const c = byId.get(r.spaceId)!;
    const st = availabilityStatus(c.availability, { asOf: o.asOf, decayDays: o.decayDays, assetStatus: c.asset.status, assetCompletion: c.asset.completion_date });
    const extra: string[] = [];
    if (!st.offerable && !r.disqualifiers.some((d) => /Availability status/.test(d))) extra.push(`Availability status: ${st.status}`);
    const cat = c.asset.category ?? null;
    let eligibility = r.eligibility;
    const verification = [...r.verification];
    if (types) {
      if (!cat) { verification.push({ code: "category_unknown", text: `Property category unknown (required: ${types.join(" / ")})` }); }
      else if (!types.includes(cat)) extra.push(`Property type ${cat} not in ${types.join(" / ")}`);
    }
    // B9: an option with almost no recorded data (or no usable availability) cannot outrank well-documented eligible
    // options just because unknown fields were not tested — it needs verification first.
    if (!extra.length && !r.disqualifiers.length && (st.confidence === "none" || r.completenessScore < LOW_DATA_PCT))
      verification.push({ code: "low_data", text: `Too little recorded to confirm fit (data ${r.completenessScore}%${st.confidence === "none" ? ", availability unconfirmed" : ""}) — verify before presenting` });
    const disqualifiers = [...r.disqualifiers, ...extra];
    eligibility = disqualifiers.length ? "ineligible" : verification.length ? "needs_verification" : "eligible";
    const merged: OptionResult = { ...r, disqualifiers, verification, verificationNeeded: verification.map((v) => v.text), eligibility,
      flags: { ...r.flags, clientReleaseBlocked: r.flags.clientReleaseBlocked || eligibility !== "eligible" } };
    return { ...merged, category: cat, supplyStatus: st, explanation: explainOption(merged, c as never, req, { asOf: o.asOf, status: st }) };
  }).sort((a, b) => TIER[a.eligibility] - TIER[b.eligibility] || b.fitScore - a.fitScore || b.completenessScore - a.completenessScore || a.spaceId.localeCompare(b.spaceId))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Read-only match of a requirement against inventory. Persist with deals/matching runShortlist(). */
export async function matchRequirement(ctx: DealsCtx, requirementId: string, o: { asOf?: string; propertyTypes?: string[] } = {}): Promise<SupplyMatch[]> {
  const req = must(await ctx.db.from("requirement").select("*").eq("workspace_id", ctx.workspaceId).eq("id", requirementId).maybeSingle(), "requirement") as RequirementRow;
  const types = o.propertyTypes ?? (Array.isArray(req.constraints?.values?.property_types) ? (req.constraints!.values!.property_types as string[]) : null);
  const cands = withExpansion(await loadCandidates(ctx, requirementId), req.area_basis);
  return matchCandidates(req, cands, { asOf: o.asOf ?? today(), decayDays: await decayDays(ctx), propertyTypes: types });
}

export interface AlternativeCriteria {
  requirementId?: string;
  areaMinSf?: number | null; areaMaxSf?: number | null; areaTargetSf?: number | null; areaBasis?: "carpet" | "chargeable" | null;
  budgetMax?: number | null; budgetBasis?: "per_sf_month" | "per_seat_month" | "total_month" | null;
  localityIds?: string[]; occupationDate?: string | null; propertyTypes?: string[];
  excludeSpaceIds?: string[]; excludeAssetIds?: string[]; asOf?: string; limit?: number;
}
/** Alternatives for a requirement or for lease-style criteria (Modules 15/16). Hard-filter failures stay listed, last. */
export async function findAlternatives(ctx: DealsCtx, c: AlternativeCriteria): Promise<SupplyMatch[]> {
  let req: RequirementRow;
  let reqId = NIL;
  if (c.requirementId) {
    req = must(await ctx.db.from("requirement").select("*").eq("workspace_id", ctx.workspaceId).eq("id", c.requirementId).maybeSingle(), "requirement") as RequirementRow;
    reqId = c.requirementId;
  } else {
    req = { area_min_sf: c.areaMinSf ?? null, area_max_sf: c.areaMaxSf ?? null, area_target_sf: c.areaTargetSf ?? null, area_basis: c.areaBasis ?? null,
      budget_max: c.budgetMax ?? null, budget_basis: c.budgetBasis ?? null, preferred_geography_ids: c.localityIds ?? [], occupation_date: c.occupationDate ?? null, constraints: {} };
  }
  const ex = new Set(c.excludeSpaceIds ?? []), exA = new Set(c.excludeAssetIds ?? []);
  const cands = withExpansion((await loadCandidates(ctx, reqId)).filter((x) => !ex.has(x.space.id) && !exA.has(x.asset.id)), req.area_basis);
  const out = matchCandidates(req, cands, { asOf: c.asOf ?? today(), decayDays: await decayDays(ctx), propertyTypes: c.propertyTypes ?? null });
  return out.slice(0, c.limit ?? 50);
}

/** Latest snapshot → status. A lease expiry is passed only as a hint (never establishes vacancy). */
export async function availabilityStatusForSpace(ctx: DealsCtx, spaceId: string, asOf = today()): Promise<StatusResult> {
  const sp = must(await ctx.db.from("space").select("id, asset_id").eq("workspace_id", ctx.workspaceId).eq("id", spaceId).maybeSingle(), "space") as { asset_id: string };
  const [av, asset, lease] = await Promise.all([
    ctx.db.from("availability").select("as_of, status, supply_status, available_from, valid_until, fact_status, last_verified_on").eq("workspace_id", ctx.workspaceId).eq("space_id", spaceId).is("archived_at", null).order("as_of", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ctx.db.from("asset").select("status, completion_date").eq("workspace_id", ctx.workspaceId).eq("id", sp.asset_id).maybeSingle(),
    ctx.db.from("lease").select("contractual_expiry").eq("workspace_id", ctx.workspaceId).eq("space_id", spaceId).is("archived_at", null).not("contractual_expiry", "is", null).order("contractual_expiry", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (av.error) throw dbError(av.error, "availability");
  return availabilityStatus(av.data as never, { asOf, decayDays: await decayDays(ctx), assetStatus: asset.data?.status, assetCompletion: asset.data?.completion_date,
    leaseExpiry: (lease.data as { contractual_expiry?: string } | null)?.contractual_expiry ?? null });
}

// ==================================================================== F. operators
export interface OperatorCentreInput {
  id?: string; row_version?: number;
  operator_name: string; centre_name: string; category?: "managed_office" | "coworking"; operator_org_id?: string | null;
  asset_id?: string | null; locality_id?: string | null; micro_market_id?: string | null;
  capacity_seats?: number | null; seats_available?: number | null; private_offices?: number | null;
  price_per_seat_min?: number | null; price_per_seat_max?: number | null; pricing_notes?: string | null;
  services?: string[]; amenities?: string[]; contract_terms?: Record<string, unknown>; additional_charges?: unknown[];
  brokerage_conditions?: string | null; source_label?: string | null; last_verified_on?: string | null;
  fact_status?: "reported" | "currently_confirmed" | "historical_observed" | "unknown";
}
export async function upsertOperatorCentre(ctx: DealsCtx, input: OperatorCentreInput) {
  if (!input.operator_name?.trim() || !input.centre_name?.trim()) throw new DealsError(400, "operator and centre name are required");
  if (input.seats_available != null && input.capacity_seats != null && input.seats_available > input.capacity_seats) throw new DealsError(400, "seats available exceed capacity");
  const { id, row_version, ...fields } = input;
  if (id) {
    if (row_version === undefined) throw new DealsError(400, "row_version required");
    const r = await ctx.db.from("operator_centre").update(fields).eq("workspace_id", ctx.workspaceId).eq("id", id).eq("row_version", row_version).select("*");
    if (r.error) throw dbError(r.error, "operator_centre");
    if (!r.data?.length) throw new DealsError(409, "stale_version: the record changed, reload and retry");
    return r.data[0];
  }
  return must(await ctx.db.from("operator_centre").insert({ ...owned(ctx), ...fields }).select("*").single(), "operator_centre");
}
export async function operatorCentres(ctx: DealsCtx, f: { operatorOrgId?: string; operatorName?: string; localityId?: string; minSeats?: number } = {}) {
  let q = ctx.db.from("operator_centre").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("operator_name").order("centre_name").limit(500);
  if (f.operatorOrgId) q = q.eq("operator_org_id", f.operatorOrgId);
  if (f.operatorName) q = q.ilike("operator_name", f.operatorName);
  if (f.localityId) q = q.eq("locality_id", f.localityId);
  // Unknown seat availability is kept (not treated as 0 or as enough) — caller sees seats_available null.
  if (f.minSeats) q = q.or(`seats_available.gte.${Number(f.minSeats)},seats_available.is.null`);
  const r = await q;
  if (r.error) throw dbError(r.error, "operator_centre");
  return r.data ?? [];
}

// ==================================================================== I. shortlist feedback / history
export async function recordShortlistFeedback(ctx: DealsCtx, i: { optionId: string; kind: "client_feedback" | "rejection"; reasonCode?: string | null; comment?: string | null; sentiment?: "positive" | "neutral" | "negative" | null }) {
  const opt = must(await ctx.db.from("shortlist_option").select("id, requirement_id, classification").eq("workspace_id", ctx.workspaceId).eq("id", i.optionId).maybeSingle(), "option") as { requirement_id: string; classification: string };
  if (i.kind === "rejection" && !i.reasonCode) throw new DealsError(400, "a rejection needs a reason");
  const fb = must(await ctx.db.from("shortlist_feedback").insert({ ...owned(ctx, opt.classification), shortlist_option_id: i.optionId, requirement_id: opt.requirement_id,
    kind: i.kind, reason_code: i.reasonCode ?? null, comment: i.comment ?? null, sentiment: i.sentiment ?? null }).select("*").single(), "shortlist_feedback");
  if (i.kind === "rejection") {
    const u = await ctx.db.from("shortlist_option").update({ option_status: "rejected" }).eq("workspace_id", ctx.workspaceId).eq("id", i.optionId);
    if (u.error) throw dbError(u.error, "option");
  }
  return fb;
}
export async function shortlistHistory(ctx: DealsCtx, requirementId: string) {
  const [v, o, f] = await Promise.all([
    ctx.db.from("shortlist_version").select("id, version, as_of, rubric_version, candidate_count, eligible_count, needs_verification_count, note, created_at").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).order("version", { ascending: false }),
    ctx.db.from("shortlist_option").select("id, version, space_id, asset_id, eligible, fit_score, option_status, disqualifiers, score_breakdown, updated_at").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).order("version", { ascending: false }).limit(1000),
    ctx.db.from("shortlist_feedback").select("id, shortlist_option_id, kind, reason_code, comment, sentiment, created_at").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).order("created_at", { ascending: false }),
  ]);
  for (const r of [v, o, f]) if (r.error) throw dbError(r.error, "shortlist history");
  return { versions: v.data ?? [], options: o.data ?? [], feedback: f.data ?? [] };
}

// ==================================================================== J. reconfirmation
export interface ReconfirmRow { optionId: string; spaceId: string; label: string; status: SupplyStatus; items: ReconfirmItem[] }
export async function reconfirmationDue(ctx: DealsCtx, requirementId: string, o: { asOf?: string; pricingMaxAgeDays?: number } = {}): Promise<ReconfirmRow[]> {
  const asOf = o.asOf ?? today();
  const last = await ctx.db.from("shortlist_version").select("version").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).order("version", { ascending: false }).limit(1).maybeSingle();
  if (last.error) throw dbError(last.error, "shortlist_version");
  if (!last.data) return [];
  const opts = await ctx.db.from("shortlist_option").select("id, space_id, score_breakdown, option_status").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId)
    .eq("version", (last.data as { version: number }).version).in("option_status", ["proposed", "shortlisted", "visited", "selected"]);
  if (opts.error) throw dbError(opts.error, "shortlist_option");
  if (!opts.data?.length) return [];
  const want = new Set(opts.data.map((x) => x.space_id as string));
  const cands = (await loadCandidates(ctx, requirementId)).filter((c) => want.has(c.space.id));
  // Expired/superseded quotes: look at the newest quote per space including superseded ones (history is preserved).
  const qs = await ctx.db.from("quote").select("id, version, valid_until, superseded_by, terms_json, space_id").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).is("archived_at", null).order("version", { ascending: false });
  if (qs.error) throw dbError(qs.error, "quote");
  const qBySpace = new Map<string, never>();
  for (const q of qs.data ?? []) if (q.space_id && !qBySpace.has(q.space_id as string)) qBySpace.set(q.space_id as string, q as never);
  const dd = await decayDays(ctx);
  const byId = new Map(cands.map((c) => [c.space.id, c]));
  return opts.data.map((op) => {
    const c = byId.get(op.space_id as string);
    const label = (op.score_breakdown as { label?: string } | null)?.label ?? String(op.space_id);
    if (!c) return { optionId: op.id as string, spaceId: op.space_id as string, label, status: "unconfirmed" as SupplyStatus, items: [{ code: "stale_availability" as const, text: "Space no longer in inventory" }] };
    const quote = qBySpace.get(c.space.id) ?? c.quote ?? null;
    const items = reconfirmationChecks({ availability: c.availability as never, quote, asset: c.asset }, { asOf, decayDays: dd, pricingMaxAgeDays: o.pricingMaxAgeDays });
    const st = availabilityStatus(c.availability, { asOf, decayDays: dd, assetStatus: c.asset.status, assetCompletion: c.asset.completion_date });
    return { optionId: op.id as string, spaceId: c.space.id, label, status: st.status, items };
  }).filter((r) => r.items.length);
}
/** Gate before client presentation / site visit. Throws 422 with the list when anything needs reconfirming. */
export async function assertReadyToPresent(ctx: DealsCtx, requirementId: string, o: { asOf?: string; purpose?: "presentation" | "site_visit" } = {}) {
  const due = await reconfirmationDue(ctx, requirementId, o);
  if (due.length) throw new DealsError(422, `Reconfirm ${due.length} shortlisted propert${due.length === 1 ? "y" : "ies"} before the ${o.purpose === "site_visit" ? "site visit" : "client presentation"}`, due);
  return { ok: true as const };
}
