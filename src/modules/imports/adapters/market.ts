/*
 * market_matrix_v1 (spec Part III adapter 7, Part V files 4-7 and "Market-series interpretation").
 * - Skips the metadata (title) row and uses the actual header labels.
 * - Unpivots geography x year into one observation per non-blank cell. Blank cells stay unknown (never 0, never invented).
 * - The rental matrix is transposed (years across, geographies down): orientation is detected from the header labels.
 * - A "Total" column/row is a reconciliation CONTROL, never an observation. Flow series (supply/absorption) are
 *   checked at displayed precision; stock is a snapshot and is never summed (over time or across geographies).
 * - The current/latest year has unknown period completeness: it is stored as a "snapshot", not as a full year.
 */
import Decimal from "decimal.js";
import type { AdapterOptions, ControlCheck, MarketObservationRecord, MarketRowRecord, ParsedRow, ParsedSheet, RowIssue, RowOutcome, SheetMapResult } from "../types";
import { colLetter, exactKey, normHeader, num, text, yearBounds } from "../normalize";
import { type Adapter, type RoleInput, exclude, issue, quarantine } from "./framework";

type Metric = MarketObservationRecord["metric"];

const HEADER_FIRST = new Set(["year quarter", "year", "period", "geography", "micro market", "micromarket", "location"]);
const TOTAL_LABEL = /^(total|grand total|pune|overall|city total)$/i;
const FLOW: Metric[] = ["supply", "absorption"];

export function metricFromTitle(title: string): Metric | null {
  if (/absorption|take[\s-]?up|leasing/i.test(title)) return "absorption";
  if (/supply|completion/i.test(title)) return "supply";
  if (/stock|total area/i.test(title)) return "stock";
  if (/rent/i.test(title)) return "rent";
  return null;
}

function unitFromTitle(title: string, metric: Metric): string {
  if (/million\s*sq\.?\s*ft|mn\s*sq\.?\s*ft|msf/i.test(title)) return "million_sf";
  if (metric === "rent") return "rent_unit_unstated";
  return "unit_unstated";
}

function yearOf(v: unknown): number | null {
  const s = String(v ?? "").trim();
  const m = s.match(/^((?:19|20)\d{2})(?:\.0+)?$/);
  return m ? +m[1] : null;
}

function headerIndex(sheet: ParsedSheet): number {
  for (let i = 0; i < Math.min(6, sheet.rows.length); i++) {
    const first = normHeader(sheet.rows[i].cells[0]?.v);
    if (HEADER_FIRST.has(first)) return i;
  }
  return -1;
}

function titleOf(sheet: ParsedSheet, hi: number): string {
  const parts: string[] = [];
  for (let i = 0; i < hi; i++) for (const c of sheet.rows[i].cells) if (c.t === "s") parts.push(String(c.v));
  return parts.join(" ").trim();
}

function detectMatrix(sheet: ParsedSheet): { headerRow: number; signature: string } | null {
  const hi = headerIndex(sheet);
  if (hi < 0) return null;
  const metric = metricFromTitle(titleOf(sheet, hi));
  if (!metric) return null; // no stated metric => unknown schema (mapping review), never guessed from the file name
  const labels = sheet.rows[hi].cells.slice(1).map((c) => normHeader(c.v)).filter(Boolean);
  const transposed = labels.length > 0 && labels.every((l) => yearOf(l) !== null);
  const geo = transposed ? "years_across" : labels.join(",");
  return { headerRow: sheet.rows[hi].rowNumber, signature: `market_matrix_v1:${metric}:${transposed ? "transposed" : "years_down"}:${geo}` };
}

function decimals(raw: string | null): number {
  if (!raw) return 0;
  const m = raw.replace(/,/g, "").match(/\.(\d+)$/);
  return m ? m[1].length : 0;
}

function periodFor(year: number, currentYear: number) {
  const b = yearBounds(year);
  const incomplete = year >= currentYear;
  return { start: b.start, end: b.end, type: (incomplete ? "snapshot" : "full_year") as MarketObservationRecord["period_type"], incomplete };
}

function definitionFor(metric: Metric, title: string, incomplete: boolean): string {
  const base = `Source label: "${title}"`;
  const extra =
    metric === "absorption" ? "; gross/net not stated" :
    metric === "rent" ? "; unit, area basis and weighting not stated (confirm Rs/SF/month)" :
    metric === "stock" ? "; point-in-time stock (never summed)" : "";
  return `${base}${extra}${incomplete ? "; period completeness unknown" : ""}`;
}

