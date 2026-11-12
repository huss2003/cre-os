"use client";
/** Visible failure (S10): never render an empty list when loading failed. */
export default function SignalsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-bad/30 bg-bad/10 px-5 py-6 text-sm text-bad">
      <p className="font-semibold">Signals could not be loaded.</p>
      <p className="mt-1">{error.message || "Something went wrong."} This does not mean there are no signals.</p>
      <button onClick={reset} className="mt-3 min-h-11 rounded-xl bg-ink px-4 font-semibold text-white">Try again</button>
    </div>
  );
}
