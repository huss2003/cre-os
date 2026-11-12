/**
 * Category D — commercial value signals (spec §3D) from Module 1 records only. A company's recorded rent is compared with
 * currently available space in the SAME micro-market and on the SAME rent basis (carpet vs chargeable vs seat). Different
 * bases are never compared (S5/S6): the pair is skipped. Every signal lists existing information, comparison basis,
 * potential benefit, missing information and verification requirements. Arithmetic is deterministic (decimal.js).
 */
import Decimal from "decimal.js";
import type { Db } from "@/lib/supabase/server";
import { upsertSignal, type OrgContext, type Settings } from "./service";

type Row = Record<string, any>;

export interface LeaseRent { id: string; tenant_org_id: string | null; tenant_name_raw: string | null; rent_per_sf: number | null; rent_basis: string | null; area_sf: number | null; asset_id: string | null; asset_name: string | null; micro_market_id: string | null; micro_market: string | null }
export interface Offer { id: string; asset_id: string; asset_name: string; micro_market_id: string | null; asking_rent_min: number | null; asking_rent_max: number | null; rent_basis: string | null; fitout_basis: string | null; status: string; valid_until: string | null }
export interface Comparison { lease: LeaseRent; offer: Offer; savingPct: string; basis: string }

/** Pure: like-for-like comparisons where an available option asks less than the recorded rent. */
export function compareRents(leases: LeaseRent[], offers: Offer[], today: string, minSavingPct = 5): Comparison[] {
  const out: Comparison[] = [];
  for (const l of leases) {
    if (l.rent_per_sf == null || !l.rent_basis || !l.micro_market_id) continue;      // unknown stays unknown
    const cands = offers.filter((o) => o.micro_market_id === l.micro_market_id && o.asset_id !== l.asset_id && o.status === "available"
      && (!o.valid_until || o.valid_until >= today) && o.rent_basis === l.rent_basis && o.asking_rent_max != null);
    let best: Comparison | null = null;
    for (const o of cands) {
      const ask = new Decimal(o.asking_rent_max!);                   // conservative: compare against the upper asking rent
      const cur = new Decimal(l.rent_per_sf);
      if (cur.lte(0) || ask.gte(cur)) continue;
      const pct = cur.minus(ask).div(cur).times(100);
      if (pct.lt(minSavingPct)) continue;
      if (!best || pct.gt(best.savingPct)) best = { lease: l, offer: o, savingPct: pct.toFixed(1), basis: l.rent_basis };
    }
    if (best) out.push(best);
  }
  return out;
}

/** Read every row in pages (the API caps one response at 1,000 rows; an unsorted .limit() silently drops rows). */
async function allPages(build: () => any, page = 1000, max = 50_000): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < max; from += page) {
    const { data, error } = await build().order("id").range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < page) break;
  }
  return out;
}

