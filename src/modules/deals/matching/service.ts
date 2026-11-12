/**
 * Shortlist runs (spec Part III POST /v1/requirements/{id}/shortlist: "confirmed hard filters, live snapshot and score
 * version"). Loads space snapshots (never building totals), the latest availability observation per space and the
 * current quote per space, ranks with match-v1 and stores an immutable shortlist_version + shortlist_option rows.
 */
import { type DealsCtx, DealsError, dbError, must, owned, today } from "../ctx";
import type { RequirementRow } from "../requirements/contract";
import { syncVerificationTasks } from "./verify-tasks";
import { RUBRIC_VERSION, effectiveWeights, rankOptions, spaceArea, type AvailabilityData, type Candidate, type OptionResult, type QuoteData } from "./match";

export interface ShortlistRun {
  version: number;
  shortlistVersionId: string;
  asOf: string;
  requirementConfirmed: boolean;
  results: OptionResult[];
  warnings: string[];
}

const MAX_STORED = 200;

export async function loadCandidates(ctx: DealsCtx, requirementId: string): Promise<Candidate[]> {
  // The API returns at most 1,000 rows per request (supabase max_rows): page in a stable order instead of one big .limit().
  const PAGE = 1000;
  const sp: Record<string, unknown>[] = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    const spaces = await ctx.db.from("space").select("id, asset_id, floor_text, unit, carpet_sf, chargeable_sf, efficiency, seats, contiguous_group, configuration")
      .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("id").range(from, from + PAGE - 1);
    if (spaces.error) throw dbError(spaces.error, "spaces");
    sp.push(...(spaces.data ?? []));
    if ((spaces.data ?? []).length < PAGE) break;
  }
  if (!sp.length) return [];
  const assetIds = [...new Set(sp.map((s) => s.asset_id as string))];
  const spaceIds = sp.map((s) => s.id as string);
  // ~100 uuids per request keeps the PostgREST URL well under proxy limits ("URI too long" at 300).
  const chunk = <T,>(a: T[], n = 100) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  const assets: Record<string, unknown>[] = [];
  for (const ids of chunk(assetIds)) {
    const r = await ctx.db.from("asset").select("id, name, locality_id, micro_market_id, lat, lon, status, completion_date, certifications, specs, total_area_sf, category").eq("workspace_id", ctx.workspaceId).in("id", ids);
    if (r.error) throw dbError(r.error, "assets");
    assets.push(...(r.data ?? []));
  }
  const avs: Record<string, unknown>[] = [];
  for (const ids of chunk(spaceIds)) {
    for (let from = 0; from < 100_000; from += PAGE) {
      const r = await ctx.db.from("availability").select("id, space_id, as_of, status, available_from, asking_rent_min, asking_rent_max, rent_basis, fitout_basis, valid_until, fact_status, supply_status, cam_psf_month, last_verified_on, deposit_months, escalation_pct, rent_free_months, lockin_months, lease_term_months, parking_charge_month, fitout_cost_psf, brokerage_terms, other_charges, created_at")
        .eq("workspace_id", ctx.workspaceId).in("space_id", ids).is("archived_at", null).order("as_of", { ascending: false }).order("created_at", { ascending: false }).order("id").range(from, from + PAGE - 1);
      if (r.error) throw dbError(r.error, "availability");
      avs.push(...(r.data ?? []));
      if ((r.data ?? []).length < PAGE) break;
    }
  }
  const latest = new Map<string, AvailabilityData>();
  for (const a of avs) if (!latest.has(a.space_id as string)) latest.set(a.space_id as string, a as unknown as AvailabilityData);
  const q = await ctx.db.from("quote").select("id, version, valid_until, superseded_by, terms_json, space_id")
    .eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).is("superseded_by", null).is("archived_at", null).order("version", { ascending: false });
  if (q.error) throw dbError(q.error, "quotes");
  const quoteBySpace = new Map<string, QuoteData>();
  for (const x of q.data ?? []) if (x.space_id && !quoteBySpace.has(x.space_id as string)) quoteBySpace.set(x.space_id as string, x as unknown as QuoteData);
  const assetById = new Map(assets.map((a) => [a.id as string, a]));
  return sp.filter((s) => assetById.has(s.asset_id as string)).map((s) => ({
    space: s as unknown as Candidate["space"],
    asset: assetById.get(s.asset_id as string) as unknown as Candidate["asset"],
    availability: latest.get(s.id as string) ?? null,
    quote: quoteBySpace.get(s.id as string) ?? null,
  }));
}

/** Other available space in the same building (for growth/flexibility), on the requirement's basis. Pure. */
export function withExpansion(cands: Candidate[], basis: string | null | undefined): Candidate[] {
  const byAsset = new Map<string, Candidate[]>();
  for (const c of cands) byAsset.set(c.asset.id, [...(byAsset.get(c.asset.id) ?? []), c]);
  return cands.map((c) => {
    let total = 0;
    let anyKnown = false;
    for (const o of byAsset.get(c.asset.id) ?? []) {
      if (o.space.id === c.space.id) continue;
      if (o.availability?.status !== "available") continue;
      const a = spaceArea(o.space, basis).value;
      if (a !== null) { total += a; anyKnown = true; }
    }
    return { ...c, expansionSf: anyKnown ? total : (byAsset.get(c.asset.id)?.length ?? 0) > 1 ? null : 0 };
  });
}

