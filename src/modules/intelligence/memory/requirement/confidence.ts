/** Requirement memory helpers (spec §5.1–5.3) — pure. */
import type { RequirementConfidence } from "../types";

export const CONFIDENCE_LABEL: Record<RequirementConfidence, string> = {
  confirmed: "Confirmed by client", indicative: "Indicative (second-hand)", estimated: "Our estimate", inferred: "Inferred — not confirmed",
  outdated: "Outdated", conflicting: "Conflicting information", unknown: "Unknown",
};

const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && (v.length === 0 || v.every((x) => x === null || x === undefined)));

/**
 * Map a requirement field status (deals: client_confirmed | reported | estimated | unknown; capture may add "inferred")
 * to a confidence class. Conflict and staleness override; a blank value is always "unknown".
 */
export function requirementConfidence(status: string | null | undefined, opts: { value?: unknown; conflicting?: boolean; outdated?: boolean } = {}): RequirementConfidence {
  if ("value" in opts && blank(opts.value)) return "unknown";
  if (opts.conflicting) return "conflicting";
  if (opts.outdated) return "outdated";
  switch (status) {
    case "client_confirmed": return "confirmed";
    case "reported": return "indicative";
    case "estimated": return "estimated";
    case "inferred": case "ai_inference": return "inferred";
    default: return "unknown";
  }
}

/** Fields tracked for requirement evolution, with the snapshot columns they read. */
export const TRACKED: { key: string; label: string; cols: string[]; kind: "area" | "budget" | "location" | "timeline" | "other" }[] = [
  { key: "area", label: "Area (SF)", cols: ["area_min_sf", "area_target_sf", "area_max_sf"], kind: "area" },
  { key: "seats", label: "Seats", cols: ["seats_min", "seats_target", "seats_max"], kind: "area" },
  { key: "budget", label: "Budget", cols: ["budget_min", "budget_max"], kind: "budget" },
  { key: "budget_basis", label: "Budget basis", cols: ["budget_basis"], kind: "budget" },
  { key: "preferred_locations", label: "Preferred locations", cols: ["preferred_geography_ids"], kind: "location" },
  { key: "forbidden_locations", label: "Excluded locations", cols: ["excluded_geography_ids"], kind: "location" },
  { key: "occupation_date", label: "Target possession", cols: ["occupation_date"], kind: "timeline" },
  { key: "decision_date", label: "Decision date", cols: ["decision_date"], kind: "timeline" },
  { key: "objective", label: "Purpose", cols: ["objective"], kind: "other" },
  { key: "transaction_kinds", label: "Property / deal type", cols: ["transaction_kinds"], kind: "other" },
  { key: "status", label: "Status", cols: ["status"], kind: "other" },
];

export interface RequirementChange {
  field: string; label: string; kind: string; from: unknown; to: unknown;
  fromVersion: number; toVersion: number; at: string; reason: string | null; changeProposalId: string | null;
  /** The earlier value is superseded (obsolete) — kept for history, never deleted. */
  previousObsolete: true;
}

const val = (snap: Record<string, unknown>, cols: string[]) => (cols.length === 1 ? snap[cols[0]] ?? null : cols.map((c) => snap[c] ?? null));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface VersionRow { version: number; snapshot: Record<string, unknown>; created_at: string; change_reason: string | null; change_proposal_id: string | null }

/** What changed between two consecutive snapshots (b newer). */
export function diffRequirementVersions(a: VersionRow, b: VersionRow): RequirementChange[] {
  const out: RequirementChange[] = [];
  for (const t of TRACKED) {
    const from = val(a.snapshot ?? {}, t.cols), to = val(b.snapshot ?? {}, t.cols);
    if (!same(from, to)) out.push({ field: t.key, label: t.label, kind: t.kind, from, to, fromVersion: a.version, toVersion: b.version, at: b.created_at, reason: b.change_reason, changeProposalId: b.change_proposal_id, previousObsolete: true });
  }
  return out;
}

/** All changes across an ordered (any order) version list. */
export function requirementEvolution(versions: VersionRow[]): RequirementChange[] {
  const v = [...versions].sort((x, y) => x.version - y.version);
  const out: RequirementChange[] = [];
  for (let i = 1; i < v.length; i++) out.push(...diffRequirementVersions(v[i - 1], v[i]));
  return out;
}
