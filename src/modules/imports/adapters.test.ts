import { describe, it, expect } from "vitest";
import { parseFile, parseXlsx } from "./parse";
import { detectWorkbook, mapWorkbook, shapeSignature, type ApprovedMapping } from "./detect";
import { buildStaged, diffVersions, markDuplicates, reconcile, diffKey, rawJson, hashOf } from "./reconcile";
import { classifySize, range } from "./normalize";
import { deriveEventDate, inThreeToTwelveMonthWindow } from "./lease-events";
import { DEFAULT_SIZE_RULES, type AdapterOptions, type LeaseRecord, type MarketRowRecord, type TransactionRecord, type AssetObservationRecord, type ParsedRow } from "./types";
import { ASSET_HEADER, LEASE_COMMON, LEASE_LARGE_HEADER, LEASE_SMALL_HEADER, largeLeaseRow, sheet, utcDate, workbook, xlsxBytes } from "./testkit";

const OPTS: AdapterOptions = { as_of: "2026-10-23", size_rules: DEFAULT_SIZE_RULES, file_name: "fixture.xlsx" };

function run(wb: ReturnType<typeof workbook>, mappings: ApprovedMapping[] = [], opts = OPTS) {
  const det = detectWorkbook(wb, mappings);
  const mapped = mapWorkbook(wb, det, opts);
  const rows = new Map(wb.sheets.map((s) => [s.name, new Map<number, ParsedRow>(s.rows.map((r) => [r.rowNumber, r]))]));
  const staged = buildStaged(mapped, rows);
  return { det, mapped, staged };
}

describe("read-only parsing", () => {
  it("keeps formula text AND cached value, never recalculates", async () => {
    const bytes = await xlsxBytes([{ name: "S", rows: [["a", "b"], [2, { formula: "=A2*1000", result: 7 }]] }]);
    const wb = await parseXlsx(bytes);
    const c = wb.sheets[0].rows[1].cells[1];
    expect(c.f).toBe("=A2*1000");
    expect(c.v).toBe(7); // stale cache retained as-is: nothing executed
    expect(wb.sheets[0].formulaCount).toBe(1);
  });
  it("rejects legacy binary .xls instead of guessing", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(parseFile(ole, "x.xls")).rejects.toThrow(/Legacy binary/);
  });
  it("parses CSV with numbers as numbers and blanks as empty", async () => {
    const wb = await parseFile(new TextEncoder().encode(",Title,\nYear/Quarter,CBD,SBD East\n2018,1.5,\n"), "m.csv");
    expect(wb.sheets[0].rows[2].cells.map((c) => c.t)).toEqual(["n", "n"]);
  });
});

