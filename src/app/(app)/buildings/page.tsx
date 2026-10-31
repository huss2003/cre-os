import { Suspense } from "react";
import { ButtonLink, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { EntityList } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Buildings" };

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext();
  return (
    <>
      <PageHeader title="Buildings" subtitle="Campuses, projects, buildings and towers. Vacancy is only shown with dated evidence."
        actions={hasRole(ctx, "editor") ? <ButtonLink href="/buildings/new">Add building</ButtonLink> : null} />
      <EntityList ctx={ctx} table="asset" sp={await searchParams} />
    </>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>;
}
