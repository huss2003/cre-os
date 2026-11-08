import { notFound } from "next/navigation";
import { Button, ButtonLink, Card, Field, Input, PageHeader, Select } from "@/components/ui";
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
    <div className="max-w-3xl">
      <PageHeader title="Edit requirement" subtitle="Change anything below and press Save. Fields the client already confirmed are sent to Approvals instead of changing straight away." />
      <Flash sp={sp} />
      <form action={editRequirementAction} className="space-y-4">
        <input type="hidden" name="id" value={id} />
        <Card title="Who and what">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title"><Input name="title" required maxLength={300} defaultValue={v(r.title)} /></Field>
            {sel("objective", "Objective", opts("objective"))}
          </div>
        </Card>
        <Card title="Size, budget and timing (leave blank if unknown)">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Area min (sq ft)"><Input name="area_min" inputMode="numeric" defaultValue={n(r.area_min_sf)} /></Field>
            <Field label="Target"><Input name="area_target" inputMode="numeric" defaultValue={n(r.area_target_sf)} /></Field>
            <Field label="Max"><Input name="area_max" inputMode="numeric" defaultValue={n(r.area_max_sf)} /></Field>
            {sel("area_basis", "Area basis", ["carpet", "chargeable"])}
            <Field label="Seats (target)"><Input name="seats_target" inputMode="numeric" defaultValue={n(r.seats_target)} /></Field>
            {sel("fitout_standard", "Fit-out standard", opts("fitout_standard"))}
            <Field label="Budget min"><Input name="budget_min" inputMode="decimal" defaultValue={n(r.budget_min)} /></Field>
            <Field label="Budget max"><Input name="budget_max" inputMode="decimal" defaultValue={n(r.budget_max)} /></Field>
            {sel("budget_basis", "Budget basis", opts("budget_basis"))}
            <Field label="Decision date"><Input type="date" name="decision_date" defaultValue={v(r.decision_date).slice(0, 10)} /></Field>
            <Field label="Move-in date"><Input type="date" name="occupation_date" defaultValue={v(r.occupation_date).slice(0, 10)} /></Field>
            <Field label="Tenure (months)"><Input name="tenure_months" inputMode="numeric" defaultValue={n(r.tenure_months)} /></Field>
            {sel("mandate_status", "Mandate", opts("mandate_status").filter((o) => o !== "unknown"))}
          </div>
        </Card>
        <Card title="Why are you changing this?">
          <Field label="Source (optional)" hint="e.g. call with Rahul, 8 Nov"><Input name="reason" maxLength={300} /></Field>
        </Card>
        <div className="flex gap-2"><Button type="submit">Save changes</Button><ButtonLink variant="secondary" href={`/requirements/${id}`}>Cancel</ButtonLink></div>
      </form>
    </div>
  );
}
