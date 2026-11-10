import Link from "next/link";
import { HelpFor } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { requirementCompleteness, type RequirementRow } from "@/modules/deals/requirements/contract";
import { EmptyState, OpenRow, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";

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
      <div data-tour="toolkit-brief">
        <ToolHeader title="Client briefs" purpose="Write down what each client needs, and see at a glance what is confirmed and what is still missing."
          steps={["Pick a requirement", "Fill the gaps", "Save a snapshot", "Approve it"]} current={0}
          action={<Link href="/requirements" className={btn.secondary}>New requirement</Link>} />
      </div>
      <section className="space-y-3">
        <h2 className="flex items-center text-lg font-semibold">Pick a requirement<HelpFor k="Requirements" /></h2>
        {rows.length === 0 ? (
          <EmptyState title="No requirements yet" text="A requirement is one client search. Create it under Requirements, then come back to build its brief." action={<Link href="/requirements" className={btn.primary}>Create a requirement</Link>} />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => {
              const c = requirementCompleteness(r as RequirementRow); const b = byReq.get(r.id);
              return (
                <li key={r.id}>
                  <OpenRow href={`/toolkit/brief/${r.id}`} title={r.title}
                    meta={<>{r.organisation?.display_name ?? "No company"} · {b ? `Snapshot version ${b.current_version}` : "No snapshot yet"}</>}
                    right={
                      <span className="flex shrink-0 flex-col items-end gap-1.5">{b ? <Status s={String(b.status)} /> : <Status s="draft" label="No snapshot" />}<span className="hidden w-40 sm:block" role="img" aria-label={`${c.percentKnown}% known, ${c.percentConfirmed}% confirmed`}>
                        <span className="relative block h-1.5 overflow-hidden rounded-full bg-line">
                          <span className="absolute inset-y-0 left-0 bg-amber-400" style={{ width: `${c.percentKnown}%` }} />
                          <span className="absolute inset-y-0 left-0 bg-ok" style={{ width: `${c.percentConfirmed}%` }} />
                        </span>
                        <span className="mt-1 block text-[11px] tabular-nums text-ink-soft">{c.percentKnown}% known · {c.percentConfirmed}% confirmed</span>
                      </span></span>}
                  />
                  <p className="mt-1 px-1 text-xs text-ink-soft sm:hidden">{c.percentKnown}% known · {c.percentConfirmed}% confirmed</p>
                </li>);
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
