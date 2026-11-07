import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Client = SupabaseClient<any, any, any>;

/**
 * Linked records: child rows added from a parent's detail page (employment, contact methods, spaces, leases, ...).
 * A whitelist — only these tables/fields can be written from the UI. RLS still decides who may write.
 */
export type Host = "person" | "organisation" | "asset" | "lease" | "requirement" | "workspace";
export type FieldKind = "text" | "number" | "date" | "select" | "ref" | "textarea" | "checkbox";
export interface FieldSpec {
  name: string; label: string; kind: FieldKind; required?: boolean; options?: [string, string][];
  ref?: { table: string; label: string; filter?: "host_asset" | "geo_parent"; where?: Record<string, string> };
  hint?: string; min?: number;
}
export interface LinkedSpec { kind: string; table: string; title: string; host: Host; hostColumn: string | null; fields: FieldSpec[]; submit: string; fixed?: Record<string, unknown> }

const ORG = { table: "organisation", label: "display_name" };
const PERSON = { table: "person", label: "full_name" };
const ASSET = { table: "asset", label: "name" };
const GEO = { table: "geography", label: "name" };
const yesNo: [string, string][] = [["", "Unknown"], ["true", "Yes"], ["false", "No"]];

export const LINKED: Record<string, LinkedSpec> = {
  // ---- person page
  employment: { kind: "employment", table: "employment", title: "Add employment", host: "person", hostColumn: "person_id", submit: "Add role", fields: [
    { name: "org_id", label: "Company", kind: "ref", ref: ORG, required: true },
    { name: "title", label: "Designation", kind: "text" },
    { name: "start_date", label: "Start date", kind: "date" },
    { name: "end_date", label: "End date", kind: "date", hint: "Leave blank if still there." },
    { name: "is_current", label: "Current role?", kind: "select", options: [["true", "Current"], ["false", "Previous"]], required: true },
  ]},
  contact_method: { kind: "contact_method", table: "contact_method", title: "Add contact method", host: "person", hostColumn: "person_id", submit: "Add contact", fields: [
    { name: "method_type", label: "Type", kind: "select", required: true, options: [["email", "Email"], ["phone", "Phone"], ["whatsapp", "WhatsApp"], ["linkedin", "LinkedIn"], ["other", "Other"]] },
    { name: "value", label: "Email / number / URL", kind: "text", required: true, hint: "Only what the person shared. Never guess." },
    { name: "verified_on", label: "Verified on", kind: "date" },
    { name: "preferred", label: "Preferred", kind: "checkbox" },
  ]},
  relationship_context: { kind: "relationship_context", table: "relationship_context", title: "Add relationship context", host: "person", hostColumn: "person_id", submit: "Add context", fields: [
    { name: "org_id", label: "In the context of company", kind: "ref", ref: ORG },
    { name: "strength", label: "Strength", kind: "select", options: [["unknown", "Unknown"], ["cold", "Cold"], ["warm", "Warm"], ["strong", "Strong"], ["champion", "Champion"]] },
    { name: "context", label: "How we know them", kind: "textarea", required: true },
    { name: "last_verified_on", label: "Last verified", kind: "date" },
  ]},
  relationship_edge: { kind: "relationship_edge", table: "relationship_edge", title: "Connect to another person", host: "person", hostColumn: "from_person_id", submit: "Connect", fields: [
    { name: "to_person_id", label: "Person", kind: "ref", ref: PERSON, required: true },
    { name: "edge_type", label: "Relationship", kind: "select", required: true, options: [["worked_with", "Worked with"], ["colleague_relationship", "Colleague"], ["client_of", "Client of"], ["introduced_by", "Introduced by"], ["friend", "Friend"]] },
    { name: "warmth", label: "Warmth", kind: "select", options: [["", "Unknown"], ["cold", "Cold"], ["warm", "Warm"], ["hot", "Hot"], ["trusted", "Trusted"]] },
    { name: "valid_to", label: "Valid until", kind: "date" },
  ]},
  person_alias: { kind: "person_alias", table: "entity_alias", title: "Add alternative name", host: "person", hostColumn: "entity_id", submit: "Add name", fixed: { entity_type: "person" }, fields: [
    { name: "raw_alias", label: "Alternative name", kind: "text", required: true },
  ]},
  // ---- company page
  org_alias: { kind: "org_alias", table: "entity_alias", title: "Add alias", host: "organisation", hostColumn: "entity_id", submit: "Add alias", fixed: { entity_type: "organisation" }, fields: [
    { name: "raw_alias", label: "Alias / former name", kind: "text", required: true },
  ]},
  org_relation: { kind: "org_relation", table: "organisation_relation", title: "Link related company", host: "organisation", hostColumn: "from_org_id", submit: "Link", fields: [
    { name: "relation_type", label: "This company is…", kind: "select", required: true, options: [["parent_of", "Parent of"], ["subsidiary_of", "Subsidiary of"], ["affiliate", "Affiliate of"], ["owner_of", "Owner of"], ["developer_of", "Developer of"], ["operator_of", "Operator of"], ["acquired", "Acquirer of"]] },
    { name: "to_org_id", label: "Company", kind: "ref", ref: ORG, required: true },
    { name: "valid_from", label: "From", kind: "date" },
  ]},
  org_employment: { kind: "org_employment", table: "employment", title: "Add employee", host: "organisation", hostColumn: "org_id", submit: "Add employee", fields: [
    { name: "person_id", label: "Person", kind: "ref", ref: PERSON, required: true },
    { name: "title", label: "Designation", kind: "text" },
    { name: "start_date", label: "Start date", kind: "date" },
    { name: "is_current", label: "Current role?", kind: "select", options: [["true", "Current"], ["false", "Previous"]], required: true },
  ]},
  // ---- building page
  space: { kind: "space", table: "space", title: "Add floor / unit", host: "asset", hostColumn: "asset_id", submit: "Add space", fields: [
    { name: "floor_text", label: "Floor label", kind: "text", required: true, hint: "Kept as text: G, 5, Upper Ground, 5–7." },
    { name: "unit", label: "Unit", kind: "text" },
    { name: "carpet_sf", label: "Carpet area (sq ft)", kind: "number", min: 0 },
    { name: "chargeable_sf", label: "Chargeable area (sq ft)", kind: "number", min: 0 },
    { name: "seats", label: "Seats", kind: "number", min: 0 },
  ]},
  availability: { kind: "availability", table: "availability", title: "Record availability (dated snapshot)", host: "asset", hostColumn: null, submit: "Save snapshot", fields: [
    { name: "space_id", label: "Space", kind: "ref", required: true, ref: { table: "space", label: "floor_text", filter: "host_asset" } },
    { name: "as_of", label: "As of", kind: "date", required: true },
    { name: "status", label: "Status", kind: "select", required: true, options: [["unverified", "Unknown / unverified"], ["available", "Available (claimed)"], ["under_offer", "Under offer"], ["leased", "Unavailable (leased)"], ["withdrawn", "Withdrawn"]] },
    { name: "fact_status", label: "Evidence", kind: "select", required: true, options: [["reported", "Claimed / reported"], ["currently_confirmed", "Verified (confirmed now)"]] },
    { name: "available_from", label: "Available from", kind: "date" },
    { name: "valid_until", label: "Valid until", kind: "date" },
    { name: "asking_rent_min", label: "Asking rent min (₹/sq ft/month)", kind: "number", min: 0 },
    { name: "asking_rent_max", label: "Asking rent max", kind: "number", min: 0 },
    { name: "rent_basis", label: "Rent basis", kind: "select", options: [["", "Unknown"], ["carpet", "Carpet"], ["chargeable", "Chargeable"], ["seat", "Per seat"]] },
  ]},
  asset_spec: { kind: "asset_spec", table: "asset_spec", title: "Add specification", host: "asset", hostColumn: "asset_id", submit: "Add spec", fields: [
    { name: "spec_key", label: "Specification", kind: "select", required: true, options: [["parking_slots", "Parking slots"], ["parking_ratio", "Parking ratio"], ["power_backup", "Power backup"], ["power_load_kva", "Power load (kVA)"], ["hvac", "HVAC"], ["lifts_passenger", "Passenger lifts"], ["lifts_service", "Service lifts"], ["floor_plate_sf", "Floor plate (sq ft)"], ["efficiency_pct", "Efficiency %"], ["ceiling_height_m", "Ceiling height (m)"], ["fire_safety", "Fire safety"], ["other", "Other"]] },
    { name: "value_text", label: "Value as stated", kind: "text" },
    { name: "value_num", label: "Number (if any)", kind: "number" },
    { name: "unit", label: "Unit", kind: "text" },
    { name: "as_of", label: "As of", kind: "date" },
    { name: "verification", label: "Verification", kind: "select", options: [["reported", "Reported"], ["verified", "Verified"], ["disputed", "Disputed"]] },
  ]},
  asset_alias: { kind: "asset_alias", table: "entity_alias", title: "Add alternative name", host: "asset", hostColumn: "entity_id", submit: "Add name", fixed: { entity_type: "asset" }, fields: [
    { name: "raw_alias", label: "Alternative name", kind: "text", required: true },
  ]},
  lease: { kind: "lease", table: "lease", title: "Add lease", host: "asset", hostColumn: "asset_id", submit: "Add lease", fixed: { fact_status: "reported" }, fields: [
    { name: "tenant_org_id", label: "Tenant", kind: "ref", ref: ORG, required: true },
    { name: "landlord_org_id", label: "Landlord", kind: "ref", ref: ORG },
    { name: "start_date", label: "Commencement", kind: "date" },
    { name: "contractual_expiry", label: "Contractual expiry", kind: "date" },
    { name: "lockin_months_raw", label: "Lock-in (months)", kind: "number", min: 0 },
    { name: "area_sf", label: "Leased area (sq ft)", kind: "number", min: 0 },
    { name: "area_basis", label: "Area basis", kind: "select", options: [["", "Unknown"], ["carpet", "Carpet"], ["chargeable", "Chargeable"], ["super_built_up", "Super built-up"]] },
    { name: "rent_per_sf", label: "Rent (₹/sq ft/month)", kind: "number", min: 0 },
    { name: "status", label: "Status", kind: "select", options: [["unknown", "Unknown"], ["active", "Active"], ["expired", "Expired"], ["terminated", "Terminated"]] },
    { name: "registration_ref", label: "Registration no.", kind: "text" },
  ]},
  observation: { kind: "observation", table: "observation", title: "Add sourced value (observation)", host: "asset", hostColumn: "entity_id", submit: "Add observation", fixed: { entity_type: "asset" }, fields: [
    { name: "field", label: "Field", kind: "select", required: true, options: [["asking_rent", "Asking rent"], ["total_area_sf", "Total area"], ["grade", "Grade"], ["vacancy_sf", "Vacant area"], ["other", "Other"]] },
    { name: "value_raw", label: "Value exactly as in source", kind: "text", required: true },
    { name: "value_num", label: "Normalised number", kind: "number" },
    { name: "unit", label: "Unit", kind: "text" },
    { name: "source_location", label: "Where in the source", kind: "text", hint: "e.g. broker email 3 Nov, Sheet1!C12" },
    { name: "observed_on", label: "Observed on", kind: "date" },
    { name: "effective_on", label: "Effective on", kind: "date" },
    { name: "confidence", label: "Confidence (0–1)", kind: "number", min: 0 },
    { name: "verification", label: "Status", kind: "select", options: [["reported", "Reported"], ["currently_confirmed", "Confirmed now"], ["disputed", "Disputed"], ["ai_inference", "AI inference"]] },
  ]},
  // ---- lease (rendered under each lease on the building page)
  lease_event: { kind: "lease_event", table: "lease_event", title: "Add lease date", host: "lease", hostColumn: "lease_id", submit: "Add date", fields: [
    { name: "event_type", label: "Event", kind: "select", required: true, options: [["expiry", "Expiry"], ["lockin_end", "Lock-in end"], ["notice_deadline", "Notice deadline"], ["break", "Break option"], ["option", "Renewal window"], ["escalation", "Escalation"]] },
    { name: "event_date", label: "Date", kind: "date", required: true },
    { name: "date_basis", label: "Basis", kind: "select", required: true, options: [["contractual", "From the signed document"], ["reported", "Reported"], ["calculated_from_source_tenure", "Calculated"], ["estimated", "Estimated"]] },
    { name: "notice_days", label: "Notice (days)", kind: "number", min: 0 },
  ]},
  lease_space: { kind: "lease_space", table: "lease_space", title: "Link space to lease", host: "lease", hostColumn: "lease_id", submit: "Link space", fields: [
    { name: "space_id", label: "Space", kind: "ref", required: true, ref: { table: "space", label: "floor_text", filter: "host_asset" } },
    { name: "area_sf", label: "Area in this lease (sq ft)", kind: "number", min: 0 },
  ]},
  // ---- requirement page
  requirement_location: { kind: "requirement_location", table: "requirement_location", title: "Add location preference", host: "requirement", hostColumn: "requirement_id", submit: "Add location", fields: [
    { name: "geography_id", label: "Location", kind: "ref", ref: GEO, required: true },
    { name: "preference", label: "Preference", kind: "select", required: true, options: [["preferred", "Preferred"], ["acceptable", "Acceptable"], ["must", "Must (hard constraint)"], ["excluded", "Excluded"]] },
  ]},
  requirement_feature: { kind: "requirement_feature", table: "requirement_feature", title: "Add required feature", host: "requirement", hostColumn: "requirement_id", submit: "Add feature", fields: [
    { name: "feature_key", label: "Feature", kind: "select", required: true, options: [["parking_slots", "Parking slots"], ["power_backup", "Power backup"], ["grade", "Building grade"], ["floor_plate_sf", "Floor plate (sq ft)"], ["certification", "Certification"], ["other", "Other"]] },
    { name: "operator", label: "Rule", kind: "select", required: true, options: [["has", "Must have"], ["gte", "At least"], ["lte", "At most"], ["eq", "Equals"]] },
    { name: "value_text", label: "Value (text)", kind: "text" },
    { name: "value_num", label: "Value (number)", kind: "number" },
    { name: "unit", label: "Unit", kind: "text" },
    { name: "is_hard_constraint", label: "Hard constraint", kind: "checkbox" },
  ]},
  // ---- geography (Setup › Geography)
  geography: { kind: "geography", table: "geography", title: "Add place", host: "workspace", hostColumn: null, submit: "Add place", fields: [
    { name: "level", label: "Level", kind: "select", required: true, options: [["city", "City"], ["corridor", "Corridor"], ["micro_market", "Micro-market"], ["locality", "Locality"]] },
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "parent_id", label: "Inside (parent)", kind: "ref", ref: GEO, hint: "City → Corridor → Micro-market → Locality." },
    { name: "aliases", label: "Other names (comma separated)", kind: "text" },
    { name: "lat", label: "Latitude", kind: "number" },
    { name: "lon", label: "Longitude", kind: "number" },
  ]},
};

