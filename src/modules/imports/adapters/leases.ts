/*
 * lease_large_v1 / lease_small_v1 (spec Part III adapters 3-4, Part V files 2-3).
 * Lease and lock-in sheets map separately and produce distinct event kinds. Header-driven: the small file's shifted
 * columns (Building Type, Transaction Type) are resolved by label, never by the large tab's positions.
 * Formulas are not executed: the expiry formula text and its cached value are retained beside the independent calculation.
 */
import type { AdapterOptions, LeaseEventKind, LeaseRecord, RowOutcome, SheetMapResult } from "../types";
import { classifySize, date, exactKey, num, text } from "../normalize";
import { deriveEventDate } from "../lease-events";
import { type Adapter, type FieldSpec, type RoleInput, RowRecord, f, issue, quarantine, records } from "./framework";

const COMMON: FieldSpec[] = [
  f("registration_date", "Registration date", ["registration date"], true),
  f("building", "Building name", ["building name"], true),
  f("locality", "Locality", ["locality", "locality name"], true),
  f("area", "Area (sft)", ["area sft", "area sq ft", "area"], true),
  f("rate", "Rate (Rs/sft/month)", ["rate rs sft month", "rate"], true),
  f("floor", "Floor", ["floor"], true),
  f("expiry", "Expiry date (source formula)", ["expiry date"], true),
  f("tenant", "Buyer/Tenant company name", ["buyer tenant company name", "tenant company name"], true),
  f("representative", "Buyer/Tenant representative name", ["buyer tenant representative name"], true),
  f("developer", "Developer name", ["developer name"], true),
  f("start_date", "Lease start date", ["lease start date"], true),
  f("tenure", "Tenure (months)", ["tenure"], true),
];

const LARGE_EXTRA: FieldSpec[] = [
  f("lease_label", "Lease", ["lease"], true),
  f("furnished_rate", "Furnished rate", ["furnished rate rs sft months", "furnished rate rs sft month", "furnished rate"], true),
  f("rent_type", "Rent type", ["rent type"], true),
];

const SMALL_EXTRA: FieldSpec[] = [
  f("building_type", "Building type", ["building type"], true),
  f("transaction_type", "Transaction type", ["transaction type"], true),
];

