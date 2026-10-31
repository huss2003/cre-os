/**
 * Requirement contract (spec Part I §8 "Workflow contracts → Requirement").
 * Pure, deterministic: field catalogue, status model and missing-question generation.
 *
 * Storage: domain columns on `requirement` hold the typed values that have columns (area, seats, budget,
 * dates, geographies, mandate/conflict). Everything else lives in `requirement.constraints.values`.
 * Per-field confirmation lives in `requirement.constraints.field_status` — "client_confirmed" ≠ "estimated".
 */
export type FieldStatus = "client_confirmed" | "reported" | "estimated" | "unknown";
/** Status ladder (workflow 08): only client_confirmed is a confirmed client instruction. "reported" = stated by a
 *  third party / second-hand (e.g. a colleague, a landlord, an email forward); "estimated" = our estimate. */
export const FIELD_STATUSES: FieldStatus[] = ["client_confirmed", "reported", "estimated", "unknown"];
export const FIELD_STATUS_LABEL: Record<FieldStatus, string> = {
  client_confirmed: "client-confirmed", reported: "reported", estimated: "estimated", unknown: "unknown",
};

export type FieldKind = "text" | "number" | "date" | "enum" | "list" | "boolean" | "geo_list" | "range";

export interface FieldDef {
  key: string;
  label: string;
  group: "purpose" | "timing" | "size" | "budget" | "location" | "technical" | "terms" | "authority" | "status";
  kind: FieldKind;
  /** Column(s) on requirement; absent => stored in constraints.values[key]. */
  columns?: string[];
  /** Mandatory before a shortlist can be called "confirmed". */
  mandatory: boolean;
  question: string;
  options?: string[];
}

