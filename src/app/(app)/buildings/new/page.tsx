import { Suspense } from "react";
import { Card, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { EntityForm } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";
import { localityOptions, parentAssetOptions } from "@/modules/admin/entities";

export const metadata = { title: "Add building" };

async function Body() {
  const ctx = await requirePageContext("editor");
  const [parents, localities] = await Promise.all([parentAssetOptions(ctx.db, ctx.workspaceId), localityOptions(ctx.db, ctx.workspaceId)]);
  return (
    <>
      <PageHeader title="Add building" subtitle="Add the campus first, then each tower as its own record. Leave unknown values blank." />
      <Card><EntityForm table="asset" row={null} parentOptions={parents} localityOptions={localities} /></Card>
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Body /></Suspense>;
}
