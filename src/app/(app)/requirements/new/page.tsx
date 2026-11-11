import { Button, Card, Field, Input, MoreFields, PageHeader, Select } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { createRequirementAction } from "@/modules/deals/actions";
import { FIELD_BY_KEY } from "@/modules/deals/requirements/contract";
import { Flash } from "@/modules/deals/ui";

const opts = (k: string) => FIELD_BY_KEY.get(k)?.options ?? [];

export default async function NewRequirementPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext("editor");
  // Values sent back after a failed submit (?v=JSON), so the user does not retype everything.
  let kept: Record<string, string> = {};
  try { if (typeof sp.v === "string") kept = JSON.parse(sp.v) as Record<string, string>; } catch { kept = {}; }
  const dv = (k: string) => (typeof kept[k] === "string" ? kept[k] : "");
  const { data: orgs } = await ctx.db.from("organisation").select("id, display_name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("display_name").limit(500);
  return (
    <div className="max-w-lg">
      <PageHeader title="New requirement" subtitle="Saved as an estimate until the client confirms." />
      <Flash sp={sp} />
      <form action={createRequirementAction} className="space-y-4">
        <Card title="Who and what">
          <div className="space-y-4">
            <Field label="Title"><Input name="title" defaultValue={dv("title")} required maxLength={300} placeholder="e.g. Acme Pune consolidation 2027" /></Field>
            <Field label="Company"><Select name="org_id" defaultValue={dv("org_id") || (typeof sp.org === "string" ? sp.org : "")}><option value="">— choose —</option>{(orgs ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</Select></Field>
            <Field label="Or new company"><Input name="org_name" defaultValue={dv("org_name")} maxLength={300} /></Field>
            <MoreFields>
              <Field label="Objective"><Select name="objective" defaultValue={dv("objective")}><option value="">Unknown</option>{opts("objective").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
            </MoreFields>
          </div>
        </Card>
        <Card title="Size and timing">
          <div className="space-y-4">
            <Field label="Target area (sq ft)" hint="Leave blank if unknown"><Input name="area_target" defaultValue={dv("area_target")} inputMode="numeric" /></Field>
            <Field label="Move-in date"><Input type="date" name="occupation_date" defaultValue={dv("occupation_date")} /></Field>
            <MoreFields>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Area min"><Input name="area_min" defaultValue={dv("area_min")} inputMode="numeric" /></Field>
                <Field label="Area max"><Input name="area_max" defaultValue={dv("area_max")} inputMode="numeric" /></Field>
              </div>
              <Field label="Area basis"><Select name="area_basis" defaultValue={dv("area_basis")}><option value="">Unknown</option><option value="carpet">Carpet</option><option value="chargeable">Chargeable</option></Select></Field>
              <Field label="Seats"><Input name="seats_target" defaultValue={dv("seats_target")} inputMode="numeric" /></Field>
              <Field label="Fit-out"><Select name="fitout_standard" defaultValue={dv("fitout_standard")}><option value="">Unknown</option>{opts("fitout_standard").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Budget min"><Input name="budget_min" defaultValue={dv("budget_min")} inputMode="decimal" /></Field>
                <Field label="Budget max"><Input name="budget_max" defaultValue={dv("budget_max")} inputMode="decimal" /></Field>
              </div>
              <Field label="Budget basis"><Select name="budget_basis" defaultValue={dv("budget_basis")}><option value="">Unknown</option>{opts("budget_basis").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
              <Field label="Decision date"><Input type="date" name="decision_date" defaultValue={dv("decision_date")} /></Field>
              <Field label="Tenure (months)"><Input name="tenure_months" defaultValue={dv("tenure_months")} inputMode="numeric" /></Field>
              <Field label="Mandate"><Select name="mandate_status" defaultValue={dv("mandate_status")}><option value="">Unknown</option>{opts("mandate_status").filter((o) => o !== "unknown").map((o) => <option key={o} value={o}>{o}</option>)}</Select></Field>
            </MoreFields>
          </div>
        </Card>
        <Button type="submit">Create requirement</Button>
      </form>
    </div>
  );
}
