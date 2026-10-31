import { Suspense } from "react";
import { ButtonLink, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { EntityList } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "People" };

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext();
  return (
    <>
      <PageHeader title="People" subtitle="Contacts on accounts you can see. Suppressed contacts are labelled."
        actions={hasRole(ctx, "editor") ? <ButtonLink href="/people/new">Add person</ButtonLink> : null} />
      <EntityList ctx={ctx} table="person" sp={await searchParams} />
    </>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>;
}
