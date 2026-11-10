import Link from "next/link";
import { Badge, ButtonLink, EmptyState, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listAnalyses } from "@/modules/toolkit/store";

export default async function ComparePage() {
  const ctx = await requirePageContext();
  const rows = await listAnalyses(ctx.db, ctx.workspaceId, { kind: "property_comparison" });
  return (
    <div data-tour="toolkit-compare">
      <PageHeader title="Property comparison" subtitle="Side-by-side, weighted rating of buildings against a requirement. Every run is saved as a reproducible version."
        actions={<><ButtonLink variant="secondary" href="/toolkit/models">Rating models</ButtonLink><ButtonLink data-tour="compare-new" href="/toolkit/compare/new">New comparison</ButtonLink></>} />
      {rows.length === 0 ? (
        <EmptyState title="No comparisons yet" action={<ButtonLink href="/toolkit/compare/new">Start a comparison</ButtonLink>}>
          Pick a requirement and the buildings you are considering — or type in options that aren&apos;t in the database yet. Unknown data is left out of the score, never counted as zero.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Link href={`/toolkit/compare/${r.id}`} className="font-medium text-brand">{r.title}</Link>
                <div className="text-xs text-ink-soft">{r.requirement?.title ?? "No requirement linked"} · v{r.current_version} · {r.formula_version}</div>
              </div>
              <div className="flex gap-2"><Badge tone={r.status === "approved" ? "ok" : r.status === "needs_info" ? "warn" : "brand"}>{String(r.status).replace("_", " ")}</Badge>
                <span className="text-xs text-ink-soft">{new Date(r.updated_at).toLocaleDateString("en-IN")}</span></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