export const REQUIREMENT_FIELDS: FieldDef[] = [
  { key: "objective", label: "Purpose", group: "purpose", kind: "enum", columns: ["objective"], mandatory: true,
    options: ["new", "relocation", "expansion", "consolidation", "renewal", "flex", "other"],
    question: "What is the purpose of this requirement — new site, relocation, expansion, consolidation, renewal or flex?" },
  { key: "transaction_kinds", label: "Transaction types considered", group: "purpose", kind: "list", columns: ["transaction_kinds"], mandatory: false,
    question: "Which options are in scope: conventional lease, managed office, coworking, build-to-suit?" },
  { key: "decision_date", label: "Decision date", group: "timing", kind: "date", columns: ["decision_date"], mandatory: true,
    question: "By when must the decision be made (board/committee date)?" },
  { key: "occupation_date", label: "Occupation date", group: "timing", kind: "date", columns: ["occupation_date"], mandatory: true,
    question: "What is the required occupation (go-live) date?" },
  { key: "area", label: "Area min/target/max", group: "size", kind: "range", columns: ["area_min_sf", "area_target_sf", "area_max_sf"], mandatory: true,
    question: "What area range is acceptable (minimum, target, maximum)?" },
  { key: "area_basis", label: "Area measurement basis", group: "size", kind: "enum", columns: ["area_basis"], mandatory: true,
    options: ["carpet", "chargeable"], question: "Is the area on carpet or chargeable (super built-up) basis?" },
  { key: "seats", label: "Seats min/target/max", group: "size", kind: "range", columns: ["seats_min", "seats_target", "seats_max"], mandatory: false,
    question: "How many seats are needed now (minimum/target/maximum)?" },
  { key: "growth_assumption", label: "Growth assumption", group: "size", kind: "text", mandatory: false,
    question: "What headcount growth should we plan for over the term?" },
  { key: "attendance_assumption", label: "Attendance / utilisation", group: "size", kind: "text", mandatory: false,
    question: "What attendance or hybrid-working ratio applies (seats vs headcount)?" },
  { key: "budget", label: "Budget min/max", group: "budget", kind: "range", columns: ["budget_min", "budget_max"], mandatory: true,
    question: "What budget range is approved?" },
  { key: "budget_basis", label: "Budget basis", group: "budget", kind: "enum", columns: ["budget_basis"], mandatory: true,
    options: ["per_sf_month", "total_month", "per_seat_month"], question: "Is the budget per SF per month, per seat per month, or a total monthly amount?" },
  { key: "budget_inclusions", label: "Budget inclusions", group: "budget", kind: "text", mandatory: true,
    question: "Does the budget include CAM, parking, GST, fit-out amortisation?" },
  { key: "preferred_locations", label: "Preferred locations", group: "location", kind: "geo_list", columns: ["preferred_geography_ids"], mandatory: true,
    question: "Which micro-markets or localities are preferred?" },
  { key: "forbidden_locations", label: "Excluded locations", group: "location", kind: "geo_list", columns: ["excluded_geography_ids"], mandatory: false,
    question: "Are any locations ruled out?" },
  { key: "employee_catchments", label: "Employee catchments", group: "location", kind: "list", mandatory: false,
    question: "Where do most employees live / commute from (catchment points)?" },
  { key: "parking", label: "Parking (cars / two-wheelers)", group: "technical", kind: "text", mandatory: false,
    question: "How many car and two-wheeler parking slots are needed?" },
  { key: "transit", label: "Transit access", group: "technical", kind: "text", mandatory: false,
    question: "Is metro / public-transit proximity required (max distance)?" },
  { key: "power", label: "Power & redundancy", group: "technical", kind: "text", mandatory: false,
    question: "What power load and backup (DG/UPS) redundancy is required?" },
  { key: "working_hours", label: "Working hours", group: "technical", kind: "text", mandatory: false,
    question: "What are working hours — 24×7 operations, shifts, HVAC overtime?" },
  { key: "security_access", label: "Security / access", group: "technical", kind: "text", mandatory: false,
    question: "Any security, access-control or client-audit requirements?" },
  { key: "it_load", label: "Technical / IT load", group: "technical", kind: "text", mandatory: false,
    question: "Any server room, IT load or connectivity requirements?" },
  { key: "certifications", label: "Certifications required", group: "technical", kind: "list", mandatory: false,
    question: "Are building certifications required (e.g. green-building rating)?" },
  { key: "fitout_standard", label: "Fit-out standard", group: "technical", kind: "enum", mandatory: true,
    options: ["bare", "warm_shell", "fitted", "managed"], question: "Bare shell, warm shell, fully fitted or managed?" },
  { key: "expansion", label: "Expansion / contraction", group: "terms", kind: "text", mandatory: false,
    question: "Are expansion or contraction rights needed during the term?" },
  { key: "tenure_months", label: "Tenure (months)", group: "terms", kind: "number", mandatory: true,
    question: "What lease tenure is expected (months)?" },
  { key: "lockin_months", label: "Lock-in (months)", group: "terms", kind: "number", mandatory: false,
    question: "What lock-in period is acceptable (months)?" },
  { key: "capex_financing", label: "Capex financing", group: "terms", kind: "text", mandatory: false,
    question: "Will fit-out capex be funded internally, by the landlord or through financing?" },
  { key: "legal_entity", label: "Contracting legal entity", group: "authority", kind: "text", mandatory: true,
    question: "Which legal entity will sign the lease?" },
  { key: "commercial_authority", label: "Commercial authority", group: "authority", kind: "text", mandatory: true,
    question: "Who has commercial authority to approve the deal?" },
  { key: "procurement_process", label: "Procurement process", group: "authority", kind: "text", mandatory: true,
    question: "What is the procurement process (RFP, vendor onboarding, board approval) and lead time?" },
  { key: "current_lease_notice", label: "Current lease notice / break", group: "timing", kind: "text", mandatory: true,
    question: "When is the notice deadline or break on the current lease?" },
  { key: "mandate_status", label: "Mandate status", group: "status", kind: "enum", columns: ["mandate_status"], mandatory: true,
    options: ["none", "non_exclusive", "exclusive", "support", "unknown"], question: "Do we have a mandate (exclusive / non-exclusive / support)?" },
  { key: "conflict_status", label: "Conflict check", group: "status", kind: "enum", columns: ["conflict_status"], mandatory: true,
    options: ["not_checked", "clear", "conflict_flagged", "cleared_with_approval"],
    question: "Has the corporate account / competing-mandate / landlord conflict check been done?" },
];

export const FIELD_BY_KEY = new Map(REQUIREMENT_FIELDS.map((f) => [f.key, f]));

