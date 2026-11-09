import { notFound } from "next/navigation";
import { Button, ButtonLink, Card, Field, Input, MoreFields, PageHeader, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { editRequirementAction } from "@/modules/deals/actions";
import { FIELD_BY_KEY } from "@/modules/deals/requirements/contract";
import { Flash } from "@/modules/deals/ui";

const opts = (k: string) => FIELD_BY_KEY.get(k)?.options ?? [];
const v = (x: unknown) => (x === null || x === undefined ? "" : String(x));
const n = (x: unknown) => (x === null || x === undefined || x === "" ? "" : String(Number(x)));

export default async function EditRequirementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext("editor");
  const { data: r } = await ctx.db.from("requirement").select("*").eq("id", id).eq("workspace_id", ctx.workspaceId).maybeSingle();
  if (!r) notFound();
  const sel = (name: string, label: string, list: string[]) => (
    <Field label={label}><Select name={name} defaultValue={v(r[name])}><option value="">Unknown</option>{list.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}</Select></Field>
  );
  return (
    <div className="max-w-lg">
      <PageHeader title="Edit requirement" subtitle="Confirmed fields go to Approvals." />
      <Flash sp={sp} />
      <form action={editRequirementAction} className="space-y-4">
        <input type="hidden" name="id" value={id} />
        <Card title="Who and what">
          <div className="space-y-4">
            <Field label="Title"><Input name="title" required maxLength={300} defaultValue={v(r.title)} /></Field>
            {sel("objective", "Objective", opts("objective"))}
          </div>
        </Card>
        <Card title="Size and timing">
          <div className="space-y-4">
            <Field label="Target area (sq ft)"><Input name="area_target" inputMode="numeric" defaultValue={n(r.area_target_sf)} /></Field>
            <Field label="Move-in date"><Input type="date" name="occupation_date" defaultValue={v(r.occupation_date).slice(0, 10)} /></Field>
            <MoreFields>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Area min"><Input name="area_min" inputMode="numeric" defaultValue={n(r.area_min_sf)} /></Field>
                <Field label="Area max"><Input name="area_max" inputMode="numeric" defaultValue={n(r.area_max_sf)} /></Field>
              </div>
              {sel("area_basis", "Area basis", ["carpet", "chargeable"])}
              <Field label="Seats"><Input name="seats_target" inputMode="numeric" defaultValue={n(r.seats_target)} /></Field>
              {sel("fitout_standard", "Fit-out", opts("fitout_standard"))}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Budget min"><Input name="budget_min" inputMode="decimal" defaultValue={n(r.budget_min)} /></Field>
                <Field label="Budget max"><Input name="budget_max" inputMode="decimal" defaultValue={n(r.budget_max)} /></Field>
              </div>
              {sel("budget_basis", "Budget basis", opts("budget_basis"))}
              <Field label="Decision date"><Input type="date" name="decision_date" defaultValue={v(r.decision_date).slice(0, 10)} /></Field>
              <Field label="Tenure (months)"><Input name="tenure_months" inputMode="numeric" defaultValue={n(r.tenure_months)} /></Field>
              {sel("mandate_status", "Mandate", opts("mandate_status").filter((o) => o !== "unknown"))}
            </MoreFields>
          </div>
        </Card>
        <Field label="Source (optional)"><Input name="reason" maxLength={300} placeholder="e.g. call with Rahul, 8 Nov" /></Field>
        <div className="flex gap-2"><Button type="submit">Save changes</Button><ButtonLink variant="secondary" href={`/requirements/${id}`}>Cancel</ButtonLink></div>
      </form>
    </div>
  );
}
