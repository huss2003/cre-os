/*
 * transactions_2022_v1 / transactions_2023_v1 (spec Part III adapters 5-6, Part V files 10-11).
 * Historical transactions, not live leads. Subtotal/summary blocks are excluded by entity-field validation;
 * serial numbers (often formulas) are never used as identity; rent bands keep min/max; broker FIRM context only.
 */
import type { AdapterOptions, RowOutcome, SheetMapResult, TransactionRecord } from "../types";
import {
  canonicalBuilding, canonicalOrg, classifySize, month, monthBounds, num, quarter, quarterBounds, range, text, yearBounds, yearFromLabel,
} from "../normalize";
import { type Adapter, type RoleInput, RowRecord, exclude, f, issue, looksLikeTotal, quarantine, records } from "./framework";

interface PeriodResult {
  start: string | null; end: string | null; precision: TransactionRecord["period_precision"]; basis: string; flags: string[]; extras: Record<string, unknown>;
}

function batchYear(opts: AdapterOptions): { year: number | null; basis: string } {
  if (opts.period_year) return { year: opts.period_year, basis: "batch_option" };
  const y = yearFromLabel(opts.file_name);
  return y ? { year: y, basis: "file_label" } : { year: null, basis: "unknown" };
}

/** Month/quarter/year period with explicit precision. Never synthesises an exact day. */
export function resolvePeriod(qText: string | null, mText: string | null, opts: AdapterOptions): PeriodResult {
  const q = quarter(qText);
  const m = month(mText);
  const by = batchYear(opts);
  const flags: string[] = [];
  const extras: Record<string, unknown> = {};
  const year = m?.year ?? q?.year ?? by.year;
  const basis = m?.year || q?.year ? "row_text" : by.basis;
  if (year === null) {
    if (q || m) flags.push("period_year_unknown");
    return { start: null, end: null, precision: "unknown", basis: "unknown", flags, extras };
  }
  if (m) {
    if (q) {
      const calQ = Math.floor((m.m - 1) / 3) + 1;
      extras.quarter_convention = calQ === q.q ? "calendar" : "differs_from_calendar_month_used";
    }
    const b = monthBounds(year, m.m);
    return { start: b.start, end: b.end, precision: "month", basis, flags, extras };
  }
  if (q) {
    extras.quarter_convention = "calendar_assumed";
    flags.push("quarter_convention_assumed");
    const b = quarterBounds(year, q.q);
    return { start: b.start, end: b.end, precision: "quarter", basis, flags, extras };
  }
  const b = yearBounds(year);
  return { start: b.start, end: b.end, precision: "year", basis, flags, extras };
}

const SUMMARY_LABEL_RE = /\b(net\s+absorption|absorption|pre-?\s*commitments?|fresh\s*\+\s*expansion|seater\s+deals)\b/i;

function txKey(parts: (string | number | null | undefined)[]) {
  return parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|");
}