export interface RequirementRow {
  id?: string;
  title?: string;
  objective?: string | null;
  transaction_kinds?: string[] | null;
  area_min_sf?: number | string | null;
  area_target_sf?: number | string | null;
  area_max_sf?: number | string | null;
  area_basis?: string | null;
  seats_min?: number | null;
  seats_target?: number | null;
  seats_max?: number | null;
  budget_min?: number | string | null;
  budget_max?: number | string | null;
  budget_basis?: string | null;
  preferred_geography_ids?: string[] | null;
  excluded_geography_ids?: string[] | null;
  decision_date?: string | null;
  occupation_date?: string | null;
  constraints?: RequirementConstraints | null;
  status?: string | null;
  mandate_status?: string | null;
  conflict_status?: string | null;
  row_version?: number;
}

export interface RequiredSpecs {
  min_power_kva?: number | null;
  min_car_parks?: number | null;
  min_two_wheeler_parks?: number | null;
  max_metro_km?: number | null;
  certifications?: string[];        // any-of required certification names (case-insensitive contains)
  fitout_basis?: string[];          // acceptable configurations
  operating_24x7?: boolean | null;
}

/** Optional hard filters (default off = the criterion is scored, not filtered). */
export interface HardFilters {
  /** All-in cost above budget max → ineligible (unknown cost → needs verification). */
  budget_ceiling?: boolean;
  /** Available-from later than the occupation date → ineligible (unknown date → needs verification). */
  latest_occupation?: boolean;
  /** Outside the preferred locations → ineligible (unknown geography → needs verification). */
  preferred_only?: boolean;
}

export type SpecKey = keyof RequiredSpecs;

export interface RequirementConstraints {
  values?: Record<string, unknown>;
  field_status?: Record<string, FieldStatus>;
  /** Per-requirement match weight overrides (percent points), e.g. {location: 30, cost: 20}. */
  weights?: Partial<Record<"location" | "cost" | "readiness" | "technical" | "flexibility" | "sustainability", number>>;
  /** Hard technical constraints used by matching (missing building data => needs verification). */
  required_specs?: RequiredSpecs;
  /** Catchment points for location scoring. */
  catchments?: { label: string; lat: number; lon: number; weight?: number }[];
  /** Explicit "not applicable" answers — question suppressed without inventing a value. */
  not_applicable?: string[];
  /** Optional hard filters (budget ceiling, latest occupation date, preferred-location-only). */
  hard_filters?: HardFilters;
  /** Where each required_specs key came from: "manual" (set in matching config) or "derived:<field>". */
  spec_sources?: Partial<Record<SpecKey, string>>;
}

// ==================================================================== free text → structured specs (deterministic)
const numRe = String.raw`(\d+(?:[.,]\d+)?)`;
const toNum = (x: string) => Number(x.replace(/,/g, ""));

/** Which free-text contract field feeds which structured spec keys. */
export const SPEC_DERIVATION: Record<string, SpecKey[]> = {
  power: ["min_power_kva"],
  parking: ["min_car_parks", "min_two_wheeler_parks"],
  transit: ["max_metro_km"],
  working_hours: ["operating_24x7"],
  certifications: ["certifications"],
  fitout_standard: ["fitout_basis"],
};

export interface DerivedSpecs { specs: Partial<RequiredSpecs>; unparsed: string[] }

/**
 * Parse the free-text technical answers into structured matching specs. Pure and conservative: anything it cannot
 * read with certainty is left unset and reported in `unparsed` (never guessed; kW is not converted to kVA).
 */
