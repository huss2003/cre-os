import { Suspense } from "react";
import { Card, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { EntityForm } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Add person" };

async function Body() {
  await requirePageContext("editor");
  return (
    <>
      <PageHeader title="Add person" subtitle="Search first to avoid duplicates. Leave anything you don't know blank — unknown stays unknown." />
      <Card><EntityForm table="person" row={null} /></Card>
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Body /></Suspense>;
}
