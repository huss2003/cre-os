"use server";
/**
 * Server Actions for company locations (company page) and landlord offers (requirement page). Run as the signed-in user
 * (RLS) and redirect back with ?msg= / ?err=. Forms work without client JavaScript.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { saveAnalysis } from "@/modules/toolkit/store";
import { compareLandlordOffers, landlordOfferSchema, OFFER_CMP_FORMULA, OFFER_FIELDS, type LandlordOffer } from "@/modules/toolkit/calc/landlord-offer";
import { addOrgLocation, archiveOrgLocation, backfillLocationsFromLeases, updateOrgLocation, type LocationInput } from "./locations";
import { listLandlordOffers, reviseLandlordOffer, saveLandlordOffer } from "./offers";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => s(f, k) || null;
const num = (f: FormData, k: string) => { const v = s(f, k).replace(/,/g, ""); if (!v) return null; const x = Number(v); if (!Number.isFinite(x)) throw new Error(`${k}: not a number`); return x; };
const int = (f: FormData, k: string) => { const x = num(f, k); return x === null ? null : Math.round(x); };
const withParam = (url: string, k: string, v: string) => `${url}${url.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v.slice(0, 300))}`;

async function run(back: string, fn: (ctx: Awaited<ReturnType<typeof requireContext>>) => Promise<string | { to?: string; msg?: string }>) {
  let dest = back, msg = "Saved", err: string | null = null;
  try {
    const ctx = await requireContext("editor");
    const r = await fn(ctx);
    if (typeof r === "string") msg = r; else { dest = r.to ?? back; msg = r.msg ?? msg; }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    if (/ZodError|invalid/i.test(err) && e && typeof e === "object" && "issues" in e) err = ((e as { issues: { path: (string | number)[]; message: string }[] }).issues).map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join("; ");
  }
  revalidatePath(back.split("?")[0]);
  redirect(err ? withParam(back, "err", err) : withParam(dest, "msg", msg));
}

// ---------------------------------------------------------------- locations
function locationFrom(f: FormData, orgId: string): LocationInput {
  return {
    orgId, kind: s(f, "kind") as LocationInput["kind"], name: opt(f, "name"), address: opt(f, "address"), city: opt(f, "city"), area: opt(f, "area"),
    assetId: opt(f, "asset_id"), headcount: int(f, "headcount"), lat: num(f, "lat"), lon: num(f, "lon"),
    source: opt(f, "source") ?? "user", sourceRef: opt(f, "source_ref"),
    factStatus: (opt(f, "fact_status") ?? "reported") as LocationInput["factStatus"], observedAt: opt(f, "observed_at"),
  };
}

export async function addLocationAction(f: FormData) {
  const orgId = s(f, "org_id");
  await run(`/companies/${orgId}`, async (ctx) => {
    const r = await addOrgLocation(ctx.db, ctx.workspaceId, ctx.userId, locationFrom(f, orgId));
    return r.duplicate ? "This location is already recorded" : "Location added";
  });
}
export async function updateLocationAction(f: FormData) {
  const orgId = s(f, "org_id");
  await run(`/companies/${orgId}`, async (ctx) => {
    await updateOrgLocation(ctx.db, ctx.workspaceId, s(f, "id"), Number(s(f, "row_version")), { ...locationFrom(f, orgId), source: opt(f, "source") ?? "user" });
    return "Location updated";
  });
}
export async function archiveLocationAction(f: FormData) {
  const orgId = s(f, "org_id");
  await run(`/companies/${orgId}`, async (ctx) => { await archiveOrgLocation(ctx.db, ctx.workspaceId, s(f, "id"), Number(s(f, "row_version"))); return "Location removed"; });
}
export async function backfillLocationsAction(f: FormData) {
  const orgId = s(f, "org_id");
  await run(`/companies/${orgId}`, async (ctx) => { const n = await backfillLocationsFromLeases(ctx.db, ctx.workspaceId); return `${n} office location(s) added from leases`; });
}

// ---------------------------------------------------------------- landlord offers
const NUM_FIELDS = ["areaSf", "efficiencyPct", "rentPerSf", "escalationPct", "securityDepositMonths", "fitoutAllowanceInr", "camPerSf", "carParkRatePerSlot"] as const;
const INT_FIELDS = ["escalationEveryMonths", "lockInMonths", "termMonths", "rentFreeMonths", "carParks", "seats"] as const;

function offerFrom(f: FormData): LandlordOffer {
  const o: Record<string, unknown> = {
    name: s(f, "name"), assetId: opt(f, "asset_id"), spaceId: opt(f, "space_id"), buildingName: opt(f, "building_name"), floorUnit: opt(f, "floor_unit"),
    areaBasis: opt(f, "areaBasis"), powerBackup: opt(f, "powerBackup"), possessionDate: opt(f, "possessionDate"), leaseCommencement: opt(f, "leaseCommencement"),
    validUntil: opt(f, "validUntil"), sourceDoc: opt(f, "sourceDoc"), sourcePage: opt(f, "sourcePage"), notes: opt(f, "notes"),
    factStatus: opt(f, "factStatus") ?? "reported",
  };
  for (const k of NUM_FIELDS) o[k] = num(f, k);
  for (const k of INT_FIELDS) o[k] = int(f, k);
  const confirmed = f.getAll("confirmed").map(String).filter((k) => (OFFER_FIELDS as readonly string[]).includes(k));
  if (confirmed.length) o.fieldStatus = Object.fromEntries(confirmed.map((k) => [k, "currently_confirmed"]));
  return landlordOfferSchema.parse(o);
}

export async function saveOfferAction(f: FormData) {
  const reqId = s(f, "requirement_id");
  await run(`/requirements/${reqId}`, async (ctx) => {
    const c = { db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId };
    const offer = offerFrom(f);
    const qid = opt(f, "quote_id");
    if (qid) { const q = await reviseLandlordOffer(c, qid, offer, opt(f, "evidence")); return `Offer revised to v${q.version}; the previous version is superseded`; }
    await saveLandlordOffer(c, { requirementId: reqId, offer, evidence: opt(f, "evidence") });
    return "Landlord offer saved (v1)";
  });
}

export async function compareOffersAction(f: FormData) {
  const reqId = s(f, "requirement_id");
  await run(`/requirements/${reqId}`, async (ctx) => {
    const c = { db: ctx.db, workspaceId: ctx.workspaceId, userId: ctx.userId };
    const pick = new Set(f.getAll("quote_ids").map(String));
    const rows = (await listLandlordOffers(c, reqId)).filter((q) => !pick.size || pick.has(q.id));
    if (!rows.length) throw new Error("No landlord offers to compare");
    const offers = rows.map((q) => landlordOfferSchema.parse(q.offer));
    const dates = offers.map((o) => o.leaseCommencement ?? o.possessionDate).filter(Boolean).sort() as string[];
    const baseDate = opt(f, "base_date") ?? dates[0] ?? new Date().toISOString().slice(0, 10);
    const discountRatePct = num(f, "discount") ?? 10;
    const r = compareLandlordOffers(offers, { discountRatePct, baseDate });
    const lc = r.leaseComparison;
    const outputs = lc && lc.offers.length > 1 ? { mode: "compare", comparison: lc, offerComparison: r } : lc?.offers.length === 1 ? { mode: "single", result: lc.offers[0], offerComparison: r } : null;
    if (!outputs) throw new Error(`No offer can be costed yet: ${r.missing.join("; ")}`);
    const saved = await saveAnalysis(ctx.db, ctx.workspaceId, ctx.userId, {
      kind: "lease_economics", title: `Landlord offers — ${offers.map((o) => o.name).join(" vs ")}`.slice(0, 200), requirementId: reqId,
      quoteRefs: rows.map((q) => ({ quoteId: q.id, version: q.version, validUntil: q.valid_until })), inputs: { offers, discountRatePct, baseDate },
      outputs, formulaVersion: OFFER_CMP_FORMULA, missing: r.missing,
    });
    return { to: `/toolkit/lease?id=${saved.id}`, msg: `Compared ${offers.length} offer(s)${r.missing.length ? ` — ${r.missing.length} gap(s) listed` : ""}` };
  });
}