function mapLeaseRow(rec: RowRecord, sheet: string, kind: LeaseEventKind, opts: AdapterOptions): RowOutcome {
  const building = text(rec.get("building"));
  const locality = text(rec.get("locality"));
  const tenant = text(rec.get("tenant"));
  const start = date(rec.get("start_date"));
  const area = num(rec.get("area"));
  const tenure = num(rec.get("tenure"));
  const missing: string[] = [];
  if (!building) missing.push("building");
  if (!locality) missing.push("locality");
  if (!tenant) missing.push("tenant");
  if (!start) missing.push("start_date");
  if (area.value === null) missing.push("area");
  if (tenure.value === null) missing.push("tenure");
  if (missing.length) {
    const typeErr = (!area.ok ? ["area"] : []).concat(!tenure.ok ? ["tenure"] : []);
    return quarantine(sheet, rec.row, typeErr.length ? "type_error" : "missing_required", [
      issue(typeErr.length ? "type_error" : "missing_required", `Missing/invalid: ${missing.join(", ")}`, "review", { missing, raw: rec.rawFields() }),
    ]);
  }
  if (area.value! <= 0 || tenure.value! <= 0) {
    return quarantine(sheet, rec.row, "type_error", [issue("type_error", "Area and tenure must be positive", "review", { area: area.value, tenure: tenure.value })]);
  }
  const issues = [];
  const flags: string[] = [];
  const reg = date(rec.get("registration_date"));
  const expiryCell = rec.get("expiry");
  const cachedDate = date(expiryCell);
  const derived = deriveEventDate(start, tenure.value, cachedDate ?? (expiryCell.v === null ? null : String(expiryCell.v)));
  if (!derived.integer_tenure) {
    flags.push("fractional_tenure");
    issues.push(issue("fractional_tenure", derived.review_reason ?? "Fractional tenure", "review", {
      tenure_months: tenure.value, source_formula: expiryCell.f ?? null, source_cached: expiryCell.v,
    }));
  } else if (cachedDate && derived.event_date && cachedDate !== derived.event_date) {
    flags.push("formula_cache_mismatch");
    issues.push(issue("formula_cache_mismatch", `Source cached ${cachedDate} differs from independent calculation ${derived.event_date}`, "review", {
      source_formula: expiryCell.f ?? null, source_cached: cachedDate, calculated: derived.event_date,
    }));
  }
  const sizeClass = classifySize(area.value, opts.size_rules);
  if (sizeClass === "boundary_min" || sizeClass === "boundary_max") {
    flags.push("size_boundary");
    issues.push(issue("size_boundary", `Area ${area.value} SF sits exactly on the ${sizeClass === "boundary_min" ? "minimum" : "maximum"} size boundary (strict rule excludes it); review eligibility`, "review", { area_sf: area.value }));
  }
  const floor = text(rec.get("floor"));
  const rate = num(rec.get("rate"));
  const record: LeaseRecord = {
    kind: "lease_row",
    identity_key: [reg ?? "", exactKey(building), exactKey(locality), exactKey(tenant), area.value, start, exactKey(floor)].join("|"),
    eventKind: kind,
    registration_date: reg,
    building_name: building!,
    locality: locality!,
    building_type: text(rec.get("building_type")),
    transaction_type: text(rec.get("transaction_type")),
    area_sf: area.value!,
    rent_per_sf: rate.ok ? rate.value : null,
    floor_text: floor,
    tenant_name: tenant!,
    representative_name: text(rec.get("representative")),
    developer_name: text(rec.get("developer")),
    start_date: start!,
    tenure_months: tenure.value!,
    tenure_is_integer: derived.integer_tenure,
    source_expiry_formula: expiryCell.f ?? null,
    source_expiry_cached: expiryCell.v,
    source_expiry_cached_date: cachedDate,
    calculated_event_date: derived.event_date,
    size_class: sizeClass,
    furnished_rate_raw: text(rec.get("furnished_rate")),
    rent_type_raw: text(rec.get("rent_type")),
    lease_label_raw: text(rec.get("lease_label")),
    fields: { ...rec.rawFields(), expiry_formula: expiryCell.f ?? null, size_class: sizeClass },
  };
  return { sheet, rowNumber: rec.row.rowNumber, status: "accepted", record, issues, flags };
}

const mapLease = (kind: LeaseEventKind) => (input: RoleInput, opts: AdapterOptions): SheetMapResult => ({
  outcomes: records(input).map((r) => mapLeaseRow(r, input.sheet.name, kind, opts)),
  controls: [],
  issues: [],
});

const LOCKIN_ROLE = {
  role: "lockin",
  label: "Lock-in expiry events",
  sheetNamePattern: /lock/i,
  fields: COMMON,
  map: mapLease("lockin_end"),
};

export const leaseLargeV1: Adapter = {
  id: "lease_large_v1",
  version: "1.0.0",
  label: "Lease expiry workbook (lease tab with Lease / Furnished rate / Rent type)",
  roles: [
    { role: "lease", label: "Lease expiry events", sheetNameExclude: /lock/i, fields: [...COMMON, ...LARGE_EXTRA], map: mapLease("expiry") },
    LOCKIN_ROLE,
  ],
};

export const leaseSmallV1: Adapter = {
  id: "lease_small_v1",
  version: "1.0.0",
  label: "Lease expiry workbook (lease tab with Building type / Transaction type)",
  roles: [
    { role: "lease", label: "Lease expiry events (shifted columns)", sheetNameExclude: /lock/i, fields: [...COMMON, ...SMALL_EXTRA], map: mapLease("expiry") },
    LOCKIN_ROLE,
  ],
};