describe("asset_list_v1 / ready_asset_v1 + headerless upcoming tab", () => {
  const existing = sheet("Existing assets", [
    ASSET_HEADER,
    ["Alpha Park Tower 1", "Kharadi", "20,000 - 25,000", 300000, "G+10", "Ready", 4],
    ["Alpha Park Tower 2", "Kharadi", "18000-22000", 0, "G+8", "Ready", 1],
    ["Beta House", "Baner", 9000, 45000, "G+4", "Under Construction", 0],
  ]);
  const upcoming = sheet("Upcoming inventory", [
    ["Alpha Park Tower 1", "Kharadi", "20,000 - 25,000", 300000, "G+10", "Ready", 4],
    ["Beta House", "Baner", "9000", 45000, "G+4", "Under Construction", 0],
  ]);

  it("maps the header tab: floor-size range -> min/max + text, total area 0 -> source zero (not unknown, not a value)", () => {
    const { det, staged } = run(workbook(existing));
    expect(det[0]).toMatchObject({ status: "mapped", adapter: "asset_list_v1", role: "assets_existing", headerRow: 1, rowsConsidered: 3, layoutRows: 1 });
    const recs = staged.map((s) => s.record as AssetObservationRecord);
    expect(recs[0]).toMatchObject({ floor_size_min_sf: 20000, floor_size_max_sf: 25000, floor_size_text: "20,000 - 25,000", total_area_sf: 300000 });
    expect(recs[1]).toMatchObject({ total_area_sf: null, total_area_source_zero: true });
    expect(staged[1].flags).toContain("total_area_source_zero");
    expect(recs[0].identity_key).toBe("alpha park tower 1|kharadi");
  });

  it("headerless tab is quarantined for mapping review (never silently mapped) with a positional suggestion", () => {
    const { det, staged } = run(workbook(existing, upcoming));
    expect(det[1].status).toBe("unknown");
    expect(det[1].headerRow).toBe(0);
    expect(det[1].signature).toBe(shapeSignature(upcoming));
    const sug = det[1].suggestions.find((s) => s.positional);
    expect(sug).toMatchObject({ adapter: "asset_list_v1", role: "assets_headerless" });
    const up = staged.filter((s) => s.sheet === "Upcoming inventory");
    expect(up.every((s) => s.status === "quarantined" && s.reason === "unknown_schema")).toBe(true);
    expect(up.length).toBe(2); // first row counted as a row, not swallowed as a header
  });

  it("after an APPROVED positional map the first row is data and keys match the existing tab", () => {
    const sig = shapeSignature(upcoming);
    const mapping: ApprovedMapping = {
      id: "m1", adapter: "asset_list_v1", sheet_role: "assets_headerless", schema_signature: sig, header_row: 0, positional: true, version: 1,
      column_map: { building: 0, locality: 1, floor_size: 2, total_area: 3, floors: 4, status: 5, transactions: 6 },
    };
    const { det, staged } = run(workbook(existing, upcoming), [mapping]);
    expect(det[1]).toMatchObject({ status: "mapped", mappingSource: "approved_mapping", headerRow: 0, rowsConsidered: 2, layoutRows: 0 });
    const up = staged.filter((s) => s.sheet === "Upcoming inventory");
    expect(up.map((s) => s.status)).toEqual(["accepted", "accepted"]);
    expect(up[0].row_number).toBe(1);
    expect(up[0].flags).toContain("positional_map");
    const existingKeys = new Set(staged.filter((s) => s.sheet === "Existing assets").map((s) => s.record!.identity_key));
    expect(up.every((s) => existingKeys.has(s.record!.identity_key))).toBe(true);
    expect((up[0].record as AssetObservationRecord).sourceTabLabel).toBe("upcoming_inventory_label");
    // overlapping tabs are separate observations of one master, not duplicates
    expect(markDuplicates(staged)).toBe(0);
  });

  it("ready_asset_v1 adds rent only with an as-of date", () => {
    const ready = sheet("Building Data", [
      [...ASSET_HEADER.slice(0, 6), "Transactions- ( agreements data available in the software)", "Average Building rental"],
      ["Gamma Tower", "Hinjewadi", "15000", 200000, "G+6", "Ready", 2, 93],
      ["Delta", "Hinjewadi", "15000", 100000, "G+6", "Ready", 2, null],
    ]);
    const withAsOf = run(workbook(ready)).staged.map((s) => s.record as AssetObservationRecord);
    expect(withAsOf[0]).toMatchObject({ avg_rent: 93, as_of: "2026-10-23", sourceTabLabel: "ready_snapshot" });
    expect(withAsOf[1].avg_rent).toBeNull();
    const noAsOf = run(workbook(ready), [], { ...OPTS, as_of: null });
    expect((noAsOf.staged[0].record as AssetObservationRecord).avg_rent).toBeNull();
    expect(noAsOf.staged[0].issues.map((i) => i.kind)).toContain("rent_without_as_of");
  });
});

