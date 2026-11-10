import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { createComparisonAction } from "@/modules/toolkit/actions-compare";
import { latestModels, listAssetsForPicker, listRatingModels, listRequirementsForPicker } from "@/modules/toolkit/comparison";
import { COMPARE_STEPS } from "@/modules/toolkit/ui/compare/explain";
import { ManualRows } from "@/modules/toolkit/ui/compare/manual-rows";
import { Field, ToolHeader, inputCls } from "@/modules/toolkit/ui/kit";

function Step({ n, title, desc, children }: { n: number; title: string; desc: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="rounded-xl border border-line bg-surface">
      <header className="flex gap-3 border-b border-line px-5 py-4">
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">{n}</span>
        <div><h2 id={`step-${n}`} className="font-semibold"><span className="sr-only">Step {n}: </span>{title}</h2><p className="text-sm text-ink-soft">{desc}</p></div>
      </header>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

export default async function NewComparisonPage() {
  const ctx = await requirePageContext("editor");
  const [reqs, assets, models] = await Promise.all([
    listRequirementsForPicker(ctx.db, ctx.workspaceId), listAssetsForPicker(ctx.db, ctx.workspaceId), listRatingModels(ctx.db, ctx.workspaceId).then(latestModels),
  ]);
  return (
    <div className="max-w-4xl space-y-6">
      <ToolHeader back={{ href: "/toolkit/compare", label: "All comparisons" }} title="New comparison"
        purpose="Fill in what you know. Blank fields stay unknown — they are left out of the score and listed as missing, never treated as zero."
        steps={COMPARE_STEPS} current={0} />
      <ActionForm action={createComparisonAction} className="space-y-6 pb-4">
        <div data-tour="compare-basics"><Step n={1} title="Requirement & rating model" desc="What the client needs, and how buildings should be scored.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Comparison title" required htmlFor="c-title"><input id="c-title" name="title" className={inputCls} placeholder="e.g. Kharadi 25k sf options" required /></Field>
            <Field label="Client requirement" htmlFor="c-req" hint="Its area, budget and preferred micro-markets set the must-have rules.">
              <select id="c-req" name="requirement_id" defaultValue="" className={inputCls}><option value="">None — no must-have rules from a requirement</option>{reqs.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
            </Field>
            <Field label="Rating model" htmlFor="c-model" hint="A rating model is the set of weights (what matters most) and must-have rules used to score buildings.">
              <select id="c-model" name="model_id" defaultValue="" className={inputCls}><option value="">Workspace default (or built-in)</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name} v{m.version}</option>)}</select>
            </Field>
            <Field label="Lease term" unit="months" htmlFor="c-term" hint="Used for effective occupancy cost. Blank = 60 months, shown as an assumption."><input id="c-term" name="term_months" inputMode="numeric" className={`${inputCls} pr-16`} placeholder="60" /></Field>
          </div>
        </Step></div>

        <Step n={2} title="Buildings from your database" desc="Tick each building to include. Quotes and availability on file are used automatically.">
          {assets.length === 0 ? <p className="rounded-lg border-2 border-dashed border-slate-300 px-4 py-6 text-center text-sm text-ink-soft">No buildings in the database yet — add them under Buildings, or type them in Step 3.</p> : (
            <fieldset>
              <legend className="sr-only">Buildings to compare</legend>
              <div className="grid max-h-96 gap-2 overflow-y-auto p-0.5 sm:grid-cols-2">
                {assets.map((a) => (
                  <label key={a.id} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-slate-300 bg-white px-3 py-2 hover:border-brand/60 has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:ring-1 has-[:checked]:ring-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40">
                    <input type="checkbox" name="asset_ids" value={a.id} className="peer h-5 w-5 shrink-0 accent-brand" />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{a.name}</span><span className="block truncate text-xs text-ink-soft">{[a.micro?.name, a.grade ? `Grade ${a.grade}` : null].filter(Boolean).join(" · ") || "Location/grade unknown"}</span></span>
                    <span className="hidden text-xs font-semibold text-brand peer-checked:inline">✓ Selected</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </Step>

        <div data-tour="compare-manual"><Step n={3} title="Buildings not in the database (optional)" desc="Type in other options. They are labelled as manually entered and flagged for verification.">
          <ManualRows />
        </Step></div>

        <div className="sticky bottom-0 z-20 -mx-4 flex flex-col gap-2 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-soft">Scores, ranking and the recommendation are calculated next.</p>
          <Submit dataTour="compare-run" className="min-h-11 w-full sm:w-auto">Compare buildings →</Submit>
        </div>
      </ActionForm>
    </div>
  );
}
