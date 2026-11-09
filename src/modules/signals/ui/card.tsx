import Link from "next/link";
import { CATEGORY_LABEL, type Category } from "../engine";

type Row = Record<string, any>;
/** One colour per category, used on the card rail, the horizon dots and the view list. */
export const CAT_COLOR: Record<string, { dot: string; rail: string; text: string }> = {
  expansion: { dot: "bg-emerald-500", rail: "bg-emerald-500", text: "text-emerald-700" },
  restructuring: { dot: "bg-rose-500", rail: "bg-rose-500", text: "text-rose-700" },
  lease: { dot: "bg-amber-500", rail: "bg-amber-500", text: "text-amber-700" },
  commercial: { dot: "bg-sky-500", rail: "bg-sky-500", text: "text-sky-700" },
  leadership: { dot: "bg-violet-500", rail: "bg-violet-500", text: "text-violet-700" },
  infrastructure: { dot: "bg-slate-500", rail: "bg-slate-500", text: "text-slate-700" },
  macro: { dot: "bg-stone-400", rail: "bg-stone-400", text: "text-stone-600" },
};
export const STATUS_LABEL: Record<string, string> = { new: "New", reviewing: "Looking into it", approved: "Approved", converted: "Task created", rejected: "Rejected", dismissed: "Dismissed", snoozed: "Snoozed", known: "Already known" };
export const VERIFY_LABEL: Record<string, string> = { fact: "Confirmed", inference: "Reported", hypothesis: "Unverified", unknown: "Needs checking" };
export const URGENCY: Record<string, { label: string; cls: string }> = {
  high: { label: "Act now", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  medium: { label: "This month", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  low: { label: "Watch", cls: "bg-slate-50 text-slate-600 ring-slate-200" },
};
const LEVEL: Record<string, number> = { high: 4, medium: 3, low: 2, insufficient: 1 };

/** Evidence strength drawn like phone signal bars — the page's one visual motif. */
export function StrengthBars({ level, size = "sm" }: { level: string; size?: "sm" | "lg" }) {
  const n = LEVEL[level] ?? 0;
  const h = size === "lg" ? [8, 13, 18, 24] : [5, 8, 11, 14];
  const w = size === "lg" ? "w-1.5" : "w-1";
  return (
    <span className="inline-flex items-end gap-0.5" role="img" aria-label={`Evidence ${level}`} title={`Evidence: ${level}`}>
      {h.map((px, i) => <span key={i} className={`${w} rounded-sm ${i < n ? (n >= 3 ? "bg-ink" : "bg-ink/60") : "bg-line"}`} style={{ height: px }} />)}
    </span>
  );
}

function when(s: Row): string | null {
  if (!s.event_date) return null;
  const d = Math.round((Date.parse(s.event_date) - Date.now()) / 86_400_000);
  return d < 0 ? `${-d} days ago` : d === 0 ? "today" : d < 60 ? `in ${d} days` : `in ${Math.round(d / 30)} months`;
}

export function SignalCard({ s }: { s: Row }) {
  const who = s.org?.display_name ?? s.person?.full_name ?? s.entity_name_raw ?? "Company not matched";
  const c = CAT_COLOR[s.category] ?? CAT_COLOR.macro;
  const u = URGENCY[s.priority_band] ?? URGENCY.low;
  const w = when(s);
  return (
    <Link href={`/signals/${s.id}`} className="group relative flex overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-ink/25 focus-visible:outline-2 focus-visible:outline-brand">
      <span className={`w-1.5 shrink-0 ${c.rail}`} aria-hidden />
      <div className="min-w-0 flex-1 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-xs font-medium ${c.text}`}>{CATEGORY_LABEL[s.category as Category] ?? s.category}</p>
            <h3 className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">{s.title}</h3>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${u.cls}`}>{u.label}</span>
            <StrengthBars level={s.confidence} />
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          <span className={!s.org_id && !s.person_id ? "text-warn" : "text-ink"}>{who}</span>
          {s.location_text ? <>, {s.location_text}</> : null}
          {w ? <> — {w}</> : null}
        </p>
        {s.recommended_action ? <p className="mt-3 border-t border-line pt-3 text-sm text-ink">{s.recommended_action.split(" On record:")[0]}</p> : null}
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
          <SourceLine ev={(s.evidence ?? []) as Row[]} />
          <span>{VERIFY_LABEL[s.verification] ?? s.verification}, {(STATUS_LABEL[s.status] ?? s.status).toLowerCase()}</span>
        </p>
      </div>
    </Link>
  );
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
/** "Source: economictimes.com +2" — where the signal came from, always visible on the card. */
export function SourceLine({ ev }: { ev: Row[] }) {
  const sup = ev.filter((e) => e.role !== "counter");
  if (!sup.length) return <span>Source: none recorded</span>;
  const first = sup.find((e) => e.source_url) ?? sup[0];
  const name = first.source_url ? host(first.source_url) : first.source_name ?? "Your records";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-2 py-0.5 text-ink">
      {first.source_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://www.google.com/s2/favicons?domain=${name}&sz=32`} alt="" width={12} height={12} className="rounded-sm" />
      ) : null}
      Source: {name}{sup.length > 1 ? ` +${sup.length - 1}` : ""}
    </span>
  );
}
