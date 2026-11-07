import { Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { createRequirementAction } from "@/modules/deals/actions";
import { FIELD_BY_KEY } from "@/modules/deals/requirements/contract";
import { Flash } from "@/modules/deals/ui";

const opts = (k: string) => FIELD_BY_KEY.get(k)?.options ?? [];

export default async function NewRequirementPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext("editor");
  const { data: orgs } = await ctx.db.from("organisation").select("id, display_name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("display_name").limit(500);
  return (
    <div className="max-w-3xl">
      <PageHeader title="New requirement" subtitle="Everything you enter here is saved as an estimate until the client confirms it." />
      <Flash sp={sp} />
      <form action={createRequirementAction} className="space-y-4">
        <Card title="Who and what">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" hint="e.g. Acme Pune consolidation 2027"><Input name="title" required maxLength={300} /></Field>
            <Field label="Objective"><Select name="objective" defaultValue=""><option value="">Unknown</option>{opts("objective").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
            <Field label="Existing company"><Select name="org_id" defaultValue={typeof sp.org === "string" ? sp.org : ""}><option value="">— choose —</option>{(orgs ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</Select></Field>
            <Field label="…or new company name"><Input name="org_name" maxLength={300} /></Field>
          </div>
        </Card>
        <Card title="Size, budget and timing (leave blank if unknown)">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Area min (SF)"><Input name="area_min" inputMode="numeric" /></Field>
            <Field label="Target"><Input name="area_target" inputMode="numeric" /></Field>
            <Field label="Max"><Input name="area_max" inputMode="numeric" /></Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Area basis"><Select name="area_basis" defaultValue=""><option value="">Unknown</option><option value="carpet">Carpet</option><option value="chargeable">Chargeable</option></Select></Field>
            <Field label="Seats (target)"><Input name="seats_target" inputMode="numeric" /></Field>
            <Field label="Fit-out standard"><Select name="fitout_standard" defaultValue=""><option value="">Unknown</option>{opts("fitout_standard").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Budget min"><Input name="budget_min" inputMode="decimal" /></Field>
            <Field label="Budget max"><Input name="budget_max" inputMode="decimal" /></Field>
            <Field label="Budget basis"><Select name="budget_basis" defaultValue=""><option value="">Unknown</option>{opts("budget_basis").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Decision date"><Input type="date" name="decision_date" /></Field>
            <Field label="Occupation date"><Input type="date" name="occupation_date" /></Field>
            <Field label="Tenure (months)"><Input name="tenure_months" inputMode="numeric" /></Field>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Mandate"><Select name="mandate_status" defaultValue=""><option value="">Unknown</option>{opts("mandate_status").filter((o) => o !== "unknown").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
          </div>
        </Card>
        <Button type="submit">Create requirement</Button>
      </form>
    </div>
  );
}
