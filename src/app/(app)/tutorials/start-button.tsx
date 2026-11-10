"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTour } from "@/components/tour/runner";
import { setupPracticeAction, removePracticeAction, type PracticeIds, type PracticeStatus } from "./practice";

export function StartTourButton({ tourKey, ids, needsPractice }: { tourKey: string; ids: PracticeIds; needsPractice: boolean }) {
  const { startTour } = useTour();
  return (
    <>
      {needsPractice ? <p className="mt-2 text-xs text-warn">Set up practice data above first for the full hands-on version.</p> : null}
      <button type="button" onClick={() => startTour(tourKey, ids as Record<string, string | undefined>)} className="mt-4 w-full rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
        Start
      </button>
    </>
  );
}

const WILL_CREATE = [
  "Company: Practice Co (tutorial)",
  "Contact: Priya Sharma (tutorial), Head of Admin, priya.sharma@practice-co.example",
  "Requirement: 25,000 sq ft in Kharadi, and a deal for it",
  "Signal: Practice Co plans Pune expansion (tutorial)",
  "Meeting: requirement discussion tomorrow at 11:00, with a preparation page",
];

export function PracticePanel({ status }: { status: PracticeStatus }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => start(async () => {
    const r = await fn();
    setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? "Something went wrong." });
    router.refresh();
  });
  return (
    <section className="rounded-2xl border border-line bg-surface p-5" aria-labelledby="practice-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="practice-h" className="font-semibold">Practice data {status.complete ? <span className="ml-1 rounded-full bg-ok/10 px-2 py-0.5 text-xs font-semibold text-ok">Ready</span> : status.exists ? <span className="ml-1 rounded-full bg-warn/10 px-2 py-0.5 text-xs font-semibold text-warn">Incomplete</span> : <span className="ml-1 rounded-full bg-canvas px-2 py-0.5 text-xs text-ink-soft">Not set up</span>}</h2>
          <p className="mt-1 text-sm text-ink-soft">The tutorials work on a few practice records in your workspace, all labelled “(tutorial)”. Nothing is sent to anyone — the email address can’t receive mail.</p>
        </div>
        {status.canEdit ? (
          <div className="flex flex-wrap gap-2">
            {!status.complete ? <button type="button" disabled={pending} onClick={() => run(setupPracticeAction, "Practice data is ready.")} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{pending ? "Working…" : status.exists ? "Finish setting up" : "Set up practice data"}</button> : null}
            {status.exists ? <button type="button" disabled={pending} onClick={() => { if (window.confirm("Archive all practice records? They are hidden, not deleted.")) run(removePracticeAction, "Practice data removed (archived)."); }} className="rounded-xl border border-line px-4 py-2 text-sm font-medium disabled:opacity-60">Remove practice data</button> : null}
          </div>
        ) : <p className="text-xs text-ink-soft">Ask an editor to set up practice data.</p>}
      </div>
      <details className="mt-3 text-sm" open={!status.exists}>
        <summary className="cursor-pointer text-ink-soft">What will be created</summary>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink-soft">{WILL_CREATE.map((w) => <li key={w}>{w}</li>)}</ul>
      </details>
      {msg ? <p role="status" className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad"}`}>{msg.text}</p> : null}
    </section>
  );
}