export const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{6,18}[0-9]$/;

export class LinkedError extends Error {}

/** Parse + validate a form for a spec. Blank stays null (never 0). Throws LinkedError with a plain-language message. */
export function parseLinked(spec: LinkedSpec, form: FormData): Record<string, unknown> {
  const row: Record<string, unknown> = { ...(spec.fixed ?? {}) };
  for (const f of spec.fields) {
    const raw = form.get(f.name);
    if (f.kind === "checkbox") { row[f.name] = raw === "on" || raw === "true"; continue; }
    const v = raw === null ? "" : norm(String(raw));
    if (!v) {
      if (f.required) throw new LinkedError(`${f.label} is required.`);
      row[f.name] = null; continue;
    }
    if (f.kind === "number") {
      const n = Number(v.replace(/,/g, ""));
      if (!Number.isFinite(n)) throw new LinkedError(`${f.label} must be a number (digits only).`);
      if (f.min !== undefined && n < f.min) throw new LinkedError(`${f.label} cannot be negative.`);
      row[f.name] = n;
    } else if (f.kind === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new LinkedError(`${f.label} is not a valid date.`);
      row[f.name] = v;
    } else if (f.kind === "select") {
      if (f.options && !f.options.some(([k]) => k === v)) throw new LinkedError(`${f.label}: choose one of the listed options.`);
      row[f.name] = v === "true" ? true : v === "false" ? false : v;
    } else if (f.kind === "ref") {
      if (!/^[0-9a-f-]{36}$/i.test(v)) throw new LinkedError(`${f.label}: pick a record from the list.`);
      row[f.name] = v;
    } else row[f.name] = v.slice(0, 2000);
  }
  // Cross-field rules
  const pairs: [string, string, string][] = [["start_date", "end_date", "End date"], ["start_date", "contractual_expiry", "Expiry"], ["available_from", "valid_until", "Valid until"], ["observed_on", "effective_on", ""]];
  for (const [a, b, label] of pairs) if (label && row[a] && row[b] && String(row[b]) < String(row[a])) throw new LinkedError(`${label} cannot be before ${a === "start_date" ? "the start date" : "available-from"}.`);
  if (row.asking_rent_min != null && row.asking_rent_max != null && Number(row.asking_rent_max) < Number(row.asking_rent_min)) throw new LinkedError("Asking rent max cannot be lower than min.");
  if (row.confidence != null && (Number(row.confidence) < 0 || Number(row.confidence) > 1)) throw new LinkedError("Confidence must be between 0 and 1.");
  if (row.lat != null && Math.abs(Number(row.lat)) > 90) throw new LinkedError("Latitude must be between -90 and 90.");
  if (row.lon != null && Math.abs(Number(row.lon)) > 180) throw new LinkedError("Longitude must be between -180 and 180.");
  if (spec.table === "contact_method") {
    const t = row.method_type, v = String(row.value);
    if (t === "email" && !EMAIL.test(v)) throw new LinkedError("That email address is not valid (example: name@company.com).");
    if ((t === "phone" || t === "whatsapp") && !PHONE.test(v)) throw new LinkedError("That phone number is not valid. Use digits, optionally starting with +91.");
    if (t === "email") row.value = v.toLowerCase();
  }
  if (spec.table === "employment" && row.end_date && row.is_current === true) throw new LinkedError("A role with an end date cannot be current. Choose 'Previous'.");
  if (spec.table === "entity_alias") row.canonical_alias = String(row.raw_alias).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, " ").trim();
  if (spec.table === "geography") row.aliases = row.aliases ? String(row.aliases).split(",").map((s) => norm(s)).filter(Boolean) : [];
  if (spec.table === "asset_spec" && row.value_text == null && row.value_num == null) throw new LinkedError("Enter the value as stated or a number.");
  if (spec.table === "requirement_feature" && row.value_text == null && row.value_num == null) throw new LinkedError("Enter a value (text or number).");
  return row;
}

