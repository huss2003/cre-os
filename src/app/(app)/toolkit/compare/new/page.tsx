import { Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { createComparisonAction } from "@/modules/toolkit/actions-compare";
import { latestModels, listAssetsForPicker, listRatingModels, listRequirementsForPicker } from "@/modules/toolkit/comparison";

export default async function NewComparisonPage() {
  const ctx = await requirePageContext("editor");
  const [reqs, assets, models] = await Promise.all([
    listRequirementsForPicker(ctx.db, ctx.workspaceId), listAssetsForPicker(ctx.db, ctx.workspaceId), listRatingModels(ctx.db, ctx.workspaceId).then(latestModels),
  ]);
  return (
    <div className="max-w-4xl">
      <PageHeader title="New comparison" subtitle="Blank fields stay unknown — they are excluded from the score and listed as missing." />
      <ActionForm action={createComparisonAction} className="space-y-5">
        <div data-tour="compare-basics"><Card title="Basics">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title"><Input name="title" placeholder="e.g. Kharadi 25k sf options" required /></Field>
            <Field label="Requirement" hint="Area, budget and preferred micro-markets come from the requirement and drive the mandatory rules.">
              <Select name="requirement_id" defaultValue=""><option value="">— none —</option>{reqs.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</Select>
            </Field>
            <Field label="Rating model"><Select name="model_id" defaultValue="">
              <option value="">Workspace default (or built-in)</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name} v{m.version}</option>)}</Select></Field>
            <Field label="Term (months)" hint="Used for the effective occupancy cost. Blank = 60 months, shown as an assumption."><Input name="term_months" inputMode="numeric" /></Field>
          </div>
        </Card></div>
        <Card title="Buildings in the database">
          {assets.length === 0 ? <p className="text-sm text-ink-soft">No buildings yet — add them under Buildings, or use manual rows below.</p> : (
            <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
              {assets.map((a) => (
                <label key={a.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-canvas">
                  <input type="checkbox" name="asset_ids" value={a.id} className="h-4 w-4 accent-brand" />
                  <span>{a.name}</span><span className="text-xs text-ink-soft">{a.micro?.name ?? ""} {a.grade ?? ""}</span>
                </label>
              ))}
            </div>
          )}
        </Card>
        <div data-tour="compare-manual"><Card title="Manual properties" help="For options not in the database. They are labelled as manually entered and flagged for verification.">
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <details key={i} open={i === 0} className="rounded-xl border border-line bg-canvas/50 p-3">
                <summary className="cursor-pointer text-sm font-medium">Property {i + 1}</summary>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Name"><Input name={`m${i}_name`} /></Field>
                  <Field label="Micro-market"><Input name={`m${i}_mm`} /></Field>
                  <Field label="Grade"><Select name={`m${i}_grade`} defaultValue=""><option value="">unknown</option>{["A+", "A", "B+", "B", "C"].map((g) => <option key={g}>{g}</option>)}</Select></Field>
                  <Field label="Area basis"><Select name={`m${i}_basis`} defaultValue=""><option value="">unknown</option><option value="chargeable">chargeable</option><option value="carpet">carpet</option></Select></Field>
                  <Field label="Area (sf)"><Input name={`m${i}_area`} inputMode="decimal" /></Field>
                  <Field label="Rent ₹/sf/mo"><Input name={`m${i}_rent`} inputMode="decimal" /></Field>
                  <Field label="CAM ₹/sf/mo"><Input name={`m${i}_cam`} inputMode="decimal" /></Field>
                  <Field label="Deposit (months)" hint="Refundable — shown separately, never part of cost."><Input name={`m${i}_dep`} inputMode="decimal" /></Field>
                  <Field label="Rent-free (months)"><Input name={`m${i}_rf`} inputMode="decimal" /></Field>
                  <Field label="Escalation %"><Input name={`m${i}_esc`} inputMode="decimal" /></Field>
                  <Field label="Every (years)"><Input name={`m${i}_escyears`} inputMode="decimal" /></Field>
                  <Field label="Metro (km)"><Input name={`m${i}_metro`} inputMode="decimal" /></Field>
                  <Field label="Figures are"><Select name={`m${i}_evidence`} defaultValue="manual"><option value="manual">manual</option><option value="estimated">estimated</option><option value="quoted">quoted</option></Select></Field>
                </div>
              </details>
            ))}
          </div>
        </Card></div>
        <Submit dataTour="compare-run">Run comparison</Submit>
      </ActionForm>
    </div>
  );
}
