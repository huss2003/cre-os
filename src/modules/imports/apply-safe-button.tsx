"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/** Runs the safe-row approval in chunks and shows live progress. Stops when nothing is left or a chunk makes no progress. */
export function ApplySafeButton({ batchId, total }: { batchId: string; total: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    if (!confirm(`Approve and add ${total.toLocaleString("en-IN")} safe rows to your records? Possible duplicates and conflicts are not included.`)) return;
    setBusy(true); setMsg(null);
    let applied = 0, bad = 0;
    for (let round = 0; round < 200; round++) {
      const res = await fetch(`/api/v1/imports/${batchId}/apply-safe`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(body.error ?? `Stopped (error ${res.status}). Already applied rows stay applied.`); break; }
      applied += body.applied ?? 0; bad += body.failed ?? 0;
      setDone(applied); setFailed(bad);
      if (!body.remaining || (body.applied ?? 0) === 0) {
        setMsg(bad ? `Done. ${applied.toLocaleString("en-IN")} added; ${bad} could not be applied and are listed under "Check".` : `Done. ${applied.toLocaleString("en-IN")} rows added to your records.`);
        break;
      }
    }
    setBusy(false);
    router.refresh();
  }

  const pct = total ? Math.min(100, Math.round(((done + failed) / total) * 100)) : 0;
  return (
    <div className="space-y-2">
      <Button onClick={run} disabled={busy || total === 0} className="w-full py-3 text-base sm:w-auto sm:px-6">
        {busy ? `Adding… ${pct}%` : `Approve & add all ${total.toLocaleString("en-IN")} safe rows`}
      </Button>
      {busy || done ? (
        <div className="h-2 w-full overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-ok transition-all" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {msg ? <p className="text-sm text-ink-soft">{msg}</p> : null}
    </div>
  );
}
