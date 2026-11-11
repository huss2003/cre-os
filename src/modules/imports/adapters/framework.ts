/* Adapter framework: header-driven sheet roles, row records, and shared row helpers. Pure functions. */
import type { AdapterOptions, Cell, ParsedRow, ParsedSheet, RowIssue, RowOutcome, SheetMapResult } from "../types";
import { colLetter, normHeader } from "../normalize";

export interface FieldSpec {
  key: string;
  label: string;
  headers: string[]; // normalised header aliases (normHeader form)
  required?: boolean;
}

export interface RoleInput {
  sheet: ParsedSheet;
  headerRow: number; // 1-based source row number of the header; 0 = headerless (first row is data)
  columnMap: Record<string, number>; // field key -> 0-based column index
  unlabeledColumns: number[];
  dataRows: ParsedRow[];
}

export interface RoleSpec {
  role: string;
  label: string;
  sheetNamePattern?: RegExp; // sheet must match (discriminator, e.g. lock-in)
  sheetNameExclude?: RegExp;
  fields?: FieldSpec[]; // header-driven roles
  allowUnlabeled?: boolean; // keep unlabeled columns as reviewable extras
  headerless?: boolean; // positional role: only usable through an APPROVED adapter_mapping
  positionalDefault?: string[]; // suggested positional map (field keys in column order)
  /**
   * Custom detection for non-tabular layouts (market matrices, reference templates) or fuzzy header matching. Returns the
   * header row (1-based) or null. A detector may also return the column map it resolved and the labelled columns it
   * could not map. `aliases` are the workspace's learned header aliases ("adapter:role:field" -> normalised headers).
   */
  detect?: (sheet: ParsedSheet, aliases?: Record<string, string[]>) => {
    headerRow: number; signature: string; columnMap?: Record<string, number>; matched?: number; extraColumns?: string[]; issues?: RowIssue[];
  } | null;
  map: (input: RoleInput, opts: AdapterOptions) => SheetMapResult;
}

export interface Adapter {
  id: string;
  version: string;
  label: string;
  roles: RoleSpec[];
}

/** Accessor over one source row using the resolved column map. */
export class RowRecord {
  constructor(public row: ParsedRow, private map: Record<string, number>, private unlabeled: number[]) {}
  get(key: string): Cell {
    const i = this.map[key];
    if (i === undefined) return { v: null, t: "null" };
    return this.row.cells[i] ?? { v: null, t: "null" };
  }
  has(key: string) {
    return this.map[key] !== undefined;
  }
  /** Values in unlabeled columns, keyed "unlabeled_<Letter>" (kept as reviewable source extras). */
  extras(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const i of this.unlabeled) {
      const c = this.row.cells[i];
      if (c && c.t !== "null") out[`unlabeled_${colLetter(i)}`] = c.f ? { v: c.v, f: c.f } : c.v;
    }
    return out;
  }
  /** Mapped raw values by field key (for mapped_json / diffs). */
  rawFields(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(this.map)) {
      const c = this.get(k);
      out[k] = c.v;
    }
    return out;
  }
  isEmpty() {
    return this.row.cells.every((c) => c.t === "null");
  }
  texts(): string[] {
    return this.row.cells.filter((c) => c.t === "s").map((c) => String(c.v));
  }
}

export function records(input: RoleInput): RowRecord[] {
  return input.dataRows.map((r) => new RowRecord(r, input.columnMap, input.unlabeledColumns));
}

export const issue = (kind: string, message: string, severity: RowIssue["severity"] = "review", details?: Record<string, unknown>): RowIssue => ({
  kind, message, severity, details,
});

export function quarantine(sheet: string, row: ParsedRow, reason: string, issues: RowIssue[] = []): RowOutcome {
  return { sheet, rowNumber: row.rowNumber, status: "quarantined", reason, issues };
}
export function exclude(sheet: string, row: ParsedRow, reason: string): RowOutcome {
  return { sheet, rowNumber: row.rowNumber, status: "excluded", reason, issues: [] };
}

/** Field spec helper: f("building", "Building name", ["building name"], true). */
export const f = (key: string, label: string, headers: string[], required = false): FieldSpec => ({
  key, label, headers: headers.map(normHeader), required,
});

const TOTAL_RE = /\b(grand\s*total|sub-?\s*total|total|summary)\b/i;
export function looksLikeTotal(rec: RowRecord): boolean {
  return rec.texts().some((t) => TOTAL_RE.test(t));
}