function conventionalRow(rec: RowRecord, sheet: string, opts: AdapterOptions, v2023: boolean): RowOutcome {
  const project = text(rec.get("project"));
  const lessee = text(rec.get("lessee"));
  const area = num(rec.get("area"));
  const hasEntity = !!(project || lessee);
  if (looksLikeTotal(rec) && (!project || !lessee)) return exclude(sheet, rec.row, "summary_or_total");
  if (!hasEntity) return exclude(sheet, rec.row, "summary_or_note");
  // Footer summary lines below the deal table ("Net Absorption | 4561522 | 4.61 Mn", "Total Transactions with PC", "Pre-Commitments"):
  // no serial number, no typed area, and a summary label => derived figures, deliberately excluded (not a deal to review).
  if (rec.get("sr_no").v === null && area.value === null && (looksLikeTotal(rec) || SUMMARY_LABEL_RE.test(project ?? "") || SUMMARY_LABEL_RE.test(lessee ?? ""))) {
    return exclude(sheet, rec.row, "summary_or_total");
  }
  if (!project || !lessee || area.value === null || !area.ok) {
    const missing = [!project && "project", !lessee && "lessee", (area.value === null || !area.ok) && "area"].filter(Boolean);
    return quarantine(sheet, rec.row, area.ok ? "missing_required" : "type_error", [
      issue(area.ok ? "missing_required" : "type_error", `Conventional rows require project, lessee and numeric area (missing: ${missing.join(", ")})`, "review", { raw: rec.rawFields() }),
    ]);
  }
  const flags: string[] = [];
  const period = resolvePeriod(v2023 ? text(rec.get("quarter")) : null, v2023 ? text(rec.get("month")) : null, opts);
  flags.push(...period.flags);
  const rent = range(rec.get("rental"));
  if (!rent.ok) flags.push("rent_unparsed");
  const dealType = text(rec.get(v2023 ? "transaction_type" : "layout_kind"));
  const location = text(rec.get("location"));
  const extras: Record<string, unknown> = {
    ...period.extras,
    period_basis: period.basis,
    serial_no_raw: rec.get("sr_no").v,
    absorption_type: text(rec.get("absorption_type")),
    corridor_a: text(rec.get("corridor_a")),
    corridor_b: text(rec.get("corridor_b")),
    ern: text(rec.get("ern")),
    earlier_occupied: rec.get("earlier_occupied").v,
    lease_outright: text(rec.get("lease_outright")),
    grade: text(rec.get("grade")),
    retail_office: text(rec.get("retail_office")),
    rent_text: rent.text,
    floor_condition: text(rec.get("floor_condition")),
    floor_occupied: rec.get("floor_occupied").v,
    mandate: text(rec.get("mandate")),
    remark: text(rec.get("remark")),
    size_class: classifySize(area.value, opts.size_rules),
    ...rec.extras(),
  };
  for (const k of Object.keys(extras)) if (extras[k] === null || extras[k] === undefined) delete extras[k];
  const record: TransactionRecord = {
    kind: "transaction",
    layout: "conventional",
    identity_key: txKey(["conv", canonicalOrg(lessee), canonicalBuilding(project), canonicalBuilding(location), area.value, period.start, period.precision, (dealType ?? "").toLowerCase(), String(rec.get("floor_occupied").v ?? "")]),
    tenant_name: lessee,
    building_name: project,
    locality: location,
    operator_name: null,
    deal_type: dealType ? dealType.toLowerCase() : null,
    period_start: period.start,
    period_end: period.end,
    period_precision: period.precision,
    area_sf: area.value,
    seats: null,
    rent_min: rent.ok ? rent.min : null,
    rent_max: rent.ok ? rent.max : null,
    rent_basis: null, // the source does not state carpet/chargeable/seat basis
    broker_name_raw: text(rec.get("agent")),
    extras,
    fields: rec.rawFields(),
  };
  return { sheet, rowNumber: rec.row.rowNumber, status: "accepted", record, issues: [], flags };
}

function coworkingRow(rec: RowRecord, sheet: string, opts: AdapterOptions, v2023: boolean): RowOutcome {
  const player = text(rec.get("player"));
  const building = text(rec.get("building"));
  const client = text(rec.get("client"));
  if (looksLikeTotal(rec) && (!client || !player)) return exclude(sheet, rec.row, "summary_or_total");
  if (!player && !building && !client) return exclude(sheet, rec.row, "summary_or_note");
  if (!player || !building || !client) {
    const missing = [!player && "operator", !building && "building", !client && "client"].filter(Boolean);
    return quarantine(sheet, rec.row, "missing_required", [
      issue("missing_required", `Coworking rows require client, operator and building (missing: ${missing.join(", ")})`, "review", { raw: rec.rawFields() }),
    ]);
  }
  const flags: string[] = [];
  const seats = num(rec.get("seats"));
  if (!seats.ok) flags.push("seats_unparsed");
  const area = num(rec.get("area"));
  if (!area.ok) flags.push("area_unparsed");
  const period = resolvePeriod(v2023 ? text(rec.get("quarter")) : null, v2023 ? text(rec.get("month")) : null, opts);
  flags.push(...period.flags);
  const unlabeled = rec.extras();
  if (Object.keys(unlabeled).length) flags.push("unlabeled_extras");
  const location = text(rec.get("location"));
  const extras: Record<string, unknown> = {
    ...period.extras,
    period_basis: period.basis,
    serial_no_raw: rec.get("sr_no").v,
    cost_raw: rec.get("cost").v,
    area_raw: area.ok ? undefined : rec.get("area").v,
    ...unlabeled,
  };
  for (const k of Object.keys(extras)) if (extras[k] === null || extras[k] === undefined) delete extras[k];
  const record: TransactionRecord = {
    kind: "transaction",
    layout: "coworking",
    identity_key: txKey(["cowork", canonicalOrg(client), canonicalOrg(player), canonicalBuilding(building), canonicalBuilding(location), seats.value, period.start, period.precision]),
    tenant_name: client,
    building_name: building,
    locality: location,
    operator_name: player,
    deal_type: "coworking",
    period_start: period.start,
    period_end: period.end,
    period_precision: period.precision,
    area_sf: area.ok ? area.value : null,
    seats: seats.ok && seats.value !== null ? Math.round(seats.value) : null,
    rent_min: null,
    rent_max: null,
    rent_basis: null,
    broker_name_raw: text(rec.get("broker")),
    extras,
    fields: rec.rawFields(),
  };
  return { sheet, rowNumber: rec.row.rowNumber, status: "accepted", record, issues: [], flags };
}

