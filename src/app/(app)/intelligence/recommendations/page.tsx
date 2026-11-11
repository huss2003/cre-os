import { Field, PageHeader, Select, Button, EmptyState, StaleBanner } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { Flash } from "@/modules/intelligence/ui";
import { listRecommendations, memCtxFromTool } from "@/modules/intelligence/memory/integrate";
import { Recs } from "@/modules/intelligence/memory/ui/panels";

export const metadata = { title: "Recommendations" };
type SP = Record<string, string | undefined>;
const ENTITY: Record<string, string> = { organisation: "Company", person: "Contact", asset: "Building", requirement: "Requirement", opportunity: "Deal", meeting: "Meeting" };

/** All open recommendations (persisted + live rules), filterable. Done/Dismiss only change the user's own state. */
export default async function RecommendationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const all = await listRecommendations(memCtxFromTool(ctx), { limit: 500 }).catch(() => null);
  const kinds = [...new Set((all ?? []).map((r) => r.kind))].sort();
  const xs = (all ?? []).filter((r) => (!sp.kind || r.kind === sp.kind) && (!sp.confidence || r.confidence === sp.confidence) && (!sp.entity || r.entityType === sp.entity));
  const back = `/intelligence/recommendations?${new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && !["notice", "error"].includes(k)) as [string, string][])}`;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Recommendations" subtitle="Suggested next actions from your records. Each shows why, the evidence and sources. Nothing is sent or changed automatically." />
      <Flash sp={sp} />
      <form method="get" className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-4">
        <Field label="Type"><Select name="kind" defaultValue={sp.kind ?? ""}><option value="">All</option>{kinds.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}</Select></Field>
        <Field label="Confidence"><Select name="confidence" defaultValue={sp.confidence ?? ""}><option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></Select></Field>
        <Field label="Record"><Select name="entity" defaultValue={sp.entity ?? ""}><option value="">All</option>{Object.entries(ENTITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <div className="flex items-end"><Button type="submit" variant="secondary" className="w-full">Filter</Button></div>
      </form>
      {all === null ? <StaleBanner>Couldn&apos;t load recommendations — reload to retry. This does not mean there are none.</StaleBanner>
        : !xs.length ? <EmptyState title={all.length ? "No recommendations match these filters" : "No open recommendations"}>{all.length ? "Clear a filter to see more." : "They appear as your records grow — e.g. stale requirements, meetings without follow-up, outdated quotes. Run a scan from Memory quality to detect changes."}</EmptyState>
        : <><p className="text-sm text-ink-soft">{xs.length} open</p><Recs xs={xs} back={back} /></>}
    </div>
  );
}
