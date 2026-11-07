import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Field, Input, PageHeader, Select, Stat, StaleBanner, Table, Td, Textarea, inr } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { toDealsCtx } from "@/modules/deals/api";
import { DealsError } from "@/modules/deals/ctx";
import {
  crmExportedAction, crmExternalAction, crmProposeAction, moveStageAction, objectionAction, seedChecklistAction,
  setOutcomeAction, updateLabelsAction,
} from "@/modules/deals/actions";
import { getClosingView } from "@/modules/deals/pipeline/closing-service";
import { ClosingTimeline, FeeFormB, LedgerTable, OutstandingDocs, ReconExceptions } from "@/modules/deals/closing-ui";
import { localDate } from "@/lib/util/time";
import { getOpportunityDetail } from "@/modules/deals/pipeline/service";
import { LOST_REASONS, OUTCOMES, STAGES, STAGE_LABEL, type Stage } from "@/modules/deals/pipeline/stages";
import { Flash, KV } from "@/modules/deals/ui";

export default async function DealDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const app = await requirePageContext();
  let d: Awaited<ReturnType<typeof getOpportunityDetail>>;
  try { d = await getOpportunityDetail(toDealsCtx(app), id); } catch (e) { if (e instanceof DealsError && e.status === 404) notFound(); throw e; }
  const cv = await getClosingView(toDealsCtx(app), id, localDate());
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
                <Field label="Expected close (changes are kept for slippage)"><Input type="date" name="expected_close" defaultValue={(o.expected_close as string) ?? ""} /></Field>
                <div className="flex items-end"><Button variant="secondary" type="submit">Save labels</Button></div>
              </form>
              {cv.closeHistory.length > 1 && <p className="text-xs text-ink-soft">Expected close history: {(cv.closeHistory as { old_expected_close: string | null; new_expected_close: string | null; changed_at: string }[]).map((h) => `${h.old_expected_close ?? "—"} → ${h.new_expected_close ?? "—"} (${h.changed_at.slice(0, 10)})`).join(" · ")}</p>}
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
        {cv.timeline.length === 0
          ? <p className="text-sm text-ink-soft">No checklist yet — it is created automatically when the deal reaches LOI, or create it now. Items marked “needed before” block those stages until done (with proof) or waived.</p>
          : <ClosingTimeline oppId={id} items={cv.timeline} members={cv.members} canEdit={canEdit} />}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Outstanding documents"><OutstandingDocs items={cv.outstanding} /></Card>
        <Card title="Reconciliation with official finance"><ReconExceptions rows={cv.recon as never} /></Card>
      </div>

      <Card title="Fees (gross / credited / invoiced / recognised / collected)">
        <KV items={[["Gross", inr(d.feeSummary.gross)], ["Credited to you", `${inr(d.feeSummary.credited)}${d.feeSummary.creditShareUnknown ? " (credit share unknown on some rows)" : ""}`], ["Invoiced", inr(d.feeSummary.invoiced)], ["Recognised", inr(d.feeSummary.recognised)], ["Collected", inr(d.feeSummary.collected)], ["Receivable", inr(d.feeSummary.receivable)]]} />
        <p className="mt-3 text-xs text-ink-soft">Every amount has its own status and transaction link. Expected fees are a forecast only and never count as invoiced, recognised or collected.</p>
        <div className="mt-2"><LedgerTable lines={cv.ledger} /></div>
        {canEdit && <FeeFormB oppId={id} fees={d.fees.map((f) => ({ id: f.id as string, milestone: f.milestone ?? null }))} milestones={cv.timeline.map((t) => ({ id: t.id, title: t.title }))} />}
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
          <ul className="space-y-1 text-xs">{(d.history as Record<string, unknown>[]).map((h, i) => <li key={i}>{new Date(h.changed_at as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}: {h.from_stage ? `${STAGE_LABEL[h.from_stage as Stage]} → ` : ""}{STAGE_LABEL[h.to_stage as Stage]}{h.evidence ? ` — ${h.evidence}` : ""}</li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
