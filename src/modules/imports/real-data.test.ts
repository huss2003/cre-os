/* Regressions found by the real-data end-to-end run (scripts/real-data-e2e.ts) on the tenant's Pune workbooks. Synthetic rows that copy the real layouts. */
import { describe, it, expect } from "vitest";
import { detectWorkbook, mapWorkbook } from "./detect";
import { buildStaged } from "./reconcile";
import { month, quarter } from "./normalize";
import { atScale, sameValue } from "./pipeline";
import { DEFAULT_SIZE_RULES, type AdapterOptions, type ParsedRow, type TransactionRecord } from "./types";
import { sheet, workbook } from "./testkit";

const OPTS: AdapterOptions = { as_of: "2026-11-01", size_rules: DEFAULT_SIZE_RULES, file_name: "95fe5909-Transaction_Tracker_2023_-_Final.xlsx" };

function run(wb: ReturnType<typeof workbook>, opts = OPTS) {
  const det = detectWorkbook(wb, []);
  const mapped = mapWorkbook(wb, det, opts);
  const rows = new Map(wb.sheets.map((s) => [s.name, new Map<number, ParsedRow>(s.rows.map((r) => [r.rowNumber, r]))]));
  return { det, staged: buildStaged(mapped, rows) };
}

describe("real data: period text with a 4-digit year", () => {
  it("'Q1 2023' is 2023, not 2020 (2-digit branch must not match the first two digits of a 4-digit year)", () => {
    expect(quarter("Q1 2023")).toEqual({ q: 1, year: 2023 });
    expect(quarter("Q4 2022")).toEqual({ q: 4, year: 2022 });
    expect(quarter("Q2-23")).toEqual({ q: 2, year: 2023 });
    expect(quarter("Q3 FY24")).toEqual({ q: 3, year: 2024 });
    expect(quarter("Q2")).toEqual({ q: 2, year: null });
    expect(month("Jan 2023")).toEqual({ m: 1, year: 2023 });
    expect(month("June")).toEqual({ m: 6, year: null });
  });

  it("2023 tracker rows ('Q1 2023' + 'January') are dated January 2023 with month precision; co-working 'Q3 2023' => Q3 2023", () => {
    const conv = sheet("Convential Deals", [
      ["Sr. No", "Project Name", "Transaction Type", "Grade", "Location", "Corridor A", "Corridor B", "Retails / Office", "Lessee", "E/RN/F", "Quater of Transaction",
        "Type of absorbtion", "Earlier occupied", "Area leased (sq.ft.)", "Agent / IPC", "Lease/ outright", "Month", "Rental (sq.ft.)", "Floor condition", "Floor Occupied", "Mandate / Non-Mandate", "Remark"],
      [1, "Alpha IT Park", "Conventional ", "B", "Aundh", "SBD West", "Western", "Office", "Acme Technologies Ltd", "R+E", "Q1 2023", "IT", 2000, 4630, "C&W", "Lease", "January", "80 - 84", "Plug & play", "A - 2", "NM", null],
      [{ formula: "=A2+1", result: 2 }, "Beta House", "Conventional", "B", "Baner", "SBD West", "Western", "Office", "Bolt Ltd", "F", "Q2 2023", "Non - IT", null, 4500, "Local", "Lease", "June", "60 - 65", "Plug & play", 5, "NM", null],
    ]);
    const cw = sheet("Co-working Transactions", [
      ["Sr. No", "Player Name", "Building Name", "Location ", "Client Name", "Seats Occupied", "Broker / IPC", "Quarter of Transaction", "Month of Transaction", "Cost", "Area Occupied"],
      [1, "Hub Spaces", "Alpha IT Park", "Kharadi", "Delta Corp", 11, "C&W", "Q3 2023", null, null, null],
    ]);
    const { det, staged } = run(workbook(conv, cw));
    expect(det.map((d) => d.adapter)).toEqual(["transactions_2023_v1", "transactions_2023_v1"]);
    const [a, b, c] = staged.map((s) => s.record as TransactionRecord);
    expect(a).toMatchObject({ period_start: "2023-01-01", period_end: "2023-01-31", period_precision: "month", area_sf: 4630 });
    expect(a.extras).toMatchObject({ quarter_convention: "calendar", earlier_occupied: 2000 });
    expect(b).toMatchObject({ period_start: "2023-06-01", period_precision: "month", area_sf: 4500, broker_name_raw: "Local" });
    expect(c).toMatchObject({ period_start: "2023-07-01", period_end: "2023-09-30", period_precision: "quarter" });
  });
});