/** Insert a linked row. Host ownership + workspace are checked; RLS and DB triggers re-check. Returns warnings (non-blocking). */
export async function addLinked(db: Client, ws: string, userId: string, kind: string, hostId: string | null, form: FormData) {
  const spec = LINKED[kind];
  if (!spec) throw new LinkedError("Unknown record type.");
  const row = parseLinked(spec, form);
  const warnings: string[] = [];
  if (spec.host !== "workspace") {
    if (!hostId || !/^[0-9a-f-]{36}$/i.test(hostId)) throw new LinkedError("Missing parent record.");
    const { data: host } = await db.from(spec.host).select("id, workspace_id").eq("id", hostId).eq("workspace_id", ws).maybeSingle();
    if (!host) throw new LinkedError("The parent record was not found in this workspace.");
    if (spec.hostColumn) row[spec.hostColumn] = hostId;
  }
  // Space must belong to the building we're on.
  if (row.space_id && spec.host === "asset") {
    const { data: sp } = await db.from("space").select("asset_id").eq("id", row.space_id as string).maybeSingle();
    if (!sp || sp.asset_id !== hostId) throw new LinkedError("That space belongs to another building.");
  }
  if (spec.table === "space") {
    // Same floor + unit in the same building = the same known space (DB-144). Floor without unit is allowed once.
    let q = db.from("space").select("id").eq("workspace_id", ws).eq("asset_id", hostId!).is("archived_at", null).ilike("floor_text", String(row.floor_text));
    q = row.unit ? q.ilike("unit", String(row.unit)) : q.is("unit", null);
    const { data: dup } = await q.limit(1);
    if (dup?.length) throw new LinkedError(`Floor ${row.floor_text}${row.unit ? `, unit ${row.unit}` : ""} already exists in this building. Edit that space instead of adding it twice.`);
  }
  if (spec.table === "organisation_relation" && row.to_org_id === hostId) throw new LinkedError("A company cannot be linked to itself.");
  if (spec.table === "relationship_edge" && row.to_person_id === hostId) throw new LinkedError("A person cannot be connected to themselves.");
  if (spec.table === "geography" && row.parent_id) {
    // walk up to stop cycles (new row has no id yet, so only depth guard + parent level order)
    const order = ["city", "corridor", "micro_market", "locality"];
    const { data: p } = await db.from("geography").select("level").eq("id", row.parent_id as string).maybeSingle();
    if (!p) throw new LinkedError("Parent place not found.");
    if (order.indexOf(p.level) >= order.indexOf(String(row.level))) throw new LinkedError(`A ${String(row.level).replace("_", "-")} must sit inside a higher level (city → corridor → micro-market → locality).`);
  }
  if (spec.table === "contact_method") {
    const hash = createHash("sha256").update(String(row.value).toLowerCase().trim()).digest("hex");
    const { data: same } = await db.from("contact_method").select("person_id").eq("workspace_id", ws).eq("value_hash", hash).neq("person_id", hostId!).limit(3);
    if (same?.length) warnings.push(`This ${row.method_type} is already recorded for ${same.length} other person(s). Saved anyway — shared inboxes and reused numbers happen. Nothing was merged.`);
  }
  if (spec.table === "employment" && row.is_current === true) {
    const { data: cur } = await db.from("employment").select("id").eq("workspace_id", ws).eq("person_id", (row.person_id ?? hostId) as string).eq("is_current", true).is("archived_at", null);
    if (cur?.length) warnings.push("This person already has a current role. Both are kept; end the old one with 'End role' if they moved.");
  }
  if (spec.table === "observation") {
    row.obs_key = createHash("sha256").update(`${hostId}|${row.field}|${row.source_location ?? ""}|${row.value_raw}|${row.observed_on ?? ""}`).digest("hex");
    const { data: other } = await db.from("observation").select("value_raw").eq("workspace_id", ws).eq("entity_id", hostId!).eq("field", row.field as string).neq("value_raw", row.value_raw as string).is("archived_at", null).limit(5);
    if (other?.length) warnings.push(`Conflicts with ${other.length} other observation(s) for this field (e.g. "${other[0].value_raw}"). Both are kept; pick the canonical value with 'Propose as current value'.`);
  }
  if (spec.table === "lease_space") {
    const { data: lease } = await db.from("lease").select("area_sf").eq("id", hostId!).maybeSingle();
    const { data: links } = await db.from("lease_space").select("area_sf").eq("lease_id", hostId!).is("archived_at", null);
    const total = (links ?? []).reduce((s, l) => s + Number(l.area_sf ?? 0), 0) + Number(row.area_sf ?? 0);
    if (lease?.area_sf != null && total > 0 && Math.abs(total - Number(lease.area_sf)) > 1) warnings.push(`Linked spaces now total ${total.toLocaleString("en-IN")} sq ft; the lease says ${Number(lease.area_sf).toLocaleString("en-IN")} sq ft.`);
  }
  const insert = { workspace_id: ws, owner_user_id: userId, ...row };
  const q = spec.table === "observation"
    ? db.from("observation").upsert(insert, { onConflict: "workspace_id,obs_key", ignoreDuplicates: true }).select("id")
    : db.from(spec.table).insert(insert).select("id");
  const { data, error } = await q;
  if (error) throw error;
  if (spec.table === "observation" && !data?.length) warnings.push("Identical observation already recorded — nothing duplicated.");
  return { id: data?.[0]?.id as string | undefined, warnings };
}

