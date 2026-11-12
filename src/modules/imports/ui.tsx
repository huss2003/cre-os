/* Small presentational helpers for the /imports pages (server-safe, no client JS). */
import { Badge, Skeleton } from "@/components/ui";

const STATUS: Record<string, ["neutral" | "brand" | "ok" | "warn" | "bad" | "accent", string]> = {
  registered: ["neutral", "Queued"],
  processing: ["brand", "Processing"],
  needs_mapping: ["warn", "Needs mapping"],
  completed: ["ok", "Completed"],
  completed_with_exceptions: ["warn", "Completed · review"],
  failed: ["bad", "Failed"],
  mapped: ["ok", "Mapped"],
  unknown: ["warn", "Unknown schema"],
  summary: ["neutral", "Summary (excluded)"],
  empty: ["neutral", "Empty"],
  open: ["warn", "Open"],
  resolved: ["ok", "Resolved"],
  dismissed: ["neutral", "Dismissed"],
  pending: ["warn", "Pending"],
  merge_proposed: ["brand", "Merge proposed"],
  related: ["brand", "Relation proposed"],
  kept_separate: ["neutral", "Kept separate"],
  auto_linked: ["ok", "Auto-linked"],
  awaiting_source: ["warn", "Source not approved"],
  proposed: ["brand", "Proposed"],
  applied: ["ok", "Applied"],
  rejected: ["neutral", "Rejected"],
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const [tone, label] = STATUS[status ?? ""] ?? ["neutral", status ?? "—"];
  return <Badge tone={tone}>{label}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge tone={severity === "blocking" ? "bad" : severity === "review" ? "warn" : "neutral"}>{severity}</Badge>;
}

export const n = (v: unknown) => (v === null || v === undefined ? "—" : new Intl.NumberFormat("en-IN").format(Number(v)));

export function Loading({ variant = "list" }: { variant?: "list" | "detail" | "cards" }) {
  return <Skeleton variant={variant} />;
}

export interface Counts {
  rows_considered?: number; accepted?: number; duplicates?: number; quarantined?: number; excluded?: number; layout_rows?: number; reconciles?: boolean;
  masters?: Record<string, { new: number; existing_linked: number }>;
  observations?: Record<string, { new: number; existing: number }>;
  rows_linked_to_existing_master?: number; match_candidates?: number; reference_rows?: number;
  controls?: { name: string; sheet: string; locator: string; expected: number | null; actual: number; ok: boolean; note?: string }[];
  controls_failed?: number; exceptions?: number;
  excluded_reasons?: Record<string, number>; quarantine_reasons?: Record<string, number>;
  by_sheet?: { sheet: string; status: string; adapter: string | null; role: string | null; rows_considered: number; accepted: number; duplicates: number; quarantined: number; excluded: number; layout_rows: number }[];
}

/** "raw 5 = accepted 3 + quarantined 2 + excluded 0" with a pass/fail mark. */
export function ReconcileLine({ c }: { c: Counts }) {
  if (c.rows_considered === undefined) return <span className="text-ink-soft">Not processed yet</span>;
  return (
    <span className={c.reconciles ? "text-ok" : "text-bad"}>
      {n(c.rows_considered)} rows = {n(c.accepted)} accepted + {n(c.quarantined)} quarantined + {n(c.excluded)} excluded {c.reconciles ? "✓" : "✗ does not reconcile"}
    </span>
  );
}
