import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Field, Input, PageHeader, Select, Stat, StaleBanner, Table, Td, Textarea, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { DealsError } from "@/modules/deals/ctx";
import {
  crmExportedAction, crmExternalAction, crmProposeAction, feeAction, moveStageAction, objectionAction, seedChecklistAction,
  setOutcomeAction, updateLabelsAction, updateMilestoneAction,
} from "@/modules/deals/actions";
import { getOpportunityDetail } from "@/modules/deals/pipeline/service";
import { LOST_REASONS, OUTCOMES, STAGES, STAGE_LABEL, type Stage } from "@/modules/deals/pipeline/stages";
import { Flash, KV } from "@/modules/deals/ui";

export default async function DealDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const app = await requirePageContext();
  let d: Awaited<ReturnType<typeof getOpportunityDetail>>;
  try { d = await getOpportunityDetail(toDealsCtx(app), id); } catch (e) { if (e instanceof DealsError && e.status === 404) notFound(); throw e; }
  const o = d.opportunity as Record<string, unknown> & { row_version: number; stage: Stage; name: string };
  const req = o.requirement as { id: string; title: string; status: string } | null;
  const canEdit = app.role !== "viewer";
  const hid = (<><input type="hidden" name="id" value={id} /><input type="hidden" name="row_version" value={o.row_version} /></>);
  return (
    <div className="space-y-5">
      <PageHeader title={o.name} subtitle={<>{(o.organisation as { display_name?: string } | null)?.display_name ?? "—"} · {STAGE_LABEL[o.stage]} · outcome {String(o.outcome)}</>} />
      <Flash sp={sp} />
      {d.feeIssues.length > 0 && <StaleBanner>Fee protection: {d.feeIssues.map((i) => i.issue).join(" · ")}</StaleBanner>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Expected gross fee" value={inr(o.expected_fee as number, { compact: true })} hint={o.credit_share != null ? `credit ${Number(o.credit_share) * 100}%` : "credit share unknown"} />
        <Stat label="Invoiced" value={inr(d.feeSummary.invoiced, { compact: true })} />
        <Stat label="Recognised" value={inr(d.feeSummary.recognised, { compact: true })} />
        <Stat label="Collected" value={inr(d.feeSummary.collected, { compact: true })} hint={`receivable ${inr(d.feeSummary.receivable, { compact: true })}`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Stage">
          <ol className="mb-3 flex flex-wrap gap-1 text-xs">
            {STAGES.map((s) => <li key={s}><Badge tone={s === o.stage ? "brand" : STAGES.indexOf(s) < STAGES.indexOf(o.stage) ? "ok" : "neutral"}>{STAGE_LABEL[s]}</Badge></li>)}
          </ol>
          {req ? <p className="mb-3 text-sm">Requirement: <Link className="text-brand underline" href={`/requirements/${req.id}`}>{req.title}</Link> ({req.status})</p> : <p className="mb-3 text-sm text-warn">No linked requirement — stages from “requirement confirmed” need one.</p>}
          {canEdit && (
            <form action={moveStageAction} className="space-y-2">
              {hid}
              <Field label="Move to"><Select name="stage" defaultValue={STAGES[Math.min(STAGES.indexOf(o.stage) + 1, STAGES.length - 1)]}>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</Select></Field>
              <Field label="Evidence / reason" hint="Required for qualified discussion, requirement confirmed, LOI, signed and later, and for moving back."><Textarea name="evidence" /></Field>
              <Button type="submit">Move stage</Button>
            </form>
          )}
        </Card>
        <Card title="Labels & outcome">
          <KV items={[["Temperature", String(o.temperature ?? "—")], ["Mandate", String(o.mandate_status ?? "—")], ["Next action", `${o.next_action ?? "—"}${o.next_action_due ? ` · ${o.next_action_due}` : ""}`], ["Expected close", String(o.expected_close ?? "—")], ["Official CRM id", String(o.crm_external_id ?? "— not linked")], ["Outcome reason", String(o.outcome_reason ?? "—")]]} />
          {canEdit && (
            <div className="mt-3 grid gap-3">
              <form action={updateLabelsAction} className="grid grid-cols-2 gap-2">
                {hid}
                <Select name="temperature" defaultValue={(o.temperature as string) ?? ""}><option value="">temperature —</option><option>cold</option><option>warm</option><option>hot</option></Select>
                <Select name="mandate_status" defaultValue={(o.mandate_status as string) ?? "unknown"}>{["unknown", "none", "non_exclusive", "exclusive", "support"].map((m) => <option key={m}>{m}</option>)}</Select>
                <Input name="next_action" placeholder="Next action" defaultValue={(o.next_action as string) ?? ""} />
                <Input type="date" name="next_action_due" defaultValue={(o.next_action_due as string) ?? ""} />
                <Button variant="secondary" type="submit">Save labels</Button>
              </form>
              <form action={setOutcomeAction} className="grid grid-cols-2 gap-2">
                {hid}
                <Select name="outcome" defaultValue={String(o.outcome ?? "open")}>{OUTCOMES.map((x) => <option key={x}>{x}</option>)}</Select>
                <Select name="reason" defaultValue=""><option value="">reason (lost / disqualified)</option>{LOST_REASONS.map((x) => <option key={x}>{x}</option>)}</Select>
                <Button variant="secondary" type="submit">Set outcome</Button>
              </form>
            </div>
          )}
        </Card>
      </div>

      <Card title="Closing checklist & move dependencies" actions={canEdit ? <form action={seedChecklistAction}><input type="hidden" name="id" value={id} /><Button variant="secondary" type="submit">{d.milestones.length ? "Add missing items" : "Create checklist"}</Button></form> : null}>
        {d.milestones.length === 0 ? <p className="text-sm text-ink-soft">No checklist yet. Items marked “needed before” block those stages until done (with proof) or waived.</p> : (
          <ul className="divide-y divide-line text-sm">
            {(d.milestones as Record<string, unknown>[]).map((m) => (
              <li key={m.id as string} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">{m.title as string}</div>
                  <div className="text-xs text-ink-soft">{m.required_for_stage ? `needed before ${STAGE_LABEL[m.required_for_stage as Stage]}` : "dependency"}{m.proof_required ? " · proof required" : ""}{m.proof_text ? ` · proof: ${m.proof_text}` : ""}</div>
                </div>
                {canEdit ? (
                  <form action={updateMilestoneAction} className="flex gap-1">
                    <input type="hidden" name="id" value={id} /><input type="hidden" name="milestone_id" value={m.id as string} />
                    <Select name="status" defaultValue={m.status as string} className="min-w-28">{["open", "in_progress", "done", "blocked", "waived", "not_applicable"].map((x) => <option key={x}>{x}</option>)}</Select>
                    <Input name="proof_text" placeholder="proof" defaultValue={(m.proof_text as string) ?? ""} className="w-32" />
                    <Button variant="ghost" type="submit">Save</Button>
                  </form>
                ) : <Badge>{m.status as string}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Fees (gross / credited / invoiced / recognised / collected)">
        <KV items={[["Gross", inr(d.feeSummary.gross)], ["Credited to you", `${inr(d.feeSummary.credited)}${d.feeSummary.creditShareUnknown ? " (credit share unknown on some rows)" : ""}`], ["Invoiced", inr(d.feeSummary.invoiced)], ["Recognised", inr(d.feeSummary.recognised)], ["Collected", inr(d.feeSummary.collected)], ["Receivable", inr(d.feeSummary.receivable)]]} />
        {d.fees.length > 0 && (
          <div className="mt-3"><Table head={["Milestone", "Gross", "Credit", "Invoiced", "Recognised", "Collected", "Evidence"]}>
            {d.fees.map((f) => (
              <tr key={f.id}><Td>{f.milestone ?? "—"}</Td><Td>{inr(f.gross_fee)}</Td><Td>{f.credit_share != null ? `${Number(f.credit_share) * 100}%` : "—"}</Td>
                <Td>{inr(f.invoiced_amount)}{f.invoiced_on ? ` · ${f.invoiced_on}` : ""}</Td><Td>{inr(f.recognised_amount)}{f.recognised_on ? ` · ${f.recognised_on}` : ""}</Td>
                <Td>{inr(f.collected_amount)}{f.collected_on ? ` · ${f.collected_on}` : ""}</Td><Td className="text-xs">{f.evidence ?? "—"}</Td></tr>
            ))}
          </Table></div>
        )}
        {canEdit && (
          <details className="mt-3 rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">Record fee / invoice / collection</summary>
            <form action={feeAction} className="mt-3 grid gap-2 sm:grid-cols-3">
              <input type="hidden" name="id" value={id} />
              <Field label="Update existing"><Select name="milestone_id" defaultValue=""><option value="">— new milestone —</option>{d.fees.map((f) => <option key={f.id} value={f.id}>{f.milestone ?? f.id}</option>)}</Select></Field>
              <Field label="Milestone"><Input name="milestone" placeholder="e.g. on signing" /></Field>
              <Field label="Gross fee ₹"><Input name="gross_fee" inputMode="decimal" /></Field>
              <Field label="Credit share %"><Input name="credit_share_pct" inputMode="decimal" /></Field>
              <Field label="Invoiced ₹ / date"><div className="flex gap-1"><Input name="invoiced_amount" inputMode="decimal" /><Input type="date" name="invoiced_on" /></div></Field>
              <Field label="Recognised ₹ / date"><div className="flex gap-1"><Input name="recognised_amount" inputMode="decimal" /><Input type="date" name="recognised_on" /></div></Field>
              <Field label="Collected ₹ / date"><div className="flex gap-1"><Input name="collected_amount" inputMode="decimal" /><Input type="date" name="collected_on" /></div></Field>
              <Field label="Evidence (invoice no., remittance ref.)"><Input name="evidence" /></Field>
              <div className="sm:col-span-3"><Button type="submit">Save fee record</Button></div>
            </form>
          </details>
        )}
      </Card>

      <Card title="Official CRM" actions={canEdit ? <form action={crmProposeAction}><input type="hidden" name="id" value={id} /><Button variant="secondary" type="submit">Prepare export proposal</Button></form> : null}>
        <p className="mb-2 text-sm text-ink-soft">The official CRM is the source of truth. CRE OS prepares what to enter, records what the CRM currently says, and shows competing updates instead of overwriting.</p>
        {(d.crmExports as Record<string, unknown>[]).length === 0 ? <p className="text-sm text-ink-soft">No export proposals yet.</p> : (
          <ul className="space-y-3">
            {(d.crmExports as Record<string, unknown>[]).map((x) => (
              <li key={x.id as string} className="rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={x.status === "conflict" ? "bad" : x.status === "exported" || x.status === "reconciled" ? "ok" : "neutral"}>{x.status as string}</Badge><span>CRM id: {(x.crm_external_id as string) ?? "missing"}</span></div>
                {(x.conflict_fields as unknown[]).length > 0 && (
                  <Table head={["Field", "Base", "CRE OS", "Official CRM"]}>
                    {(x.conflict_fields as { field: string; base: unknown; local: unknown; external: unknown }[]).map((c) => <tr key={c.field}><Td>{c.field}</Td><Td>{String(c.base ?? "—")}</Td><Td>{String(c.local ?? "—")}</Td><Td>{String(c.external ?? "—")}</Td></tr>)}
                  </Table>
                )}
                {canEdit && ["proposed", "conflict", "needs_external_id"].includes(x.status as string) && (
                  <div className="mt-2 grid gap-2 lg:grid-cols-2">
                    <form action={crmExternalAction} className="grid grid-cols-2 gap-1">
                      <input type="hidden" name="id" value={id} /><input type="hidden" name="export_id" value={x.id as string} />
                      <Input name="crm_external_id" placeholder="Official CRM id" defaultValue={(x.crm_external_id as string) ?? ""} />
                      <Input name="ext_stage" placeholder="CRM stage now" />
                      <Input name="ext_expected_fee" placeholder="CRM fee now" />
                      <Input name="ext_expected_close" placeholder="CRM close date" />
                      <Button variant="secondary" type="submit">Record CRM values</Button>
                    </form>
                    <form action={crmExportedAction} className="flex flex-wrap gap-1">
                      <input type="hidden" name="id" value={id} /><input type="hidden" name="export_id" value={x.id as string} />
                      {x.status === "conflict" && <Select name="resolution" defaultValue=""><option value="">resolve…</option><option value="keep_external">Keep CRM values</option><option value="use_local">Entered CRE OS values</option></Select>}
                      <Button type="submit">Mark entered in CRM</Button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Objections">
          {(d.objections as Record<string, unknown>[]).length === 0 ? <p className="text-sm text-ink-soft">None logged.</p> : (
            <ul className="space-y-1 text-sm">{(d.objections as Record<string, unknown>[]).map((x) => <li key={x.id as string}><Badge>{x.category as string}</Badge> {x.objection as string}{x.response ? ` → ${x.response}` : ""}</li>)}</ul>
          )}
          {canEdit && (
            <form action={objectionAction} className="mt-3 grid gap-2">
              <input type="hidden" name="id" value={id} />
              <Select name="category" defaultValue="price">{["price", "location", "timing", "specification", "terms", "landlord", "competitor", "internal_approval", "other"].map((c) => <option key={c}>{c}</option>)}</Select>
              <Input name="objection" placeholder="Objection" required /><Input name="response" placeholder="Response (optional)" />
              <Button variant="secondary" type="submit">Log objection</Button>
            </form>
          )}
        </Card>
        <Card title="Stage history">
          <ul className="space-y-1 text-xs">{(d.history as Record<string, unknown>[]).map((h, i) => <li key={i}>{new Date(h.changed_at as string).toLocaleString("en-IN")}: {h.from_stage ? `${STAGE_LABEL[h.from_stage as Stage]} → ` : ""}{STAGE_LABEL[h.to_stage as Stage]}{h.evidence ? ` — ${h.evidence}` : ""}</li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
