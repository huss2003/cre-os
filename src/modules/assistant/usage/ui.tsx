import Link from "next/link";
import { PRICING } from "@/lib/ai/pricing";
import { budgetStatus } from "./service";

/** USD estimate → rupees for display (planning FX rate, same as the gateway's budget maths). */
export const usdToInr = (usd: number) => usd * PRICING.fxInrPerUsd;
export function money(usd: number) {
  const inr = usdToInr(usd);
  return `₹${inr < 100 ? inr.toFixed(2) : Math.round(inr).toLocaleString("en-IN")}`;
}

/**
 * In-app alert at 80% / 100% of the monthly AI budget. Server Component; mount on /assistant and /home:
 *   <UsageBanner workspaceId={ctx.workspaceId} />
 * Shows nothing below 80% or when no budget is set. Never throws (a failed check must not break the page).
 */
export async function UsageBanner({ workspaceId }: { workspaceId: string }) {
  let s: Awaited<ReturnType<typeof budgetStatus>>;
  try { s = await budgetStatus(workspaceId); } catch { return null; }
  if (s.paused) return <Banner tone="bad">AI is paused for this workspace (kill switch). Ask the owner to turn it back on.</Banner>;
  if (s.level === 0) return null;
  const pct = Math.floor(s.pct ?? 0);
  return s.level === 100
    ? <Banner tone="bad">The monthly AI budget is used up ({pct}%). AI features stop until the owner raises it. <Link className="font-medium underline" href="/assistant/usage">See usage</Link></Banner>
    : <Banner tone="warn">AI spend is at {pct}% of this month&apos;s budget. <Link className="font-medium underline" href="/assistant/usage">See usage</Link></Banner>;
}

function Banner({ tone, children }: { tone: "warn" | "bad"; children: React.ReactNode }) {
  const cls = tone === "bad" ? "border-bad/40 bg-bad/10 text-bad" : "border-warn/40 bg-warn/10 text-warn";
  return <div role="status" className={`mb-3 rounded-lg border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

/** Accessible vertical bar chart (SVG, no packages). Values in USD; labels via `money`. */
export function DayBars({ data, label }: { data: { date: string; usd: number }[]; label: string }) {
  const max = Math.max(...data.map((d) => d.usd), 0);
  const w = 300, h = 120, bw = w / Math.max(data.length, 1);
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h + 14}`} className="h-40 w-full" role="img" aria-label={label}>
        {data.map((d, i) => {
          const bh = max > 0 ? Math.max((d.usd / max) * h, d.usd > 0 ? 1 : 0) : 0;
          return (
            <g key={d.date}>
              <title>{`${d.date}: ${money(d.usd)}`}</title>
              <rect x={i * bw + 1} y={h - bh} width={Math.max(bw - 2, 1)} height={bh} rx={1.5} className="fill-brand" />
            </g>
          );
        })}
        <line x1={0} x2={w} y1={h} y2={h} className="stroke-line" strokeWidth={1} />
        <text x={0} y={h + 12} className="fill-ink-soft" fontSize={9}>{data[0]?.date.slice(5)}</text>
        <text x={w} y={h + 12} textAnchor="end" className="fill-ink-soft" fontSize={9}>{data[data.length - 1]?.date.slice(5)}</text>
      </svg>
      <figcaption className="sr-only">{data.filter((d) => d.usd > 0).map((d) => `${d.date} ${money(d.usd)}`).join("; ") || "No spend in this period"}</figcaption>
    </figure>
  );
}

/** Horizontal bars for a breakdown (accessible as a list). */
export function SliceBars({ items, labelFor }: { items: { key: string; usd: number; calls: number }[]; labelFor?: (k: string) => string }) {
  if (!items.length) return <p className="text-sm text-ink-soft">No spend yet this month.</p>;
  const max = Math.max(...items.map((i) => i.usd), 0);
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.key} className="text-sm">
          <div className="flex justify-between gap-2"><span className="truncate">{labelFor ? labelFor(i.key) : i.key}</span>
            <span className="shrink-0 tabular-nums text-ink-soft">{money(i.usd)} · {i.calls} call{i.calls === 1 ? "" : "s"}</span></div>
          <div className="mt-1 h-2 rounded bg-canvas" aria-hidden><div className="h-2 rounded bg-brand" style={{ width: `${max > 0 ? Math.max((i.usd / max) * 100, i.usd > 0 ? 2 : 0) : 0}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
