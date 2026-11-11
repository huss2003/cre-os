/**
 * Human-readable rendering of change proposals: plain field labels, *_id / *_ids resolved to names
 * (batched, RLS client + explicit workspace filter), JSON objects as key: value lists, dates formatted.
 * Unknown / unreadable ids render as "Unknown record" — never the raw id.
 */
import { format, parseISO, isValid } from "date-fns";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const UNKNOWN_RECORD = "Unknown record";
export const UNKNOWN = "Unknown";

const FIELD_LABELS: Record<string, string> = {
  org_id: "Company", tenant_org_id: "Tenant company", landlord_org_id: "Landlord", owner_org_id: "Owner company",
  developer_org_id: "Developer", operator_org_id: "Operator", person_id: "Person", confirmed_by_person_id: "Confirmed by",
  asset_id: "Building", parent_asset_id: "Campus", space_id: "Space", lease_id: "Lease", requirement_id: "Requirement",
  opportunity_id: "Deal", geography_id: "Location", preferred_geography_ids: "Preferred locations", excluded_geography_ids: "Excluded locations",
  area_min_sf: "Min area (sf)", area_max_sf: "Max area (sf)", area_target_sf: "Target area (sf)", area_sf: "Area (sf)", area_basis: "Area basis",
  seats_min: "Min seats", seats_max: "Max seats", seats_target: "Target seats", budget_min: "Min budget", budget_max: "Max budget", budget_basis: "Budget basis",
  transaction_kinds: "Transaction types", objective: "Objective", status: "Status", title: "Title", constraints: "Constraints",
  occupation_date: "Move-in date", decision_date: "Decision date", mandate_status: "Mandate status", display_name: "Name", full_name: "Full name",
  name: "Name", next_action: "Next action", next_action_due: "Next action due", field_status: "Field status", notes: "Notes",
  lease_start: "Lease start", lease_end: "Lease end", expiry_date: "Expiry date", rent_per_sf: "Rent per sf",
};

const TABLE_BY_FIELD: [RegExp, string][] = [
  [/(^|_)org_ids?$/, "organisation"], [/(^|_)person_ids?$/, "person"], [/(^|_)asset_ids?$/, "asset"], [/(^|_)geography_ids?$/, "geography"],
  [/(^|_)requirement_ids?$/, "requirement"], [/(^|_)opportunity_ids?$/, "opportunity"], [/(^|_)lease_ids?$/, "lease"], [/(^|_)space_ids?$/, "space"],
];

export const isRefField = (f: string) => /_ids?$/.test(f) || f === "id";
export const refTable = (f: string) => TABLE_BY_FIELD.find(([re]) => re.test(f))?.[1] ?? null;

const humanise = (k: string) => { const s = k.replace(/_ids?$/, "").replace(/_/g, " ").replace(/\bsf\b/, "(sf)").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
export function fieldLabel(path: string): string {
  const f = path.replace(/^\//, "").split("/")[0];
  return FIELD_LABELS[f] ?? humanise(f);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function fmtScalar(v: unknown): string {
  if (v === null || v === undefined || v === "") return UNKNOWN;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString("en-IN");
  if (typeof v === "string") {
    if (ISO_DATE.test(v)) { const d = parseISO(v); if (isValid(d)) return format(d, "d MMM yyyy"); }
    if (ISO_TS.test(v)) { const d = parseISO(v); if (isValid(d)) return format(d, "d MMM yyyy, HH:mm"); }
    return v;
  }
  return String(v);
}

/** Format one value for display. `refs` maps id -> label (from resolveRefs). */
export function formatValue(field: string, v: unknown, refs: Record<string, string> = {}): string {
  const f = field.replace(/^\//, "");
  if (v === null || v === undefined || v === "") return UNKNOWN;
  if (isRefField(f)) {
    const one = (x: unknown) => (typeof x === "string" ? refs[x] ?? UNKNOWN_RECORD : fmtScalar(x));
    if (Array.isArray(v)) return v.length ? v.map(one).join(", ") : UNKNOWN;
    return one(v);
  }
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === "object" ? formatValue("", x, refs) : fmtScalar(x))).join(", ") : UNKNOWN;
  if (typeof v === "object") {
    const parts = Object.entries(v as AnyRow).map(([k, x]) => `${fieldLabel(k)}: ${x && typeof x === "object" && !Array.isArray(x) ? `(${formatValue(k, x, refs)})` : formatValue(k, x, refs)}`);
    return parts.length ? parts.join("; ") : UNKNOWN;
  }
  return fmtScalar(v);
}

/** Collect {table -> ids} referenced by id fields in a value (recurses into objects). */
export function collectRefs(field: string, v: unknown, out: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
  const f = field.replace(/^\//, "");
  if (v && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v as AnyRow)) collectRefs(k, x, out); return out; }
  const t = refTable(f);
  if (!t) return out;
  for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)) out.set(t, (out.get(t) ?? new Set()).add(x));
  return out;
}