export async function runShortlist(ctx: DealsCtx, requirementId: string, opts: { asOf?: string; note?: string | null; decayDays?: number; trigger?: string } = {}): Promise<ShortlistRun> {
  const req = must(await ctx.db.from("requirement").select("*").eq("workspace_id", ctx.workspaceId).eq("id", requirementId).maybeSingle(), "requirement") as RequirementRow & Record<string, unknown>;
  const asOf = opts.asOf ?? today();
  const warnings: string[] = [];
  if (req.status !== "client_confirmed") warnings.push("Requirement is not client-confirmed: this shortlist is provisional and cannot be released to the client as confirmed.");
  const settings = await ctx.db.from("workspace_setting").select("value").eq("workspace_id", ctx.workspaceId).eq("key", "deals.availability_decay_days").maybeSingle();
  const decay = opts.decayDays ?? (typeof settings.data?.value === "number" ? (settings.data.value as number) : 30);
  const cands = withExpansion(await loadCandidates(ctx, requirementId), req.area_basis);
  const results = rankOptions(req, cands, { asOf, availabilityDecayDays: decay });
  if (!cands.length) warnings.push("No spaces recorded in this workspace yet: import availability or add buildings/spaces first.");
  const { data: last } = await ctx.db.from("shortlist_version").select("version").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).order("version", { ascending: false }).limit(1).maybeSingle();
  const version = ((last as { version: number } | null)?.version ?? 0) + 1;
  const cls = String(req.classification ?? "corporate_confidential");
  const sv = must(await ctx.db.from("shortlist_version").insert({
    ...owned(ctx, cls), requirement_id: requirementId, version, rubric_version: RUBRIC_VERSION, weights: effectiveWeights(req),
    requirement_row_version: req.row_version, as_of: asOf, candidate_count: results.length,
    eligible_count: results.filter((r) => r.eligibility === "eligible").length,
    needs_verification_count: results.filter((r) => r.eligibility === "needs_verification").length,
    note: [opts.trigger ? `[${opts.trigger}]` : null, opts.note, ...warnings].filter(Boolean).join(" ") || null,
  }).select("id").single(), "shortlist_version") as { id: string };
  const stored = results.slice(0, MAX_STORED);
  if (results.length > MAX_STORED) warnings.push(`Only the top ${MAX_STORED} of ${results.length} candidates were stored.`);
  if (stored.length) {
    const ins = await ctx.db.from("shortlist_option").insert(stored.map((r) => ({
      ...owned(ctx, cls), requirement_id: requirementId, space_id: r.spaceId, asset_id: r.assetId, availability_id: r.availabilityId,
      version, eligible: r.eligibility === "eligible", disqualifiers: r.disqualifiers,
      fit_score: r.fitScore, completeness_score: r.completenessScore, rubric_version: RUBRIC_VERSION,
      score_breakdown: { eligibility: r.eligibility, rank: r.rank, label: r.label, criteria: r.criteria, verificationNeeded: r.verificationNeeded,
        verification: r.verification, qualifies: r.qualifies, hardFilters: req.constraints?.hard_filters ?? {},
        area: r.area, allInCostPerUnit: r.allInCostPerUnit, flags: r.flags, quoteId: r.quoteId, shortlistVersionId: sv.id },
      option_status: r.eligibility === "ineligible" ? "rejected" : "proposed",
    })));
    if (ins.error) throw dbError(ins.error, "shortlist_option");
  }
  const tasks = await syncVerificationTasks(ctx, req as RequirementRow & { id: string }, results, version);
  if (tasks.created) warnings.push(`${tasks.created} verification task(s) created.`);
  return { version, shortlistVersionId: sv.id, asOf, requirementConfirmed: req.status === "client_confirmed", results, warnings };
}

/** Change the user-facing status of an option (shortlisted / visited / rejected / selected). Ineligible options cannot be shortlisted. */
export async function setOptionStatus(ctx: DealsCtx, optionId: string, status: "proposed" | "shortlisted" | "visited" | "rejected" | "selected") {
  const opt = must(await ctx.db.from("shortlist_option").select("id, eligible, disqualifiers, score_breakdown").eq("id", optionId).maybeSingle(), "option") as { eligible: boolean; disqualifiers: string[]; score_breakdown: { eligibility?: string } };
  if (["shortlisted", "selected"].includes(status) && opt.score_breakdown?.eligibility === "ineligible")
    throw new DealsError(422, `option is ineligible: ${opt.disqualifiers.join("; ")}`);
  const r = await ctx.db.from("shortlist_option").update({ option_status: status }).eq("id", optionId).select("*").single();
  if (r.error) throw dbError(r.error, "option");
  return r.data;
}
