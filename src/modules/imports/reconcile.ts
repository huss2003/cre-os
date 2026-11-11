/*
 * Staging + reconciliation helpers (pure). Spec Part III "Import adapters and reconciliation":
 *   raw rows considered = accepted + quarantined + deliberately excluded (duplicates are a reported subset of accepted),
 *   master-entity counts (new vs existing-linked) are kept separate from observation counts,
 *   a revised source version gets a row/field diff against the previous version.
 */
import { createHash } from "node:crypto";
import type { Cell, ControlCheck, MappedRecord, ParsedRow, RowIssue, RowStatus } from "./types";
import type { SheetDetection, SheetMapping } from "./detect";
import { colLetter } from "./normalize";

export interface StagedRowDraft {
  sheet: string;
  row_number: number;
  locator: string;
  raw_json: Record<string, { v: Cell["v"]; t: Cell["t"]; f?: string }>;
  row_hash: string;
  status: RowStatus;
  reason: string | null;
  flags: string[];
  record: MappedRecord | null;
  issues: RowIssue[];
  role: string | null;
  adapter: string | null;
}

export function rawJson(row: ParsedRow | undefined): StagedRowDraft["raw_json"] {
  const out: StagedRowDraft["raw_json"] = {};
  row?.cells.forEach((c, i) => {
    if (c.t === "null" && !c.f) return;
    out[colLetter(i)] = c.f ? { v: c.v, t: c.t, f: c.f } : { v: c.v, t: c.t };
  });
  return out;
}

export const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Build staged-row drafts for every non-empty source row of every sheet (layout/header rows are counted separately). */
export function buildStaged(mappings: SheetMapping[], rowsBySheet: Map<string, Map<number, ParsedRow>>): StagedRowDraft[] {
  const out: StagedRowDraft[] = [];
  for (const { detection, result } of mappings) {
    const rows = rowsBySheet.get(detection.sheet) ?? new Map();
    for (const o of result.outcomes) {
      const raw = rawJson(rows.get(o.rowNumber));
      out.push({
        sheet: o.sheet, row_number: o.rowNumber, locator: `${o.sheet}!${o.rowNumber}`, raw_json: raw, row_hash: hashOf(raw),
        status: o.status, reason: o.reason ?? null, flags: o.flags ?? [], record: o.record ?? null, issues: o.issues,
        role: detection.role, adapter: detection.adapter,
      });
    }
  }
  return out;
}

/**
 * Within-batch duplicate observations: the same identity key twice in the same sheet role (e.g. a repeated
 * registration row). The repeat keeps its locator and links to the same target but creates nothing new.
 * Different tabs observing the same building (existing + upcoming) are NOT duplicates: they are separate observations.
 */
export function markDuplicates(rows: StagedRowDraft[]): number {
  const seen = new Map<string, string>();
  let n = 0;
  for (const r of rows) {
    if (r.status !== "accepted" || !r.record || r.record.kind === "reference") continue;
    const k = `${r.sheet}|${r.record.kind}|${r.record.identity_key}`;
    if (seen.has(k)) {
      r.status = "duplicate";
      r.reason = `duplicate_of ${seen.get(k)}`;
      n++;
    } else seen.set(k, r.locator);
  }
  return n;
}

export interface WriteStats {
  masters: Record<string, { new: number; existing_linked: number }>;
  observations: Record<string, { new: number; existing: number }>;
  rows_linked_to_existing_master: number;
  match_candidates: number;
}

export interface Reconciliation {
  rows_considered: number;
  accepted: number;
  duplicates: number;
  quarantined: number;
  excluded: number;
  layout_rows: number;
  reconciles: boolean;
  by_sheet: { sheet: string; status: string; adapter: string | null; role: string | null; rows_considered: number; accepted: number; duplicates: number; quarantined: number; excluded: number; layout_rows: number }[];
  excluded_reasons: Record<string, number>;
  quarantine_reasons: Record<string, number>;
  masters: WriteStats["masters"];
  observations: WriteStats["observations"];
  rows_linked_to_existing_master: number;
  match_candidates: number;
  reference_rows: number;
  controls: ControlCheck[];
  controls_failed: number;
  exceptions: number;
}

