import Link from "next/link";
import { HelpFor } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { requirementCompleteness, type RequirementRow } from "@/modules/deals/requirements/contract";

type Row = Record<string, any>;

export default async function BriefIndexPage() {
  const app = await requirePageContext();
  const [reqs, briefs] = await Promise.all([
    app.db.from("requirement").select("*, organisation:org_id(display_name)").eq("workspace_id", app.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200),
    app.db.from("deal_analysis").select("requirement_id, status, current_version").eq("workspace_id", app.workspaceId).eq("kind", "brief").is("archived_at", null),
  ]);
  const byReq = new Map(((briefs.data ?? []) as Row[]).map((b) => [b.requirement_id, b]));
  const rows = (reqs.data ?? []) as Row[];
  return (
    <div className="mx-auto max-w-4xl space-y-8 pb-16">
      <header data-tour="toolkit-brief">
        <Link href="/toolkit" className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">← Deal toolkit</Link>
        <h1 className="mt-2 font-serif text-3xl text-ink">Requirement brief</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">Pick a requirement to see its brief: every item marked Confirmed, Estimated, Assumption or Missing, with open questions and pending approvals.</p>
      </header>
      <section>
        <h2 className="flex items-center border-b border-ink pb-2 text-xs font-semibold uppercase tracking-[0.18em]">Requirements<HelpFor k="Requirements" /></h2>
        {rows.length === 0 ? <p className="py-6 text-sm text-ink-soft">No requirements yet. Create one under <Link className="text-brand underline" href="/requirements">Deals → Requirements</Link>, then come back to build its brief.</p> : (
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const c = requirementCompleteness(r as RequirementRow); const b = byReq.get(r.id);
              return (
                <li key={r.id} className="grid gap-2 py-4 sm:grid-cols-[1fr_12rem] sm:items-center sm:gap-6">
                  <div className="min-w-0"><Link href={`/toolkit/brief/${r.id}`} className="font-serif text-lg text-ink hover:text-brand focus-visible:outline-2 focus-visible:outline-brand">{r.title}</Link>
                    <p className="text-xs text-ink-soft">{r.organisation?.display_name ?? "—"} · {b ? `Snapshot v${b.current_version} · ${String(b.status).replace(/_/g, " ")}` : "No snapshot yet"}</p></div>
                  <div role="img" aria-label={`${c.percentKnown}% known, ${c.percentConfirmed}% confirmed`}>
                    <div className="relative h-1.5 overflow-hidden rounded-full bg-line">
                      <div className="absolute inset-y-0 left-0 bg-amber-400" style={{ width: `${c.percentKnown}%` }} />
                      <div className="absolute inset-y-0 left-0 bg-ok" style={{ width: `${c.percentConfirmed}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] tabular-nums text-ink-soft">{c.percentKnown}% known · {c.percentConfirmed}% confirmed</p>
                  </div>
                </li>);
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
