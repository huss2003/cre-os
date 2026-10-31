import { Suspense } from "react";
import { Badge, PageHeader } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { ConfigPage, Yes, type ConfigField } from "@/modules/admin/ui/config-page";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Partners" };

const FIELDS: ConfigField[] = [
  { name: "name", label: "Name", required: true },
  { name: "partner_type", label: "Type", type: "select", options: [["fitout_finance", "Fit-out finance"], ["referral", "Referral"], ["landlord", "Landlord"], ["operator", "Operator"], ["vendor", "Vendor"], ["other", "Other"]] },
  { name: "terms_json", label: "Terms (JSON)", type: "json", hint: "e.g. {\"referral_fee_pct\": 1, \"min_ticket_inr\": 5000000}. Deterministic code reads these; the AI never computes fees." },
  { name: "conflicts_note", label: "Conflicts / disclosure", type: "textarea" },
  { name: "reliability_preference", label: "Recorded preference", hint: "Shown with alternatives, never instead of them." },
  { name: "active", label: "Active", type: "checkbox" },
];

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAdminPage("admin", "/settings/partners");
  const sp = await searchParams;
  return (
    <ConfigPage ctx={ctx} kind="partner" fields={FIELDS} title="partner" archived={sp.archived === "1"}
      emptyText={<>Add partners your tenant works with. Proposals and finance options show them alongside alternatives.</>}
      summary={(r) => <><Badge>{String(r.partner_type).replace(/_/g, " ")}</Badge><Yes on={r.active} yes="active" no="inactive" /></>} />
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Partners" subtitle="Fit-out finance, referral and other partners. A recorded preference never hides alternatives (partner neutrality)." />
      <SettingsNav current="/settings/partners" />
      <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
