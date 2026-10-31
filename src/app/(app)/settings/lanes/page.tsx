import { Suspense } from "react";
import { Badge, PageHeader } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { ConfigPage, Yes, type ConfigField } from "@/modules/admin/ui/config-page";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Data lanes" };

const FIELDS: ConfigField[] = [
  { name: "name", label: "Name", required: true },
  { name: "allowed_classifications", label: "Data classes in this lane", type: "classes" },
  { name: "approved_processors", label: "Approved processors", type: "list", hint: "Comma separated, e.g. supabase, openai" },
  { name: "approved_regions", label: "Approved regions", type: "list", hint: "e.g. ap-south-1" },
  { name: "approval_evidence", label: "Approval evidence", type: "textarea", hint: "Who approved, when, reference to the policy or email." },
  { name: "approved", label: "Approved", type: "checkbox" },
];

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAdminPage("admin", "/settings/lanes");
  const sp = await searchParams;
  return (
    <ConfigPage ctx={ctx} kind="data_lane" fields={FIELDS} title="data lane" archived={sp.archived === "1"}
      emptyText={<>Define at least a personal/reference lane and, if the tenant allows it, a corporate-restricted lane with its approved processors.</>}
      summary={(r) => <>{(r.allowed_classifications ?? []).map((c: string) => <Badge key={c}>{c.replace(/_/g, " ")}</Badge>)}<Yes on={r.approved_at} yes="approved" no="not approved" /></>} />
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Data lanes" subtitle="Which processors and regions may handle each data class. Corporate-restricted data only flows through approved lanes." />
      <SettingsNav current="/settings/lanes" />
      <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
