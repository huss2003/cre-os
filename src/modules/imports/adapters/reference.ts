/*
 * comparison_reference_v1 (spec Part III adapter 8, Part V file 8 and "Comparative model defects").
 * Reference/template intake ONLY: every row is staged with its cell values and formula text so it can be read and
 * reviewed, but nothing is written into market facts, quotes or masters. Automatic reuse is blocked.
 */
import type { ParsedSheet, ReferenceRecord, RowOutcome, SheetMapResult } from "../types";
import { colLetter } from "../normalize";
import { type Adapter, type RoleInput, issue } from "./framework";

const MARKERS = /commercial\s+(summary|comparative)|rating\s+scale|qualitative\s+criteria|lock-?in\s+comparative|per\s+seat\s+per\s+month/i;

export function looksLikeComparison(sheet: ParsedSheet): boolean {
  const head = sheet.rows.slice(0, 8).flatMap((r) => r.cells.filter((c) => c.t === "s").map((c) => String(c.v)));
  return head.some((t) => MARKERS.test(t));
}

function mapReference(input: RoleInput): SheetMapResult {
  const outcomes: RowOutcome[] = input.dataRows.map((row) => {
    const cells: Record<string, unknown> = {};
    row.cells.forEach((c, i) => {
      if (c.t !== "null" || c.f) cells[`${colLetter(i)}${row.rowNumber}`] = c.f ? { v: c.v, f: c.f } : c.v;
    });
    const record: ReferenceRecord = { kind: "reference", identity_key: `${input.sheet.name}!${row.rowNumber}`, fields: { cells } };
    return { sheet: input.sheet.name, rowNumber: row.rowNumber, status: "accepted", record, issues: [], flags: ["reference_only"] };
  });
  return {
    outcomes,
    controls: [],
    issues: [
      issue("reference_only", "Comparison/reference template: staged for reading only; not imported into market facts or client quotes", "info"),
      ...(input.sheet.formulaCount > 0
        ? [issue("template_reuse_blocked", `${input.sheet.formulaCount} formula cells kept as text (never executed). Automatic reuse is blocked until the template's formulas are reviewed`, "review")]
        : []),
    ],
  };
}

export const comparisonReferenceV1: Adapter = {
  id: "comparison_reference_v1",
  version: "1.0.0",
  label: "Comparison / reference template (reference only)",
  roles: [
    {
      role: "reference",
      label: "Reference sheet",
      detect: (sheet) => (looksLikeComparison(sheet) ? { headerRow: 0, signature: "comparison_reference_v1:comparative" } : null),
      map: mapReference,
    },
  ],
};