describe("lease_large_v1 / lease_small_v1, lease chronology and size labels", () => {
  const large = sheet("Lease Expiry", [
    LEASE_LARGE_HEADER,
    largeLeaseRow({ row: 2, building: "Alpha Park Tower 1", locality: "Kharadi", area: 7500, tenant: "Acme Pvt Ltd", start: "2021-01-31", tenure: 61, cached: "2026-02-28" }),
    largeLeaseRow({ row: 3, building: "Beta House", locality: "Baner", area: 5000, tenant: "Bolt Ltd", start: "2020-03-15", tenure: 60.5, cached: "2025-03-15" }),
    largeLeaseRow({ row: 4, building: "Beta House", locality: "Baner", area: 200000, tenant: "Core Inc", start: "2023-06-01", tenure: 36, cached: "2026-06-01" }),
    largeLeaseRow({ row: 5, building: "Beta House", locality: "Baner", area: 4500, tenant: "Dot LLP", start: "2023-06-01", tenure: 24, cached: "2025-07-01" }),
  ]);
  const lock = sheet("Lock-in Expiry", [
    LEASE_COMMON,
    largeLeaseRow({ row: 2, building: "Alpha Park Tower 1", locality: "Kharadi", area: 7500, tenant: "Acme Pvt Ltd", start: "2021-01-31", tenure: 36, cached: "2024-01-31" }).slice(0, 12),
  ]);

  it("detects large layout by header labels; lease and lock-in sheets map to distinct event kinds of the same lease", () => {
    const { det, staged } = run(workbook(large, lock));
    expect(det.map((d) => [d.adapter, d.role])).toEqual([["lease_large_v1", "lease"], ["lease_large_v1", "lockin"]]);
    const l = staged[0].record as LeaseRecord;
    const k = staged.find((s) => s.sheet === "Lock-in Expiry")!.record as LeaseRecord;
    expect(l.eventKind).toBe("expiry");
    expect(k.eventKind).toBe("lockin_end");
    expect(k.identity_key).toBe(l.identity_key); // one agreement, two separate events
    expect(k.calculated_event_date).toBe("2024-01-31");
  });

  it("integer tenure => EDATE with month-end clamp; formula text + cached value retained", () => {
    const l = run(workbook(large)).staged[0].record as LeaseRecord;
    expect(l.calculated_event_date).toBe("2026-02-28"); // 31 Jan 2021 + 61 months, clamped
    expect(l.source_expiry_formula).toBe("=EDATE(K2,L2)");
    expect(l.source_expiry_cached_date).toBe("2026-02-28");
    expect(deriveEventDate("2024-01-31", 1).event_date).toBe("2024-02-29");
  });

  it("fractional tenure: no date derived, flagged for review (never truncated)", () => {
    const s = run(workbook(large)).staged[1];
    const l = s.record as LeaseRecord;
    expect(l.tenure_is_integer).toBe(false);
    expect(l.calculated_event_date).toBeNull();
    expect(s.flags).toContain("fractional_tenure");
    expect(s.issues[0].details).toMatchObject({ source_formula: "=EDATE(K3,L3)" });
  });

  it("stale formula cache is surfaced, the independent calculation wins", () => {
    const s = run(workbook(large)).staged[3]; // start 2023-06-01 + 24 => 2025-06-01, cache says 2025-07-01
    expect((s.record as LeaseRecord).calculated_event_date).toBe("2025-06-01");
    expect(s.flags).toContain("formula_cache_mismatch");
  });

  it("size classes come from typed area; strict 5,000/200,000 boundaries kept for review; <8,000 rows classified, not discarded", () => {
    const st = run(workbook(large)).staged;
    expect(st.map((s) => (s.record as LeaseRecord).size_class)).toEqual(["in_scope_small", "boundary_min", "boundary_max", "below_min"]);
    expect(st.every((s) => s.status === "accepted")).toBe(true);
    expect(st[1].flags).toContain("size_boundary");
    expect(classifySize(5001, DEFAULT_SIZE_RULES)).toBe("in_scope_small");
    expect(classifySize(199999, DEFAULT_SIZE_RULES)).toBe("in_scope");
    expect(classifySize(0, DEFAULT_SIZE_RULES)).toBe("unknown");
  });

  it("small layout: shifted columns resolved by label, not by the large tab's positions", () => {
    const small = sheet("Lease Expiry", [
      LEASE_SMALL_HEADER,
      [utcDate("2022-02-01"), "Zeta Plaza", "IT", "Aundh", "Lease", 3000, 60, 2, { formula: "=EDATE(M2,N2)", result: "2025-02-01" }, "Tiny Co", "R", "D", utcDate("2022-02-01"), 36],
    ]);
    const { det, staged } = run(workbook(small));
    expect(det[0].adapter).toBe("lease_small_v1");
    const l = staged[0].record as LeaseRecord;
    expect(l).toMatchObject({ building_type: "IT", transaction_type: "Lease", area_sf: 3000, locality: "Aundh", calculated_event_date: "2025-02-01" });
  });

  it("3-12 month window is inclusive", () => {
    expect(inThreeToTwelveMonthWindow("2027-01-23", "2026-10-23")).toBe(true);
    expect(inThreeToTwelveMonthWindow("2027-10-23", "2026-10-23")).toBe(true);
    expect(inThreeToTwelveMonthWindow("2027-01-22", "2026-10-23")).toBe(false);
  });
});

