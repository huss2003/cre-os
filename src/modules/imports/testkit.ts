/* Synthetic fixture builders for imports tests (no real client data). Not imported by application code. */
import ExcelJS from "exceljs";
import type { Cell, ParsedSheet, ParsedWorkbook } from "./types";

export type FixtureCell = string | number | boolean | null | Date | { formula: string; result: unknown };

function toCell(v: FixtureCell): Cell {
  if (v === null || v === undefined || v === "") return { v: null, t: "null" };
  if (v instanceof Date) return { v: v.toISOString().slice(0, 10), t: "d" };
  if (typeof v === "number") return { v, t: "n" };
  if (typeof v === "boolean") return { v, t: "b" };
  if (typeof v === "object") {
    const r = v.result;
    const base: Cell = r instanceof Date ? { v: r.toISOString().slice(0, 10), t: "d" } : typeof r === "number" ? { v: r, t: "n" } : r == null ? { v: null, t: "null" } : { v: String(r), t: "s" };
    return { ...base, f: v.formula.startsWith("=") ? v.formula : `=${v.formula}` };
  }
  return { v, t: "s" };
}

/** In-memory parsed sheet (rows numbered from 1; fully empty rows dropped like the real parser). */
export function sheet(name: string, rows: FixtureCell[][]): ParsedSheet {
  const out: ParsedSheet = { name, rows: [], columnCount: 0, formulaCount: 0 };
  rows.forEach((r, i) => {
    const cells = r.map(toCell);
    let end = cells.length;
    while (end > 0 && cells[end - 1].t === "null" && !cells[end - 1].f) end--;
    if (!end) return;
    out.rows.push({ rowNumber: i + 1, cells: cells.slice(0, end) });
    out.columnCount = Math.max(out.columnCount, end);
    out.formulaCount += cells.filter((c) => c.f).length;
  });
  return out;
}

export const workbook = (...sheets: ParsedSheet[]): ParsedWorkbook => ({ format: "xlsx", sheets, warnings: [] });

/** Real .xlsx bytes (formulas stored with cached results; nothing is calculated). */
export async function xlsxBytes(sheets: { name: string; rows: FixtureCell[][] }[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r, i) => {
      r.forEach((v, j) => {
        if (v === null || v === undefined) return;
        const cell = ws.getCell(i + 1, j + 1);
        if (typeof v === "object" && !(v instanceof Date)) cell.value = { formula: v.formula.replace(/^=/, ""), result: v.result } as ExcelJS.CellFormulaValue;
        else cell.value = v as ExcelJS.CellValue;
      });
    });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export const ASSET_HEADER = ["Building Name", "Locality Name", "Floor Size (sft)", "Total Area (sft)", "Floors", "Status", "Transactions"];
export const LEASE_COMMON = ["Registration Date", "Building Name", "Locality", "Area (sft)", "Rate (Rs/sft/month)", "Floor", "Expiry Date",
  "Buyer/Tenant Company name", "Buyer/Tenant representative name", "Developer Name", "Lease Start Date", "Tenure"];
export const LEASE_LARGE_HEADER = [...LEASE_COMMON, "Lease", "Furnished Rate (Rs/sft/months)", "Rent Type"];
export const LEASE_SMALL_HEADER = ["Registration Date", "Building Name", "Building Type", "Locality", "Transaction Type", "Area (sft)", "Rate (Rs/sft/month)",
  "Floor", "Expiry Date", "Buyer/Tenant Company name", "Buyer/Tenant representative name", "Developer Name", "Lease Start Date", "Tenure"];

const d = (s: string) => new Date(`${s}T00:00:00Z`);
export { d as utcDate };

/** One large-tab lease row in LEASE_LARGE_HEADER order. Expiry is a formula with a cached value (never executed). */
export function largeLeaseRow(o: { reg?: string; building: string; locality: string; area: number; rate?: number; floor?: string | number; tenant: string; start: string; tenure: number; cached?: string; row: number }): FixtureCell[] {
  return [
    d(o.reg ?? "2022-01-10"), o.building, o.locality, o.area, o.rate ?? 80, o.floor ?? 3,
    { formula: `=EDATE(K${o.row},L${o.row})`, result: o.cached ? d(o.cached) : null },
    o.tenant, "Rep Person", "Dev Co", d(o.start), o.tenure, null, null, null,
  ];
}
