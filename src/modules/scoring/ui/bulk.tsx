"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { bulkStep } from "../actions";

/** Scores every company in one click: keeps calling the server in batches and shows progress until done. */
export function BulkScore() {
  const router = useRouter();
  const [state, setState] = useState<{ running: boolean; done: number; total: number; error?: string; finished?: boolean }>({ running: false, done: 0, total: 0 });
  async function run() {
    setState({ running: true, done: 0, total: 0 });
    let done = 0; let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const r: Awaited<ReturnType<typeof bulkStep>> = await bulkStep(cursor);
      if (r.error) { setState((s) => ({ ...s, running: false, error: r.error })); return; }
      done += r.scoredNow; cursor = r.cursor;
      setState({ running: true, done: Math.min(done, r.total), total: r.total });
      router.refresh(); // tiles and rankings update after every batch
      if (r.finished || r.scoredNow === 0) break;
    }
    setState((s) => ({ ...s, running: false, finished: true }));
    router.refresh();
  }
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  return (
    <div className="w-full sm:w-auto">
      <button type="button" onClick={run} disabled={state.running}
        className="inline-flex min-h-10 w-full items-center justify-center whitespace-nowrap rounded-xl bg-brand px-4 text-sm font-semibold text-white disabled:opacity-70 sm:w-auto">
        {state.running ? "Scoring…" : "Score everything now"}
      </button>
      {state.running || state.finished || state.error ? (
        <div className="mt-2 w-full sm:w-64" aria-live="polite">
          {state.error ? <p className="text-sm text-rose-700">{state.error}</p> : (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${state.finished ? 100 : pct}%` }} /></div>
              <p className="mt-1 text-xs text-ink-soft">{state.finished ? `Done — ${state.done} companies scored.` : state.total ? `${state.done} of ${state.total} companies…` : "Starting…"}</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Refreshes the dashboard every 10 s while recalculation jobs are waiting, every 60 s otherwise. */
export function AutoRefresh({ busy }: { busy: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, busy ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [busy, router]);
  return null;
}