export function deriveSpecs(field: string, value: unknown): DerivedSpecs {
  const out: DerivedSpecs = { specs: {}, unparsed: [] };
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return out;
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  const t = text.toLowerCase();
  switch (field) {
    case "power": {
      const m = t.match(new RegExp(`${numRe}\\s*(mva|kva)\\b`));
      if (m) out.specs.min_power_kva = toNum(m[1]) * (m[2] === "mva" ? 1000 : 1);
      else out.unparsed.push(`power: "${text}" has no kVA/MVA figure`);
      break;
    }
    case "parking": {
      const car = t.match(new RegExp(`${numRe}\\s*(?:car|cars|car parks?|4[- ]?wheelers?|four[- ]?wheelers?|4w)\\b`)) ?? t.match(new RegExp(`(?:cars?|4[- ]?wheelers?)\\s*[:=-]?\\s*${numRe}`));
      const two = t.match(new RegExp(`${numRe}\\s*(?:two[- ]?wheelers?|2[- ]?wheelers?|bikes?|2w)\\b`)) ?? t.match(new RegExp(`(?:two[- ]?wheelers?|2[- ]?wheelers?|bikes?)\\s*[:=-]?\\s*${numRe}`));
      if (car) out.specs.min_car_parks = toNum(car[1]);
      if (two) out.specs.min_two_wheeler_parks = toNum(two[1]);
      if (!car && !two) out.unparsed.push(`parking: "${text}" has no car / two-wheeler count`);
      break;
    }
    case "transit": {
      const m = t.match(new RegExp(`${numRe}\\s*(km|kms|kilomet(?:er|re)s?|m|meters?|metres?)\\b[^.;]*metro`)) ?? t.match(new RegExp(`metro[^.;]*?${numRe}\\s*(km|kms|kilomet(?:er|re)s?|m|meters?|metres?)\\b`));
      if (m) out.specs.max_metro_km = /^k/.test(m[2]) ? toNum(m[1]) : toNum(m[1]) / 1000;
      else out.unparsed.push(`transit: "${text}" has no distance to metro`);
      break;
    }
    case "working_hours": {
      if (/24\s*[x×*/]\s*7|round[- ]the[- ]clock|24\s*hours/.test(t)) out.specs.operating_24x7 = true;
      break; // other working-hour answers simply do not impose a 24×7 constraint
    }
    case "certifications": {
      const list = (Array.isArray(value) ? value.map(String) : text.split(",")).map((x) => x.trim()).filter(Boolean);
      if (list.length) out.specs.certifications = list;
      break;
    }
    case "fitout_standard": {
      if (["bare", "warm_shell", "fitted", "managed"].includes(t.trim())) out.specs.fitout_basis = [t.trim()];
      break;
    }
  }
  return out;
}

/**
 * Re-derive structured specs from changed free-text fields into `constraints.required_specs`. Keys set manually in the
 * matching configuration (spec_sources[key] === "manual") are never overwritten. A cleared/unparseable answer removes
 * the derived spec it previously produced (unknown stays unknown). Pure; returns parse notes.
 */
export function applyDerivedSpecs(constraints: RequirementConstraints, changedFields: string[]): string[] {
  const notes: string[] = [];
  for (const field of changedFields) {
    const keys = SPEC_DERIVATION[field];
    if (!keys) continue;
    const d = deriveSpecs(field, constraints.values?.[field]);
    notes.push(...d.unparsed);
    constraints.required_specs = constraints.required_specs ?? {};
    constraints.spec_sources = constraints.spec_sources ?? {};
    for (const k of keys) {
      if (constraints.spec_sources[k] === "manual") continue;
      const v = d.specs[k];
      if (v === undefined) {
        if (constraints.spec_sources[k] === `derived:${field}`) { delete constraints.required_specs[k]; delete constraints.spec_sources[k]; }
      } else {
        (constraints.required_specs as Record<string, unknown>)[k] = v;
        constraints.spec_sources[k] = `derived:${field}`;
      }
    }
  }
  return notes;
}

export interface HardConstraint { key: string; label: string; value: string; source: string; status: FieldStatus | "config" }