describe("real data: footer summary lines under the 2022 deal table", () => {
  it("'Net Absorption' / 'Pre-Commitments' / 'Total Transactions with PC' lines are excluded (derived), real deals without area still quarantined", () => {
    const conv = sheet("Convential Deals", [
      ["Sr. No", "Conventional Vs Manages", "Type of Absorption", "Corridor A", "Corridor B", "Project Name", "Location", "Lessee", "E/R/N", "Earlier occupied", "Area leased (sq.ft.)", "Agent / IPC", "Lease/ outright"],
      [1, "Conventional", "IT", "SBD East", "Eastern", "Alpha Park", "Kharadi", "Acme Pvt Ltd", "PC", null, 422000, "C&W", "Lease"],
      [null, null, null, null, null, null, null, null, null, { formula: "=SUBTOTAL(9,J2:J2)", result: 0 }, { formula: "=SUBTOTAL(9,K2:K2)", result: 422000 }],
      [null, null, null, null, null, "Net Absorption", 4561522, "4.61 Mn"],
      [null, null, null, null, null, "Pre-Commitments ", 1284000, "1.28 Mn"],
      [null, null, null, null, null, "Total Transactions with PC", 6136946, "6.1 Mn"],
      [null, null, null, null, null, "Co Working Internal Seater deals", 20834, null],
      [7, "Conventional", "IT", "SBD East", "Eastern", "Gamma", "Kharadi", "Core Inc", "E", null, null, null, "Lease"],
    ]);
    const { staged } = run(workbook(conv), { ...OPTS, file_name: "Transaction Tracker 2022-Pivot Table.xlsx" });
    expect(staged.map((s) => [s.row_number, s.status, s.reason])).toEqual([
      [2, "accepted", null],
      [3, "excluded", "summary_or_note"],
      [4, "excluded", "summary_or_total"],
      [5, "excluded", "summary_or_total"],
      [6, "excluded", "summary_or_total"],
      [7, "excluded", "summary_or_total"],
      [8, "quarantined", "missing_required"],
    ]);
  });
});

describe("real data: lease numerics compared at the stored scale", () => {
  it("fractional tenure 52.866 stored as numeric(8,2) 52.87 is not a field conflict; a real change still is", () => {
    expect(atScale(52.866, 2)).toBe(52.87);
    expect(sameValue(atScale(52.866, 2), "52.87")).toBe(true);
    expect(sameValue(atScale(60, 2), "52.87")).toBe(false);
    expect(atScale(null, 2)).toBeNull();
    expect(atScale("NA", 2)).toBe("NA");
  });
});

describe("real data: long proposal keys are looked up in URL-bounded chunks", () => {
  it("862 person-proposal keys split into chunks under the budget, none lost (150 per request used to hit HTTP 414)", async () => {
    const { keyChunks } = await import("./pipeline");
    const keys = Array.from({ length: 862 }, () => `imports.person:${crypto.randomUUID()}|${crypto.randomUUID()}`);
    const parts = keyChunks(keys);
    expect(parts.flat()).toEqual(keys);
    for (const p of parts) expect(p.reduce((s, k) => s + encodeURIComponent(`"${k}"`).length + 3, 0)).toBeLessThanOrEqual(4_000);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThan(150);
  });
});

describe("real data: floor-size ranges in the asset list", () => {
  it("reversed ranges are flagged for review; an implausible spread ('7,420 - 8') leaves min/max unknown but keeps the text", async () => {
    const { ASSET_HEADER } = await import("./testkit");
    const wb = workbook(sheet("Existing assets", [
      ASSET_HEADER,
      ["Weikfield IT CITI Info-Park D", "Nagar Road", "45,000 - 35,000", 400000, "G + 8", "Ready", 3],
      ["Kalpataru Infinia", "Yerwada", "7,420 - 8", 90000, "G + 6", "Ready", 1],
      ["Zero One", "Mundhwa", "25,000 - 25,000", 200000, "2B + G + 8", "Ready", 57],
      ["Zenith Complex", "Shivaji Nagar", "NA", 0, "G + 5", "Ready", 9],
    ]));
    const { staged } = run(wb, { ...OPTS, file_name: "existing_and_upcoming_Assets.xlsx" });
    const rec = (i: number) => staged[i].record as unknown as { floor_size_min_sf: number | null; floor_size_max_sf: number | null; floor_size_text: string | null; total_area_sf: number | null; total_area_source_zero: boolean };
    expect(staged.map((s) => s.status)).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    expect(rec(0)).toMatchObject({ floor_size_min_sf: 35000, floor_size_max_sf: 45000, floor_size_text: "45,000 - 35,000" });
    expect(staged[0].flags).toContain("floor_size_range_suspect");
    expect(staged[0].issues.map((i) => [i.kind, i.severity])).toContainEqual(["floor_size_range_suspect", "review"]);
    expect(rec(1)).toMatchObject({ floor_size_min_sf: null, floor_size_max_sf: null, floor_size_text: "7,420 - 8" });
    expect(staged[1].flags).toContain("floor_size_range_suspect");
    expect(staged[2].flags).not.toContain("floor_size_range_suspect");
    expect(rec(3)).toMatchObject({ floor_size_min_sf: null, floor_size_text: "NA", total_area_sf: null, total_area_source_zero: true }); // NA / 0 stay unknown
  });
});
