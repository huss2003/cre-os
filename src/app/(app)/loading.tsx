/** Instant feedback while a page's data loads (shown inside the app shell on every navigation). */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-4">
      <div className="h-7 w-48 rounded bg-line" />
      <div className="h-4 w-80 max-w-full rounded bg-line/70" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-xl bg-line/60" />)}
      </div>
      <div className="h-64 rounded-xl bg-line/50" />
    </div>
  );
}