/** Hard constraints as displayed on the requirement (pure). Only constraints that are actually set are listed. */
export function hardConstraints(req: RequirementRow, geoName: (id: string) => string = (x) => x): HardConstraint[] {
  const out: HardConstraint[] = [];
  const st = (k: string) => fieldStatus(req, k);
  const numv = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const amin = numv(req.area_min_sf), amax = numv(req.area_max_sf), atgt = numv(req.area_target_sf);
  if (amin !== null || amax !== null || atgt !== null)
    out.push({ key: "area", label: "Area range", value: `${amin ?? (atgt !== null ? `~${Math.round(atgt * 0.85)}` : "–")} – ${amax ?? (atgt !== null ? `~${Math.round(atgt * 1.15)}` : "–")} SF ${req.area_basis ?? "(basis unknown)"}`, source: "requirement", status: st("area") });
  if (req.seats_min) out.push({ key: "seats", label: "Minimum seats", value: String(req.seats_min), source: "requirement", status: st("seats") });
  if ((req.excluded_geography_ids ?? []).length)
    out.push({ key: "forbidden_locations", label: "Excluded locations", value: (req.excluded_geography_ids ?? []).map(geoName).join(", "), source: "requirement", status: st("forbidden_locations") });
  const rs = req.constraints?.required_specs ?? {};
  const src = req.constraints?.spec_sources ?? {};
  const srcLabel = (k: SpecKey) => { const s = src[k]; return !s ? "matching config" : s === "manual" ? "matching config" : `derived from “${FIELD_BY_KEY.get(s.slice(8))?.label ?? s.slice(8)}”`; };
  const stOf = (k: SpecKey): HardConstraint["status"] => { const s = src[k]; return s && s.startsWith("derived:") ? st(s.slice(8)) : "config"; };
  if (rs.min_power_kva != null) out.push({ key: "min_power_kva", label: "Power", value: `≥ ${rs.min_power_kva} kVA`, source: srcLabel("min_power_kva"), status: stOf("min_power_kva") });
  if (rs.min_car_parks != null) out.push({ key: "min_car_parks", label: "Car parks", value: `≥ ${rs.min_car_parks}`, source: srcLabel("min_car_parks"), status: stOf("min_car_parks") });
  if (rs.min_two_wheeler_parks != null) out.push({ key: "min_two_wheeler_parks", label: "Two-wheeler parks", value: `≥ ${rs.min_two_wheeler_parks}`, source: srcLabel("min_two_wheeler_parks"), status: stOf("min_two_wheeler_parks") });
  if (rs.max_metro_km != null) out.push({ key: "max_metro_km", label: "Metro distance", value: `≤ ${rs.max_metro_km} km`, source: srcLabel("max_metro_km"), status: stOf("max_metro_km") });
  if (rs.operating_24x7) out.push({ key: "operating_24x7", label: "24×7 operations", value: "required", source: srcLabel("operating_24x7"), status: stOf("operating_24x7") });
  if (rs.certifications?.length) out.push({ key: "certifications", label: "Certification (any of)", value: rs.certifications.join(" / "), source: srcLabel("certifications"), status: stOf("certifications") });
  if (rs.fitout_basis?.length) out.push({ key: "fitout_basis", label: "Fit-out basis", value: rs.fitout_basis.join(" / "), source: srcLabel("fitout_basis"), status: stOf("fitout_basis") });
  const hf = req.constraints?.hard_filters ?? {};
  if (hf.budget_ceiling) out.push({ key: "hf_budget", label: "Budget ceiling (hard filter)", value: req.budget_max != null ? `≤ ${req.budget_max} ${req.budget_basis ?? ""}` : "on — budget max unknown", source: "matching config", status: "config" });
  if (hf.latest_occupation) out.push({ key: "hf_occupation", label: "Latest occupation (hard filter)", value: req.occupation_date ? `available by ${req.occupation_date}` : "on — occupation date unknown", source: "matching config", status: "config" });
  if (hf.preferred_only) out.push({ key: "hf_preferred", label: "Preferred locations only (hard filter)", value: (req.preferred_geography_ids ?? []).map(geoName).join(", ") || "on — no preferred locations set", source: "matching config", status: "config" });
  return out;
}

function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "" && v.trim().toLowerCase() !== "unknown";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Current value of a contract field from a requirement row (column(s) or constraints.values). */
export function fieldValue(req: RequirementRow, key: string): unknown {
  const def = FIELD_BY_KEY.get(key);
  if (!def) return undefined;
  if (def.columns) {
    if (def.columns.length === 1) {
      const v = (req as Record<string, unknown>)[def.columns[0]];
      if (key === "mandate_status" && v === "unknown") return null;
      if (key === "conflict_status" && v === "not_checked") return null;
      return v;
    }
    const vals = def.columns.map((c) => (req as Record<string, unknown>)[c]);
    return vals.some(present) ? vals : null;
  }
  return req.constraints?.values?.[key];
}

export function fieldStatus(req: RequirementRow, key: string): FieldStatus {
  const s = req.constraints?.field_status?.[key];
  if (s) return s;
  return present(fieldValue(req, key)) ? "estimated" : "unknown";
}

export interface MissingQuestion {
  key: string;
  label: string;
  question: string;
  priority: "mandatory" | "helpful";
  reason: "missing" | "estimated_needs_confirmation";
}

/**
 * Deterministic missing-question list: mandatory unknowns first (contract order), then mandatory estimates that
 * still need client confirmation, then helpful unknowns. Same row → same list.
 */
