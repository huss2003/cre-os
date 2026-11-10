import Link from "next/link";
import { Badge, Card, EmptyState, Field, Help, Input, PageHeader, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { generatePacksAction } from "@/modules/toolkit/actions-extras";

type Row = Record<string, any>;

export default async function PacksPage() {
  const app = await requirePageContext();
  const [reqs, assets, packs] = await Promise.all([
    app.db.from("requirement").select("id, title").eq("workspace_id", app.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200),
    app.db.from("asset").select("id, name, micro:micro_market_id(name)").eq("workspace_id", app.workspaceId).is("archived_at", null).in("asset_kind", ["building", "tower"]).order("name").limit(300),
    app.db.from("deal_analysis").select("id, title, current_version, updated_at").eq("workspace_id", app.workspaceId).eq("kind", "deliverable").eq("formula_version", "packs-1.0").is("archived_at", null).order("updated_at", { ascending: false }).limit(30),
  ]);
  const r = (reqs.data ?? []) as Row[], a = (assets.data ?? []) as Row[], p = (packs.data ?? []) as Row[];
  return (
    <div data-tour="toolkit-packs" className="space-y-5">
      <PageHeader title="Site visit pack & presentation" subtitle="Pick a requirement and the buildings to show. You get a Word site-visit pack (details, checklist, blank feedback) and an editable PowerPoint deck. Unverified and estimated figures are labelled." />
      <Card title="Generate" help={<Help>Commercial terms come from the latest quote version per building; comparison figures from the latest saved property comparison / lease economics for the requirement. Branding comes from your template settings.</Help>}>
        {!r.length || !a.length ? <EmptyState title="Nothing to pack yet">You need at least one requirement and one building. Add them under Requirements and Buildings.</EmptyState> : (
          <ActionForm action={generatePacksAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Requirement"><Select name="requirement_id" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...r.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)]}</Select></Field>
              <Field label="Prepared for (optional)"><Input name="prepared_for" placeholder="Client name on the cover" /></Field>
            </div>
            <fieldset><legend className="mb-1 text-xs font-medium text-ink-soft">Buildings</legend>
              <div className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-2">
                {a.map((x) => <label key={x.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="asset_id" value={x.id} /> {x.name}{x.micro?.name ? <span className="text-xs text-ink-soft">· {x.micro.name}</span> : null}</label>)}
              </div>
            </fieldset>
            <Submit>Generate both files</Submit>
          </ActionForm>
        )}
      </Card>
      <Card title="Generated packs">
        {!p.length ? <EmptyState title="No packs yet">Generated packs are kept with the analysis and quote versions they used.</EmptyState> : (
          <ul className="divide-y divide-line text-sm">
            {p.map((x) => <li key={x.id} className="flex items-center justify-between gap-2 py-2"><Link className="text-brand" href={`/toolkit/packs/${x.id}`}>{x.title}</Link><span className="text-xs text-ink-soft">{String(x.updated_at).slice(0, 10)} <Badge>v{x.current_version}</Badge></span></li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
