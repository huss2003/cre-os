import { requirePageContext } from "@/lib/auth/context";
import { Button, Card, Field, Input, MoreFields, PageHeader, Select } from "@/components/ui";
import { createLeaseAction } from "@/modules/leases/actions";
import { CATEGORY_LABEL } from "@/modules/leases/status";
import { Flash, LeaseTabs } from "@/modules/leases/ui";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const ctx = await requirePageContext("editor");
  const [orgs, assets] = await Promise.all([
    ctx.db.from("organisation").select("id, display_name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("display_name").limit(500),
    ctx.db.from("asset").select("id, name").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("name").limit(500),
  ]);
  const orgOpts = (orgs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>);
  return (
    <div className="space-y-4">
      <LeaseTabs active="dashboard" />
      <PageHeader title="New lease" subtitle="Leases start as draft / negotiation. Executed and active need evidence (signed agreement, confirmed dates)." />
      <Flash sp={sp} />
      <Card>
        <form action={createLeaseAction} className="grid gap-3 md:grid-cols-2">
          <Field label="Tenant company"><Select name="tenant_org_id" defaultValue=""><option value="">— choose or type below —</option>{orgOpts}</Select></Field>
          <Field label="Tenant name (if not a company record yet)"><Input name="tenant_name" /></Field>
          <Field label="Landlord"><Select name="landlord_org_id" defaultValue=""><option value="">Unknown</option>{orgOpts}</Select></Field>
          <Field label="Property"><Select name="asset_id" defaultValue=""><option value="">Unknown</option>{(assets.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Category"><Select name="category" defaultValue="conventional_office">{Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Status"><Select name="status" defaultValue="draft"><option value="draft">Draft</option><option value="under_negotiation">Under negotiation</option><option value="awaiting_approval">Awaiting approval</option><option value="awaiting_execution">Awaiting execution</option></Select></Field>
          <Field label="Monthly rent (₹)" hint="Blank = unknown, never zero."><Input name="rent" inputMode="decimal" /></Field>
          <Field label="Chargeable area (sf)"><Input name="area" inputMode="decimal" /></Field>
          <MoreFields>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Reference"><Input name="reference" /></Field>
              <Field label="Micro-market"><Input name="micro_market" /></Field>
              <Field label="Floor"><Input name="floor" /></Field>
              <Field label="Unit"><Input name="unit" /></Field>
              <Field label="Commencement (as stated)" hint="Stored as an unconfirmed date until you confirm it against the executed agreement."><Input type="date" name="commencement" /></Field>
              <Field label="Expiry (as stated)"><Input type="date" name="expiry" /></Field>
              <Field label="Area basis"><Select name="area_basis" defaultValue=""><option value="">Unknown</option><option value="chargeable">Chargeable</option><option value="carpet">Carpet</option><option value="super_built_up">Super built-up</option><option value="rentable">Rentable</option></Select></Field>
              <Field label="CAM / month (₹)"><Input name="cam" inputMode="decimal" /></Field>
              <Field label="Parking / month (₹)"><Input name="parking" inputMode="decimal" /></Field>
              <Field label="Security deposit (₹)"><Input name="deposit" inputMode="decimal" /></Field>
              <Field label="Term (months)"><Input name="term" inputMode="numeric" /></Field>
              <Field label="Lock-in (months)"><Input name="lockin" inputMode="numeric" /></Field>
              <Field label="Escalation %"><Input name="esc_pct" inputMode="decimal" /></Field>
              <Field label="Escalation every (months)"><Input name="esc_every" inputMode="numeric" /></Field>
              <Field label="Escalation basis" hint="Follow the agreement — don't assume compounding."><Select name="esc_basis" defaultValue="unknown"><option value="unknown">Not stated</option><option value="compounding">On last paid rent (compounding)</option><option value="on_original">On original rent</option></Select></Field>
            </div>
          </MoreFields>
          <div className="md:col-span-2"><Button>Create lease</Button></div>
        </form>
      </Card>
    </div>
  );
}
