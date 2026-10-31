/* Shared types for the imports module. Pure (no server-only imports) so adapters stay unit-testable. */

/** One source cell after read-only parsing. `f` is the original formula text (never evaluated); `v` is the cached value. */
export interface Cell {
  v: string | number | boolean | null;
  t: "s" | "n" | "b" | "d" | "e" | "null"; // string, number, boolean, date (ISO yyyy-mm-dd in v), error, empty
  f?: string;
}

export interface ParsedRow {
  rowNumber: number; // 1-based source row number
  cells: Cell[]; // index = column (0-based)
}

export interface ParsedSheet {
  name: string;
  rows: ParsedRow[]; // non-empty rows only, in order
  columnCount: number;
  formulaCount: number;
}

export interface ParsedWorkbook {
  format: "xlsx" | "csv";
  sheets: ParsedSheet[];
  warnings: string[];
}

export type RowStatus = "accepted" | "quarantined" | "excluded" | "duplicate";

export interface RowIssue {
  kind: string; // missing_required, type_error, fractional_tenure, size_boundary, ...
  severity: "info" | "review" | "blocking";
  message: string;
  details?: Record<string, unknown>;
}

/** Records produced by adapters. Pure data: identity resolution and DB writes happen in the pipeline. */
export interface AssetObservationRecord {
  kind: "asset_observation";
  identity_key: string;
  sourceTabLabel: "existing" | "upcoming_inventory_label" | "ready_snapshot";
  building_name: string;
  locality: string;
  floor_size_text: string | null;
  floor_size_min_sf: number | null;
  floor_size_max_sf: number | null;
  total_area_sf: number | null;
  total_area_source_zero: boolean;
  floors_text: string | null;
  status_raw: string | null;
  transactions_count: number | null;
  avg_rent: number | null;
  as_of: string | null;
  fields: Record<string, unknown>;
}

export type LeaseEventKind = "expiry" | "lockin_end";

export interface LeaseRecord {
  kind: "lease_row";
  identity_key: string; // lease natural key (shared by lease + lock-in rows of the same agreement)
  eventKind: LeaseEventKind;
  registration_date: string | null;
  building_name: string;
  locality: string;
  building_type: string | null;
  transaction_type: string | null;
  area_sf: number;
  rent_per_sf: number | null;
  floor_text: string | null;
  tenant_name: string;
  representative_name: string | null;
  developer_name: string | null;
  start_date: string;
  tenure_months: number;
  tenure_is_integer: boolean;
  source_expiry_formula: string | null;
  source_expiry_cached: string | number | boolean | null;
  source_expiry_cached_date: string | null;
  calculated_event_date: string | null; // edate(start, tenure) when integer; null when fractional
  size_class: SizeClass;
  furnished_rate_raw: string | null;
  rent_type_raw: string | null;
  lease_label_raw: string | null;
  fields: Record<string, unknown>;
}

export interface TransactionRecord {
  kind: "transaction";
  identity_key: string;
  layout: "conventional" | "coworking";
  tenant_name: string;
  building_name: string | null;
  locality: string | null;
  operator_name: string | null;
  deal_type: string | null;
  period_start: string | null;
  period_end: string | null;
  period_precision: "day" | "month" | "quarter" | "year" | "unknown";
  area_sf: number | null;
  seats: number | null;
  rent_min: number | null;
  rent_max: number | null;
  rent_basis: string | null;
  broker_name_raw: string | null;
  extras: Record<string, unknown>;
  fields: Record<string, unknown>;
}

export interface MarketObservationRecord {
  metric: "stock" | "absorption" | "rent" | "supply";
  geography_raw: string;
  year: number;
  period_start: string;
  period_end: string;
  period_type: "full_year" | "ytd" | "quarter" | "month" | "forecast" | "snapshot";
  unit: string;
  value: number;
  definition: string;
}

export interface MarketRowRecord {
  kind: "market_row";
  identity_key: string;
  observations: MarketObservationRecord[];
  fields: Record<string, unknown>;
}

export interface ReferenceRecord {
  kind: "reference";
  identity_key: string;
  fields: Record<string, unknown>;
}

export type MappedRecord = AssetObservationRecord | LeaseRecord | TransactionRecord | MarketRowRecord | ReferenceRecord;

export interface RowOutcome {
  sheet: string;
  rowNumber: number;
  status: Exclude<RowStatus, "duplicate">;
  reason?: string;
  flags?: string[];
  record?: MappedRecord;
  issues: RowIssue[];
}

export interface ControlCheck {
  name: string;
  sheet: string;
  locator: string;
  expected: number | null;
  actual: number;
  ok: boolean;
  note?: string;
}

export interface SheetMapResult {
  outcomes: RowOutcome[];
  controls: ControlCheck[];
  issues: RowIssue[]; // sheet-level issues
}

export type SizeClass = "unknown" | "below_min" | "boundary_min" | "in_scope_small" | "in_scope" | "boundary_max" | "above_max";

export interface SizeRules {
  min_exclusive_sf: number;
  max_exclusive_sf: number;
  small_band_below_sf: number;
}

export interface IdentityThresholds {
  auto_link: number;
  review: number;
}

export interface AdapterOptions {
  as_of?: string | null; // snapshot date for ready-asset rent observations
  period_year?: number | null; // reporting year for trackers without per-row dates
  file_name?: string;
  size_rules: SizeRules;
}

export const DEFAULT_SIZE_RULES: SizeRules = { min_exclusive_sf: 5000, max_exclusive_sf: 200000, small_band_below_sf: 8000 };
export const DEFAULT_THRESHOLDS: IdentityThresholds = { auto_link: 0.95, review: 0.8 };