describe("transactions_2022_v1 / transactions_2023_v1 (historical periods)", () => {
  const conv22 = sheet("Convential Deals", [
    ["Sr. No", "Conventional Vs Manages", "Type of Absorption", "Corridor A", "Corridor B", "Project Name", "Location", "Lessee", "E/R/N", "Earlier occupied", "Area leased (sq.ft.)", "Agent / IPC", "Lease/ outright"],
    [1, "Conventional", "Fresh", "Eastern", "Kharadi", "Alpha Park", "Kharadi", "Acme Pvt Ltd", "E", null, 25000, "Broker Firm", "Lease"],
    [{ formula: "=A2+1", result: 2 }, "Managed", "Fresh", "Western", "Baner", "Beta House", "Baner", "Bolt Ltd", "N", null, "12,000", null, "Lease"],
    [null, null, null, null, null, null, "Grand Total", null, null, null, 37000, null, null],
    [3, "Conventional", "Fresh", "Eastern", "Kharadi", "Gamma", "Kharadi", "Core Inc", "E", null, "TBC", null, "Lease"],
  ]);
  const cw22 = sheet("Co-working Transactions", [
    ["Sr. No", "Player Name", "Building Name", "Location", "Client Name", "Seats Occupied", "Broker / IPC", null, null],
    [1, "Hub Spaces", "Alpha Park", "Kharadi", "Delta Corp", 120, "IPC One", "Mar-22", "5th"],
  ]);

  it("excludes subtotal rows, quarantines rows missing typed area, keeps formula serials out of identity", () => {
    const { staged, det } = run(workbook(conv22, cw22), [], { ...OPTS, file_name: "Transaction Tracker 2022-Pivot Table.xlsx" });
    expect(det[0].adapter).toBe("transactions_2022_v1");
    const conv = staged.filter((s) => s.sheet === "Convential Deals");
    expect(conv.map((s) => s.status)).toEqual(["accepted", "accepted", "excluded", "quarantined"]);
    expect(conv[2].reason).toBe("summary_or_total");
    const t = conv[1].record as TransactionRecord;
    expect(t.area_sf).toBe(12000);
    expect(t.identity_key).not.toContain("=A2");
    expect(t.period_precision).toBe("year");
    expect(t.period_start).toBe("2022-01-01");
    expect(t.extras.period_basis).toBe("file_label");
    expect(t.extras.serial_no_raw).toBe(2);
  });

  it("coworking keeps unlabeled date/floor columns as reviewable extras", () => {
    const { staged } = run(workbook(conv22, cw22), [], { ...OPTS, file_name: "Transaction Tracker 2022.xlsx" });
    const cw = staged.find((s) => s.sheet === "Co-working Transactions")!;
    const t = cw.record as TransactionRecord;
    expect(t).toMatchObject({ layout: "coworking", operator_name: "Hub Spaces", tenant_name: "Delta Corp", seats: 120 });
    expect(t.extras).toMatchObject({ unlabeled_H: "Mar-22", unlabeled_I: "5th" });
    expect(cw.flags).toContain("unlabeled_extras");
  });

  it("2023 layout: month precision when month present, quarter otherwise; rent band min/max; managed rows kept", () => {
    const conv23 = sheet("Convential Deals", [
      ["Sr. No", "Project Name", "Transaction Type", "Grade", "Location", "Corridor A", "Corridor B", "Retails / Office", "Lessee", "E/RN/F", "Quater of Transaction",
        "Type of absorbtion", "Earlier occupied", "Area leased (sq.ft.)", "Agent / IPC", "Lease/ outright", "Month", "Rental (sq.ft.)", "Floor condition", "Floor Occupied", "Mandate / Non-Mandate", "Remark"],
      [{ formula: "=1", result: 1 }, "Alpha Park", "Managed", "A", "Kharadi", "E", "K", "Office", "Acme Pvt Ltd", "F", "Q1", "Fresh", null, 30000, "Broker Firm", "Lease", "Feb", "80-84", "WS", 5, "Mandate", null],
      [{ formula: "=A2+1", result: 2 }, "Beta House", "Conventional", "A", "Baner", "W", "B", "Office", "Bolt Ltd", "F", "Q3", "Fresh", null, 9000, null, "Lease", null, "75", "BS", 2, "Non", null],
    ]);
    const { staged } = run(workbook(conv23), [], { ...OPTS, file_name: "Transaction Tracker 2023 - Final.xlsx" });
    const [a, b] = staged.map((s) => s.record as TransactionRecord);
    expect(a).toMatchObject({ deal_type: "managed", period_precision: "month", period_start: "2023-02-01", period_end: "2023-02-28", rent_min: 80, rent_max: 84 });
    expect(b).toMatchObject({ period_precision: "quarter", period_start: "2023-07-01", period_end: "2023-09-30", rent_min: 75, rent_max: 75 });
    expect(staged[1].flags).toContain("quarter_convention_assumed");
  });

  it("no year anywhere => unknown precision, never a synthesised date", () => {
    const { staged } = run(workbook(conv22), [], { ...OPTS, file_name: "tracker.xlsx" });
    expect((staged[0].record as TransactionRecord)).toMatchObject({ period_start: null, period_precision: "unknown" });
  });

  it("pivot / analysis sheets are deliberately excluded, not quarantined", () => {
    const pivot = sheet("sheet3", [[null], [null], ["Row Labels", "Sum of Area leased (sq.ft.)"], ["Eastern", 3553978], ["Grand Total", 6136946]]);
    const { det, staged } = run(workbook(conv22, pivot), [], { ...OPTS, file_name: "Tracker 2022.xlsx" });
    expect(det[1].status).toBe("summary");
    expect(staged.filter((s) => s.sheet === "sheet3").every((s) => s.status === "excluded" && s.reason === "pivot_or_analysis_summary")).toBe(true);
  });
});

