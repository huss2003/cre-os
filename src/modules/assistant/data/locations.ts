/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";

/**
 * Company locations (mudar.org_location): HQ, offices, factories, plants, warehouses, R&D sites — each with its source
 * and fact status (reported ≠ currently_confirmed ≠ ai_inference, S6). Offices are backfilled from leases → buildings
 * (source 'lease', status 'reported'). All functions take a user-scoped (RLS) client and filter workspace_id explicitly.
 */
type Db = any;
type Row = Record<string, any>;

export const LOCATION_KINDS = ["hq", "office", "factory", "warehouse", "plant", "r_and_d", "other"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const LOCATION_KIND_LABEL: Record<LocationKind, string> = { hq: "HQ", office: "Office", factory: "Factory", warehouse: "Warehouse", plant: "Plant", r_and_d: "R&D", other: "Other" };
export const OFFICE_KINDS: LocationKind[] = ["hq", "office", "r_and_d"];
export const INDUSTRIAL_KINDS: LocationKind[] = ["factory", "plant", "warehouse"];
export const LOCATION_FACT_STATUSES = ["reported", "currently_confirmed", "ai_inference"] as const;

const txt = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
export const locationInput = z.object({
  orgId: z.string().uuid(),
  kind: z.enum(LOCATION_KINDS),
  name: txt(200), address: txt(500), city: txt(100), area: txt(150).describe("Micro-market / industrial area, e.g. 'MIDC Chakan'"),
  geographyId: z.string().uuid().nullable().optional(), assetId: z.string().uuid().nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(), lon: z.number().min(-180).max(180).nullable().optional(),
  headcount: z.number().int().min(0).nullable().optional(),
  source: z.string().trim().min(1).max(40).default("user"), sourceRef: txt(500),
  factStatus: z.enum(LOCATION_FACT_STATUSES).default("reported"),
  observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).refine((v) => v.city || v.area || v.address || v.assetId || v.geographyId || v.name, "give at least a city, area, address, building or name");
export type LocationInput = z.input<typeof locationInput>;

const COLS = "id, org_id, location_kind, name, address, city, area, geography_id, lat, lon, asset_id, headcount, source, source_lease_id, source_ref, fact_status, observed_at, row_version, updated_at, classification";

function toRow(i: z.output<typeof locationInput>) {
  return {
    org_id: i.orgId, location_kind: i.kind, name: i.name, address: i.address, city: i.city, area: i.area,
    geography_id: i.geographyId ?? null, asset_id: i.assetId ?? null, lat: i.lat ?? null, lon: i.lon ?? null, headcount: i.headcount ?? null,
    source: i.source, source_ref: i.sourceRef, fact_status: i.factStatus, observed_at: i.observedAt ?? new Date().toISOString().slice(0, 10),
  };
}

export async function listOrgLocations(db: Db, ws: string, orgId: string): Promise<Row[]> {
  const { data, error } = await db.from("org_location").select(COLS).eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).order("location_kind").order("city");
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

/** Insert; a duplicate (same company + kind + building or area|city|name) returns the existing row instead (S8). */
export async function addOrgLocation(db: Db, ws: string, userId: string, input: LocationInput): Promise<{ row: Row; duplicate: boolean }> {
  const i = locationInput.parse(input);
  const { data: org } = await db.from("organisation").select("id, classification").eq("workspace_id", ws).eq("id", i.orgId).maybeSingle();
  if (!org) throw new Error("not_found_or_no_access");
  const ins = await db.from("org_location").insert({ workspace_id: ws, owner_user_id: userId, classification: org.classification, ...toRow(i) }).select(COLS).single();
  if (!ins.error) return { row: ins.data as Row, duplicate: false };
  if (ins.error.code !== "23505") throw new Error(ins.error.message);
  const existing = (await listOrgLocations(db, ws, i.orgId)).find((r) => r.location_kind === i.kind && (i.assetId ? r.asset_id === i.assetId : norm(r) === norm({ area: i.area, city: i.city, name: i.name })));
  if (!existing) throw new Error("duplicate location");
  return { row: existing, duplicate: true };
}
const norm = (r: Row) => [r.area, r.city, r.name].map((x) => String(x ?? "").toLowerCase().replace(/\s+/g, " ")).join("|");

export async function updateOrgLocation(db: Db, ws: string, id: string, expectedVersion: number, input: LocationInput): Promise<Row> {
  const i = locationInput.parse(input);
  const patch: Partial<ReturnType<typeof toRow>> = toRow(i); delete patch.org_id;
  const { data, error } = await db.from("org_location").update(patch).eq("workspace_id", ws).eq("id", id).eq("row_version", expectedVersion).select(COLS);
  if (error) throw new Error(error.code === "23505" ? "another location of this company already has these details" : error.message);
  if (!data?.length) throw new Error("conflict: the location changed or is not visible — reload and retry");
  return data[0] as Row;
}

export async function archiveOrgLocation(db: Db, ws: string, id: string, expectedVersion: number): Promise<void> {
  const { data, error } = await db.from("org_location").update({ archived_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", id).eq("row_version", expectedVersion).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("conflict: the location changed or is not visible — reload and retry");
}

/** Re-runnable lease → building backfill (RLS-scoped). Returns rows added. */
export async function backfillLocationsFromLeases(db: Db, ws: string): Promise<number> {
  const { data, error } = await db.schema("mudar_app").rpc("org_location_backfill", { p_workspace: ws });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

// ------------------------------------------------------------------------------------------------ place matching
export async function loadGeoIndex(db: Db, ws: string) {
  const { data } = await db.from("geography").select("id, name, parent_id, aliases").eq("workspace_id", ws).is("archived_at", null).limit(5000);
  const byId = new Map(((data ?? []) as Row[]).map((g) => [g.id, g]));
  const path = (gid: string | null | undefined): string[] => {
    const out: string[] = []; let cur = gid ? byId.get(gid) : null; let guard = 0;
    while (cur && guard++ < 10) { out.push(cur.name, ...((cur.aliases ?? []) as string[])); cur = cur.parent_id ? byId.get(cur.parent_id) : null; }
    return out;
  };
  return { path };
}
/** Searchable text of a location: name, address, city, area and the geography path (with aliases). */
export function placeText(l: Row, geoPath: (id: string | null) => string[]): string {
  return [l.name, l.address, l.city, l.area, ...geoPath(l.geography_id ?? null)].filter(Boolean).join(" | ").toLowerCase();
}
export const placeMatches = (text: string, needle: string) => {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  if (text.includes(n)) return true;
  // all words present, e.g. "chakan midc" vs "MIDC Chakan"
  const words = n.split(/[\s,]+/).filter((w) => w.length > 1);
  return words.length > 1 && words.every((w) => text.includes(w));
};

export interface LocationFilters {
  kinds?: LocationKind[]; city?: string; area?: string; hasOfficeIn?: string; hasFactoryIn?: string; companyIds?: string[]; sector?: string;
  factStatus?: (typeof LOCATION_FACT_STATUSES)[number][];
}
export interface LocationSearchResult {
  companies: { orgId: string; name: string; sector: string | null; locations: Row[] }[];
  coverage: { companiesChecked: number; withLocationData: number; withoutLocationData: number; note: string };
}

async function allLocations(db: Db, ws: string, orgIds?: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let p = 0; ; p += 1000) {
    let q = db.from("org_location").select(COLS).eq("workspace_id", ws).is("archived_at", null);
    if (orgIds) q = q.in("org_id", orgIds.slice(0, 300));
    const { data, error } = await q.range(p, p + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Companies with locations matching ALL filters. hasOfficeIn / hasFactoryIn each require one site of that family in the
 * place (they may be different sites). Coverage counts companies without any recorded location: they could not be checked.
 */
export async function searchCompanyLocations(db: Db, ws: string, f: LocationFilters): Promise<LocationSearchResult> {
  let oq = db.from("organisation").select("id, display_name, sector").eq("workspace_id", ws).is("archived_at", null).limit(5000);
  if (f.companyIds?.length) oq = oq.in("id", f.companyIds.slice(0, 300));
  if (f.sector) oq = oq.ilike("sector", `%${f.sector.replace(/[%_,()\\]/g, " ").trim()}%`);
  const orgs = ((await oq).data ?? []) as Row[];
  const orgBy = new Map(orgs.map((o) => [o.id, o]));
  const locs = (await allLocations(db, ws, f.companyIds?.length ? f.companyIds : undefined)).filter((l) => orgBy.has(l.org_id));
  const geo = await loadGeoIndex(db, ws);
  const text = new Map(locs.map((l) => [l.id, placeText(l, geo.path)]));
  const byOrg = new Map<string, Row[]>();
  for (const l of locs) (byOrg.get(l.org_id) ?? byOrg.set(l.org_id, []).get(l.org_id)!).push(l);

  const siteOk = (l: Row) =>
    (!f.kinds?.length || f.kinds.includes(l.location_kind)) &&
    (!f.factStatus?.length || f.factStatus.includes(l.fact_status)) &&
    (!f.city || placeMatches(String(l.city ?? "").toLowerCase() + " | " + text.get(l.id), f.city)) &&
    (!f.area || placeMatches(text.get(l.id)!, f.area));
  const has = (rows: Row[], kinds: LocationKind[], place: string) => rows.some((l) => kinds.includes(l.location_kind) && placeMatches(text.get(l.id)!, place));

  const companies: LocationSearchResult["companies"] = [];
  for (const [orgId, rows] of byOrg) {
    if (f.hasOfficeIn && !has(rows, OFFICE_KINDS, f.hasOfficeIn)) continue;
    if (f.hasFactoryIn && !has(rows, INDUSTRIAL_KINDS, f.hasFactoryIn)) continue;
    const plainFilters = f.kinds?.length || f.city || f.area || f.factStatus?.length;
    const matched = plainFilters ? rows.filter(siteOk) : rows.filter((l) =>
      (f.hasOfficeIn && OFFICE_KINDS.includes(l.location_kind) && placeMatches(text.get(l.id)!, f.hasOfficeIn)) ||
      (f.hasFactoryIn && INDUSTRIAL_KINDS.includes(l.location_kind) && placeMatches(text.get(l.id)!, f.hasFactoryIn)) ||
      (!f.hasOfficeIn && !f.hasFactoryIn));
    if (!matched.length) continue;
    const o = orgBy.get(orgId)!;
    companies.push({ orgId, name: o.display_name, sector: o.sector ?? null, locations: matched });
  }
  companies.sort((a, b) => a.name.localeCompare(b.name));
  const withData = byOrg.size; const checked = orgs.length;
  const kindsWithData = new Set(locs.map((l) => l.location_kind));
  let note = `${checked} compan${checked === 1 ? "y" : "ies"} checked; ${withData} have at least one recorded location, ${checked - withData} have none (their sites are unknown, not absent).`;
  if (f.hasFactoryIn && !INDUSTRIAL_KINDS.some((k) => kindsWithData.has(k))) note += " No factory/plant/warehouse sites are recorded in this workspace at all — factory coverage is effectively zero.";
  const leaseOnly = [...byOrg.values()].filter((rows) => rows.every((l) => l.source === "lease")).length;
  if (leaseOnly) note += ` ${leaseOnly} of those know only lease-derived offices (no HQ/factory data).`;
  return { companies, coverage: { companiesChecked: checked, withLocationData: withData, withoutLocationData: checked - withData, note } };
}

/** Org ids with a location (optionally of given kinds) matching the place text. Used by find_leases_expiring. */
export async function orgIdsWithLocationIn(db: Db, ws: string, place: string, kinds?: LocationKind[]): Promise<{ matched: Set<string>; withAnyLocation: Set<string> }> {
  const locs = await allLocations(db, ws);
  const geo = await loadGeoIndex(db, ws);
  const matched = new Set<string>();
  for (const l of locs) if ((!kinds?.length || kinds.includes(l.location_kind)) && placeMatches(placeText(l, geo.path), place)) matched.add(l.org_id);
  return { matched, withAnyLocation: new Set(locs.map((l) => l.org_id)) };
}