export function reconcile(rows: StagedRowDraft[], detections: SheetDetection[], controls: ControlCheck[], stats: WriteStats, exceptions: number): Reconciliation {
  const count = (pred: (r: StagedRowDraft) => boolean) => rows.filter(pred).length;
  const tally = (st: RowStatus) => {
    const m: Record<string, number> = {};
    for (const r of rows) if (r.status === st) m[r.reason?.split(" ")[0] ?? "unspecified"] = (m[r.reason?.split(" ")[0] ?? "unspecified"] ?? 0) + 1;
    return m;
  };
  const accepted = count((r) => r.status === "accepted" || r.status === "duplicate");
  const quarantined = count((r) => r.status === "quarantined");
  const excluded = count((r) => r.status === "excluded");
  const layout = detections.reduce((a, d) => a + d.layoutRows, 0);
  const considered = rows.length;
  return {
    rows_considered: considered,
    accepted,
    duplicates: count((r) => r.status === "duplicate"),
    quarantined,
    excluded,
    layout_rows: layout,
    reconciles: considered === accepted + quarantined + excluded,
    by_sheet: detections.map((d) => {
      const rs = rows.filter((r) => r.sheet === d.sheet);
      return {
        sheet: d.sheet, status: d.status, adapter: d.adapter, role: d.role,
        rows_considered: rs.length,
        accepted: rs.filter((r) => r.status === "accepted" || r.status === "duplicate").length,
        duplicates: rs.filter((r) => r.status === "duplicate").length,
        quarantined: rs.filter((r) => r.status === "quarantined").length,
        excluded: rs.filter((r) => r.status === "excluded").length,
        layout_rows: d.layoutRows,
      };
    }),
    excluded_reasons: tally("excluded"),
    quarantine_reasons: tally("quarantined"),
    masters: stats.masters,
    observations: stats.observations,
    rows_linked_to_existing_master: stats.rows_linked_to_existing_master,
    match_candidates: stats.match_candidates,
    reference_rows: count((r) => r.record?.kind === "reference"),
    controls,
    controls_failed: controls.filter((c) => !c.ok).length,
    exceptions,
  };
}

export interface DiffRow { key: string; sheet: string; identity_key: string; row_hash: string; fields: Record<string, unknown> | null; locator: string }

export interface VersionDiff {
  previous_batch_id: string;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  samples: { kind: "added" | "removed" | "changed"; key: string; locator: string; previous_locator?: string; fields?: { field: string; before: unknown; after: unknown }[] }[];
}

/** null, undefined and blank strings all mean "no value" when comparing versions. */
const blankToNull = (v: unknown) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : v);

/** Row/field diff between two versions of the same source, keyed by sheet + identity key (falls back to row hash). */
export function diffVersions(previousBatchId: string, prev: DiffRow[], cur: DiffRow[], sampleLimit = 50): VersionDiff {
  const P = new Map(prev.map((r) => [r.key, r]));
  const C = new Map(cur.map((r) => [r.key, r]));
  const d: VersionDiff = { previous_batch_id: previousBatchId, added: 0, removed: 0, changed: 0, unchanged: 0, samples: [] };
  const push = (s: VersionDiff["samples"][number]) => { if (d.samples.length < sampleLimit) d.samples.push(s); };
  const changed = (k: string, p: DiffRow, c: DiffRow) => {
    const fields: { field: string; before: unknown; after: unknown }[] = [];
    const keys = new Set([...Object.keys(p.fields ?? {}), ...Object.keys(c.fields ?? {})]);
    for (const f of keys) {
      const a = blankToNull((p.fields ?? {})[f]), b = blankToNull((c.fields ?? {})[f]);
      if (JSON.stringify(a) !== JSON.stringify(b)) fields.push({ field: f, before: a, after: b });
    }
    // a row that only moved (different position/hash, same values) is not a change: no "null → null" noise
    if (!fields.length) { d.unchanged++; return; }
    d.changed++;
    push({ kind: "changed", key: k, locator: c.locator, previous_locator: p.locator, fields });
  };
  const addedRows: DiffRow[] = [];
  for (const [k, c] of C) {
    const p = P.get(k);
    if (!p) { addedRows.push(c); continue; }
    if (p.row_hash === c.row_hash) d.unchanged++;
    else changed(k, p, c);
  }
  // rows whose identity changed (e.g. an edited area) but sit at the same locator are reported as field changes
  const removedByLocator = new Map([...P].filter(([k]) => !C.has(k)).map(([, p]) => [p.locator, p]));
  for (const c of addedRows) {
    const p = removedByLocator.get(c.locator);
    if (p) { removedByLocator.delete(c.locator); changed(c.key, p, c); }
    else { d.added++; push({ kind: "added", key: c.key, locator: c.locator }); }
  }
  for (const p of removedByLocator.values()) { d.removed++; push({ kind: "removed", key: p.key, locator: p.locator }); }
  return d;
}

/** Diff key for a staged row. */
export function diffKey(sheet: string, identityKey: string | null | undefined, rowHash: string) {
  return identityKey ? `${sheet}|${identityKey}` : `${sheet}|#${rowHash}`;
}
