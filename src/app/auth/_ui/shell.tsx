import type { ReactNode } from "react";

/** Split auth layout: brand panel on desktop, single column on mobile. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-brand p-12 text-white lg:flex">
        <p className="text-lg font-bold tracking-tight">CRE OS</p>
        <div className="max-w-md">
          <h2 className="text-3xl font-bold leading-tight">The evidence-linked workbench for Pune commercial real-estate advisers.</h2>
          <ul className="mt-8 space-y-4 text-base text-white/90">
            {["Every requirement, building and deal in one place.", "Lease dates, rents and fees computed, never guessed.", "AI drafts and briefs you approve before anything changes."].map((b) => (
              <li key={b} className="flex gap-3"><span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white" />{b}</li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-white/70">Accounts are created by your administrator.</p>
      </aside>
      <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-sm">
          <div className="mb-6 lg:hidden">
            <p className="text-xl font-bold tracking-tight text-ink">CRE OS</p>
            <p className="mt-1 text-sm text-ink-soft">The workbench for Pune commercial real-estate advisers.</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "error" | "ok"; children: ReactNode }) {
  const cls = tone === "error" ? "border-bad/30 bg-bad/5 text-bad" : "border-ok/30 bg-ok/5 text-ok";
  return <div role={tone === "error" ? "alert" : "status"} className={`mb-4 rounded-lg border px-3 py-2.5 text-sm ${cls}`}>{children}</div>;
}
