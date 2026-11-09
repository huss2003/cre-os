/** Shared scoring UI pieces. The score bar is the page's one visual motif: a filled track, never a fake gauge. */
export const BAND_TONE: Record<string, string> = {
  "Very High": "bg-emerald-600", High: "bg-emerald-500", Medium: "bg-amber-500", Low: "bg-slate-400", "Very Low": "bg-slate-300",
  Strong: "bg-emerald-600", Active: "bg-emerald-500", Developing: "bg-amber-500", Weak: "bg-slate-400", "No established relationship": "bg-slate-300", Disqualified: "bg-rose-500",
};
export const CONF_LABEL: Record<string, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence", insufficient: "Not enough data" };

export function ScoreBar({ score, band, size = "sm" }: { score: number; band: string; size?: "sm" | "lg" }) {
  return (
    <div className={size === "lg" ? "w-full" : "w-28"} role="img" aria-label={`${score} out of 100, ${band}`}>
      <div className={`overflow-hidden rounded-full bg-line ${size === "lg" ? "h-3" : "h-1.5"}`}>
        <div className={`h-full rounded-full ${BAND_TONE[band] ?? "bg-brand"}`} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

export function Completeness({ value }: { value: number }) {
  return <span className={`text-xs ${value < 50 ? "text-amber-700" : "text-ink-soft"}`}>{value}% known</span>;
}