describe("market_matrix_v1 (historical periods)", () => {
  const supply = sheet("supply", [
    [null, "Total Supply in Million SQFT"],
    ["Year/Quarter", "SBD East", "SBD West", "PBD West", "CBD", "PBD East", "Total"],
    [2024, 1.25, 2.5, 0.5, 0, 1.06, 5.31],
    [2025, 1.2, 1.1, 0.4, 0.1, 0.5, 3.3],
    [2026, null, null, null, null, null, null],
  ]);
  it("skips the metadata row, unpivots non-blank cells, Total is a control (not an observation), 2026 not invented", () => {
    const { det, mapped, staged } = run(workbook(supply));
    expect(det[0]).toMatchObject({ adapter: "market_matrix_v1", headerRow: 2, layoutRows: 2, rowsConsidered: 3 });
    const obs = staged.flatMap((s) => (s.record as MarketRowRecord | null)?.observations ?? []);
    expect(obs.length).toBe(10);
    expect(obs.every((o) => o.metric === "supply" && o.unit === "million_sf" && o.geography_raw !== "Total")).toBe(true);
    expect(obs.find((o) => o.geography_raw === "CBD" && o.year === 2024)!.value).toBe(0); // a reported zero stays a zero
    expect(staged[2]).toMatchObject({ status: "excluded", reason: "no_values_period_not_reported" });
    expect(obs.some((o) => o.year === 2026)).toBe(false);
    const ctl = mapped[0].result.controls;
    expect(ctl.map((c) => c.ok)).toEqual([true, true]);
  });
  it("a Total that does not reconcile at displayed precision fails the control", () => {
    const bad = sheet("supply", [[null, "Total Supply in Million SQFT"], ["Year/Quarter", "CBD", "SBD East", "Total"], [2023, 1.11, 2.22, 3.4]]);
    const c = run(workbook(bad)).mapped[0].result.controls[0];
    expect(c.ok).toBe(false);
    expect(c.actual).toBeCloseTo(3.33);
  });
  it("rental matrix is transposed: geographies down, years across", () => {
    const rent = sheet("rent", [
      [null, "Average Rental"],
      ["Year/Quarter", "2024", "2025", "2026"],
      ["CBD", 95, 98, 101],
      ["SBD East", 80, null, 84],
    ]);
    const { staged, mapped } = run(workbook(rent));
    const obs = staged.flatMap((s) => (s.record as MarketRowRecord).observations);
    expect(obs.length).toBe(5);
    expect(obs.find((o) => o.geography_raw === "SBD East" && o.year === 2026)!.value).toBe(84);
    expect(obs.every((o) => o.metric === "rent" && o.unit === "rent_unit_unstated")).toBe(true);
    const y26 = obs.find((o) => o.year === 2026)!;
    expect(y26.period_type).toBe("snapshot"); // current year: completeness unknown
    expect(obs.find((o) => o.year === 2024)!.period_type).toBe("full_year");
    expect(mapped[0].result.issues.map((i) => i.kind)).toContain("rent_unit_unconfirmed");
  });
  it("stock is a snapshot series: no sums over time or geography are produced", () => {
    const stock = sheet("stock", [[null, "Total Area/ Stock in Million SQFt"], ["Year/Quarter", "CBD", "SBD East"], [2024, 10, 20], [2025, 10.5, 21]]);
    const { staged, mapped } = run(workbook(stock));
    const obs = staged.flatMap((s) => (s.record as MarketRowRecord).observations);
    expect(obs.map((o) => o.value)).toEqual([10, 20, 10.5, 21]);
    expect(mapped[0].result.controls).toEqual([]);
    expect(mapped[0].result.issues.map((i) => i.kind)).toContain("stock_not_summed");
  });
  it("a matrix with no stated metric is an unknown schema (never guessed from the file name)", () => {
    const m = sheet("Pune_absorption_2018_2026", [["Year/Quarter", "CBD"], [2024, 1]]);
    expect(run(workbook(m)).det[0].status).toBe("unknown");
  });
});