export function missingQuestions(req: RequirementRow): MissingQuestion[] {
  const na = new Set(req.constraints?.not_applicable ?? []);
  const out: MissingQuestion[] = [];
  const push = (f: FieldDef, reason: MissingQuestion["reason"]) =>
    out.push({ key: f.key, label: f.label, question: f.question, priority: f.mandatory ? "mandatory" : "helpful", reason });
  for (const f of REQUIREMENT_FIELDS) if (f.mandatory && !na.has(f.key) && !present(fieldValue(req, f.key))) push(f, "missing");
  for (const f of REQUIREMENT_FIELDS) if (f.mandatory && !na.has(f.key) && present(fieldValue(req, f.key)) && fieldStatus(req, f.key) !== "client_confirmed") push(f, "estimated_needs_confirmation");
  for (const f of REQUIREMENT_FIELDS) if (!f.mandatory && !na.has(f.key) && !present(fieldValue(req, f.key))) push(f, "missing");
  return out;
}

export interface Completeness { mandatoryTotal: number; mandatoryKnown: number; mandatoryConfirmed: number; percentKnown: number; percentConfirmed: number }
export function requirementCompleteness(req: RequirementRow): Completeness {
  const na = new Set(req.constraints?.not_applicable ?? []);
  const mand = REQUIREMENT_FIELDS.filter((f) => f.mandatory && !na.has(f.key));
  const known = mand.filter((f) => present(fieldValue(req, f.key)));
  const conf = known.filter((f) => fieldStatus(req, f.key) === "client_confirmed");
  const pct = (n: number) => (mand.length ? Math.round((n / mand.length) * 100) : 100);
  return { mandatoryTotal: mand.length, mandatoryKnown: known.length, mandatoryConfirmed: conf.length, percentKnown: pct(known.length), percentConfirmed: pct(conf.length) };
}

/** Can the requirement be marked client_confirmed? All mandatory fields known; each must be marked confirmed. */
export function confirmationBlockers(req: RequirementRow): string[] {
  return missingQuestions(req).filter((q) => q.priority === "mandatory").map((q) =>
    q.reason === "missing" ? `${q.label}: unknown` : `${q.label}: estimated, needs client confirmation`);
}

/**
 * Split an edit into (a) direct writes and (b) fields that must go through proposeChange because they are
 * already client-confirmed (or the whole requirement is confirmed). Pure.
 */
export function partitionEdit(req: RequirementRow, patchKeys: string[]): { direct: string[]; viaProposal: string[] } {
  const direct: string[] = [];
  const viaProposal: string[] = [];
  const confirmedReq = req.status === "client_confirmed";
  for (const k of patchKeys) {
    if (confirmedReq || fieldStatus(req, k) === "client_confirmed") viaProposal.push(k);
    else direct.push(k);
  }
  return { direct, viaProposal };
}

/** Map a contract field key + value to column patch entries / constraints.values entry. */
export function toColumnPatch(key: string, value: unknown): { columns: Record<string, unknown>; constraintValue?: unknown } {
  const def = FIELD_BY_KEY.get(key);
  if (!def) throw new Error(`unknown requirement field: ${key}`);
  if (!def.columns) return { columns: {}, constraintValue: value };
  if (def.columns.length === 1) return { columns: { [def.columns[0]]: value === "" ? null : value } };
  const arr = Array.isArray(value) ? value : [];
  const cols: Record<string, unknown> = {};
  def.columns.forEach((c, i) => { cols[c] = arr[i] === "" || arr[i] === undefined ? null : arr[i]; });
  return { columns: cols };
}

export const STAKEHOLDER_ROLES = ["sponsor", "user", "finance", "procurement", "legal", "technical", "approver", "influencer", "other"] as const;

/** Stakeholder-map gaps (multi-threading gap detector). */
export function stakeholderGaps(roles: string[]): string[] {
  const have = new Set(roles);
  const gaps: string[] = [];
  if (roles.length <= 1) gaps.push("Single-person dependency: only one stakeholder mapped");
  if (!have.has("approver") && !have.has("sponsor")) gaps.push("No economic buyer / approver identified");
  if (!have.has("finance")) gaps.push("Finance not involved");
  if (!have.has("procurement")) gaps.push("Procurement not involved");
  if (!have.has("legal")) gaps.push("Legal not involved");
  return gaps;
}