/** Batched id -> name lookup through the caller's (RLS) client, filtered to the workspace. Missing ids are simply absent. */
export async function resolveRefs(db: Db, workspaceId: string, wanted: Map<string, Set<string>>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const q = (t: string, cols: string, ids: string[]) => db.from(t).select(cols).eq("workspace_id", workspaceId).in("id", ids).is("archived_at", null);
  const put = (rows: AnyRow[] | null, fn: (r: AnyRow) => string | null | undefined) => { for (const r of rows ?? []) { const l = fn(r); if (l) out[r.id] = l; } };
  const leaseOrgs: AnyRow[] = [], spaceRows: AnyRow[] = [];
  await Promise.all([...wanted].map(async ([t, set]) => {
    const ids = [...set]; if (!ids.length) return;
    if (t === "organisation") put((await q(t, "id, display_name", ids)).data, (r) => r.display_name);
    else if (t === "person") put((await q(t, "id, full_name", ids)).data, (r) => r.full_name);
    else if (t === "asset" || t === "geography") put((await q(t, "id, name", ids)).data, (r) => r.name);
    else if (t === "requirement") put((await q(t, "id, title", ids)).data, (r) => r.title);
    else if (t === "opportunity") put((await q(t, "id, name", ids)).data, (r) => r.name);
    else if (t === "lease") leaseOrgs.push(...((await q(t, "id, tenant_org_id, tenant_name_raw, asset_id", ids)).data ?? []));
    else if (t === "space") spaceRows.push(...((await q(t, "id, asset_id, floor_text, unit", ids)).data ?? []));
  }));
  if (leaseOrgs.length || spaceRows.length) {
    const orgIds = [...new Set(leaseOrgs.map((l) => l.tenant_org_id).filter(Boolean))] as string[];
    const assetIds = [...new Set([...leaseOrgs, ...spaceRows].map((l) => l.asset_id).filter(Boolean))] as string[];
    const [o, a] = await Promise.all([
      orgIds.length ? q("organisation", "id, display_name", orgIds) : { data: [] },
      assetIds.length ? q("asset", "id, name", assetIds) : { data: [] },
    ]);
    const on = new Map(((o.data ?? []) as AnyRow[]).map((r) => [r.id, r.display_name]));
    const an = new Map(((a.data ?? []) as AnyRow[]).map((r) => [r.id, r.name]));
    for (const l of leaseOrgs) out[l.id] = `${on.get(l.tenant_org_id) ?? l.tenant_name_raw ?? "Unknown tenant"} at ${an.get(l.asset_id) ?? "unknown building"}`;
    for (const s of spaceRows) out[s.id] = [an.get(s.asset_id) ?? "Unknown building", s.floor_text ? `floor ${s.floor_text}` : null, s.unit ? `unit ${s.unit}` : null].filter(Boolean).join(", ");
  }
  return out;
}

/** Resolve every id referenced by a set of proposals (patch values + before snapshots + current). */
export async function proposalRefs(db: Db, workspaceId: string, ps: { patch?: { path: string; value?: unknown }[] | null; current?: AnyRow | null; before?: AnyRow | null }[]) {
  const wanted = new Map<string, Set<string>>();
  for (const p of ps) {
    for (const op of p.patch ?? []) collectRefs(op.path, op.value, wanted);
    for (const [k, v] of Object.entries({ ...(p.before?.fields ?? {}), ...(p.current ?? {}) })) collectRefs(k, v, wanted);
  }
  return resolveRefs(db, workspaceId, wanted);
}
