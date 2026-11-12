import Link from "next/link";
import { CATEGORY_LABEL, type Category } from "../engine";
import { SUB_TYPES } from "../taxonomy";
import { humanize, plural } from "../text";
import { fmtDate } from "@/lib/util/time";

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
export const STATUS_LABEL: Record<string, string> = { new: "New", reviewing: "Reviewing", approved: "Approved", converted: "Converted to action", rejected: "Rejected", dismissed: "Dismissed", snoozed: "Snoozed", known: "Already known" };
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
  return d < 0 ? `${plural(-d, "day")} ago` : d === 0 ? "today" : d < 60 ? `in ${plural(d, "day")}` : `in ${plural(Math.round(d / 30), "month")}`;
}

const CONF_LABEL: Record<string, string> = { high: "Strong evidence", medium: "Moderate evidence", low: "Weak evidence", insufficient: "Insufficient evidence" };
export const confLabel = (c: string) => CONF_LABEL[c] ?? c;
/** Dates are shown as IST calendar days (same day boundaries as the "Detected from/to" filter). */
const fmt = (d?: string | null) => (d ? fmtDate(d.length === 10 ? `${d}T00:00:00+05:30` : d) : null);
/** "Why act now: Expansion relevance (+14). Evidence low (+4)." — reasons are already sentences. */
export function priorityTip(label: string, reasons: string[]): string {
  const rs = reasons.map((r) => r.trim().replace(/^[.;\s]+/, "")).filter(Boolean).map((r) => (/[.!?]$/.test(r) ? r : `${r}.`));
  return rs.length ? `Why ${label.toLowerCase()}: ${rs.join(" ")}` : "No priority reasons recorded";
}

export function SignalCard({ s }: { s: Row }) {
  const who = s.org?.display_name ?? s.person?.full_name ?? s.entity_name_raw ?? "Company not matched";
  const c = CAT_COLOR[s.category] ?? CAT_COLOR.macro;
  const u = URGENCY[s.priority_band] ?? URGENCY.low;
  const w = when(s);
  const reasons = ((s.priority_reasons ?? []) as string[]).filter(Boolean);
  const ev = (s.evidence ?? []) as Row[];
  const support = ev.filter((e) => e.role === "support").length;
  const indep = typeof s.independent_evidence_count === "number" ? s.independent_evidence_count : null;
  const contra = typeof s.contradictory_count === "number" ? s.contradictory_count : ev.filter((e) => e.role === "counter").length;
  const sub = s.sub_type ? SUB_TYPES[s.sub_type]?.label ?? humanize(s.sub_type) : null;
  const tip = priorityTip(u.label, reasons);
  return (
    <Link href={`/signals/${s.id}`} className="group relative flex overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-ink/25 focus-visible:outline-2 focus-visible:outline-brand">
      <span className={`w-1.5 shrink-0 ${c.rail}`} aria-hidden />
      <div className="min-w-0 flex-1 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-xs font-medium ${c.text}`}>{CATEGORY_LABEL[s.category as Category] ?? s.category}{sub ? <span className="text-ink-soft"> · {sub}</span> : null}</p>
            <h3 className="mt-0.5 break-words text-[15px] font-semibold leading-snug text-ink">{s.title}</h3>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className={`group/p relative cursor-help rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${u.cls}`} title={tip}>
              {u.label}<span className="sr-only"> — {tip}</span>
              <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-20 mt-1 hidden w-64 rounded-lg bg-ink px-3 py-2 text-left text-xs font-normal text-white shadow-lg group-hover/p:block">{tip}</span>
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-soft"><StrengthBars level={s.confidence} /><span className="hidden sm:inline">{confLabel(s.confidence)}</span></span>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          <span className={!s.org_id && !s.person_id ? "text-warn" : "text-ink"}>{who}</span>
          {s.location_text ? <>, {s.location_text}</> : null}
          {w ? <> — {w}</> : null}
        </p>
        {s.cre_relevance ? <p className="mt-1 line-clamp-2 text-xs text-ink-soft"><span className="font-medium text-ink">Why it matters:</span> {s.cre_relevance}</p> : null}
        {s.recommended_action ? <p className="mt-3 border-t border-line pt-3 text-sm text-ink"><span className="sr-only">Recommended action: </span>{s.recommended_action.split(" On record:")[0]}</p> : null}
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-ink-soft sm:grid-cols-4">
          <div><dt className="inline">Detected </dt><dd className="inline text-ink">{fmt(s.detected_at) ?? "—"}</dd></div>
          <div><dt className="inline">Event </dt><dd className="inline text-ink">{fmt(s.event_date) ?? "not dated"}</dd></div>
          <div><dt className="inline">Evidence </dt><dd className="inline text-ink">{support} item{support === 1 ? "" : "s"}{indep !== null ? `, ${indep} independent` : ""}</dd></div>
          <div>{contra ? <dd className="text-warn">{contra} contradicting</dd> : null}</div>
        </dl>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
          <SourceLine ev={ev} />
          <span>{VERIFY_LABEL[s.verification] ?? s.verification}</span>
          <span className="rounded-full bg-canvas px-2 py-0.5 text-ink">{STATUS_LABEL[s.status] ?? s.status}</span>
          {s.status === "snoozed" && s.snoozed_until ? <span>until {fmt(s.snoozed_until)}</span> : null}
          {s.status_reason && ["dismissed", "snoozed", "rejected", "known"].includes(s.status) ? <span className="italic">“{s.status_reason}”</span> : null}
        </p>
      </div>
    </Link>
  );
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const txt = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "");
/** "Source: economictimes.com +2" — shown only when a source is actually known (no empty "Source:" label). */
export function SourceLine({ ev }: { ev: Row[] }) {
  const sup = ev.filter((e) => e.role !== "counter" && (safeUrl(txt(e.source_url)) || txt(e.source_name)));
  if (!sup.length) return null;
  const first = sup.find((e) => safeUrl(txt(e.source_url))) ?? sup[0];
  const url = safeUrl(txt(first.source_url));
  const name = txt(first.source_name) || (url ? host(url) : "");
  if (!name) return null;
  // Local generic icon: no third-party favicon service (it would leak evidence domains).
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-2 py-0.5 text-ink">
      <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-ink-soft">
        <path d="M4 1.75h5.5L12.25 4.5v9.75H4z" /><path d="M9.25 1.75V4.75h3M6 8h4.5M6 10.75h4.5" />
      </svg>
      Source:{" "}
      {/* plain text: the whole card is already a link (no nested <a>); the source link is on the detail page */}
      <span title={url || undefined}>{name}</span>
      {sup.length > 1 ? ` +${sup.length - 1}` : ""}
    </span>
  );
}
