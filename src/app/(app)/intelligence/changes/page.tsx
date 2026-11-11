import { Field, PageHeader, Select, Button, EmptyState, StaleBanner } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { Flash } from "@/modules/intelligence/ui";
import { CHANGE_LABEL, listChanges, memCtxFromTool } from "@/modules/intelligence/memory/integrate";
import { Changes } from "@/modules/intelligence/memory/ui/panels";

export const metadata = { title: "Detected changes" };
type SP = Record<string, string | undefined>;
const ENTITY: Record<string, string> = { organisation: "Company", person: "Contact", asset: "Building", requirement: "Requirement", opportunity: "Deal" };

/** Every stored change (memory_change): previous → latest, date, source, verification, impact. */
export default async function ChangesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const kind = sp.kind && sp.kind in CHANGE_LABEL ? sp.kind : undefined;
  const all = await listChanges(memCtxFromTool(ctx), { kinds: kind ? [kind] : undefined, state: sp.state === "all" ? "all" : "open", limit: 300 }).catch(() => null);
  const xs = (all ?? []).filter((c) => (!sp.entity || c.entityType === sp.entity) && (sp.material !== "1" || c.material));
  const back = `/intelligence/changes?${new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && !["notice", "error"].includes(k)) as [string, string][])}`;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Detected changes" subtitle="Important changes in your records. The previous value is kept; nothing here edits a record." />
      <Flash sp={sp} />
      <form method="get" className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-5">
        <Field label="Change"><Select name="kind" defaultValue={kind ?? ""}><option value="">All</option>{Object.entries(CHANGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Record"><Select name="entity" defaultValue={sp.entity ?? ""}><option value="">All</option>{Object.entries(ENTITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="State"><Select name="state" defaultValue={sp.state ?? "open"}><option value="open">Open</option><option value="all">All</option></Select></Field>
        <Field label="Material only"><Select name="material" defaultValue={sp.material ?? ""}><option value="">No</option><option value="1">Yes</option></Select></Field>
        <div className="flex items-end"><Button type="submit" variant="secondary" className="w-full">Filter</Button></div>
      </form>
      {all === null ? <StaleBanner>Couldn&apos;t load changes — reload to retry. This does not mean nothing changed.</StaleBanner>
        : !xs.length ? <EmptyState title="No changes found">Changes are detected when records are updated, or when you run a scan from Memory quality.</EmptyState>
        : <><p className="text-sm text-ink-soft">{xs.length} change(s)</p><Changes xs={xs} back={back} /></>}
    </div>
  );
}
