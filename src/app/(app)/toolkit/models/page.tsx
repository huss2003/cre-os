import Link from "next/link";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveRatingModelAction } from "@/modules/toolkit/actions-compare";
import { DEFAULT_MODEL, type RatingFactor, type RatingRule } from "@/modules/toolkit/calc/rating";
import { listRatingModels } from "@/modules/toolkit/comparison";
import { Field, OpenRow, Status, ToolHeader, btn, inputCls } from "@/modules/toolkit/ui/kit";
import { ModelEditor } from "./editor";

export default async function RatingModelsPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  const ctx = await requirePageContext();
  const rows = await listRatingModels(ctx.db, ctx.workspaceId);
  const cur = rows.find((r) => r.id === edit);
  const init = cur ? { name: cur.name as string, factors: cur.factors as RatingFactor[], rules: cur.rules as RatingRule[], isDefault: !!cur.is_default } : { name: "", factors: DEFAULT_MODEL.factors, rules: DEFAULT_MODEL.rules, isDefault: rows.length === 0 };
  return (
    <div data-tour="toolkit-models" className="max-w-4xl space-y-6">
      <ToolHeader back={{ href: "/toolkit/compare", label: "Property comparison" }} title="Rating models"
        purpose="A rating model decides how buildings are scored: how many points each factor is worth, and which must-have rules a building has to pass. Saving creates a new version; past comparisons keep the version they used." />

      <section aria-labelledby="saved-h" className="space-y-3">
        <h2 id="saved-h" className="text-lg font-semibold">Saved models</h2>
        {rows.length === 0 ? <p className="rounded-xl border-2 border-dashed border-slate-300 px-4 py-5 text-sm text-ink-soft">None yet — comparisons use the built-in default (location 20, area 20, commercials 25, quality 15, connectivity 10, amenities 10). Save one below to customise.</p> : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.id}><OpenRow href={`/toolkit/models?edit=${r.id}`} title={<>{r.name} <span className="font-normal text-ink-soft">v{r.version}</span></>} meta="Edit as new version" right={r.is_default ? <Status s="approved" label="Workspace default" /> : null} /></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="edit-h" className="rounded-xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="edit-h" className="text-lg font-semibold">{cur ? `Edit ${cur.name} (saves as v${cur.version + 1})` : "New model"}</h2>
          {cur ? <Link className={btn.quiet} href="/toolkit/models">Start a new model instead</Link> : null}
        </div>
        {ctx.role === "viewer" ? <p className="mt-2 text-sm text-ink-soft">Viewers can’t change rating models.</p> : (
          <ActionForm key={edit ?? "new"} action={saveRatingModelAction} className="mt-4 space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Model name" required htmlFor="m-name" hint="Same name = new version of that model."><input id="m-name" name="name" defaultValue={init.name} required className={inputCls} /></Field>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 self-end rounded-lg border border-slate-300 bg-white px-3 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
                <input type="checkbox" name="is_default" defaultChecked={init.isDefault} className="h-5 w-5 accent-brand" /> Use as workspace default
              </label>
            </div>
            <ModelEditor initialFactors={init.factors} initialRules={init.rules} />
            <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink-soft">Saving never changes past comparisons — it creates a new version.</p>
              <Submit className="min-h-11">Save as new version</Submit>
            </div>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