function mapWith(fn: (r: RowRecord, s: string, o: AdapterOptions, v: boolean) => RowOutcome, v2023: boolean) {
  return (input: RoleInput, opts: AdapterOptions): SheetMapResult => {
    const outcomes = records(input).map((r) => fn(r, input.sheet.name, opts, v2023));
    const sheetIssues = [];
    if (input.unlabeledColumns.length && outcomes.some((o) => o.flags?.includes("unlabeled_extras"))) {
      sheetIssues.push(issue("unlabeled_columns", `Unlabeled source columns kept as reviewable extras: ${input.unlabeledColumns.length}`, "info"));
    }
    return { outcomes, controls: [], issues: sheetIssues };
  };
}

const SR = f("sr_no", "Sr. No", ["sr no", "s no", "sr", "serial no"]);
const CW_COMMON = [
  SR,
  f("player", "Operator (player)", ["player name"], true),
  f("building", "Building name", ["building name"], true),
  f("location", "Location", ["location"], true),
  f("client", "Client name", ["client name"], true),
  f("seats", "Seats occupied", ["seats occupied"]),
  f("broker", "Broker / IPC", ["broker ipc", "broker"]),
];

export const transactions2022V1: Adapter = {
  id: "transactions_2022_v1",
  version: "1.0.0",
  label: "Transaction tracker (2022 layout)",
  roles: [
    {
      role: "conventional",
      label: "Conventional / managed deals",
      allowUnlabeled: true,
      fields: [
        SR,
        f("layout_kind", "Conventional vs managed", ["conventional vs manages", "conventional vs managed"], true),
        f("absorption_type", "Type of absorption", ["type of absorption"]),
        f("corridor_a", "Corridor A", ["corridor a"]),
        f("corridor_b", "Corridor B", ["corridor b"]),
        f("project", "Project name", ["project name"], true),
        f("location", "Location", ["location"], true),
        f("lessee", "Lessee", ["lessee"], true),
        f("ern", "E/R/N", ["e r n"], true),
        f("earlier_occupied", "Earlier occupied", ["earlier occupied"]),
        f("area", "Area leased (sq.ft.)", ["area leased sq ft", "area leased sqft"], true),
        f("agent", "Agent / IPC", ["agent ipc"]),
        f("lease_outright", "Lease / outright", ["lease outright"]),
      ],
      map: mapWith(conventionalRow, false),
    },
    { role: "coworking", label: "Co-working transactions", allowUnlabeled: true, fields: CW_COMMON, map: mapWith(coworkingRow, false) },
  ],
};

export const transactions2023V1: Adapter = {
  id: "transactions_2023_v1",
  version: "1.0.0",
  label: "Transaction tracker (2023 layout)",
  roles: [
    {
      role: "conventional",
      label: "Conventional + managed deals",
      allowUnlabeled: true,
      fields: [
        SR,
        f("project", "Project name", ["project name"], true),
        f("transaction_type", "Transaction type", ["transaction type"], true),
        f("grade", "Grade", ["grade"]),
        f("location", "Location", ["location"], true),
        f("corridor_a", "Corridor A", ["corridor a"]),
        f("corridor_b", "Corridor B", ["corridor b"]),
        f("retail_office", "Retail / office", ["retails office", "retail office"]),
        f("lessee", "Lessee", ["lessee"], true),
        f("ern", "E/RN/F", ["e rn f", "e r n f"]),
        f("quarter", "Quarter of transaction", ["quater of transaction", "quarter of transaction"], true),
        f("absorption_type", "Type of absorption", ["type of absorbtion", "type of absorption"]),
        f("earlier_occupied", "Earlier occupied", ["earlier occupied"]),
        f("area", "Area leased (sq.ft.)", ["area leased sq ft", "area leased sqft"], true),
        f("agent", "Agent / IPC", ["agent ipc"]),
        f("lease_outright", "Lease / outright", ["lease outright"]),
        f("month", "Month", ["month"]),
        f("rental", "Rental (sq.ft.)", ["rental sq ft", "rental"]),
        f("floor_condition", "Floor condition", ["floor condition"]),
        f("floor_occupied", "Floor occupied", ["floor occupied"]),
        f("mandate", "Mandate / non-mandate", ["mandate non mandate"]),
        f("remark", "Remark", ["remark", "remarks"]),
      ],
      map: mapWith(conventionalRow, true),
    },
    {
      role: "coworking",
      label: "Co-working transactions",
      allowUnlabeled: true,
      fields: [
        ...CW_COMMON,
        f("quarter", "Quarter of transaction", ["quarter of transaction", "quater of transaction"], true),
        f("month", "Month of transaction", ["month of transaction"]),
        f("cost", "Cost", ["cost"]),
        f("area", "Area occupied", ["area occupied"]),
      ],
      map: mapWith(coworkingRow, true),
    },
  ],
};
