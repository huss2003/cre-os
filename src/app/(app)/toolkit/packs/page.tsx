import Link from "next/link";
import { Help } from "@/components/ui";
import { EmptyState, Field, OpenRow, ToolHeader, btn, inputCls } from "@/modules/toolkit/ui/kit";
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
    <div data-tour="toolkit-packs" className="mx-auto max-w-4xl space-y-8 pb-16">
      <ToolHeader title="Site-visit pack & deck" purpose="Pick a requirement and the buildings to show. You get a Word site-visit pack (details, key commercials, photos/layouts, assessment checklist, blank feedback form), the same pack as a printable PDF, and an editable PowerPoint deck. Unverified and estimated figures are labelled."
        steps={["Choose the requirement", "Tick the buildings", "Generate the files", "Download"]} current={0} />
      <section className="space-y-3">
        <h2 className="flex items-center text-lg font-semibold">Make a pack<Help>Commercial terms come from the latest quote version per building; comparison figures from the latest saved property comparison / lease economics for the requirement. Branding comes from your template settings.</Help></h2>
        {!r.length || !a.length ? <EmptyState title="Nothing to pack yet" text={`You need at least one requirement and one building.${!r.length ? " Add a requirement first." : " Add a building first."}`} action={<Link href={!r.length ? "/requirements" : "/buildings"} className={btn.primary}>{!r.length ? "Create a requirement" : "Add a building"}</Link>} /> : (
          <ActionForm action={generatePacksAction} className="space-y-4 rounded-xl border border-line bg-surface p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Requirement" htmlFor="pk-req" required><select id="pk-req" name="requirement_id" required defaultValue="" className={inputCls}>{[<option key="" value="" disabled>Choose…</option>, ...r.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)]}</select></Field>
              <Field label="Prepared for" htmlFor="pk-for" hint="Client name on the cover."><input id="pk-for" name="prepared_for" placeholder="e.g. Acme Ltd" className={inputCls} /></Field>
            </div>
            <fieldset><legend className="mb-1.5 flex items-center gap-1.5 text-sm font-medium"><span aria-hidden className="text-slate-400">✎</span>Buildings to show <span className="text-xs font-normal text-ink-soft">tick one or more</span></legend>
              <div className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border border-slate-300 bg-white p-2 sm:grid-cols-2">
                {a.map((x) => <label key={x.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-canvas has-[:checked]:bg-brand-soft/50"><input type="checkbox" name="asset_id" value={x.id} className="size-5 accent-[var(--color-brand)]" /> <span>{x.name}{x.micro?.name ? <span className="text-xs text-ink-soft"> · {x.micro.name}</span> : null}</span></label>)}
              </div>
            </fieldset>
            <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0"><Submit className="w-full sm:w-auto">Generate the files</Submit></div>
          </ActionForm>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Your packs <span className="text-sm font-normal text-ink-soft">({p.length})</span></h2>
        {!p.length ? <EmptyState title="No packs yet" text="Generate a pack above. Each pack is kept with the analysis and quote versions it used." /> : (
          <ul className="space-y-2">
            {p.map((x) => <li key={x.id}><OpenRow href={`/toolkit/packs/${x.id}`} title={x.title} meta={`Version ${x.current_version} · ${String(x.updated_at).slice(0, 10)}`} /></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
