import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import { Badge, Button, Card, Input, MoreFields, PageHeader, Select, Skeleton, Table, Td, Textarea, inr } from "@/components/ui";
import * as A from "@/modules/leases/actions";
import { alternativeProperties, depositRecovery, diffTerms, escalationView, getLease, leaseAudit, leaseCost, TERM_LABEL, type CommercialTerms } from "@/modules/leases/service";
import { CATEGORY_LABEL, STATUS_LABEL, nextStatuses, type LeaseStatus } from "@/modules/leases/status";
import { DATE_TYPE_LABEL, DEPOSIT_STATUS_LABEL, FACT_STATUS_LABEL, Flash, TERMINATION_STATUS_LABEL, VerificationBadge, auditEventText, conventionText, humanize } from "@/modules/leases/ui";

type P = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ params, searchParams }: { params: P; searchParams: SP }) {
  return <Suspense fallback={<Skeleton variant="detail" />}><Body params={params} searchParams={searchParams} /></Suspense>;
}

const DOC_TYPES = ["lease_agreement", "leave_and_licence", "lease_amendment", "renewal_agreement", "loi", "term_sheet", "mou", "commercial_proposal", "rent_quotation", "termination_notice", "handover", "possession", "security_deposit", "other"];
const EXEC_STATES = ["executed", "signed", "amendment", "draft", "unsigned_proposal", "supporting"];
const MONEY_TERMS = new Set(["monthlyRent", "camMonthly", "parkingMonthly", "otherMonthly", "securityDeposit"]);
const AREA_TERMS = new Set(["rentableArea", "chargeableArea", "carpetArea", "superBuiltUpArea"]);
/** Plain display of a commercial term: ₹ with Indian grouping for money, sf for area, readable escalation. */
const fmtV = (v: unknown, k?: string) => {
  if (v == null || v === "") return "unknown";
  if (k && MONEY_TERMS.has(k) && Number.isFinite(Number(v))) return inr(Number(v));
  if (k && AREA_TERMS.has(k) && Number.isFinite(Number(v))) return `${new Intl.NumberFormat("en-IN").format(Number(v))} sf`;
  if (typeof v === "object") {
    const e = v as { pct?: number | null; everyMonths?: number | null; basis?: string };
    if ("pct" in e || "everyMonths" in e) return `${e.pct ?? "?"}% every ${e.everyMonths ?? "?"} months (${e.basis === "compounding" ? "compounding" : e.basis === "on_original" ? "on original rent" : "basis not stated"})`;
    return JSON.stringify(v);
  }
  return typeof v === "number" ? new Intl.NumberFormat("en-IN").format(v) : String(v);
};

