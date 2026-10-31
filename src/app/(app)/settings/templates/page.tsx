import { Suspense } from "react";
import { Badge, PageHeader } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { ConfigPage, Yes, type ConfigField } from "@/modules/admin/ui/config-page";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Templates" };

const FIELDS: ConfigField[] = [
  { name: "name", label: "Name", required: true },
  { name: "kind", label: "Format", type: "select", options: [["pptx", "PowerPoint (.pptx)"], ["docx", "Word (.docx)"], ["xlsx", "Excel (.xlsx)"]] },
  { name: "purpose", label: "Purpose", required: true, hint: "e.g. shortlist_deck, proposal, market_note, comparison_xlsx" },
  { name: "file", label: "Template file", type: "file", hint: "Optional. Max 25 MB. Without a file the built-in default layout is used with your brand settings." },
  { name: "brand_json", label: "Brand (JSON)", type: "json", hint: "e.g. {\"primary\": \"#0f7c86\", \"accent\": \"#c08a4a\", \"font\": \"Calibri\", \"logo_path\": \"...\"}" },
  { name: "approved", label: "Approved for use", type: "checkbox" },
];

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Body({ searchParams }: { searchParams: SP }) {
  const ctx = await requireAdminPage("admin", "/settings/templates");
  const sp = await searchParams;
  return (
    <ConfigPage ctx={ctx} kind="template_asset" fields={FIELDS} title="template" archived={sp.archived === "1"}
      emptyText={<>No templates yet. Documents use the built-in neutral layout until you upload your own.</>}
      summary={(r) => <><Badge>{r.kind}</Badge><Badge>{r.purpose}</Badge><Badge>v{r.version}</Badge><Yes on={r.approved} yes="approved" no="not approved" />{r.storage_path ? null : <Badge>built-in layout</Badge>}</>} />
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Templates" subtitle="Office templates for decks, proposals, market notes and comparison workbooks. Upload a file and brand settings; approve before use." />
      <SettingsNav current="/settings/templates" />
      <Suspense fallback={<Loading />}><Body searchParams={searchParams} /></Suspense>
    </>
  );
}
