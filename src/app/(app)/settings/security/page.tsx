import { Suspense } from "react";
import { Card, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { MfaPanel } from "@/modules/admin/ui/mfa-panel";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Loading } from "@/modules/admin/ui/parts";
import { ownerMfaEnforced } from "@/modules/admin/mfa";

export const metadata = { title: "Security & MFA" };

type SP = Promise<Record<string, string | string[] | undefined>>;

/** Any member can manage their own MFA here (no admin guard — the guard redirects here, so it must not loop). */
async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : null;
  const mode = sp.verify === "1" ? "verify" : sp.enrol === "1" ? "enrol" : null;
  const privileged = ctx.role === "owner" || ctx.isPlatformAdmin;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Authenticator app (TOTP)">
        <MfaPanel next={next} mode={mode} privileged={privileged} />
      </Card>
      <Card title="Policy">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
          <li>Owners{ctx.isPlatformAdmin ? " and platform administrators" : ""} must verify with an authenticator before opening Settings, Health or Platform pages{ownerMfaEnforced() ? "" : " (enforced in production; warning only here)"}.</li>
          <li>Anyone who has enrolled is asked for a code once per session on those pages.</li>
          <li>CRE OS never sends codes by email or SMS.</li>
          <li>Lost your phone? Another owner or the platform administrator can remove your membership and re-add you.</li>
        </ul>
      </Card>
    </div>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Security & MFA" subtitle="Protect privileged accounts with a second factor." />
      <SettingsNav current="/settings/security" />
      <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