function mapMatrix(input: RoleInput, opts: AdapterOptions): SheetMapResult {
  const sheet = input.sheet;
  const hiIdx = sheet.rows.findIndex((r) => r.rowNumber === input.headerRow);
  const header = sheet.rows[hiIdx];
  const title = titleOf(sheet, hiIdx);
  const metric = metricFromTitle(title) as Metric;
  const unit = unitFromTitle(title, metric);
  const currentYear = Number((opts.as_of ?? new Date().toISOString().slice(0, 10)).slice(0, 4));
  const labels = header.cells.map((c) => (c.v === null ? "" : String(c.v).trim()));
  const transposed = labels.slice(1).filter(Boolean).every((l) => yearOf(l) !== null);
  const outcomes: RowOutcome[] = [];
  const controls: ControlCheck[] = [];
  const issues: RowIssue[] = [];
  const geoCols: number[] = [];
  let totalCol = -1;
  for (let c = 1; c < labels.length; c++) {
    if (!labels[c]) continue;
    if (!transposed && TOTAL_LABEL.test(labels[c])) totalCol = c;
    else geoCols.push(c);
  }
  if (metric === "rent") issues.push(issue("rent_unit_unconfirmed", "Rental series: unit, area basis and weighting are not stated; confirm before comparison", "review"));
  if (metric === "stock") issues.push(issue("stock_not_summed", "Stock is a point-in-time snapshot; it is never summed over years or used to infer vacancy", "info"));
  if (metric === "absorption") issues.push(issue("absorption_definition", "Absorption definition (gross/net) not stated; no vacancy inference from stock minus absorption", "info"));

  const rowObs = (row: ParsedRow, label: string, cols: { col: number; year: number; geo: string }[]): RowOutcome => {
    const observations: MarketObservationRecord[] = [];
    const flags: string[] = [];
    const rowIssues: RowIssue[] = [];
    let blanks = 0;
    for (const { col, year, geo } of cols) {
      const n = num(row.cells[col]);
      if (n.blank) { blanks++; continue; }
      if (!n.ok || n.value === null) {
        rowIssues.push(issue("type_error", `Non-numeric value "${n.raw}" at ${colLetter(col)}${row.rowNumber}`, "review", { col: colLetter(col), raw: n.raw }));
        continue;
      }
      const p = periodFor(year, currentYear);
      if (p.incomplete) flags.push("period_completeness_unknown");
      observations.push({
        metric, geography_raw: geo, year, period_start: p.start, period_end: p.end, period_type: p.type, unit, value: n.value,
        definition: definitionFor(metric, title, p.incomplete),
      });
    }
    if (blanks) flags.push("blank_cells_kept_unknown");
    if (observations.length === 0) {
      if (rowIssues.length) return quarantine(sheet.name, row, "type_error", rowIssues);
      return exclude(sheet.name, row, "no_values_period_not_reported");
    }
    const record: MarketRowRecord = {
      kind: "market_row",
      identity_key: `${metric}|${exactKey(label)}`,
      observations,
      fields: { label, metric, unit, orientation: transposed ? "transposed" : "years_down", title },
    };
    return { sheet: sheet.name, rowNumber: row.rowNumber, status: rowIssues.length ? "quarantined" : "accepted", reason: rowIssues.length ? "type_error" : undefined, record: rowIssues.length ? undefined : record, issues: rowIssues, flags: [...new Set(flags)] };
  };

  for (const row of input.dataRows) {
    const label = text(row.cells[0]);
    if (!label) {
      outcomes.push(exclude(sheet.name, row, "unlabelled_row"));
      continue;
    }
    if (!transposed) {
      const year = yearOf(row.cells[0]?.v);
      if (year === null) {
        if (TOTAL_LABEL.test(label)) outcomes.push(exclude(sheet.name, row, "summary_or_total"));
        else outcomes.push(quarantine(sheet.name, row, "period_unparsed", [issue("period_unparsed", `Period label "${label}" is not an annual label; map it explicitly`, "review", { label })]));
        continue;
      }
      const out = rowObs(row, label, geoCols.map((c) => ({ col: c, year, geo: labels[c] })));
      outcomes.push(out);
      if (totalCol >= 0) {
        const t = num(row.cells[totalCol]);
        if (t.value !== null && t.ok) {
          if (FLOW.includes(metric)) {
            const vals = geoCols.map((c) => num(row.cells[c])).filter((n) => n.ok && n.value !== null);
            const sum = vals.reduce((a, n) => a.plus(new Decimal(n.value!)), new Decimal(0));
            const dp = decimals(t.raw);
            const ok = sum.toDecimalPlaces(dp).equals(new Decimal(t.value).toDecimalPlaces(dp));
            controls.push({
              name: `${metric}_total_${year}`, sheet: sheet.name, locator: `${sheet.name}!${colLetter(totalCol)}${row.rowNumber}`,
              expected: t.value, actual: sum.toNumber(), ok, note: `geography sum vs source Total at ${dp} dp`,
            });
          } else {
            controls.push({
              name: `${metric}_total_${year}`, sheet: sheet.name, locator: `${sheet.name}!${colLetter(totalCol)}${row.rowNumber}`,
              expected: t.value, actual: t.value, ok: true, note: "reported total kept as control only; stock is never summed",
            });
          }
        }
      }
    } else {
      if (TOTAL_LABEL.test(label)) {
        outcomes.push(exclude(sheet.name, row, "summary_or_total"));
        continue;
      }
      const cols = labels.map((l, c) => ({ col: c, year: yearOf(l) ?? 0, geo: label })).filter((x) => x.col > 0 && x.year > 0);
      outcomes.push(rowObs(row, label, cols));
    }
  }
  return { outcomes, controls, issues };
}

export const marketMatrixV1: Adapter = {
  id: "market_matrix_v1",
  version: "1.0.0",
  label: "Market matrix (stock / supply / absorption / rental by geography and year)",
  roles: [{ role: "matrix", label: "Geography x year matrix", detect: detectMatrix, map: mapMatrix }],
};
