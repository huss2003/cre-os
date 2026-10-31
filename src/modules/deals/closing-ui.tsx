/** Server-rendered UI blocks for the closing coordinator and revenue view (deals-B). Mobile-first: stacks at 375px. */
import Link from "next/link";
import { Badge, Button, Field, Input, Select, Table, Td, inr } from "@/components/ui";
import { feeActionB, updateMilestoneDetailsAction } from "./actions-b";
import type { OutstandingDoc, TimelineItem } from "./pipeline/closing";
import { MILESTONE_STATUSES } from "./pipeline/closing-service";
import { STAGE_LABEL, type Stage } from "./pipeline/stages";
import { MONEY_STAGE_LABEL, type LedgerLine } from "./fees/ledger";

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "brand"> = { done: "ok", waived: "neutral", not_applicable: "neutral", in_progress: "brand", open: "neutral", blocked: "bad" };

export function ClosingTimeline({ oppId, items, members, canEdit }: { oppId: string; items: TimelineItem[]; members: { userId: string; name: string }[]; canEdit: boolean }) {
  const who = (id: string | null | undefined) => (id ? members.find((m) => m.userId === id)?.name ?? "member" : null);
  const blocked = items.filter((t) => t.blocked).length, overdue = items.filter((t) => t.overdue).length;
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-soft">
        Dependency timeline — indented items wait on the item above them. {blocked ? <span className="text-bad">{blocked} blocked</span> : "Nothing blocked"} · {overdue ? <span className="text-bad">{overdue} overdue</span> : "nothing overdue"}.
        Items marked “needed before” block that stage until done (with proof where required) or waived.
      </p>
      <ol className="divide-y divide-line text-sm">
        {items.map((t) => (
          <li key={t.id} className="py-2" style={{ paddingLeft: `${Math.min(t.level, 4) * 0.75}rem` }}>
            <div className="flex flex-wrap items-center gap-1">
              {t.level > 0 && <span aria-hidden className="text-ink-soft">↳</span>}
              <span className="font-medium">{t.title}</span>
              <Badge tone={t.blocked ? "bad" : STATUS_TONE[t.status] ?? "neutral"}>{t.blocked && t.status !== "blocked" ? "blocked" : t.status.replace(/_/g, " ")}</Badge>
              {t.overdue && <Badge tone="bad">overdue {t.daysOverdue}d</Badge>}
            </div>
            <div className="mt-0.5 text-xs text-ink-soft">
              {[t.required_for_stage ? `needed before ${STAGE_LABEL[t.required_for_stage as Stage] ?? t.required_for_stage}` : "move dependency",
                t.due_date ? `due ${t.due_date}` : "no due date", who(t.assignee_user_id) ? `owner ${who(t.assignee_user_id)}` : t.owner_note ? null : "no owner",
                t.owner_note ? `external: ${t.owner_note}` : null, t.proof_required ? "proof required" : null, t.proof_text ? `proof: ${t.proof_text}` : null].filter(Boolean).join(" · ")}
            </div>
            {t.waitingOn.length > 0 && <div className="mt-0.5 text-xs text-bad">Waiting on: {t.waitingOn.map((w) => `${w.title} (${w.status.replace(/_/g, " ")}${w.due_date ? `, due ${w.due_date}` : ""})`).join(" → ")}</div>}
            {canEdit && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-brand">Edit</summary>
                <form action={updateMilestoneDetailsAction} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input type="hidden" name="id" value={oppId} /><input type="hidden" name="milestone_id" value={t.id} />
                  <Field label="Status"><Select name="status" defaultValue={t.status}>{MILESTONE_STATUSES.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ")}</option>)}</Select></Field>
                  <Field label="Due date"><Input type="date" name="due_date" defaultValue={t.due_date ?? ""} /></Field>
                  <Field label="Owner"><Select name="assignee_user_id" defaultValue={t.assignee_user_id ?? ""}><option value="">— unassigned —</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</Select></Field>
                  <Field label="External owner (optional)"><Input name="owner_note" placeholder="e.g. client legal, landlord" defaultValue={t.owner_note ?? ""} /></Field>
                  <Field label="Waits on"><Select name="depends_on" defaultValue={t.depends_on ?? ""}><option value="">— nothing —</option>{items.filter((x) => x.id !== t.id).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</Select></Field>
                  <Field label="Proof (document, email ref, signed copy)"><Input name="proof_text" defaultValue={t.proof_text ?? ""} /></Field>
                  <div className="sm:col-span-3"><Button variant="secondary" type="submit">Save item</Button></div>
                </form>
              </details>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function OutstandingDocs({ items }: { items: OutstandingDoc[] }) {
  if (!items.length) return <p className="text-sm text-ink-soft">Nothing outstanding: every document item is done with proof, and client documents are released and current.</p>;
  return (
    <ul className="divide-y divide-line text-sm">
      {items.map((o) => (
        <li key={`${o.source}-${o.id}`} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div><span className="font-medium">{o.title}</span> <span className="text-xs text-ink-soft">{o.source === "document" ? "client document" : "checklist"}{o.due_date ? ` · due ${o.due_date}` : ""}{o.note ? ` · ${o.note}` : ""}</span></div>
          {o.source === "document" ? <Link className="text-xs text-brand underline" href="/documents">{o.status}</Link> : <Badge tone={o.status === "blocked" || o.status === "proof missing" ? "bad" : "neutral"}>{o.status.replace(/_/g, " ")}</Badge>}
        </li>
      ))}
    </ul>
  );
}

const MONEY_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "brand"> = { forecast: "warn", agreed: "brand", credited: "ok", computed: "neutral", recorded: "ok", missing_evidence: "bad", unknown: "neutral" };
export function LedgerTable({ lines }: { lines: LedgerLine[] }) {
  return (
    <Table head={["Stage", "Milestone", "Amount", "Status", "Date", "Reference / link"]}>
      {lines.map((l, i) => (
        <tr key={i}>
          <Td>{MONEY_STAGE_LABEL[l.stage]}</Td><Td>{l.label}</Td><Td>{l.amount === null ? "unknown" : inr(l.amount)}</Td>
          <Td><Badge tone={MONEY_TONE[l.status]}>{l.status.replace(/_/g, " ")}</Badge></Td><Td>{l.date ?? "—"}</Td>
          <Td className="text-xs">{[l.reference, l.transaction.invoiceNo && l.reference !== l.transaction.invoiceNo ? `inv ${l.transaction.invoiceNo}` : null, l.transaction.crmId ? `CRM ${l.transaction.crmId}` : null, l.transaction.feeMilestoneId ? `fee ${l.transaction.feeMilestoneId.slice(0, 8)}` : "opportunity"].filter(Boolean).join(" · ")}</Td>
        </tr>
      ))}
    </Table>
  );
}

export function FeeFormB({ oppId, fees, milestones }: { oppId: string; fees: { id: string; milestone: string | null }[]; milestones: { id: string; title: string }[] }) {
  return (
    <details className="mt-3 rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">Record fee terms / attribution / invoice / collection</summary>
      <p className="mt-2 text-xs text-ink-soft">Each amount is recorded once with its date and evidence; corrections go through an approval. The official finance system stays authoritative — use Fees → Reconcile to compare.</p>
      <form action={feeActionB} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input type="hidden" name="id" value={oppId} />
        <Field label="Update existing"><Select name="milestone_id" defaultValue=""><option value="">— new milestone —</option>{fees.map((f) => <option key={f.id} value={f.id}>{f.milestone ?? f.id.slice(0, 8)}</option>)}</Select></Field>
        <Field label="Milestone"><Input name="milestone" placeholder="e.g. on signing" /></Field>
        <Field label="Linked closing item"><Select name="deal_milestone_id" defaultValue=""><option value="">—</option>{milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</Select></Field>
        <Field label="Gross fee ₹"><Input name="gross_fee" inputMode="decimal" /></Field>
        <Field label="Credit share %"><Input name="credit_share_pct" inputMode="decimal" /></Field>
        <Field label="Contractual ₹ / agreement ref"><div className="flex gap-1"><Input name="contractual_amount" inputMode="decimal" /><Input name="contract_ref" placeholder="EL no." /></div></Field>
        <Field label="Attributed on / credit memo"><div className="flex gap-1"><Input type="date" name="attributed_on" /><Input name="attribution_ref" placeholder="memo" /></div></Field>
        <Field label="Invoiced ₹ / date"><div className="flex gap-1"><Input name="invoiced_amount" inputMode="decimal" /><Input type="date" name="invoiced_on" /></div></Field>
        <Field label="Invoice no. / due date"><div className="flex gap-1"><Input name="invoice_no" /><Input type="date" name="invoice_due_on" /></div></Field>
        <Field label="Recognised ₹ / date"><div className="flex gap-1"><Input name="recognised_amount" inputMode="decimal" /><Input type="date" name="recognised_on" /></div></Field>
        <Field label="Collected ₹ / date"><div className="flex gap-1"><Input name="collected_amount" inputMode="decimal" /><Input type="date" name="collected_on" /></div></Field>
        <Field label="Evidence (invoice no., remittance ref.)"><Input name="evidence" /></Field>
        <div className="sm:col-span-3"><Button type="submit">Save fee record</Button></div>
      </form>
    </details>
  );
}

export function ReconExceptions({ rows }: { rows: { id: string; import_id: string; row_no: number; invoice_no: string | null; status: string; exceptions: string[]; proposal_ids: string[] }[] }) {
  if (!rows.length) return <p className="text-sm text-ink-soft">No reconciliation exceptions for this deal. Import the finance system&apos;s invoice/collection export under <Link className="text-brand underline" href="/fees/reconcile">Fees → Reconcile</Link>.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.id}><Badge tone={r.status === "mismatch" ? "bad" : "warn"}>{r.status.replace(/_/g, " ")}</Badge> <Link className="underline" href={`/fees/reconcile?import=${r.import_id}`}>row {r.row_no}{r.invoice_no ? ` · ${r.invoice_no}` : ""}</Link>: {r.exceptions.join("; ")}{r.proposal_ids.length ? <> · <Link className="text-brand underline" href="/approvals">{r.proposal_ids.length} proposal(s) awaiting approval</Link></> : null}</li>
      ))}
    </ul>
  );
}
