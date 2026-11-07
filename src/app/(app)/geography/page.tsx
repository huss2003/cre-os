import { Suspense } from "react";
import { Card, EmptyState, PageHeader, Badge } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { LinkedAdd, ArchiveLinked } from "@/modules/admin/ui/linked";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Geography" };
type G = { id: string; name: string; level: string; parent_id: string | null; aliases: string[]; lat: number | null; lon: number | null };
const ORDER = ["city", "corridor", "micro_market", "locality"];

async function Body({ q }: { q: string }) {
  const ctx = await requirePageContext("viewer");
  const { data, error } = await ctx.db.from("geography").select("id, name, level, parent_id, aliases, lat, lon")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name").limit(2000);
  const rows = (data ?? []) as G[];
  const match = (g: G) => !q || g.name.toLowerCase().includes(q) || g.aliases.some((a) => a.toLowerCase().includes(q));
  const kids = (pid: string | null) => rows.filter((r) => r.parent_id === pid).sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level) || a.name.localeCompare(b.name));
  const visible = new Set<string>();
  if (q) for (const g of rows.filter(match)) { let c: G | undefined = g; while (c) { visible.add(c.id); c = rows.find((r) => r.id === c!.parent_id); } }
  const Node = ({ g, depth }: { g: G; depth: number }) => (!q || visible.has(g.id)) ? (
    <li style={{ paddingLeft: depth * 16 }} className="py-1 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{g.name}</span><Badge>{g.level.replace("_", "-")}</Badge>
        {g.aliases.length ? <span className="text-xs text-ink-soft">also: {g.aliases.join(", ")}</span> : null}
        {g.lat != null ? <span className="text-xs text-ink-soft">{g.lat}, {g.lon}</span> : null}
        {ctx.role !== "viewer" ? <ArchiveLinked table="geography" id={g.id} backPath="/geography" /> : null}
      </div>
      <ul>{kids(g.id).map((c) => <Node key={c.id} g={c} depth={depth + 1} />)}</ul>
    </li>
  ) : null;
  const roots = rows.filter((r) => !r.parent_id || !rows.some((x) => x.id === r.parent_id));
  return (
    <div className="space-y-4">
      <form className="flex gap-2" method="get"><label htmlFor="geo-q" className="sr-only">Search places</label>
        <input id="geo-q" name="q" defaultValue={q} placeholder="Search place or other name…" className="min-h-10 flex-1 rounded-lg border border-line bg-surface px-3 text-sm" />
        <button className="min-h-10 rounded-lg bg-brand px-3 text-sm text-white">Search</button></form>
      <Card title="Places">
        {error ? <p className="text-sm text-bad">Could not load places: {error.message}</p> : rows.length === 0 ? (
          <EmptyState title="No places yet">Add the city first, then corridors, micro-markets and localities inside it. Buildings link to a locality.</EmptyState>
        ) : <ul>{roots.map((g) => <Node key={g.id} g={g} depth={0} />)}</ul>}
        <LinkedAdd kind="geography" hostId={null} backPath="/geography" open={rows.length === 0} />
      </Card>
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim().toLowerCase();
  return (<><PageHeader title="Geography" subtitle="City › Corridor › Micro-market › Locality. Buildings and requirements point here." />
    <Suspense fallback={<Loading />}><Body q={q} /></Suspense></>);
}
