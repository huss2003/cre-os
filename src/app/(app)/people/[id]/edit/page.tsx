import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { EntityForm } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Edit person" };

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("editor");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: row } = await ctx.db.from("person").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!row) notFound();
  return (
    <>
      <PageHeader title={`Edit ${row.full_name}`} subtitle="Name changes go to Approvals before they apply." />
      <Card><EntityForm table="person" row={row} /></Card>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<Loading />}><Body params={params} /></Suspense>;
}
