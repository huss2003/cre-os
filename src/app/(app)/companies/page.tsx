import { Suspense } from "react";
import { ButtonLink, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { EntityList } from "@/modules/admin/ui/entity";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Companies" };

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext();
  return (
    <>
      <div data-tour="companies-header">
      <PageHeader title="Companies" subtitle="Accounts you own, that are shared with you, or that your role can see."
        actions={hasRole(ctx, "editor") ? <ButtonLink href="/companies/new">Add company</ButtonLink> : null} />
      </div>
      <EntityList ctx={ctx} table="organisation" sp={await searchParams} />
    </>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>;
}
