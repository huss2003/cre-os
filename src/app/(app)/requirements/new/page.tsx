import { Button, Card, Field, Input, MoreFields, PageHeader, Select } from "@/components/ui";
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
    <div className="max-w-lg">
      <PageHeader title="New requirement" subtitle="Saved as an estimate until the client confirms." />
      <Flash sp={sp} />
      <form action={createRequirementAction} className="space-y-4">
        <Card title="Who and what">
          <div className="space-y-4">
            <Field label="Title"><Input name="title" required maxLength={300} placeholder="e.g. Acme Pune consolidation 2027" /></Field>
            <Field label="Company"><Select name="org_id" defaultValue={typeof sp.org === "string" ? sp.org : ""}><option value="">— choose —</option>{(orgs ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</Select></Field>
            <Field label="Or new company"><Input name="org_name" maxLength={300} /></Field>
            <MoreFields>
              <Field label="Objective"><Select name="objective" defaultValue=""><option value="">Unknown</option>{opts("objective").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
            </MoreFields>
          </div>
        </Card>
        <Card title="Size and timing">
          <div className="space-y-4">
            <Field label="Target area (sq ft)" hint="Leave blank if unknown"><Input name="area_target" inputMode="numeric" /></Field>
            <Field label="Move-in date"><Input type="date" name="occupation_date" /></Field>
            <MoreFields>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Area min"><Input name="area_min" inputMode="numeric" /></Field>
                <Field label="Area max"><Input name="area_max" inputMode="numeric" /></Field>
              </div>
              <Field label="Area basis"><Select name="area_basis" defaultValue=""><option value="">Unknown</option><option value="carpet">Carpet</option><option value="chargeable">Chargeable</option></Select></Field>
              <Field label="Seats"><Input name="seats_target" inputMode="numeric" /></Field>
              <Field label="Fit-out"><Select name="fitout_standard" defaultValue=""><option value="">Unknown</option>{opts("fitout_standard").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Budget min"><Input name="budget_min" inputMode="decimal" /></Field>
                <Field label="Budget max"><Input name="budget_max" inputMode="decimal" /></Field>
              </div>
              <Field label="Budget basis"><Select name="budget_basis" defaultValue=""><option value="">Unknown</option>{opts("budget_basis").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
              <Field label="Decision date"><Input type="date" name="decision_date" /></Field>
              <Field label="Tenure (months)"><Input name="tenure_months" inputMode="numeric" /></Field>
              <Field label="Mandate"><Select name="mandate_status" defaultValue=""><option value="">Unknown</option>{opts("mandate_status").filter((o) => o !== "unknown").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
            </MoreFields>
          </div>
        </Card>
        <Button type="submit">Create requirement</Button>
      </form>
    </div>
  );
}
