import Link from "next/link";
import { Badge, Button, ButtonLink, Card, EmptyState, Field, Input, PageHeader, Select, Table, Td, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { evaluateScenarioAction } from "@/modules/deals/actions";
import { listScenarios } from "@/modules/deals/finance/service";
import { Flash } from "@/modules/deals/ui";

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const app = await requirePageContext();
  const ctx = toDealsCtx(app);
  const requirementId = typeof sp.requirement === "string" ? sp.requirement : undefined;
  const rows = await listScenarios(ctx, { requirementId }) as Record<string, unknown>[];
  const { data: reqs } = await ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-5">
      <PageHeader title="Financials" subtitle="Deterministic engine fin-1.0: monthly cash flows on an equal horizon — TCO, NPV, equivalent monthly cost, sensitivities. Unknown costs are gaps, never zero."
        actions={<ButtonLink variant="secondary" href={`/finance/compare${requirementId ? `?requirement=${requirementId}` : ""}`}>Compare scenarios</ButtonLink>} />
      <Flash sp={sp} />
      {rows.length === 0 ? (
        <EmptyState title="No scenarios yet">Calculate one below, or open a requirement and use “Calculate a scenario from a quote” so quote versions are tracked.</EmptyState>
      ) : (
        <form action="/finance/compare" method="get" className="space-y-2">
          <Table head={["Compare", "Scenario", "Requirement", "NPV", "Nominal TCO", "Equivalent monthly", "Costs", "Approved"]}>
            {rows.map((r) => {
              const rj = (r.result_json ?? {}) as { totals?: Record<string, string>; gaps?: { label: string }[] };
              const t = rj.totals ?? {};
              const gaps = (rj.gaps ?? (r.gaps as { label: string }[] | null) ?? []);
              return (
                <tr key={r.id as string}>
                  <Td><input type="checkbox" name="ids" value={r.id as string} aria-label={`compare ${r.name}`} /></Td>
                  <Td><Link className="font-medium text-brand" href={`/finance/${r.id}`}>{r.name as string}</Link> <span className="text-xs text-ink-soft">v{String(r.version ?? 1)}</span></Td>
                  <Td>{(reqs ?? []).find((q) => q.id === r.requirement_id)?.title ?? "—"}</Td>
                  <Td>{inr(t.npv)}</Td><Td>{inr(t.nominalTco)}</Td><Td>{inr(t.equivalentMonthly)}</Td>
                  <Td>{rj.gaps === undefined ? <Badge>not assessed — open to check</Badge> : gaps.length ? <Badge tone="warn" title={gaps.map((g) => g.label).join(", ")}>incomplete: {gaps.length} unknown</Badge> : <Badge tone="ok">complete</Badge>}</Td>
                  <Td>{r.approved_at ? <Badge tone="ok">approved</Badge> : <Badge>draft</Badge>}</Td>
                </tr>
              );
            })}
          </Table>
          <Button type="submit" variant="secondary">Compare selected (first = baseline)</Button>
        </form>
      )}
      {app.role !== "viewer" && (
        <Card title="New scenario">
          <form action={evaluateScenarioAction} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Name"><Input name="name" required placeholder="Option A — bare shell" /></Field>
              <Field label="Type"><Select name="kind" defaultValue="conventional">{["conventional", "managed", "coworking", "renew", "relocate"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
              <Field label="Requirement"><Select name="requirement_id" defaultValue={requirementId ?? ""}><option value="">—</option>{(reqs ?? []).map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}</Select></Field>
              <Field label="Base date (period 0)"><Input type="date" name="base_date" required defaultValue={today} /></Field>
              <Field label="Horizon (months)"><Input name="horizon" required defaultValue="60" inputMode="numeric" /></Field>
              <Field label="Discount rate % p.a."><Input name="discount" required inputMode="decimal" /></Field>
              <Field label="Tenure (months)"><Input name="tenure" inputMode="numeric" /></Field>
              <Field label="If tenure < horizon"><Select name="after_tenure" defaultValue=""><option value="">(tenure covers horizon)</option><option value="continue_same_terms">Renew on same terms</option><option value="vacate">Vacate</option></Select></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Chargeable SF"><Input name="chargeable_sf" inputMode="decimal" /></Field>
              <Field label="Carpet SF"><Input name="carpet_sf" inputMode="decimal" /></Field>
              <Field label="Planned seats"><Input name="seats" inputMode="numeric" /></Field>
              <Field label="Rent basis"><Select name="rent_basis" defaultValue="chargeable"><option>chargeable</option><option>carpet</option><option>seat</option><option>lumpsum</option></Select></Field>
              <Field label="Rent ₹/unit/month"><Input name="rent" inputMode="decimal" /></Field>
              <Field label="Escalation % / every months"><div className="flex gap-1"><Input name="esc_pct" inputMode="decimal" /><Input name="esc_every" inputMode="numeric" /></div></Field>
              <Field label="Rent-free months"><Input name="rent_free" inputMode="numeric" /></Field>
              <Field label="Rent starts at period"><Input name="start_period" defaultValue="1" inputMode="numeric" /></Field>
              <Field label="Landlord capex support ₹"><Input name="capex_support" inputMode="decimal" /></Field>
              <Field label="GST"><Select name="gst" defaultValue=""><option value="">not specified</option><option value="excluded">excluded (add)</option><option value="included">included</option><option value="recoverable">recoverable</option></Select></Field>
              <Field label="GST rate % (from finance)"><Input name="gst_rate" inputMode="decimal" /></Field>
              <Field label="Parallel rent ₹/month · months"><div className="flex gap-1"><Input name="parallel_rent" inputMode="decimal" /><Input name="parallel_months" inputMode="numeric" /></div></Field>
              <Field label="Move cost ₹"><Input name="move_cost" inputMode="decimal" /></Field>
            </div>
            <div className="rounded-lg border border-line p-3">
              <div className="mb-2 text-sm font-medium">Other costs — each is <em>unknown</em> until you give an amount or mark it none</div>
              <p className="mb-3 text-xs text-ink-soft">Unknown costs are listed as gaps, excluded from “complete” totals and block approval unless acknowledged. They are never treated as zero.</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <CostRow item="cam" label="CAM / maintenance"><Input name="cam_rate" inputMode="decimal" placeholder="₹/SF/month" /><Input name="cam_fixed" inputMode="decimal" placeholder="or fixed ₹/month" /></CostRow>
                <CostRow item="parking" label="Parking"><Input name="parking_slots" inputMode="numeric" placeholder="slots" /><Input name="parking_rate" inputMode="decimal" placeholder="₹/slot/month" /></CostRow>
                <CostRow item="deposit" label="Security deposit"><Input name="deposit_months" inputMode="decimal" placeholder="months of rent" /></CostRow>
                <CostRow item="fitout" label="Fit-out capex"><Input name="fitout" inputMode="decimal" placeholder="₹ total" /></CostRow>
                <CostRow item="opex" label="Other operating costs"><Input name="opex_monthly" inputMode="decimal" placeholder="₹/month (power, housekeeping…)" /></CostRow>
                <CostRow item="reinstatement" label="Reinstatement (end of tenure)"><Input name="reinstatement" inputMode="decimal" placeholder="₹" /></CostRow>
              </div>
            </div>
            <Field label="Discount-rate source"><Input name="discount_source" placeholder="e.g. client WACC per CFO email 30 Oct" /></Field>
            <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm font-medium">Fit-out financing (optional)</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-5">
                <Field label="Partner"><Input name="fin_partner" placeholder="from your partner list" /></Field>
                <Field label="Principal ₹"><Input name="fin_principal" inputMode="decimal" /></Field>
                <Field label="Interest % p.a."><Input name="fin_rate" inputMode="decimal" /></Field>
                <Field label="Term (months)"><Input name="fin_term" inputMode="numeric" /></Field>
                <Field label="Upfront fee ₹"><Input name="fin_fee" inputMode="decimal" /></Field>
              </div>
            </details>
            <Button type="submit">Calculate & save</Button>
          </form>
        </Card>
      )}
    </div>
  );
}

/** Three-state cost input: unknown (default, a visible gap) · none / included · amount. */
function CostRow({ item, label, children }: { item: string; label: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      <Select name={`${item}_state`} defaultValue="unknown" aria-label={`${label} state`}>
        <option value="unknown">Unknown — gap (default)</option>
        <option value="none">None / included elsewhere</option>
        <option value="amount">Amount below</option>
      </Select>
      <div className="flex gap-1">{children}</div>
    </fieldset>
  );
}
