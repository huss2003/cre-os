import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { EntityForm } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Edit company" };

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext("editor");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: row } = await ctx.db.from("organisation").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  if (!row) notFound();
  return (
    <>
      <PageHeader title={`Edit ${row.display_name}`} subtitle="Identifiers (legal name, CIN, GSTIN, domain, CRM id) go to Approvals before they change." />
      <Card><EntityForm table="organisation" row={row} /></Card>
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<Loading />}><Body params={params} /></Suspense>;
}
