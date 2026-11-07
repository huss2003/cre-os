import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { EntityForm } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";
import { localityOptions, parentAssetOptions } from "@/modules/admin/entities";

export const metadata = { title: "Edit building" };

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("editor");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: row } = await ctx.db.from("asset").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!row) notFound();
  const parents = (await parentAssetOptions(ctx.db, ctx.workspaceId)).filter(([v]) => v !== id);
  const localities = await localityOptions(ctx.db, ctx.workspaceId);
  return (
    <>
      <PageHeader title={`Edit ${row.name}`} subtitle="Availability and leases are recorded as dated evidence, not edited here." />
      <Card><EntityForm table="asset" row={row} parentOptions={parents} localityOptions={localities} /></Card>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<Loading />}><Body params={params} /></Suspense>;
}
