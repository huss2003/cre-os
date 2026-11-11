import { Suspense } from "react";
import { ButtonLink, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { EntityList } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";
import { BlockList } from "@/modules/assistant/ui/blocks";
import { buildMapBlock } from "@/modules/assistant/outputs/map";

export const metadata = { title: "Buildings" };

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const mapView = sp.view === "map";
  const toggle = <div className="mb-3 flex gap-2 text-sm" role="tablist" aria-label="View">
    <ButtonLink href="/buildings" variant={mapView ? "secondary" : "primary"}>List</ButtonLink>
    <ButtonLink href="/buildings?view=map" variant={mapView ? "primary" : "secondary"}>Map</ButtonLink>
  </div>;
  let map = null;
  if (mapView) {
    // Stored coordinates only (RLS client); buildings without coordinates are counted, never placed.
    const { data } = await ctx.db.from("asset").select("id, name, lat, lon").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name").limit(500);
    const rows = (data ?? []) as { id: string; name: string; lat: unknown; lon: unknown }[];
    const { block, missing } = buildMapBlock(rows.map((a) => ({ id: a.id, label: a.name, lat: a.lat, lon: a.lon, kind: "building" as const, href: `/buildings/${a.id}` })), { title: "Buildings" });
    map = block ? <BlockList blocks={[block]} /> : <p className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-soft">No buildings have coordinates yet. Add latitude/longitude on a building to see it on the map.</p>;
    if (block && missing.length) map = <>{map}<p className="mt-2 text-xs text-ink-soft">{missing.length} building(s) without coordinates are not shown.</p></>;
  }
  return (
    <>
      <div data-tour="buildings-header">
      <PageHeader title="Buildings" subtitle="Campuses, projects, buildings and towers. Vacancy is only shown with dated evidence."
        actions={hasRole(ctx, "editor") ? <ButtonLink href="/buildings/new">Add building</ButtonLink> : null} />
      </div>
      {toggle}
      {mapView ? map : <EntityList ctx={ctx} table="asset" sp={sp} />}
    </>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>;
}