/** Options for ref fields (bounded; archived rows excluded). */
export async function refOptions(db: Client, ws: string, spec: LinkedSpec, hostId: string | null) {
  const out: Record<string, { id: string; label: string }[]> = {};
  await Promise.all(spec.fields.filter((f) => f.kind === "ref").map(async (f) => {
    let q = db.from(f.ref!.table).select(f.ref!.table === "space" ? "id, floor_text, unit" : f.ref!.table === "geography" ? `id, name, level` : `id, ${f.ref!.label}`)
      .eq("workspace_id", ws).is("archived_at", null).order(f.ref!.label).limit(500);
    if (f.ref!.filter === "host_asset" && hostId) {
      if (spec.host === "lease") {
        const { data: l } = await db.from("lease").select("asset_id").eq("id", hostId).maybeSingle();
        q = q.eq("asset_id", l?.asset_id ?? "00000000-0000-0000-0000-000000000000");
      } else q = q.eq("asset_id", hostId);
    }
    if (spec.host === "organisation" && f.ref!.table === "organisation" && hostId) q = q.neq("id", hostId);
    if (spec.host === "person" && f.ref!.table === "person" && hostId) q = q.neq("id", hostId);
    const { data } = await q;
    out[f.name] = (data ?? []).map((r: any) => ({ id: r.id,
      label: f.ref!.table === "space" ? `Floor ${r.floor_text}${r.unit ? ` · ${r.unit}` : ""}` : f.ref!.table === "geography" ? `${r.name} (${String(r.level).replace("_", "-")})` : r[f.ref!.label] }));
  }));
  return out;
}
