import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { getContext } from "@/lib/auth/context";
import { MfaPanel } from "@/modules/admin/ui/mfa-panel";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Platform MFA" };

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await getContext();
  if (!ctx) redirect("/login?next=/platform/security");
  if (!ctx.isPlatformAdmin) redirect("/forbidden");
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : null;
  return <Card title="Authenticator app (TOTP)"><MfaPanel next={next} mode={sp.verify === "1" ? "verify" : sp.enrol === "1" ? "enrol" : null} privileged /></Card>;
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Platform MFA" subtitle="Platform administrators must verify with an authenticator app." />
      <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
