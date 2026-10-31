import Link from "next/link";
import clsx from "clsx";
import { Badge } from "@/components/ui";
import { fmtDate } from "@/lib/util/time";

const LINKS = [
  { href: "/approvals?tab=records", key: "records", label: "Record changes" },
  { href: "/approvals?tab=merges", key: "merges", label: "Identity merges" },
  { href: "/approvals/conflicts", key: "conflicts", label: "Conflicts" },
  { href: "/approvals/stale", key: "stale", label: "Stale records" },
  { href: "/approvals?tab=history", key: "history", label: "History & undo" },
];

/** Secondary navigation for the Database Steward views under /approvals. */
export function StewardNav({ current }: { current: string }) {
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Approvals and data steward">
      {LINKS.map((t) => (
        <Link key={t.key} href={t.href} aria-current={t.key === current ? "page" : undefined}
          className={clsx("whitespace-nowrap rounded-lg px-3 py-2 text-sm", t.key === current ? "bg-brand text-white" : "border border-line bg-surface")}>{t.label}</Link>
      ))}
    </nav>
  );
}

export interface Freshness { status: string; last_verified_at: string | null; basis: string | null; window_days: number | null; stale_since?: string | null }

/** Freshness flag for a record (from the stale-record detector). Unknown when the detector has not looked at it yet. */
export function FreshnessBadge({ f }: { f: Freshness | null | undefined }) {
  if (!f) return <Badge title="The stale-record detector has not flagged this record">freshness not checked</Badge>;
  const since = f.last_verified_at ? fmtDate(f.last_verified_at) : "never";
  return f.status === "stale"
    ? <Badge tone="warn" title={`Window ${f.window_days ?? "?"} days; basis ${f.basis ?? "—"}`}>stale · verified {since}</Badge>
    : <Badge tone="ok" title={f.basis ?? undefined}>fresh · verified {since}</Badge>;
}

export const show = (v: unknown) => (v === null || v === undefined || v === "" ? "unknown" : typeof v === "object" ? JSON.stringify(v) : String(v));
