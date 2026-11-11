/*
 * Pure report builders for the Input Engine spreadsheet engine (spec §3.3 validation report, §3.4 change summary /
 * changed layouts, §10 batch completion report). No DB access.
 */
import type { RowIssue } from "./types";
import type { StagedRowDraft } from "./reconcile";

/* ------------------------------------------------------------------ validation report (§3.3) */
export interface ValidationReport {
  totals: { rows_checked: number; rows_with_issues: number; blocking: number; review: number; info: number };
  checks: { kind: string; label: string; severity: RowIssue["severity"]; count: number; samples: { locator: string; message: string }[] }[];
  sheet_findings: { sheet: string; kind: string; severity: RowIssue["severity"]; message: string }[];
}

export const CHECK_LABELS: Record<string, string> = {
  invalid_email: "Invalid email addresses",
  invalid_phone: "Invalid telephone numbers",
  inconsistent_date_formats: "Inconsistent date formats",
  ambiguous_date: "Ambiguous dates (day/month order)",
  invalid_date: "Unreadable dates",
  date_imprecise: "Dates without a day",
  invalid_area: "Invalid area values",
  missing_area_unit: "Areas without a unit",
  area_basis_unknown: "Area basis not stated",
  missing_company: "Missing company names",
  possible_duplicate_contact: "Possible duplicate contacts",
  possible_duplicate_company: "Same company, different spellings",
  suspicious_number: "Suspicious numbers",
  invalid_value: "Invalid values",
  rent_basis_unknown: "Rent basis not stated",
  incomplete_row: "Blank or incomplete rows",
  contact_without_method: "Contacts without email/phone",
  missing_required: "Missing required values",
  type_error: "Wrong data types",
  unmapped_columns: "Columns that could not be mapped",
  ambiguous_mapping: "Ambiguous column mappings",
  incomplete_mapping: "Incomplete mappings",
  low_confidence_mapping: "Mappings to confirm",
  layout_changed: "Changed column layout",
  unknown_schema: "Unrecognised sheets",
};

export function validationReport(staged: StagedRowDraft[], sheetIssues: { sheet: string; issue: RowIssue }[], sampleLimit = 8): ValidationReport {
  const by = new Map<string, ValidationReport["checks"][number]>();
  const rank = { blocking: 3, review: 2, info: 1 } as const;
  const totals = { rows_checked: 0, rows_with_issues: 0, blocking: 0, review: 0, info: 0 };
  const add = (i: RowIssue, locator: string) => {
    const c = by.get(i.kind) ?? by.set(i.kind, { kind: i.kind, label: CHECK_LABELS[i.kind] ?? i.kind.replace(/_/g, " "), severity: i.severity, count: 0, samples: [] }).get(i.kind)!;
    c.count++;
    if (rank[i.severity] > rank[c.severity]) c.severity = i.severity;
    if (c.samples.length < sampleLimit) c.samples.push({ locator, message: i.message });
    totals[i.severity]++;
  };
  for (const r of staged) {
    if (r.status === "excluded") continue;
    totals.rows_checked++;
    if (r.issues.length) totals.rows_with_issues++;
    for (const i of r.issues) add(i, r.locator);
    if (r.status === "duplicate") add({ kind: "duplicate_row", severity: "info", message: `Same record as ${r.reason?.replace("duplicate_of ", "") ?? "an earlier row"}` }, r.locator);
  }
  for (const s of sheetIssues) add(s.issue, s.sheet);
  const checks = [...by.values()].sort((a, b) => rank[b.severity] - rank[a.severity] || b.count - a.count);
  return { totals, checks, sheet_findings: sheetIssues.map((s) => ({ sheet: s.sheet, kind: s.issue.kind, severity: s.issue.severity, message: s.issue.message })) };
}

