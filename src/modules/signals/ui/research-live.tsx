"use client";
import { useEffect, useRef, useState } from "react";

type Source = { url: string; title: string; used?: boolean };
export type Run = { assessment?: { score: number; band: string } | null; id: string; kind: string; label: string; status: string; queries: string[]; sources: Source[]; findings: number; new_companies: number; usd: number; error: string | null; created_at: string; finished_at: string | null };

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

/**
 * Live research log. Polls fast (2s) while a run is in progress or right after any form on the page is submitted,
 * slowly (20s) otherwise, so you can watch each run's searches and the websites it read.
 */
export function ResearchLive({ initial }: { initial: Run[] }) {
  const [runs, setRuns] = useState<Run[]>(initial);
  const [open, setOpen] = useState<string | null>(initial[0]?.id ?? null);
  const fastUntil = useRef(0);
  const anyLive = useRef(initial.some((x) => x.status === "running"));

  useEffect(() => {
    let stop = false; let t: ReturnType<typeof setTimeout>;
    const onSubmit = () => { fastUntil.current = Date.now() + 120_000; clearTimeout(t); t = setTimeout(tick, 800); };
    document.addEventListener("submit", onSubmit, true);
    async function tick() {
      try {
        const r = await fetch("/api/v1/research/runs", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { runs: Run[] };
          setRuns(j.runs);
          const live = j.runs.find((x) => x.status === "running");
          if (live) setOpen(live.id);
          anyLive.current = !!live;
        }
      } catch { /* offline: try again next tick */ }
      if (stop) return;
      const busy = Date.now() < fastUntil.current || anyLive.current;
      t = setTimeout(tick, busy ? 2000 : 20000);
    }
    t = setTimeout(tick, 2000);
    return () => { stop = true; clearTimeout(t); document.removeEventListener("submit", onSubmit, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!runs.length) return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-8 text-center text-sm text-ink-soft">
      No research has run yet. Press <b className="text-ink">Research now</b> on a company or <b className="text-ink">Find new activity</b> to watch it work here.
    </div>
  );

  return (
    <ol className="space-y-3" aria-live="polite">
      {runs.map((r) => {
        const live = r.status === "running";
        const isOpen = open === r.id;
        const used = r.sources.filter((s) => s.used).length;
        return (
          <li key={r.id} className={`overflow-hidden rounded-2xl border bg-surface ${live ? "border-brand/50" : "border-line"}`}>
            <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}
              className="flex w-full items-center gap-3 p-4 text-left">
              <span className="relative flex h-3 w-3 shrink-0" aria-hidden>
                {live ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none" /> : null}
                <span className={`relative inline-flex h-3 w-3 rounded-full ${live ? "bg-brand" : r.status === "done" ? "bg-emerald-500" : r.status === "failed" ? "bg-rose-500" : "bg-amber-400"}`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.kind === "discover" ? "Market scan: " : r.kind === "assess" ? "Client score: " : ""}{r.label}</span>
                <span className="block text-xs text-ink-soft">
                  {live ? "Searching the web…" : r.status === "done" ? `${r.sources.length} sites read, ${r.findings} new signal${r.findings === 1 ? "" : "s"}${r.new_companies ? `, ${r.new_companies} new companies` : ""}` : r.error ?? r.status}
                  {" "}· {time(r.created_at)}
                </span>
              </span>
              <span className="text-ink-soft" aria-hidden>{isOpen ? "−" : "+"}</span>
            </button>
            {isOpen ? (
              <div className="border-t border-line px-4 pb-4 pt-3">
                {r.assessment ? (
                  <a href={`/research/assessment/${r.id}`} className="mb-3 flex items-center justify-between rounded-xl bg-brand-soft/60 px-4 py-3 hover:bg-brand-soft">
                    <span><span className="text-2xl font-bold tabular-nums">{r.assessment.score}</span><span className="text-ink-soft">/100</span> <span className="ml-2 font-medium">{r.assessment.band}</span></span>
                    <span className="text-sm font-semibold text-brand">See all reasons</span>
                  </a>
                ) : null}
                {r.queries.length ? (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {r.queries.map((q, i) => <span key={i} className="rounded-full bg-canvas px-2.5 py-1 text-xs">🔎 {q}</span>)}
                  </div>
                ) : live ? <p className="mb-3 text-sm text-ink-soft">Waiting for search results…</p> : null}
                {r.sources.length ? (
                  <>
                    <p className="mb-2 text-xs text-ink-soft">{used ? `${used} of ${r.sources.length} sites gave evidence` : "Sites read"}</p>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {r.sources.map((s) => (
                        <li key={s.url}>
                          <a href={s.url} target="_blank" rel="noreferrer noopener"
                            className={`flex items-start gap-2.5 rounded-xl border p-2.5 text-sm hover:border-ink/25 ${s.used ? "border-emerald-200 bg-emerald-50/60" : "border-line"}`}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`https://www.google.com/s2/favicons?domain=${host(s.url)}&sz=32`} alt="" width={16} height={16} className="mt-0.5 shrink-0 rounded" />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{host(s.url)}</span>
                              {s.title ? <span className="line-clamp-2 text-xs text-ink-soft">{s.title}</span> : null}
                              {s.used ? <span className="mt-0.5 block text-xs font-medium text-emerald-700">Used as evidence</span> : null}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : !live ? <p className="text-sm text-ink-soft">No websites were read in this run.</p> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
