import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";
import { COMPARE_STEPS } from "@/modules/toolkit/ui/compare/explain";
import { EmptyState, OpenRow, Status, ToolHeader, btn } from "@/modules/toolkit/ui/kit";

export default async function ComparePage() {
  const ctx = await requirePageContext();
  const rows = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "property_comparison" });
  return (
    <div data-tour="toolkit-compare" className="space-y-6">
      <ToolHeader title="Property comparison" purpose="Rank the buildings you are considering against a client's requirement. Missing data is never counted as zero, and every run is saved as a version you can reproduce."
        steps={COMPARE_STEPS}
        action={<div className="flex flex-wrap gap-2"><Link className={btn.secondary} href="/toolkit/models">Rating models</Link><Link className={btn.primary} data-tour="compare-new" href="/toolkit/compare/new">+ New comparison</Link></div>} />
      {rows.length === 0 ? (
        <EmptyState title="No comparisons yet" text="Pick a requirement and the buildings you are considering — or type in options that aren't in the database yet. Unknown data is left out of the score, never counted as zero."
          action={<Link className={btn.primary} href="/toolkit/compare/new">Start a comparison</Link>} />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <OpenRow href={`/toolkit/compare/${r.id}`} title={r.title}
                meta={<>{r.requirement?.title ?? "No requirement linked"} · version {r.current_version} · updated {new Date(r.updated_at).toLocaleDateString("en-IN")}</>}
                right={<Status s={String(r.status)} />} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