/* ------------------------------------------------------------------ changed column layouts (§3.2 / §3.4) */
export interface SheetLayout { sheet: string; headers: string[]; column_map?: Record<string, number>; status?: string }
export interface LayoutChange {
  sheet: string;
  previous_sheet: string | null;
  added: string[];
  removed: string[];
  moved: { header: string; from: string; to: string }[];
  remapped: { field: string; from: string | null; to: string | null }[];
  sheet_added?: boolean;
  sheet_removed?: boolean;
}
const letter = (i: number) => { let s = "", n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const norm = (h: string) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Compare the header layout of each sheet with the previous version of the same file. */
export function layoutChanges(prev: SheetLayout[], cur: SheetLayout[]): LayoutChange[] {
  const out: LayoutChange[] = [];
  const prevByName = new Map(prev.map((p) => [p.sheet, p]));
  cur.forEach((c, idx) => {
    const p = prevByName.get(c.sheet) ?? (prev.length === cur.length ? prev[idx] : undefined);
    if (!p) { if (c.headers.some((h) => h)) out.push({ sheet: c.sheet, previous_sheet: null, added: [], removed: [], moved: [], remapped: [], sheet_added: true }); return; }
    const ph = p.headers.map(norm), ch = c.headers.map(norm);
    const added = c.headers.filter((h, i) => ch[i] && !ph.includes(ch[i]));
    const removed = p.headers.filter((h, i) => ph[i] && !ch.includes(ph[i]));
    const moved: LayoutChange["moved"] = [];
    ch.forEach((h, i) => { const j = ph.indexOf(h); if (h && j >= 0 && j !== i) moved.push({ header: c.headers[i], from: letter(j), to: letter(i) }); });
    const remapped: LayoutChange["remapped"] = [];
    const fields = new Set([...Object.keys(p.column_map ?? {}), ...Object.keys(c.column_map ?? {})]);
    for (const f of fields) {
      const a = p.column_map?.[f], b = c.column_map?.[f];
      const ha = a === undefined ? null : p.headers[a] ?? letter(a), hb = b === undefined ? null : c.headers[b] ?? letter(b);
      if (norm(ha ?? "") !== norm(hb ?? "")) remapped.push({ field: f, from: ha, to: hb });
    }
    if (added.length || removed.length || moved.length || remapped.length) out.push({ sheet: c.sheet, previous_sheet: p.sheet, added, removed, moved, remapped });
  });
  for (const p of prev) if (!cur.some((c) => c.sheet === p.sheet) && prev.length !== cur.length) out.push({ sheet: p.sheet, previous_sheet: p.sheet, added: [], removed: [], moved: [], remapped: [], sheet_removed: true });
  return out;
}

export function layoutIssue(ch: LayoutChange): RowIssue {
  const parts = [
    ch.sheet_added ? "new sheet" : null, ch.sheet_removed ? "sheet no longer present" : null,
    ch.added.length ? `added: ${ch.added.join(", ")}` : null, ch.removed.length ? `removed: ${ch.removed.join(", ")}` : null,
    ch.moved.length ? `moved: ${ch.moved.slice(0, 8).map((m) => `${m.header} ${m.from}→${m.to}`).join(", ")}` : null,
    ch.remapped.length ? `mapping changed: ${ch.remapped.map((r) => `${r.field} ${r.from ?? "—"}→${r.to ?? "—"}`).join(", ")}` : null,
  ].filter(Boolean);
  const material = ch.removed.length > 0 || ch.remapped.some((r) => r.to === null) || !!ch.sheet_removed;
  return {
    kind: "layout_changed", severity: material ? "review" : "info",
    message: `Column layout of "${ch.sheet}" changed since the previous version (${parts.join("; ")}). Columns are matched by header, not position${material ? "; check that nothing important was dropped" : ""}.`,
    details: { ...ch },
  };
}

/* ------------------------------------------------------------------ batch completion report (§10) */
export interface RunItemLike {
  file_name: string; kind: string; status: string; error: string | null; error_kind?: string | null; attempts?: number;
  batch?: { status: string; counts: Record<string, unknown> | null; error: string | null } | null;
  capture?: { status: string; error?: string | null } | null;
}
export interface RunReport {
  files_received: number;
  files_processed: number;
  files_partial: number;
  files_failed: number;
  files_pending: number;
  files_duplicate: number;
  records_identified: number;
  records_created: number;
  records_updated: number;
  potential_duplicates: number;
  conflicts: number;
  needs_review: number;
  failed_files: { file_name: string; error: string; retryable: boolean }[];
  done: boolean;
  progress: number; // 0..1
}

const sumMasters = (m: unknown, k: "new" | "existing_linked") => Object.values((m ?? {}) as Record<string, { new?: number; existing_linked?: number }>).reduce((a, x) => a + Number(x?.[k] ?? 0), 0);
const sumObs = (m: unknown) => Object.values((m ?? {}) as Record<string, { new?: number }>).reduce((a, x) => a + Number(x?.new ?? 0), 0);

/** Item status from its underlying batch / capture. */
export function itemStatus(it: RunItemLike): "queued" | "processing" | "completed" | "partial" | "failed" | "duplicate" {
  if (it.status === "duplicate") return "duplicate";
  if (it.kind === "unsupported") return "failed";
  if (it.batch) {
    const s = it.batch.status;
    if (s === "completed") return "completed";
    if (s === "completed_with_exceptions" || s === "needs_mapping" || s === "awaiting_source") return "partial";
    if (s === "failed") return "failed";
    return s === "processing" ? "processing" : "queued";
  }
  if (it.capture) {
    const s = it.capture.status;
    // capture statuses: received > transcribing > extracting > needs_review > reviewed | failed
    if (s === "reviewed") return "completed";
    if (s === "needs_review") return "partial"; // extracted; items wait for the user's review
    if (s === "failed") return "failed";
    return s === "received" ? "queued" : "processing";
  }
  return it.status === "failed" ? "failed" : "queued";
}

export function runReport(items: RunItemLike[]): RunReport {
  const r: RunReport = {
    files_received: items.length, files_processed: 0, files_partial: 0, files_failed: 0, files_pending: 0, files_duplicate: 0,
    records_identified: 0, records_created: 0, records_updated: 0, potential_duplicates: 0, conflicts: 0, needs_review: 0, failed_files: [], done: false, progress: 0,
  };
  for (const it of items) {
    const st = itemStatus(it);
    if (st === "completed") r.files_processed++;
    else if (st === "partial") r.files_partial++;
    else if (st === "failed") { r.files_failed++; r.failed_files.push({ file_name: it.file_name, error: it.error ?? it.batch?.error ?? it.capture?.error ?? "failed", retryable: it.error_kind !== "permanent" && it.kind !== "unsupported" }); }
    else if (st === "duplicate") r.files_duplicate++;
    else r.files_pending++;
    const c = it.batch?.counts as Record<string, unknown> | null | undefined;
    if (c) {
      r.records_identified += Number(c.accepted ?? 0);
      r.records_created += sumMasters(c.masters, "new") + sumObs(c.observations);
      r.records_updated += sumMasters(c.masters, "existing_linked");
      r.potential_duplicates += Number(c.duplicates ?? 0) + Number(c.match_candidates ?? 0);
      r.conflicts += Number((c.steward as Record<string, unknown> | undefined)?.conflicts ?? 0);
      r.needs_review += Number(c.exceptions ?? 0) + Number((c.contacts as Record<string, unknown> | undefined)?.requirement_proposals ?? 0) + Number((c.steward as Record<string, unknown> | undefined)?.person_proposals ?? 0);
    }
    if (it.capture && st !== "failed") r.records_identified += 1;
  }
  const finished = r.files_processed + r.files_partial + r.files_failed + r.files_duplicate;
  r.progress = items.length ? finished / items.length : 1;
  r.done = r.files_pending === 0;
  return r;
}

/** Keep the batch page auto-refreshing while any file is still queued/processing (also right after a retry). */
export function runIsActive(report: Pick<RunReport, "done">, items: { live_status: string }[]): boolean {
  return !report.done || items.some((i) => i.live_status === "queued" || i.live_status === "processing");
}
