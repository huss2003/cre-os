import Link from "next/link";
import { Badge, ButtonLink, Card, Field, Input, PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { saveRatingModelAction } from "@/modules/toolkit/actions-compare";
import { DEFAULT_MODEL, type RatingFactor, type RatingRule } from "@/modules/toolkit/calc/rating";
import { listRatingModels } from "@/modules/toolkit/comparison";
import { ModelEditor } from "./editor";

export default async function RatingModelsPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  const ctx = await requirePageContext();
  const rows = await listRatingModels(ctx.db, ctx.workspaceId);
  const cur = rows.find((r) => r.id === edit);
  const init = cur ? { name: cur.name as string, factors: cur.factors as RatingFactor[], rules: cur.rules as RatingRule[], isDefault: !!cur.is_default } : { name: "", factors: DEFAULT_MODEL.factors, rules: DEFAULT_MODEL.rules, isDefault: rows.length === 0 };
  return (
    <div className="max-w-4xl">
      <PageHeader title="Rating models" subtitle="Weights and rules used by Property comparison. Saving creates a new version; past comparisons keep the version they used."
        actions={<ButtonLink variant="secondary" href="/toolkit/compare">Comparisons</ButtonLink>} />
      <Card title="Saved models" className="mb-5">
        {rows.length === 0 ? <p className="text-sm text-ink-soft">None yet — comparisons use the built-in default (location 20, area 20, commercials 25, quality 15, connectivity 10, amenities 10). Save one below to customise.</p> : (
          <ul className="divide-y divide-line text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                <span>{r.name} <span className="text-ink-soft">v{r.version}</span> {r.is_default ? <Badge tone="brand">default</Badge> : null}</span>
                <Link className="text-brand" href={`/toolkit/models?edit=${r.id}`}>Edit as new version</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={cur ? `Edit ${cur.name} (saves v${cur.version + 1})` : "New model"}>
        {ctx.role === "viewer" ? <p className="text-sm text-ink-soft">Viewers can’t change rating models.</p> : (
          <ActionForm key={edit ?? "new"} action={saveRatingModelAction} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" hint="Same name = new version of that model."><Input name="name" defaultValue={init.name} required /></Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="is_default" defaultChecked={init.isDefault} className="h-4 w-4 accent-brand" /> Workspace default</label>
            </div>
            <ModelEditor initialFactors={init.factors} initialRules={init.rules} />
            <Submit>Save version</Submit>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