async function Body({ params, searchParams }: { params: P; searchParams: SP }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const w = { db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId };
  const today = localDate();
  const d = await getLease(w, id);
  if (!d) notFound();
  const [esc, audit, alts, tx] = await Promise.all([escalationView(w, id).catch(() => null), leaseAudit(w, id), alternativeProperties(w, id, 5).catch(() => null),
    d.lease.transaction_id ? ctx.db.from("tx_transaction").select("id, code, name").eq("workspace_id", ctx.workspaceId).eq("id", d.lease.transaction_id).maybeSingle().then((r) => r.data as { id: string; code: string; name: string } | null) : Promise.resolve(null)]);
  const cost = leaseCost(d, today);
  const L = d.lease;
  const liveDates = d.dates.filter((x) => !x.superseded_by && !x.archived_at).sort((a, b) => (a.calculated_date ?? "9999").localeCompare(b.calculated_date ?? "9999"));
  const docTitle = (docId: string | null) => { const x = d.documents.find((y) => y.id === docId); return x ? `${x.title} v${x.version}` : null; };
  const renewal = d.renewals.filter((r) => !["completed", "declined"].includes(r.stage)).slice(-1)[0] ?? null;
  const term = d.terminations.slice(-1)[0] ?? null;
  const hidden = <input type="hidden" name="lease_id" value={id} />;

  return (
    <div className="space-y-4">
      <PageHeader title={L.label} subtitle={<>{L.asset_name ?? "Property unknown"}{L.floor ? ` · Floor ${L.floor}` : ""}{L.unit ? ` · Unit ${L.unit}` : ""} · {CATEGORY_LABEL[L.category as keyof typeof CATEGORY_LABEL]} · <Badge>{STATUS_LABEL[L.lifecycle_status as LeaseStatus]}</Badge></>} />
      <Flash sp={sp} />
      <p className="text-xs text-ink-soft">Extracted clauses are shown verbatim with page references. They are administrative summaries, not legal advice; only dates a person has reviewed are confirmed contractual deadlines.</p>

      <Card title="Overview">
        <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div><dt className="text-ink-soft">Tenant</dt><dd>{L.tenant_org_id ? <Link className="text-brand" href={`/companies/${L.tenant_org_id}`}>{L.tenant_name}</Link> : L.tenant_name ?? "—"}</dd></div>
          <div><dt className="text-ink-soft">Landlord</dt><dd>{L.landlord_name ?? "Unknown"}</dd></div>
          <div><dt className="text-ink-soft">Reference</dt><dd>{L.reference ?? "—"}</dd></div>
          <div><dt className="text-ink-soft">Micro-market</dt><dd>{L.micro_market ?? "—"}</dd></div>
          <div><dt className="text-ink-soft">Execution date</dt><dd>{L.execution_date ?? "—"}</dd></div>
          <div><dt className="text-ink-soft">Transaction</dt><dd className="truncate">{L.transaction_id ? <Link className="text-brand" href={`/transactions/${L.transaction_id}`}>{tx ? `${tx.code} · ${tx.name}` : "Linked transaction"}</Link> : "—"}</dd></div>
          <div><dt className="text-ink-soft">Contacts</dt><dd>{d.contacts.length ? d.contacts.map((c: { id: string; full_name: string }) => <Link key={c.id} className="mr-2 text-brand" href={`/people/${c.id}`}>{c.full_name}</Link>) : "—"}</dd></div>
        </dl>
        <form action={A.setStatusAction} className="mt-3 grid gap-2 md:grid-cols-5">
          {hidden}
          <Select name="to" aria-label="New status">{nextStatuses(L.lifecycle_status as LeaseStatus).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</Select>
          <Select name="document_id" aria-label="Evidence document" defaultValue=""><option value="">Evidence document…</option>{d.documents.map((x) => <option key={x.id} value={x.id}>{x.title} v{x.version} ({x.execution_state})</option>)}</Select>
          <Input type="date" name="execution_date" aria-label="Execution date" />
          <Input name="note" placeholder="Note / how served" aria-label="Note" />
          <Button variant="secondary">Change status</Button>
        </form>
      </Card>

      <Card title="Important dates" className="scroll-mt-4" help="Calculated dates show the method and convention. Needs-review / conflicting dates require you to pick the date.">
        <div id="dates" />
        {liveDates.length === 0 ? <p className="text-sm text-ink-soft">No dates yet — attach the executed agreement below or add a date.</p> : (
          <ul className="space-y-3">
            {liveDates.map((x) => (
              <li key={x.id} className="rounded-md border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><strong>{x.label ?? DATE_TYPE_LABEL[x.date_type]}</strong><span>{x.calculated_date ?? "not calculable"}</span><VerificationBadge status={x.verification_status} /></div>
                <div className="mt-1 text-xs text-ink-soft">{x.method}{conventionText(x.convention) ? ` · ${conventionText(x.convention)}` : ""}{x.document_id ? ` · ${docTitle(x.document_id)}${x.page ? ` p.${x.page}` : ""}` : ""}</div>
                {x.clause_text ? <blockquote className="mt-1 border-l-2 border-line pl-2 text-xs italic">{x.clause_text}</blockquote> : null}
                {x.review_reason ? <p className="mt-1 text-xs text-warn">{x.review_reason}</p> : null}
                {x.alternatives?.length ? <p className="mt-1 text-xs">Readings: {x.alternatives.map((a: { date: string; reading: string }) => `${a.date} (${a.reading})`).join(" · ")}</p> : null}
                {x.verification_status !== "confirmed" && (
                  <form action={A.confirmDateAction} className="mt-2 flex flex-wrap gap-2">
                    {hidden}<input type="hidden" name="date_id" value={x.id} />
                    <Input type="date" name="date" defaultValue={["needs_review", "conflicting"].includes(x.verification_status) ? "" : x.calculated_date ?? ""} aria-label="Confirmed date" required={["needs_review", "conflicting"].includes(x.verification_status)} className="w-40" />
                    <Input name="note" placeholder="Review note" aria-label="Review note" className="w-48" />
                    <Button variant="secondary">Confirm after review</Button>
                    <button formAction={A.rejectDateAction} className="text-xs text-bad">Reject</button>
                  </form>
                )}
                {x.verification_status === "confirmed" ? <p className="mt-1 text-xs text-ok">Confirmed {x.confirmed_at?.slice(0, 10)}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <MoreFields label="Add or calculate a date">
          <form action={A.addDateAction} className="grid gap-2 md:grid-cols-4">
            {hidden}
            <Select name="date_type" aria-label="Date type">{Object.entries(DATE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Input type="date" name="date" aria-label="Date (leave blank to calculate from clause)" />
            <Input name="months" placeholder="Months (escalation/break)" aria-label="Months" inputMode="numeric" />
            <Textarea name="clause" placeholder="Clause wording (verbatim) — used to calculate when no date is given" aria-label="Clause" />
            <Button variant="secondary">Add</Button>
          </form>
        </MoreFields>
      </Card>

      <Card title="Commercial terms & amendment history">
        <div id="terms" />
        <Table head={["Term", "Current", "Original (v1)"]}>
          {(Object.keys(TERM_LABEL) as (keyof CommercialTerms)[]).filter((k) => d.currentTerms[k] != null || d.terms[0]?.terms?.[k] != null).map((k) => (
            <tr key={k}><Td>{TERM_LABEL[k]}</Td><Td>{fmtV(d.currentTerms[k], k)}</Td><Td className="text-ink-soft">{fmtV(d.terms[0]?.terms?.[k], k)}</Td></tr>
          ))}
        </Table>
        <ul className="mt-3 space-y-2 text-sm">
          {[...d.terms].reverse().map((v, i, arr) => {
            const prev = arr[i + 1];
            const diff = prev ? diffTerms(prev.terms, v.terms) : [];
            return (
              <li key={v.id} className="rounded-md border border-line p-2">
                v{v.version} · {humanize(v.source)} · <Badge tone={v.status === "current" ? "ok" : v.status === "proposed" ? "warn" : "neutral"}>{humanize(v.status)}</Badge>{v.effective_from ? ` · from ${v.effective_from}` : ""}{v.document_id ? ` · ${docTitle(v.document_id)}` : ""}
                {diff.length ? <div className="text-xs text-ink-soft">{diff.map((x) => `${x.label}: ${fmtV(x.before, x.field)} → ${fmtV(x.after, x.field)}`).join("; ")}</div> : null}
                {v.status === "proposed" && (
                  <form action={A.confirmTermsAction} className="mt-1 flex gap-2">{hidden}<input type="hidden" name="version_id" value={v.id} />
                    <Button variant="secondary">Confirm as current</Button><button name="op" value="reject" className="text-xs text-bad">Reject</button></form>
                )}
              </li>
            );
          })}
        </ul>
        <MoreFields label="Record an amendment (keeps history)">
          <form action={A.addAmendmentAction} className="grid gap-2 md:grid-cols-4">
            {hidden}
            <Input name="rent" placeholder="Monthly rent ₹" inputMode="decimal" aria-label="Monthly rent" />
            <Input name="cam" placeholder="CAM ₹/month" inputMode="decimal" aria-label="CAM" />
            <Input name="deposit" placeholder="Deposit ₹" inputMode="decimal" aria-label="Deposit" />
            <Input name="area" placeholder="Area sf" inputMode="decimal" aria-label="Area" />
            <Input type="date" name="effective_from" aria-label="Effective from" />
            <Input name="note" placeholder="Note" aria-label="Note" />
            <Button variant="secondary">Propose amendment</Button>
          </form>
        </MoreFields>
      </Card>

      <Card title="Financials">
        <div id="finance" />
        <Table head={["Component", "Monthly"]}>{cost.lines.map((l) => <tr key={l.label}><Td>{l.label}</Td><Td>{l.monthly == null ? <Badge tone="warn">unknown</Badge> : inr(l.monthly)}</Td></tr>)}</Table>
        <p className="mt-2 text-sm">Known monthly: {cost.monthlyKnown ? inr(cost.monthlyKnown) : "—"} · annual: {cost.annualKnown ? inr(cost.annualKnown) : "—"} · deposit: {cost.securityDeposit ? inr(cost.securityDeposit) : "unknown"} · remaining: {cost.remainingMonths ?? "?"} months</p>
        <p className="text-xs text-ink-soft">{cost.note} Payments are shown only from recorded/connected records.</p>
        {esc?.rows.length ? (
          <Table head={["Escalation", "Effective", "Expected rent", "Actual", "Check"]}>
            {esc.rows.map((r) => <tr key={r.step}><Td>{r.step}</Td><Td>{r.effectiveDate ?? "—"}</Td><Td>{r.expectedMonthlyRent ? inr(r.expectedMonthlyRent) : r.flag ?? "—"}</Td><Td>{r.actual ? inr(r.actual) : "not recorded"}</Td><Td><Badge tone={r.check.status === "discrepancy" ? "bad" : r.check.status === "match" ? "ok" : "neutral"}>{r.check.status}{r.check.difference ? ` ${r.check.difference}` : ""}</Badge></Td></tr>)}
          </Table>
        ) : <p className="text-xs text-ink-soft">{esc?.note ?? "No escalation recorded."}</p>}
        <MoreFields label="Record a payment / actual value">
          <form action={A.financialAction} className="grid gap-2 md:grid-cols-5">
            {hidden}
            <Select name="kind" aria-label="Kind"><option value="rent_payment">Rent payment</option><option value="cam_payment">CAM payment</option><option value="actual_rent_after_escalation">Actual rent after escalation</option><option value="deposit_paid">Deposit paid</option><option value="deposit_refund">Deposit refund</option><option value="deposit_adjustment">Deposit adjustment</option><option value="settlement">Settlement</option></Select>
            <Input name="amount" placeholder="₹" inputMode="decimal" aria-label="Amount" required />
            <Input type="date" name="on_date" aria-label="Date" />
            <Input name="period" placeholder="Period e.g. 2027-02" aria-label="Period" />
            <Button variant="secondary">Record (verified)</Button>
          </form>
        </MoreFields>
      </Card>

      <Card title="Documents">
        <ul className="space-y-1 text-sm">{d.documents.map((x) => <li key={x.id}>{x.title} v{x.version} · {x.doc_type.replace(/_/g, " ")} · <Badge tone={x.execution_state === "executed" || x.execution_state === "signed" ? "ok" : x.execution_state === "superseded" ? "neutral" : "warn"}>{x.execution_state.replace("_", " ")}</Badge>{x.extraction_source ? <span className="text-xs text-ink-soft"> · extracted by {x.extraction_source}</span> : null}{x.extracted?.missing?.length ? <span className="text-xs text-warn"> · missing: {x.extracted.missing.join(", ")}</span> : null}</li>)}</ul>
        <form action={A.uploadDocumentAction} className="mt-3 grid gap-2 md:grid-cols-2">
          {hidden}
          <Input name="title" placeholder="Title" aria-label="Title" />
          <Select name="doc_type" aria-label="Type">{DOC_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</Select>
          <Select name="execution_state" aria-label="Execution state">{EXEC_STATES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</Select>
          <Input type="file" name="file" accept=".txt,text/plain" aria-label="Text file" />
          <Textarea name="text" placeholder="Or paste the document text (use a form-feed or '\f' between pages for page refs)" aria-label="Document text" className="md:col-span-2" />
          <Button variant="secondary">Attach & extract</Button>
        </form>
        <p className="mt-1 text-xs text-ink-soft">PDFs and scans: upload through Capture → Documents (OCR) and paste the text here. Unsigned proposals are never treated as executed.</p>
      </Card>

      <Card title="Obligations">
        <div id="obligations" />
        <Table head={["Obligation", "Party", "Deadline", "Status", "Source"]}>
          {d.obligations.map((o) => (
            <tr key={o.id}><Td>{o.category.replace(/_/g, " ")}<div className="text-xs text-ink-soft">{o.description.slice(0, 160)}</div></Td><Td>{o.responsible}</Td><Td>{o.deadline ?? "—"}</Td>
              <Td>{o.status}{o.status === "open" || o.status === "in_progress" ? <form action={A.obligationAction} className="mt-1 flex gap-1">{hidden}<input type="hidden" name="obligation_id" value={o.id} /><input type="hidden" name="status" value="done" /><Input name="evidence" placeholder="Evidence" aria-label="Evidence" className="w-28" /><Button variant="ghost">Done</Button></form> : <div className="text-xs">{o.evidence_note}</div>}</Td>
              <Td className="text-xs">{docTitle(o.document_id) ?? "manual"}{o.page ? ` p.${o.page}` : ""}</Td></tr>
          ))}
        </Table>
        <form action={A.obligationAction} className="mt-2 grid gap-2 md:grid-cols-5">{hidden}<input type="hidden" name="op" value="add" />
          <Input name="category" placeholder="Category" aria-label="Category" /><Input name="description" placeholder="Obligation" aria-label="Obligation" required />
          <Select name="responsible" aria-label="Responsible"><option value="unclear">Responsibility unclear</option><option value="tenant">Tenant</option><option value="landlord">Landlord</option><option value="shared">Shared</option></Select>
          <Input type="date" name="deadline" aria-label="Deadline" /><Button variant="secondary">Add</Button></form>
      </Card>

      <Card title="Renewal">
        <div id="renewal" />
        {renewal ? (
          <div className="space-y-2 text-sm">
            <p>Stage: <Badge>{humanize(renewal.stage)}</Badge> · tenant: {renewal.tenant_response ?? "—"} · landlord: {renewal.landlord_response ?? "—"}</p>
            <ul className="text-xs text-ink-soft">{(renewal.log ?? []).map((l: { at: string; note: string | null; stage?: string }, i: number) => <li key={i}>{l.at.slice(0, 10)} {l.stage ?? ""} {l.note ?? ""}</li>)}</ul>
            <form action={A.renewalAction} className="grid gap-2 md:grid-cols-5">{hidden}<input type="hidden" name="renewal_id" value={renewal.id} />
              <Select name="stage" defaultValue={renewal.stage} aria-label="Stage">{["upcoming", "discussion", "proposal_pending", "negotiation", "approval_pending", "agreed", "completed", "at_risk", "declined"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
              <Input name="tenant_response" placeholder="Tenant response" aria-label="Tenant response" /><Input name="landlord_response" placeholder="Landlord response" aria-label="Landlord response" />
              <Input name="note" placeholder="Note" aria-label="Note" /><Button variant="secondary">Update</Button></form>
            <p className="text-xs">Compare renewal vs relocation in the <Link className="text-brand" href="/toolkit">Deal toolkit</Link> (uses these terms; it shows assumptions and never auto-recommends).</p>
          </div>
        ) : <form action={A.renewalAction}>{hidden}<input type="hidden" name="op" value="open" /><Button variant="secondary">Start renewal review</Button></form>}
        {alts?.items.length ? <div className="mt-3 text-sm"><p className="font-medium">Possible alternatives (recorded supply)</p><ul className="text-xs">{alts.items.map((a) => <li key={a.availabilityId}>{a.asset ?? "?"} {a.floor ?? ""} · {a.areaSf ?? "?"} sf · {FACT_STATUS_LABEL[a.factStatus] ?? humanize(a.factStatus)}</li>)}</ul><p className="text-xs text-ink-soft">{alts.note}</p></div> : null}
      </Card>

      <Card title="Termination & handover">
        <div id="termination" /><div id="handover" />
        {term ? (
          <div className="space-y-2 text-sm">
            <p><Badge>{TERMINATION_STATUS_LABEL[term.status] ?? humanize(term.status)}</Badge> {term.reason ?? "Termination"}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm md:grid-cols-4">
              <div><dt className="text-ink-soft">Notice served on</dt><dd>{term.notice_date ?? "not recorded"}</dd></div>
              <div><dt className="text-ink-soft">Proposed termination date</dt><dd>{term.proposed_date ?? "not recorded"}</dd></div>
              <div><dt className="text-ink-soft">Confirmed termination date</dt><dd>{term.confirmed_date ?? "not yet confirmed"}</dd></div>
              <div><dt className="text-ink-soft">Notice period (as in clause)</dt><dd>{term.notice_period_text ?? "not recorded"}</dd></div>
            </dl>
            <p>Security deposit {term.deposit_amount != null ? inr(term.deposit_amount) : "amount not recorded"}; {term.deposit_recovered != null ? `${inr(term.deposit_recovered)} recovered` : "nothing recorded as recovered"} — {DEPOSIT_STATUS_LABEL[depositRecovery(term).status] ?? humanize(depositRecovery(term).status)}{depositRecovery(term).outstanding && Number(depositRecovery(term).outstanding) > 0 ? `; ${inr(depositRecovery(term).outstanding)} outstanding` : ""}.</p>
            <form action={A.terminationAction} className="grid gap-2 md:grid-cols-5">{hidden}<input type="hidden" name="termination_id" value={term.id} />
              <Input type="date" name="confirmed_date" aria-label="Confirmed termination date" /><Input name="deposit_recovered" placeholder="Deposit recovered ₹" inputMode="decimal" aria-label="Deposit recovered" />
              <Select name="status" defaultValue={term.status} aria-label="Status">{["initiated", "notice_served", "in_settlement", "completed", "withdrawn"].map((s) => <option key={s} value={s}>{TERMINATION_STATUS_LABEL[s]}</option>)}</Select>
              <Input name="settlement" placeholder="Settlement ₹" inputMode="decimal" aria-label="Settlement" /><Button variant="secondary">Update</Button></form>
          </div>
        ) : (
          <form action={A.terminationAction} className="grid gap-2 md:grid-cols-5">{hidden}<input type="hidden" name="op" value="start" />
            <Input name="reason" placeholder="Reason" aria-label="Reason" /><Input type="date" name="notice_date" aria-label="Notice date" /><Input name="notice_period" placeholder="Notice period (as in clause)" aria-label="Notice period" />
            <Input type="date" name="proposed_date" aria-label="Proposed termination date" /><Button variant="secondary">Start termination</Button></form>
        )}
        <p className="mt-2 text-xs text-ink-soft">Lock-in completion alone does not permit termination — check notice and termination conditions in the agreement.</p>
        <div className="mt-3">
          {d.handover.length === 0 ? <form action={A.handoverAction}>{hidden}<input type="hidden" name="op" value="init" /><Button variant="secondary">Create handover checklist</Button></form> : (
            <ul className="space-y-1 text-sm">{d.handover.map((h) => <li key={h.id} className="flex flex-wrap items-center gap-2"><Badge tone={h.status === "done" ? "ok" : "neutral"}>{h.status}</Badge>{h.label}{h.evidence_note ? <span className="text-xs text-ink-soft">({h.evidence_note})</span> : null}
              {h.status === "pending" && <form action={A.handoverAction} className="flex gap-1">{hidden}<input type="hidden" name="item_id" value={h.id} /><input type="hidden" name="status" value="done" /><Input name="evidence" placeholder="Evidence" aria-label="Evidence" className="w-32" /><Button variant="ghost">Done</Button></form>}</li>)}
              <li><form action={A.handoverAction} className="flex gap-1">{hidden}<input type="hidden" name="op" value="add" /><Input name="label" placeholder="Add checklist item" aria-label="New item" required /><Button variant="ghost">Add</Button></form></li></ul>
          )}
        </div>
      </Card>

      <Card title="Reminders">
        <div id="reminders" />
        <p className="text-xs text-ink-soft">Created only from confirmed dates; recalculated when dates change. Delivered in-app via the orchestrator (nothing is sent externally).</p>
        <ul className="mt-2 space-y-1 text-sm">{d.reminders.filter((r) => r.status !== "cancelled").map((r) => <li key={r.id}>{r.remind_on} — {DATE_TYPE_LABEL[r.date_type] ?? r.date_type} on {r.target_date} ({r.offset_days} days before) · {humanize(r.status)}
          {r.status !== "done" && <form action={A.remindersAction} className="ml-2 inline">{hidden}<input type="hidden" name="op" value="done" /><input type="hidden" name="reminder_id" value={r.id} /><span aria-hidden="true">· </span><button className="text-xs text-brand">Mark done</button></form>}</li>)}</ul>
        <form action={A.remindersAction} className="mt-2">{hidden}<Button variant="ghost">Recalculate reminders</Button></form>
      </Card>

      <Card title="Activity timeline">
        <ul className="space-y-1 text-xs">
          {[
            ...d.history.map((h) => ({ at: String(h.changed_at), strong: true, text: `Status ${h.from_status ? `${STATUS_LABEL[h.from_status as LeaseStatus] ?? humanize(h.from_status)} → ` : "set to "}${STATUS_LABEL[h.to_status as LeaseStatus] ?? humanize(h.to_status)}${h.note ? ` (${h.note})` : ""}` })),
            ...audit.filter((a) => a.entity_type !== "lease_status_history").map((a) => ({ at: String(a.occurred_at), strong: false, text: auditEventText(a as { action: string; entity_type: string; after?: Record<string, unknown> | null }, (s) => STATUS_LABEL[s as LeaseStatus] ?? humanize(s)) })),
          ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 60).map((e, i) => (
            <li key={i} className={e.strong ? "" : "text-ink-soft"}><time dateTime={e.at}>{new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</time> — {e.text}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
