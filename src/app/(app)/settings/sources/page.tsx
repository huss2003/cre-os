import { Suspense } from "react";
import { Badge, PageHeader } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { ConfigPage, Yes, type ConfigField } from "@/modules/admin/ui/config-page";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Licensed sources" };

const FIELDS: ConfigField[] = [
  { name: "name", label: "Name", required: true },
  { name: "licence_identifier", label: "Licence / contract reference" },
  { name: "allowed_purposes", label: "Allowed purposes", type: "list", hint: "Comma separated, e.g. internal_research, client_advice" },
  { name: "user_count", label: "Licensed users", type: "number" },
  { name: "retention_days", label: "Retention (days)", type: "number", hint: "Blank = per licence / unknown." },
  { name: "expires_on", label: "Licence expires", type: "date" },
  { name: "redistribution_limits", label: "Redistribution limits", type: "textarea" },
  { name: "permits_ai_processing", label: "Licence permits AI processing", type: "checkbox" },
  { name: "permits_colleague_sharing", label: "Licence permits colleague sharing", type: "checkbox" },
];

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAdminPage("admin", "/settings/sources");
  const sp = await searchParams;
  return (
    <ConfigPage ctx={ctx} kind="licensed_source" fields={FIELDS} title="licensed source" archived={sp.archived === "1"}
      emptyText={<>Record each licensed data source (for example a lease-registration database) before importing from it. Imports tag rows from it as licensed-restricted.</>}
      summary={(r) => <><Yes on={r.permits_ai_processing} yes="AI allowed" no="no AI" /><Yes on={r.permits_colleague_sharing} yes="sharing allowed" no="no sharing" />{r.expires_on ? <Badge tone={r.expires_on < new Date().toISOString().slice(0, 10) ? "bad" : "neutral"}>expires {fmtDate(r.expires_on)}</Badge> : null}</>} />
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Licensed sources" subtitle="Paid data sources and what the licence permits. Purchase is not replication: AI processing and colleague sharing must be explicitly allowed." />
      <SettingsNav current="/settings/sources" />
      <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
