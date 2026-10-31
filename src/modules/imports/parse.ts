/*
 * Read-only parsing. Never executes macros, formulas or external links:
 *  - exceljs reads the OOXML parts as data; VBA projects and external-link parts are ignored.
 *  - Formula cells keep BOTH the original formula text (f) and the cached result (v). Nothing is recalculated.
 *  - .xls (BIFF) and other binary formats are rejected rather than guessed.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { Cell, ParsedRow, ParsedSheet, ParsedWorkbook } from "./types";

const EMPTY: Cell = { v: null, t: "null" };

function isoFromDate(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function scalar(v: unknown): Cell {
  if (v === null || v === undefined) return EMPTY;
  if (typeof v === "number") return Number.isFinite(v) ? { v, t: "n" } : { v: String(v), t: "e" };
  if (typeof v === "string") return v.trim() === "" ? EMPTY : { v, t: "s" };
  if (typeof v === "boolean") return { v, t: "b" };
  if (v instanceof Date) {
    const iso = isoFromDate(v);
    return iso ? { v: iso, t: "d" } : { v: String(v), t: "e" };
  }
  return { v: String(v), t: "s" };
}

/** Convert an exceljs cell value into a Cell (formula text kept, cached result used as value). */
export function cellFromExcel(value: unknown): Cell {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value !== "object" || value instanceof Date) return scalar(value);
  const o = value as Record<string, unknown>;
  if ("formula" in o || "sharedFormula" in o) {
    const f = String(o.formula ?? o.sharedFormula ?? "");
    let res = o.result;
    if (res && typeof res === "object" && !(res instanceof Date) && "error" in (res as object)) res = String((res as { error: unknown }).error);
    const base = scalar(res);
    return { ...base, f: f.startsWith("=") ? f : `=${f}` };
  }
  if ("richText" in o && Array.isArray(o.richText)) {
    return scalar((o.richText as { text?: string }[]).map((r) => r.text ?? "").join(""));
  }
  if ("text" in o && "hyperlink" in o) return scalar(o.text);
  if ("error" in o) return { v: String(o.error), t: "e" };
  return scalar(String(value));
}

function trimRow(cells: Cell[]): Cell[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1].t === "null" && !cells[end - 1].f) end--;
  return cells.slice(0, end);
}

export async function parseXlsx(bytes: Uint8Array): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs only reads; it has no formula engine and does not run VBA or follow external links.
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const sheets: ParsedSheet[] = [];
  const warnings: string[] = [];
  wb.eachSheet((ws) => {
    const rows: ParsedRow[] = [];
    let columnCount = 0;
    let formulaCount = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: Cell[] = [];
      const n = row.cellCount;
      for (let c = 1; c <= n; c++) {
        const cell = cellFromExcel(row.getCell(c).value);
        if (cell.f) formulaCount++;
        cells.push(cell);
      }
      const trimmed = trimRow(cells);
      if (trimmed.length === 0) return;
      columnCount = Math.max(columnCount, trimmed.length);
      rows.push({ rowNumber, cells: trimmed });
    });
    sheets.push({ name: ws.name, rows, columnCount, formulaCount });
  });
  return { format: "xlsx", sheets, warnings };
}

export function parseCsv(textContent: string, sheetName = "csv"): ParsedWorkbook {
  const res = Papa.parse<string[]>(textContent.replace(/^﻿/, ""), { header: false, skipEmptyLines: false, dynamicTyping: false });
  const rows: ParsedRow[] = [];
  let columnCount = 0;
  (res.data as string[][]).forEach((r, i) => {
    const cells = trimRow(
      r.map((raw): Cell => {
        const s = (raw ?? "").trim();
        if (s === "") return EMPTY;
        if (/^-?\d+(\.\d+)?$/.test(s)) return { v: Number(s), t: "n" };
        return { v: s, t: "s" };
      }),
    );
    if (cells.length === 0) return;
    columnCount = Math.max(columnCount, cells.length);
    rows.push({ rowNumber: i + 1, cells });
  });
  return { format: "csv", sheets: [{ name: sheetName, rows, columnCount, formulaCount: 0 }], warnings: res.errors.map((e) => e.message) };
}

export class UnsupportedFormatError extends Error {}

/** Dispatch by content sniffing (zip magic for OOXML) with filename only as a hint for CSV. */
export async function parseFile(bytes: Uint8Array, fileName: string): Promise<ParsedWorkbook> {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isOle = bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (isOle) throw new UnsupportedFormatError("Legacy binary .xls workbooks are not parsed; save as .xlsx (no macros needed) and re-upload.");
  if (isZip) return parseXlsx(bytes);
  if (/\.(csv|txt)$/i.test(fileName) || !bytes.some((b) => b === 0)) {
    const sheetName = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "csv";
    return parseCsv(new TextDecoder("utf-8").decode(bytes), sheetName);
  }
  throw new UnsupportedFormatError("Unsupported file type: upload .xlsx or .csv");
}

export function cellAt(row: ParsedRow, col: number): Cell {
  return row.cells[col] ?? EMPTY;
}