describe("comparison_reference_v1", () => {
  it("whole workbook is reference-only, including chart tabs; formulas kept as text", () => {
    const s1 = sheet("Summary", [[null], [null], [null], ["5 Year- Lock-in Comparative"], [null, null, "ITPP"], [null, "Cumulative", { formula: "=Scoring!L26", result: null }]]);
    const s2 = sheet("5 Year Chart", [[null, "Cumulative", 1]]);
    const { det, mapped, staged } = run(workbook(s1, s2));
    expect(det.every((d) => d.adapter === "comparison_reference_v1")).toBe(true);
    expect(staged.every((s) => s.status === "accepted" && s.record?.kind === "reference")).toBe(true);
    expect(JSON.stringify(staged.find((s) => s.row_number === 6)!.record)).toContain("=Scoring!L26");
    expect(mapped[0].result.issues.map((i) => i.kind)).toEqual(["reference_only", "template_reuse_blocked"]);
  });
});

describe("reconciliation + revision diff", () => {
  it("raw rows = accepted + quarantined + excluded; duplicates reported within accepted", () => {
    const conv = sheet("Convential Deals", [
      ["Sr. No", "Conventional Vs Manages", "Type of Absorption", "Corridor A", "Corridor B", "Project Name", "Location", "Lessee", "E/R/N", "Earlier occupied", "Area leased (sq.ft.)", "Agent / IPC", "Lease/ outright"],
      [1, "Conventional", "Fresh", "E", "K", "Alpha", "Kharadi", "Acme", "E", null, 25000, null, "Lease"],
      [2, "Conventional", "Fresh", "E", "K", "Alpha", "Kharadi", "Acme", "E", null, 25000, null, "Lease"],
      [null, null, null, null, null, null, null, null, null, null, 50000, null, null],
      [4, "Conventional", "Fresh", "E", "K", "Gamma", "Kharadi", null, "E", null, 1000, null, "Lease"],
    ]);
    const { det, staged, mapped } = run(workbook(conv), [], { ...OPTS, file_name: "t 2022.xlsx" });
    expect(markDuplicates(staged)).toBe(1);
    const r = reconcile(staged, det, mapped.flatMap((m) => m.result.controls), { masters: {}, observations: {}, rows_linked_to_existing_master: 0, match_candidates: 0 }, 0);
    expect(r).toMatchObject({ rows_considered: 4, accepted: 2, duplicates: 1, quarantined: 1, excluded: 1, layout_rows: 1, reconciles: true });
  });

  it("field diff between versions: changed rows show before/after, unchanged rows are not repeated", () => {
    const mk = (area: number) => {
      const raw = rawJson({ rowNumber: 2, cells: [{ v: "Alpha", t: "s" }, { v: area, t: "n" }] });
      return { key: diffKey("S", "alpha|kharadi", hashOf(raw)), sheet: "S", identity_key: "alpha|kharadi", row_hash: hashOf(raw), fields: { total_area: area }, locator: "S!2" };
    };
    const same = { key: "S|beta", sheet: "S", identity_key: "beta", row_hash: "h", fields: {}, locator: "S!3" };
    const d = diffVersions("prev", [mk(100), same], [mk(120), same]);
    expect(d).toMatchObject({ changed: 1, unchanged: 1, added: 0, removed: 0 });
    expect(d.samples[0].fields).toEqual([{ field: "total_area", before: 100, after: 120 }]);
  });

  it("identity-key change at the same locator is a field change, not add+remove", () => {
    const a = { key: "S|k1", sheet: "S", identity_key: "k1", row_hash: "1", fields: { area: 1 }, locator: "S!2" };
    const b = { key: "S|k2", sheet: "S", identity_key: "k2", row_hash: "2", fields: { area: 2 }, locator: "S!2" };
    expect(diffVersions("p", [a], [b])).toMatchObject({ changed: 1, added: 0, removed: 0 });
  });

  it("moved rows report only real changes: null, undefined and blank are the same value", () => {
    const prev = { key: "S|k1", sheet: "S", identity_key: "k1", row_hash: "h-at-row-2", fields: { expected_rent: null, area: 5000, notes: "" }, locator: "S!2" };
    const moved = { key: "S|k1", sheet: "S", identity_key: "k1", row_hash: "h-at-row-9", fields: { area: 5000, notes: null, expected_rent: undefined }, locator: "S!9" };
    const d = diffVersions("p", [prev], [moved]);
    expect(d).toMatchObject({ changed: 0, unchanged: 1, added: 0, removed: 0 });
    expect(d.samples).toEqual([]);
    const edited = { ...moved, fields: { area: 5200, expected_rent: "" } };
    const d2 = diffVersions("p", [prev], [edited]);
    expect(d2.changed).toBe(1);
    expect(d2.samples[0].fields).toEqual([{ field: "area", before: 5000, after: 5200 }]);
  });

  it("range parser keeps unparseable text instead of inventing numbers", () => {
    expect(range({ v: "On request", t: "s" })).toMatchObject({ min: null, max: null, text: "On request", ok: false });
    expect(range({ v: "25K", t: "s" })).toMatchObject({ min: 25000, max: 25000 });
  });
});
