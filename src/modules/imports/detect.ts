/*
 * Adapter registry + schema-signature detection (spec Part III: "Adapter registry keyed by file hash/schema signature,
 * not just filename"). Pure: no DB access. The pipeline passes in the workspace's APPROVED adapter mappings.
 *
 * Detection per sheet, in order:
 *   1. empty sheet                                   -> status "empty"
 *   2. comparison/reference workbook                 -> every sheet "mapped" to comparison_reference_v1 (reference only)
 *   3. built-in header-driven roles / custom detect  -> best (most specific) match, ties broken by the workbook's adapter
 *   4. approved adapter_mapping with same signature  -> "mapped" via mapping (header or positional/headerless)
 *   5. pivot / analysis layout                       -> status "summary" (rows deliberately excluded)
 *   6. otherwise                                     -> status "unknown" (rows quarantined, batch needs mapping review)
 * Unknown schemas are never silently remapped; a headerless tab is only read through an approved positional map.
 */
import { createHash } from "node:crypto";
import type { AdapterOptions, ParsedRow, ParsedSheet, ParsedWorkbook, RowIssue, RowOutcome, SheetMapResult } from "./types";
import { colLetter, normHeader } from "./normalize";
import { type Adapter, type RoleSpec, issue } from "./adapters/framework";
import { assetListV1, readyAssetV1 } from "./adapters/assets";
import { leaseLargeV1, leaseSmallV1 } from "./adapters/leases";
import { transactions2022V1, transactions2023V1 } from "./adapters/transactions";
import { marketMatrixV1 } from "./adapters/market";
import { comparisonReferenceV1, looksLikeComparison } from "./adapters/reference";

export const ADAPTERS: Adapter[] = [
  assetListV1, readyAssetV1, leaseLargeV1, leaseSmallV1, transactions2022V1, transactions2023V1, marketMatrixV1, comparisonReferenceV1,
];