export async function scanCommercialValue(db: Db, ws: string, s: Settings, today: string, cache: Map<string, OrgContext>, orgIds?: string[]) {
  const leases = await allPages(() => (orgIds ? (q: any) => q.in("tenant_org_id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]) : (q: any) => q)(db.from("lease").select("id, tenant_org_id, tenant_name_raw, rent_per_sf, rent_basis, area_sf, asset_id, status, asset:asset_id!inner(name, micro_market_id, mm:micro_market_id(name))")
    .eq("workspace_id", ws).is("archived_at", null).not("rent_per_sf", "is", null).not("rent_basis", "is", null).not("asset.micro_market_id", "is", null))); // only leases that can be compared
  const L: LeaseRent[] = (leases ?? []).filter((l: Row) => l.asset?.micro_market_id).map((l: Row) => ({
    id: l.id, tenant_org_id: l.tenant_org_id, tenant_name_raw: l.tenant_name_raw, rent_per_sf: l.rent_per_sf == null ? null : Number(l.rent_per_sf), rent_basis: l.rent_basis,
    area_sf: l.area_sf, asset_id: l.asset_id, asset_name: l.asset?.name ?? null, micro_market_id: l.asset.micro_market_id, micro_market: l.asset?.mm?.name ?? null,
  }));
  if (!L.length) return 0;
  const mms = [...new Set(L.map((l) => l.micro_market_id))];
  // All snapshots (paged): a missing latest snapshot would otherwise read as "no longer available" below.
  const av = await allPages(() => db.from("availability").select("id, space_id, as_of, created_at, status, asking_rent_min, asking_rent_max, rent_basis, fitout_basis, valid_until, space:space_id(asset_id, asset:asset_id(name, micro_market_id))")
    .eq("workspace_id", ws).is("archived_at", null));
  // availability is append-only snapshots: only the latest snapshot per space counts.
  const latest = new Map<string, Row>();
  for (const a of av ?? []) { const cur = latest.get(a.space_id); if (!cur || `${a.as_of}|${a.created_at}` > `${cur.as_of}|${cur.created_at}`) latest.set(a.space_id, a); }
  const spaceOf = new Map((av ?? []).map((a: Row) => [a.id, a.space_id]));
  const offers: Offer[] = [...latest.values()].filter((a: Row) => mms.includes(a.space?.asset?.micro_market_id)).map((a: Row) => ({
    id: a.id, asset_id: a.space.asset_id, asset_name: a.space.asset?.name ?? "", micro_market_id: a.space.asset?.micro_market_id ?? null,
    asking_rent_min: a.asking_rent_min == null ? null : Number(a.asking_rent_min), asking_rent_max: a.asking_rent_max == null ? null : Number(a.asking_rent_max),
    rent_basis: a.rent_basis, fitout_basis: a.fitout_basis, status: a.status, valid_until: a.valid_until,
  }));
  let created = 0;
  for (const c of compareRents(L, offers, today)) {
    const who = c.lease.tenant_name_raw ?? "Occupier";
    const r = await upsertSignal(db, ws, {
      category: "commercial", kind: "better_value_option", subType: "cheaper_same_micromarket",
      title: `Lower asking rent nearby: ${c.offer.asset_name} (${c.lease.micro_market})`, key: `commercial:${c.lease.id}:${c.offer.id}`,
      summary: `Recorded rent ${c.lease.rent_per_sf} per sf (${c.basis}) at ${c.lease.asset_name}; ${c.offer.asset_name} in the same micro-market asks up to ${c.offer.asking_rent_max} per sf on the same ${c.basis} basis (${c.savingPct}% lower on headline rent).`,
      creRelevance: "A like-for-like lower asking rent may reduce occupancy cost — headline rent only; total occupancy cost is not yet compared.",
      orgId: c.lease.tenant_org_id, nameRaw: c.lease.tenant_org_id ? null : who, leaseId: c.lease.id, location: c.lease.micro_market, verification: "inference",
      recommended: { text: "Validate availability and compare total occupancy costs (CAM, fit-out, deposit, escalation, relocation cost) before raising it.", actionKind: "property_research" },
      evidence: [
        { role: "support", key: `lease_rent:${c.lease.id}`, sourceName: "Lease record", note: `Existing: ${c.lease.rent_per_sf}/sf ${c.basis} at ${c.lease.asset_name}`, status: "reported" },
        { role: "support", key: `availability:${c.offer.id}`, sourceName: "Availability record", note: `Comparison: asking ${c.offer.asking_rent_min ?? "?"}–${c.offer.asking_rent_max}/sf ${c.basis}, fit-out ${c.offer.fitout_basis ?? "unknown"}`, status: "reported" },
      ],
      processing: c.lease.tenant_org_id ? "review_required" : "entity_unresolved",
    }, s, today, cache);
    if (r.created) created++;
  }
  // Property no longer available → counter-evidence on earlier commercial signals.
  const { data: open } = await db.from("signal").select("id, dedupe_key, derived").eq("workspace_id", ws).eq("category", "commercial").like("dedupe_key", "commercial:%").not("status", "in", "(dismissed,rejected,known)").order("id").limit(500);
  for (const sg of open ?? []) {
    const availId = String(sg.dedupe_key).split(":")[2];
    const snap = latest.get(spaceOf.get(availId) ?? "");
    const still = snap && snap.status === "available" && (!snap.valid_until || snap.valid_until >= today);
    if (!still && !sg.derived?.flags?.propertyUnavailable) {
      await db.from("signal_evidence").upsert({ workspace_id: ws, signal_id: sg.id, role: "counter", dedupe_key: `unavailable:${availId}`, source_name: "Availability record", excerpt: "The compared property is no longer listed as available." }, { onConflict: "workspace_id,signal_id,dedupe_key", ignoreDuplicates: true });
      await db.from("signal").update({ derived: { ...(sg.derived ?? {}), flags: { ...(sg.derived?.flags ?? {}), propertyUnavailable: true } } }).eq("workspace_id", ws).eq("id", sg.id);
    }
  }
  return created;
}

export const COMMERCIAL_MISSING = [
  "Comparable rent basis confirmed on both sides (carpet / chargeable / seat).",
  "CAM, fit-out basis, deposit, escalation and rent-free on both sides.",
  "Required area and configuration; amenities comparison.",
  "Relocation / exit costs and lease constraints (lock-in, notice).",
];