export function getAdapter(id: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
export function getRole(adapterId: string, role: string): RoleSpec | undefined {
  return getAdapter(adapterId)?.roles.find((r) => r.role === role);
}

export interface ApprovedMapping {
  id: string;
  adapter: string;
  sheet_role: string;
  schema_signature: string;
  header_row: number;
  positional: boolean;
  column_map: Record<string, number>;
  version: number;
}

export interface MappingSuggestion {
  adapter: string;
  role: string;
  label: string;
  positional: boolean;
  columnMap: Record<string, number>;
  matched: number;
  fields: { key: string; label: string; required: boolean }[];
}

export interface SheetDetection {
  sheet: string;
  status: "mapped" | "unknown" | "summary" | "empty";
  adapter: string | null;
  adapterVersion: string | null;
  role: string | null;
  headerRow: number; // 1-based; 0 = headerless / no header
  signature: string;
  mappingSource: "builtin" | "approved_mapping" | null;
  mappingId: string | null;
  mappingVersion: number | null;
  columnMap: Record<string, number>;
  unlabeledColumns: number[];
  headers: string[]; // raw header labels (headerless: first-row values as samples)
  extraColumns: string[]; // labelled columns not mapped to a field (kept raw; schema review)
  suggestions: MappingSuggestion[];
  rowsConsidered: number;
  layoutRows: number;
}

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Header fingerprint: normalised non-empty labels in column order. */
export function headerSignature(labels: string[]): string {
  return `hdr:${sha16(labels.map((l) => normHeader(l)).filter(Boolean).join("|"))}`;
}

/** Headerless shape fingerprint: column count + per-column majority type over the first 20 rows. */
export function shapeSignature(sheet: ParsedSheet): string {
  const sample = sheet.rows.slice(0, 20);
  const types: string[] = [];
  for (let c = 0; c < sheet.columnCount; c++) {
    let n = 0, s = 0;
    for (const r of sample) {
      const cell = r.cells[c];
      if (!cell || cell.t === "null") continue;
      if (cell.t === "n") n++;
      else s++;
    }
    types.push(n === 0 && s === 0 ? "_" : n > s ? "n" : "s");
  }
  return `headerless:${sheet.columnCount}:${types.join("")}`;
}

const SUMMARY_RE = /^(row labels|column labels|grand total)$|^sum of |^count of |gross absorption analysis/i;
function looksLikeSummary(sheet: ParsedSheet): boolean {
  return sheet.rows.slice(0, 10).some((r) => r.cells.some((c) => c.t === "s" && SUMMARY_RE.test(String(c.v).trim())));
}

interface RoleMatch {
  adapter: Adapter;
  role: RoleSpec;
  headerRow: number;
  columnMap: Record<string, number>;
  matched: number;
  signature: string;
  headers: string[];
}

function matchHeaderRole(sheet: ParsedSheet, adapter: Adapter, role: RoleSpec): RoleMatch | null {
  if (role.sheetNamePattern && !role.sheetNamePattern.test(sheet.name)) return null;
  if (role.sheetNameExclude && role.sheetNameExclude.test(sheet.name)) return null;
  if (role.detect) {
    const d = role.detect(sheet);
    if (!d) return null;
    const hr = sheet.rows.find((r) => r.rowNumber === d.headerRow);
    return { adapter, role, headerRow: d.headerRow, columnMap: {}, matched: 100, signature: d.signature, headers: hr ? hr.cells.map((c) => String(c.v ?? "")) : [] };
  }
  if (!role.fields || role.headerless) return null;
  let best: RoleMatch | null = null;
  for (const row of sheet.rows.slice(0, 10)) {
    const labels = row.cells.map((c) => (c.t === "s" || c.t === "n" ? normHeader(c.v) : ""));
    const columnMap: Record<string, number> = {};
    const used = new Set<number>();
    for (const fld of role.fields) {
      const idx = labels.findIndex((l, i) => !used.has(i) && l !== "" && fld.headers.includes(l));
      if (idx >= 0) {
        columnMap[fld.key] = idx;
        used.add(idx);
      }
    }
    const requiredOk = role.fields.filter((x) => x.required).every((x) => columnMap[x.key] !== undefined);
    if (!requiredOk) continue;
    const matched = Object.keys(columnMap).length;
    if (!best || matched > best.matched) {
      const headers = row.cells.map((c) => (c.v === null ? "" : String(c.v)));
      best = { adapter, role, headerRow: row.rowNumber, columnMap, matched, signature: headerSignature(headers), headers };
    }
  }
  return best;
}

function unlabeledColumns(sheet: ParsedSheet, headerRow: number, columnMap: Record<string, number>): number[] {
  const header = sheet.rows.find((r) => r.rowNumber === headerRow);
  if (!header) return [];
  const mapped = new Set(Object.values(columnMap));
  const out: number[] = [];
  for (let c = 0; c < sheet.columnCount; c++) {
    if (mapped.has(c)) continue;
    const h = header.cells[c];
    if (h && h.t !== "null") continue;
    if (sheet.rows.some((r) => r.rowNumber > headerRow && r.cells[c] && r.cells[c].t !== "null")) out.push(c);
  }
  return out;
}

function base(sheet: ParsedSheet): SheetDetection {
  return {
    sheet: sheet.name, status: "unknown", adapter: null, adapterVersion: null, role: null, headerRow: 0, signature: "", mappingSource: null,
    mappingId: null, mappingVersion: null, columnMap: {}, unlabeledColumns: [], headers: [], extraColumns: [], suggestions: [],
    rowsConsidered: sheet.rows.length, layoutRows: 0,
  };
}

function withRows(d: SheetDetection, sheet: ParsedSheet): SheetDetection {
  const layout = sheet.rows.filter((r) => r.rowNumber <= d.headerRow).length;
  return { ...d, layoutRows: layout, rowsConsidered: sheet.rows.length - layout };
}

/** Suggestions for an unknown sheet: positional defaults (headerless) and partial header matches. */
function suggest(sheet: ParsedSheet): MappingSuggestion[] {
  const out: MappingSuggestion[] = [];
  for (const a of ADAPTERS) {
    for (const r of a.roles) {
      if (!r.fields) continue;
      const fields = r.fields.map((x) => ({ key: x.key, label: x.label, required: !!x.required }));
      if (r.headerless && r.positionalDefault) {
        if (r.positionalDefault.length !== sheet.columnCount) continue;
        const columnMap: Record<string, number> = {};
        r.positionalDefault.forEach((k, i) => (columnMap[k] = i));
        out.push({ adapter: a.id, role: r.role, label: `${a.label}: ${r.label}`, positional: true, columnMap, matched: r.positionalDefault.length, fields });
        continue;
      }
      let best: Record<string, number> = {};
      for (const row of sheet.rows.slice(0, 10)) {
        const labels = row.cells.map((c) => normHeader(c.v));
        const cm: Record<string, number> = {};
        for (const fld of r.fields) {
          const idx = labels.findIndex((l) => l !== "" && fld.headers.includes(l));
          if (idx >= 0) cm[fld.key] = idx;
        }
        if (Object.keys(cm).length > Object.keys(best).length) best = cm;
      }
      const matched = Object.keys(best).length;
      if (matched >= 2) out.push({ adapter: a.id, role: r.role, label: `${a.label}: ${r.label}`, positional: false, columnMap: best, matched, fields });
    }
  }
  return out.sort((x, y) => y.matched - x.matched).slice(0, 5);
}

/** Best-guess header row for an unknown sheet: first row whose cells are all text. */
function guessHeaderRow(sheet: ParsedSheet): ParsedRow | null {
  for (const r of sheet.rows.slice(0, 10)) {
    const nonEmpty = r.cells.filter((c) => c.t !== "null");
    if (nonEmpty.length >= 2 && nonEmpty.every((c) => c.t === "s")) return r;
    if (nonEmpty.length > 2) return null; // a data-like row came first: the sheet is headerless
  }
  return null;
}

export function detectWorkbook(wb: ParsedWorkbook, mappings: ApprovedMapping[] = []): SheetDetection[] {
  // 2. comparison/reference workbooks are reference-only as a whole (including chart/summary tabs)
  if (wb.sheets.some(looksLikeComparison)) {
    return wb.sheets.map((s) => {
      if (s.rows.length === 0) return { ...base(s), status: "empty" as const, rowsConsidered: 0 };
      return {
        ...base(s), status: "mapped" as const, adapter: comparisonReferenceV1.id, adapterVersion: comparisonReferenceV1.version, role: "reference",
        signature: "comparison_reference_v1:comparative", mappingSource: "builtin" as const,
      };
    });
  }
  const perSheet = wb.sheets.map((s) => ({ sheet: s, matches: ADAPTERS.flatMap((a) => a.roles.map((r) => matchHeaderRole(s, a, r)).filter((m): m is RoleMatch => !!m)) }));
  // adapter score across the workbook = sum of best match per sheet (used only to break ties)
  const adapterScore = new Map<string, number>();
  for (const { matches } of perSheet) {
    const bestPer = new Map<string, number>();
    for (const m of matches) bestPer.set(m.adapter.id, Math.max(bestPer.get(m.adapter.id) ?? 0, m.matched));
    for (const [k, v] of bestPer) adapterScore.set(k, (adapterScore.get(k) ?? 0) + v);
  }
  return perSheet.map(({ sheet, matches }) => {
    const d = base(sheet);
    if (sheet.rows.length === 0) return { ...d, status: "empty" as const, rowsConsidered: 0 };
    if (matches.length) {
      matches.sort((a, b) => b.matched - a.matched || (adapterScore.get(b.adapter.id) ?? 0) - (adapterScore.get(a.adapter.id) ?? 0) || ADAPTERS.indexOf(a.adapter) - ADAPTERS.indexOf(b.adapter));
      const m = matches[0];
      const mapped = new Set(Object.values(m.columnMap));
      const extra = m.role.detect ? [] : m.headers.map((h, i) => ({ h, i })).filter(({ h, i }) => h.trim() !== "" && !mapped.has(i)).map(({ h, i }) => `${colLetter(i)}: ${h}`);
      return withRows({
        ...d, status: "mapped", adapter: m.adapter.id, adapterVersion: m.adapter.version, role: m.role.role, headerRow: m.headerRow, signature: m.signature,
        mappingSource: "builtin", columnMap: m.columnMap, headers: m.headers, extraColumns: extra,
        unlabeledColumns: m.role.allowUnlabeled ? unlabeledColumns(sheet, m.headerRow, m.columnMap) : [],
      }, sheet);
    }
    // 4. approved mapping (header fingerprint first, then headerless shape)
    const hr = guessHeaderRow(sheet);
    const hdrSig = hr ? headerSignature(hr.cells.map((c) => String(c.v ?? ""))) : null;
    const shape = shapeSignature(sheet);
    const approved = mappings
      .filter((mp) => mp.schema_signature === hdrSig || mp.schema_signature === shape)
      .sort((a, b) => b.version - a.version)[0];
    if (approved && getRole(approved.adapter, approved.sheet_role)) {
      const a = getAdapter(approved.adapter)!;
      const headerRow = approved.positional ? 0 : approved.header_row;
      const header = sheet.rows.find((r) => r.rowNumber === headerRow);
      return withRows({
        ...d, status: "mapped", adapter: a.id, adapterVersion: a.version, role: approved.sheet_role, headerRow, signature: approved.schema_signature,
        mappingSource: "approved_mapping", mappingId: approved.id, mappingVersion: approved.version, columnMap: approved.column_map,
        headers: header ? header.cells.map((c) => String(c.v ?? "")) : (sheet.rows[0]?.cells.map((c) => String(c.v ?? "")) ?? []),
      }, sheet);
    }
    if (looksLikeSummary(sheet)) return { ...d, status: "summary" as const, signature: hdrSig ?? shape };
    const headerless = !hr;
    return {
      ...d, status: "unknown" as const, signature: headerless ? shape : hdrSig!, headerRow: headerless ? 0 : hr!.rowNumber,
      headers: (headerless ? sheet.rows[0] : hr!).cells.map((c) => String(c.v ?? "")), suggestions: suggest(sheet),
      rowsConsidered: sheet.rows.length,
    };
  });
}

export interface SheetMapping {
  detection: SheetDetection;
  result: SheetMapResult;
}

/** Run each mapped sheet's adapter role. Unknown sheets => every row quarantined; summary sheets => rows excluded. */
export function mapWorkbook(wb: ParsedWorkbook, detections: SheetDetection[], opts: AdapterOptions): SheetMapping[] {
  return wb.sheets.map((sheet, i) => {
    const det = detections[i];
    if (det.status === "empty") return { detection: det, result: { outcomes: [], controls: [], issues: [] } };
    if (det.status === "summary") {
      return {
        detection: det,
        result: {
          outcomes: sheet.rows.map((r): RowOutcome => ({ sheet: sheet.name, rowNumber: r.rowNumber, status: "excluded", reason: "pivot_or_analysis_summary", issues: [] })),
          controls: [],
          issues: [issue("summary_sheet", `Sheet "${sheet.name}" is a pivot/analysis summary; rows deliberately excluded (derived, not source records)`, "info")],
        },
      };
    }
    if (det.status === "unknown") {
      const unknownIssue: RowIssue = issue("unknown_schema", `Sheet "${sheet.name}" does not match any adapter or approved mapping (${det.signature}); rows quarantined until a mapping is approved`, "blocking", { signature: det.signature, headers: det.headers });
      return {
        detection: det,
        result: {
          outcomes: sheet.rows.map((r): RowOutcome => ({ sheet: sheet.name, rowNumber: r.rowNumber, status: "quarantined", reason: "unknown_schema", issues: [] })),
          controls: [],
          issues: [unknownIssue],
        },
      };
    }
    const role = getRole(det.adapter!, det.role!)!;
    const dataRows = sheet.rows.filter((r) => r.rowNumber > det.headerRow);
    const result = role.map({ sheet, headerRow: det.headerRow, columnMap: det.columnMap, unlabeledColumns: det.unlabeledColumns, dataRows }, opts);
    if (det.mappingSource === "approved_mapping") {
      for (const o of result.outcomes) o.flags = [...(o.flags ?? []), det.headerRow === 0 ? "positional_map" : "approved_mapping"];
    }
    if (det.extraColumns.length) {
      result.issues.push(issue("schema_extra_columns", `Columns not used by ${det.adapter}/${det.role} are kept raw only: ${det.extraColumns.join(", ")}`, "info", { columns: det.extraColumns }));
    }
    return { detection: det, result };
  });
}
