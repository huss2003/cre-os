import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, MoreFields, PageHeader, Select, Stat, StaleBanner, Table, Td, Textarea } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { codeLabel, formatINR } from "@/lib/util/labels";
import { localDate } from "@/lib/util/time";
import { TxError } from "@/modules/transactions/ctx";
import { commandView } from "@/modules/transactions/command";
import { compareOfferPackages } from "@/modules/transactions/service";
import { supplyOptions, relationshipContext } from "@/modules/transactions/integrations";
import {
  APPROVAL_CATEGORIES, CLARIFICATION_TOPICS, ISSUE_CATEGORIES, ISSUE_STATUSES, MILESTONE_KINDS, MILESTONE_LABEL, OFFER_TERM_FIELDS, POINT_STATUSES, POINT_STATUS_LABEL,
  STAKEHOLDER_CATEGORIES, TERM_LABEL, WORKSPACE_SECTIONS, isOverdue, plainSummary, depositStageText, clarificationRequirement,
} from "@/modules/transactions/model";
import * as A from "@/modules/transactions/actions";

const lbl = (s: string | null | undefined) => codeLabel(s);
const Hid = ({ tx, ...rest }: { tx: string } & Record<string, string>) => (<><input type="hidden" name="tx" value={tx} />{Object.entries(rest).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}</>);
const Sec = ({ id, n, title, children, help }: { id: string; n: number; title: string; children: ReactNode; help?: ReactNode }) => (
  <section id={id} className="scroll-mt-20"><Card title={`${n}. ${title}`} help={help}>{children}</Card></section>
);
const None = ({ children }: { children: ReactNode }) => <p className="text-sm text-ink-soft">{children}</p>;

export default async function TransactionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const app = await requirePageContext();
  const ctx = { db: app.db, workspaceId: app.workspaceId, userId: app.userId };
  let v: Awaited<ReturnType<typeof commandView>>;
  try { v = await commandView(ctx, id, localDate(new Date(), app.timezone)); } catch (e) { if (e instanceof TxError && e.status === 404) notFound(); throw e; }
  const today = localDate(new Date(), app.timezone);
  const canEdit = app.role !== "viewer";
  const offers = v.negotiation.versions;
  const pkg = sp.a && sp.b ? await compareOfferPackages(ctx, id, sp.a, sp.b).catch((e: Error) => ({ error: e.message })) : null;
  const [supply, memory, intakes, packs] = await Promise.all([
    supplyOptions(ctx, id), relationshipContext(ctx, id),
    app.db.from("tx_intake").select("*").eq("transaction_id", id).eq("status", "pending_review").order("created_at"),
    app.db.from("document_version").select("id, version_no, created_at").eq("workspace_id", app.workspaceId).eq("purpose", "transaction_closure_pack").eq("linked_entity_id", id).order("version_no", { ascending: false }).limit(5),
  ]);
  const reviewers = [{ id: app.userId, name: "Me" }, ...v.stakeholders.filter((s) => s.user_id && s.user_id !== app.userId).map((s) => ({ id: s.user_id as string, name: `${s.name} (${lbl(s.category)})` }))];
  const docsForApproval = v.latestDocuments.filter((d) => d.status !== "superseded");

  return (
    <div className="space-y-5">
      <PageHeader title={v.tx.name} subtitle={<>{v.tx.code} · {v.typeLabel} · {lbl(v.tx.status)}{v.tx.archived_at ? " (archived)" : ""} · stage {v.currentStage?.title ?? "—"}{v.tx.opportunity_id ? <> · <Link className="text-brand underline" href={`/deals/${v.tx.opportunity_id}`}>deal</Link></> : null}{v.tx.requirement_id ? <> · <Link className="text-brand underline" href={`/requirements/${v.tx.requirement_id}`}>requirement</Link></> : null}</>} />
      {sp.err && <StaleBanner>{sp.err}</StaleBanner>}
      {sp.ok && <p className="text-sm text-ok">{sp.ok}</p>}
      <nav className="flex gap-2 overflow-x-auto pb-1 text-xs" aria-label="Workspace sections">
        {WORKSPACE_SECTIONS.map(([k, t], i) => <a key={k} href={`#${k}`} className="shrink-0 rounded border border-line px-2 py-1 hover:bg-canvas">{i + 1}. {t}</a>)}
        <a href="#timeline" className="shrink-0 rounded border border-line px-2 py-1">Timeline</a>
      </nav>

      {/* §15 command summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Agreed terms" value={v.negotiation.agreed.length} hint={`${v.negotiation.disputed.length} disputed`} />
        <Stat label="Open issues" value={v.issues.open.length} hint={`${v.issues.overdue.length} overdue · ${v.issues.blocking.length} blocking`} />
        <Stat label="Pending approvals" value={v.pendingApprovals.length} />
        <Stat label="Outstanding documents" value={v.outstandingDocuments.length} />
        <Stat label="Closure blockers" value={v.blockers.length} />
      </div>
      {v.blockingNow.length > 0 && <StaleBanner>Blocking: {v.blockingNow.join(" · ")}</StaleBanner>}
      <Card title="Next actions & route to completion">
        {v.nextActions.length === 0 ? <None>No next action recorded. Raise an issue or request an approval to set one.</None> : (
          <ul className="space-y-1 text-sm">{v.nextActions.slice(0, 8).map((a, i) => <li key={i}>{a.blocking && <Badge tone="bad">blocking</Badge>} {a.overdue && <Badge tone="warn">overdue</Badge>} <b>{a.what}</b> — {a.why}{a.due ? ` (due ${a.due})` : ""}</li>)}</ul>
        )}
        <details className="mt-3 text-sm"><summary className="cursor-pointer">Route to completion ({v.route.length} steps) · dependencies · upcoming deadlines</summary>
          <ol className="mt-2 list-decimal pl-5">{v.route.map((r, i) => <li key={i}>{r.step} <span className="text-ink-soft">({r.status})</span></li>)}</ol>
          <ul className="mt-2 list-disc pl-5">{Object.entries(v.dependencies).filter(([, x]) => x.length).map(([k, x]) => <li key={k}><b>{lbl(k.replace(/([A-Z])/g, "_$1").toLowerCase())}:</b> {x.join("; ")}</li>)}</ul>
          <ul className="mt-2 list-disc pl-5">{v.upcoming.slice(0, 10).map((u, i) => <li key={i}>{u.date} — {u.what}</li>)}</ul>
        </details>
      </Card>

      <Sec id="overview" n={1} title="Transaction overview">
        <ol className="grid gap-1 text-sm sm:grid-cols-2">{v.stages.map((s) => (
          <li key={s.id} className="flex items-center gap-2"><Badge tone={s.status === "done" ? "ok" : s.status === "in_progress" ? "brand" : "neutral"}>{lbl(s.status)}</Badge>{s.title}
            {canEdit && s.status !== "done" && <form action={A.stageAction} className="ml-auto"><Hid tx={id} stage={s.key} status={s.status === "in_progress" ? "done" : "in_progress"} /><button className="text-xs text-brand underline">{s.status === "in_progress" ? "mark done" : "start"}</button></form>}
          </li>))}</ol>
        <p className="mt-2 text-xs text-ink-soft">Owner {v.tx.tx_owner_user_id === app.userId ? "you" : v.tx.tx_owner_user_id} · priority {lbl(v.tx.priority)} · expected completion {v.tx.expected_completion ?? "not set"} · created {String(v.tx.created_at).slice(0, 10)}</p>
      </Sec>

      <Sec id="requirements" n={2} title="Client requirements vs adviser recommendations vs counterparty proposals" help="Three separate positions. None is ever converted into another; agreed terms come only from the commercial point tracker with evidence.">
        {v.positions.length === 0 ? <None>No positions yet. Link a confirmed requirement or record positions below.</None> : (
          <Table head={["Term", "Client requirement", "Adviser recommendation", "Counterparty proposal", "Agreed"]}>
            {v.positions.map((p) => <tr key={p.term}><Td>{p.label}</Td><Td>{p.client?.value ?? "—"}</Td><Td>{p.adviser?.value ?? "—"}</Td><Td>{p.counterparty?.value ?? "—"}</Td><Td>{p.agreed ? `${p.agreed.value} (${POINT_STATUS_LABEL[p.agreed.status]})` : "—"}</Td></tr>)}
          </Table>
        )}
        {canEdit && <form action={A.positionAction} className="mt-3 grid gap-2 sm:grid-cols-5"><Hid tx={id} />
          <Select name="kind">{["client_requirement", "adviser_recommendation", "counterparty_proposal"].map((k) => <option key={k} value={k}>{lbl(k)}</option>)}</Select>
          <Select name="term">{OFFER_TERM_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
          <Input name="value" placeholder="value (blank = unknown)" /><Input name="source" required placeholder="source (email, meeting…)" /><Button variant="secondary">Record</Button></form>}
      </Sec>

      <Sec id="property" n={3} title="Property information">
        <p className="text-sm">{(v.tx.property_labels ?? []).join(", ") || "No property recorded."}</p>
        {supply.requirementLinked ? (supply.options.length ? <ul className="mt-2 text-sm">{supply.options.slice(0, 8).map((o) => <li key={o.id}>{o.label} · fit {o.fit_score ?? "—"}{o.option_status ? ` · ${lbl(o.option_status)}` : ""}{o.quote ? ` · quote v${o.quote.version} valid ${o.quote.valid_until ?? "—"}` : " · no quote"}</li>)}</ul> : <None>The requirement has no shortlist yet (Property Supply).</None>) : <None>Link a requirement to see matching and alternative properties.</None>}
      </Sec>

      <Sec id="offers" n={4} title="Offers and counteroffers" help="Every version is kept; nothing is overwritten. Compare any two versions as full packages (Deal Toolkit maths).">
        {offers.length === 0 ? <None>No offers yet. Record the first proposal below or paste it into intake.</None> : (
          <Table head={["Version", "From", "Date / valid", "Key terms", "Response"]}>
            {offers.map((o) => <tr key={o.id}><Td>v{o.version_no} {lbl(o.kind).toLowerCase()}{o.parent_offer_id ? ` ← v${offers.find((x) => x.id === o.parent_offer_id)?.version_no}` : ""}</Td><Td>{lbl(o.offering_party)}</Td>
              <Td>{o.offer_date}{o.valid_until ? ` / ${o.valid_until}` : ""}{o.valid_until && o.valid_until < today && o.response_status === "pending" ? <Badge tone="warn">expired</Badge> : null}</Td>
              <Td><span className="text-xs">{Object.entries(o.terms).map(([k, x]) => `${TERM_LABEL[k] ?? k}: ${x}`).join(" · ")}</span>{o.reason ? <div className="text-xs text-ink-soft">reason: {o.reason}</div> : null}</Td>
              <Td>{lbl(o.response_status)}{canEdit && o.response_status === "pending" && <form action={A.respondOfferAction} className="mt-1 flex gap-1"><Hid tx={id} offer={o.id} /><Select name="status">{["accepted", "rejected", "withdrawn", "expired"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Input name="note" required placeholder="evidence" /><Button variant="ghost">Save</Button></form>}</Td></tr>)}
          </Table>
        )}
        {v.negotiation.diffs.length > 1 && <details className="mt-2 text-sm"><summary className="cursor-pointer">Changes between versions</summary>{v.negotiation.diffs.slice(1).map((d) => <div key={d.to} className="mt-1"><b>v{d.from} → v{d.to}:</b> {d.terms.filter((t) => t.status !== "unchanged" && t.status !== "unresolved").map((t) => `${t.label} ${t.previous ?? "—"}→${t.current ?? "—"} (${t.status})`).join("; ") || "no changes"}</div>)}</details>}
        {offers.length > 1 && <form className="mt-3 flex flex-wrap items-end gap-2" method="get"><Field label="Package A"><Select name="a" defaultValue={sp.a}>{offers.map((o) => <option key={o.id} value={o.id}>v{o.version_no}</option>)}</Select></Field><Field label="Package B"><Select name="b" defaultValue={sp.b}>{offers.map((o) => <option key={o.id} value={o.id}>v{o.version_no}</option>)}</Select></Field><Button variant="secondary">Compare packages</Button></form>}
        {pkg && ("error" in pkg ? <StaleBanner>{pkg.error}</StaleBanner> : (
          <div className="mt-3 rounded border border-line p-3 text-sm">
            <p><b>{pkg.verdictText}</b></p>
            {pkg.tradeOffs.betterInB.length > 0 && <p>Better in B: {pkg.tradeOffs.betterInB.join("; ")}</p>}
            {pkg.tradeOffs.worseInB.length > 0 && <p>Worse in B: {pkg.tradeOffs.worseInB.join("; ")}</p>}
            {pkg.missing.length > 0 && <p className="text-warn">Missing: {pkg.missing.join("; ")}</p>}
            {pkg.assumptions.length > 0 && <p className="text-ink-soft">Assumptions: {pkg.assumptions.join("; ")}</p>}
            {pkg.notModelled.length > 0 && <p className="text-ink-soft">Not modelled: {pkg.notModelled.join("; ")}</p>}
          </div>))}
        {canEdit && <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Record offer / counteroffer</summary>
          <form action={A.offerAction} className="mt-2 grid gap-2 sm:grid-cols-3"><Hid tx={id} />
            <Field label="Counter to"><Select name="parent" defaultValue=""><option value="">— (new offer)</option>{offers.map((o) => <option key={o.id} value={o.id}>v{o.version_no}</option>)}</Select></Field>
            <Field label="From"><Select name="offering_party">{["landlord", "developer", "operator", "client", "adviser", "other"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select></Field>
            <Field label="To"><Input name="receiving_party" defaultValue="client" /></Field>
            <Field label="Offer date"><Input type="date" name="offer_date" defaultValue={today} required /></Field>
            <Field label="Valid until"><Input type="date" name="valid_until" /></Field>
            <Field label="Reason for change"><Input name="reason" /></Field>
            {OFFER_TERM_FIELDS.map((f) => <Field key={f.key} label={f.label}><Input name={`t_${f.key}`} inputMode={f.numeric ? "decimal" : undefined} placeholder="unknown" /></Field>)}
            <Field label="Source document"><Input name="source" /></Field>
            <div className="sm:col-span-3"><Button>Save new version</Button></div>
          </form></details>}
        {canEdit && <details className="mt-2"><summary className="cursor-pointer text-sm font-medium">Intake a proposal / LOI / draft / report (review before it becomes a record)</summary>
          <form action={A.intakeAction} className="mt-2 grid gap-2"><Hid tx={id} />
            <Select name="kind">{["proposal", "counteroffer", "inspection_report", "technical_document", "loi", "term_sheet", "agreement_draft", "executed_agreement", "handover_document"].map((k) => <option key={k} value={k}>{lbl(k)}</option>)}</Select>
            <Input name="source" placeholder="source (email subject, file name)" /><Textarea name="text" rows={5} required placeholder="Paste the document text" /><Button variant="secondary">Extract for review</Button></form></details>}
        {(intakes.data ?? []).map((it) => <div key={it.id} className="mt-2 rounded border border-warn/40 p-2 text-sm"><b>Pending review: {lbl(it.intake_kind)}</b> {it.mocked ? <Badge>pattern extraction</Badge> : <Badge tone="accent">AI extraction</Badge>}
          <div className="text-xs">{Object.entries(it.extracted?.terms ?? {}).map(([k, x]) => `${TERM_LABEL[k] ?? k}: ${x}`).join(" · ") || "no terms found"}</div>
          {canEdit && <div className="mt-1 flex flex-wrap gap-2"><form action={A.acceptIntakeAction} className="flex flex-wrap gap-1"><Hid tx={id} intake={it.id} /><Select name="offering_party" defaultValue={it.extracted?.offeringParty ?? ""}><option value="">party?</option>{["landlord", "developer", "operator", "client", "other"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Select name="parent" defaultValue=""><option value="">no parent</option>{offers.map((o) => <option key={o.id} value={o.id}>counter to v{o.version_no}</option>)}</Select><Button variant="secondary">Accept</Button></form><form action={A.rejectIntakeAction}><Hid tx={id} intake={it.id} /><Button variant="ghost">Reject</Button></form></div>}</div>)}
      </Sec>

      <Sec id="negotiation" n={5} title="Commercial negotiations — point tracker" help="Agreed ≠ documented ≠ verified against the executed agreement. Agreeing needs evidence; an agreed value is never overwritten.">
        {v.points.length === 0 ? <None>Points appear automatically from offers.</None> : (
          <Table head={["Term", "Value", "Status", "Update"]}>
            {v.points.map((p) => <tr key={p.id}><Td>{p.label}</Td><Td>{p.value ?? "unknown"}</Td><Td><Badge tone={p.status === "verified_executed" ? "ok" : p.status === "agreed" ? "brand" : "neutral"}>{POINT_STATUS_LABEL[p.status]}</Badge>{p.agreed_evidence ? <div className="text-xs text-ink-soft">{p.agreed_evidence}</div> : null}</Td>
              <Td>{canEdit && <form action={A.pointAction} className="flex flex-wrap gap-1"><Hid tx={id} point={p.id} /><Select name="status" defaultValue={p.status}>{POINT_STATUSES.map((x) => <option key={x} value={x}>{POINT_STATUS_LABEL[x]}</option>)}</Select><Input name="evidence" placeholder="evidence" /><Select name="document" defaultValue=""><option value="">doc…</option>{v.documents.map((d) => <option key={d.id} value={d.id}>{d.title} v{d.version_no}</option>)}</Select><Button variant="ghost">Save</Button></form>}</Td></tr>)}
          </Table>
        )}
        {memory.previousAgreedTerms.length + memory.previousObjections.length > 0 && <details className="mt-2 text-sm"><summary className="cursor-pointer">Relationship memory</summary>
          <ul className="list-disc pl-5">{memory.previousAgreedTerms.slice(0, 10).map((t, i) => <li key={i}>Earlier deal: {t.label} {t.value}</li>)}{memory.previousObjections.slice(0, 10).map((o, i) => <li key={`o${i}`}>Objection ({o.category}): {o.objection}</li>)}</ul></details>}
      </Sec>

      <Sec id="inspections" n={6} title="Technical inspections & clarifications">
        {v.inspections.map((i) => <p key={i.id} className="text-sm">{i.inspection_date} · {i.inspection_type} · <Badge>{lbl(i.status)}</Badge> {i.findings ?? ""}{i.outstanding_concerns ? ` — concerns: ${i.outstanding_concerns}` : ""}</p>)}
        {v.clarifications.length > 0 && <Table head={["Topic", "Question", "Requirement", "Response", "Status"]}>{v.clarifications.map((c) => <tr key={c.id}><Td>{lbl(c.topic)}</Td><Td>{c.question}</Td><Td>{clarificationRequirement(c)}</Td><Td>{c.response ?? (canEdit ? <form action={A.clarificationResponseAction} className="flex gap-1"><Hid tx={id} clar={c.id} /><Input name="response" required /><Input name="response_num" inputMode="decimal" placeholder="number" /><Button variant="ghost">Save</Button></form> : "—")}</Td><Td><Badge tone={c.status === "discrepancy" ? "bad" : "neutral"}>{lbl(c.status)}</Badge></Td></tr>)}</Table>}
        {v.inspections.length + v.clarifications.length === 0 && <None>No inspections or clarifications yet.</None>}
        {canEdit && <MoreFields label="Record inspection / request clarification">
          <form action={A.inspectionAction} className="grid gap-2 sm:grid-cols-3"><Hid tx={id} /><Input type="date" name="date" required defaultValue={today} /><Input name="type" required placeholder="type (MEP, structural…)" /><Input name="participants" placeholder="participants, comma separated" /><Textarea name="findings" placeholder="findings" /><Textarea name="concerns" placeholder="outstanding concerns" /><Input name="responsible" placeholder="responsible party" /><Button variant="secondary">Record inspection</Button></form>
          <form action={A.clarificationAction} className="mt-3 grid gap-2 sm:grid-cols-3"><Hid tx={id} /><Select name="topic">{CLARIFICATION_TOPICS.map((t) => <option key={t} value={t}>{lbl(t)}</option>)}</Select><Input name="question" required placeholder="question" /><Input name="required" placeholder="client requirement (text)" /><Input name="required_num" inputMode="decimal" placeholder="minimum (number)" /><Input name="responsible" placeholder="responsible party" /><Button variant="secondary">Request</Button></form>
        </MoreFields>}
      </Sec>

      <Sec id="issues" n={7} title="Open issues" help="Every unresolved issue has an owner, a next action, and a due date or a recorded reason for none.">
        {v.issues.open.length === 0 ? <None>No open issues.</None> : (
          <Table head={["Issue", "Owner / responsible", "Next action", "Due", "Status"]}>
            {v.issues.open.map((i) => <tr key={i.id}><Td>{i.blocking && <Badge tone="bad">blocking</Badge>} {i.title} <span className="text-xs text-ink-soft">({lbl(i.category).toLowerCase()})</span>{(i.depends_on ?? []).length ? <div className="text-xs">depends on {i.depends_on.length}</div> : null}</Td>
              <Td>{i.internal_owner_user_id === app.userId ? "you" : "colleague"} / {v.stakeholders.find((s) => s.id === i.stakeholder_id)?.name ?? i.responsible_party ?? "—"}</Td><Td>{i.next_action}</Td>
              <Td>{i.due_date ?? <span className="text-xs">no date: {i.no_due_reason}</span>}{isOverdue(i, today) && <Badge tone="warn">overdue</Badge>}</Td>
              <Td>{canEdit ? <form action={A.updateIssueAction} className="flex flex-wrap gap-1"><Hid tx={id} issue={i.id} /><Select name="status" defaultValue={i.status}>{ISSUE_STATUSES.map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Input name="resolution" placeholder="resolution (if resolving)" /><Button variant="ghost">Save</Button></form> : lbl(i.status)}</Td></tr>)}
          </Table>
        )}
        {canEdit && <MoreFields label="Raise issue"><form action={A.issueAction} className="grid gap-2 sm:grid-cols-3"><Hid tx={id} />
          <Input name="title" required placeholder="title" /><Select name="category">{ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{lbl(c)}</option>)}</Select><Input name="next_action" required placeholder="next action" />
          <Input type="date" name="due_date" /><Input name="no_due_reason" placeholder="or: why no due date" /><Select name="stakeholder" defaultValue=""><option value="">stakeholder…</option>{v.stakeholders.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <Input name="responsible" placeholder="responsible party" /><Select name="priority" defaultValue="normal">{["low", "normal", "high", "critical"].map((p) => <option key={p} value={p}>{lbl(p)}</option>)}</Select><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="blocking" /> blocks progress</label>
          <Select name="depends_on" multiple>{v.issues.open.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</Select><Textarea name="description" placeholder="description" /><Button>Raise</Button></form></MoreFields>}
      </Sec>

      <Sec id="stakeholders" n={8} title="Stakeholders" help="External messages are drafts only — you send them yourself.">
        {v.stakeholders.length === 0 ? <None>No stakeholders yet.</None> : <Table head={["Name", "Role", "Authority", "Pending", "Blocking"]}>{v.stakeholders.map((s) => <tr key={s.id}><Td>{s.name}<div className="text-xs text-ink-soft">{s.organisation ?? ""} {s.is_internal ? "(internal)" : "(external)"}</div></Td><Td>{lbl(s.category)}{s.role ? ` — ${s.role}` : ""}</Td><Td>{lbl(s.decision_authority)}</Td><Td>{s.pendingTasks.length} actions · {s.openIssues.length} issues · {s.pendingApprovals.length} approvals</Td><Td>{s.blocking ? <Badge tone="bad">yes</Badge> : "—"}</Td></tr>)}</Table>}
        {canEdit && <MoreFields label="Add stakeholder / assign action">
          <form action={A.stakeholderAction} className="grid gap-2 sm:grid-cols-3"><Hid tx={id} /><Input name="name" required placeholder="name" /><Select name="category">{STAKEHOLDER_CATEGORIES.map((c) => <option key={c} value={c}>{lbl(c)}</option>)}</Select><Input name="organisation" placeholder="organisation" /><Input name="designation" placeholder="designation" /><Input name="contact" placeholder="contact" /><Select name="authority">{["none", "influencer", "recommender", "approver", "signatory"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Input name="user_id" placeholder="CRE OS user id (internal reviewers)" /><Textarea name="responsibilities" placeholder="responsibilities" /><Button variant="secondary">Add</Button></form>
          <form action={A.stakeholderTaskAction} className="mt-3 grid gap-2 sm:grid-cols-4"><Hid tx={id} /><Select name="stakeholder">{v.stakeholders.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Input name="title" required placeholder="pending action" /><Input type="date" name="due_date" /><Button variant="secondary">Assign</Button></form>
        </MoreFields>}
      </Sec>

      <Sec id="approvals" n={9} title="Approvals" help="Each approval is bound to the exact version (hash). A new version invalidates it and opens a reassessment. Only the assigned reviewer decides; legal only by a legal reviewer.">
        {v.approvals.length === 0 ? <None>No approvals requested.</None> : <Table head={["Category", "Version", "Reviewer / deadline", "Status", "Decide"]}>
          {v.approvals.map((a) => <tr key={a.id}><Td>{lbl(a.category)}</Td><Td>{a.version_label}<div className="font-mono text-[10px] text-ink-soft">{String(a.subject_hash).slice(0, 12)}</div></Td><Td>{a.reviewer_user_id === app.userId ? "you" : a.reviewer_user_id ? "colleague" : "—"}{a.deadline ? ` · ${a.deadline}` : ""}</Td>
            <Td>{a.invalidated_at ? <Badge tone="warn">invalidated: {a.invalidated_reason}</Badge> : <Badge tone={a.status === "approved" ? "ok" : a.status === "rejected" ? "bad" : "neutral"}>{lbl(a.status)}</Badge>}</Td>
            <Td>{!a.invalidated_at && ["pending", "under_review", "changes_requested"].includes(a.status) && (a.reviewer_user_id === app.userId
              ? <form action={A.decideApprovalAction} className="flex flex-wrap gap-1"><Hid tx={id} approval={a.id} hash={a.subject_hash} /><Select name="decision">{["approved", "rejected", "changes_requested", "under_review"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Input name="comments" placeholder="comments" /><Button variant="ghost">Decide</Button></form>
              : ["landlord", "operator", "client_commercial"].includes(a.category) && canEdit ? <form action={A.externalDecisionAction} className="flex flex-wrap gap-1"><Hid tx={id} approval={a.id} /><Select name="decision">{["approved", "rejected", "changes_requested"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Input name="evidence" required placeholder="evidence of their decision" /><Button variant="ghost">Record</Button></form> : "awaiting reviewer")}</Td></tr>)}
        </Table>}
        {canEdit && <MoreFields label="Request approval / draft a message">
          <form action={A.approvalAction} className="grid gap-2 sm:grid-cols-3"><Hid tx={id} /><Select name="category">{APPROVAL_CATEGORIES.map((c) => <option key={c} value={c}>{lbl(c)}</option>)}</Select>
            <Select name="subject_type"><option value="commercial_position">current commercial position</option><option value="document">document</option><option value="offer">offer</option><option value="deposit">deposit</option></Select>
            <Select name="subject_id" defaultValue=""><option value="">(for document / offer / deposit)</option>{docsForApproval.map((d) => <option key={d.id} value={d.id}>doc: {d.title} v{d.version_no}</option>)}{offers.map((o) => <option key={o.id} value={o.id}>offer v{o.version_no}</option>)}{v.deposits.map((d) => <option key={d.id} value={d.id}>deposit: {d.deposit_type}</option>)}</Select>
            <Select name="reviewer">{reviewers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select><Select name="reviewer_stakeholder" defaultValue=""><option value="">reviewer stakeholder…</option>{v.stakeholders.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Input type="date" name="deadline" /><Button variant="secondary">Request</Button></form>
          <form action={A.communicationAction} className="mt-3 grid gap-2"><Hid tx={id} /><p className="text-xs text-ink-soft">Messages stating commercial terms need a live client commercial approval of the current position, and every figure must be an approved value. Saved as a draft — you send it.</p><Input name="to" placeholder="recipient name" /><Input name="address" placeholder="email" /><Input name="subject" placeholder="subject" /><Textarea name="body" rows={4} required /><Button variant="secondary">Save draft</Button></form>
        </MoreFields>}
      </Sec>

      <Sec id="loi" n={10} title="LOI and term sheet">
        {v.documents.filter((d) => ["loi", "term_sheet"].includes(d.doc_kind)).map((d) => <DocRow key={d.id} d={d} tx={id} canEdit={canEdit} />)}
        {canEdit && <DocForm tx={id} kinds={["loi", "term_sheet"]} section="loi" />}
      </Sec>

      <Sec id="legal" n={11} title="Legal documents & document requests" help="Deterministic clause diff and reconciliation against agreed terms. AI may suggest questions; it never clears a clause. Uploaded ≠ verified.">
        {v.documents.filter((d) => ["agreement", "executed_agreement", "other"].includes(d.doc_kind)).map((d) => <DocRow key={d.id} d={d} tx={id} canEdit={canEdit} />)}
        {canEdit && <DocForm tx={id} kinds={["agreement", "executed_agreement", "other"]} section="legal" />}
        <h4 className="mt-4 text-sm font-medium">Document requests</h4>
        {v.docRequests.length === 0 ? <None>No documents requested.</None> : <ul className="text-sm">{v.docRequests.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-2 py-1">{d.title} <Badge tone={d.status === "verified" ? "ok" : d.status === "received" ? "warn" : "neutral"}>{d.status === "received" ? "Received — not verified" : lbl(d.status)}</Badge>{d.due_date ? `due ${d.due_date}` : ""}
          {canEdit && d.status === "requested" && <form action={A.docReceivedAction} className="flex gap-1"><Hid tx={id} req={d.id} /><Input name="file_ref" required placeholder="file / link" /><Button variant="ghost">Received</Button></form>}
          {canEdit && d.status === "received" && <form action={A.docVerifyAction} className="flex gap-1"><Hid tx={id} req={d.id} /><Input name="note" required placeholder="how verified" /><Button variant="ghost">Verify</Button></form>}</li>)}</ul>}
        {canEdit && <form action={A.docRequestAction} className="mt-2 grid gap-2 sm:grid-cols-5"><Hid tx={id} /><Input name="doc_type" required placeholder="type (title deed, OC…)" /><Input name="title" required placeholder="title" /><Input name="responsible" placeholder="responsible" /><Input type="date" name="due_date" /><Button variant="secondary">Request</Button></form>}
      </Sec>

      <Sec id="financial" n={12} title="Financial information — deposits" help="Proposed, approved, due, paid, acknowledged, refundable and refunded are separate. Due does not mean paid.">
        {v.deposits.length === 0 ? <None>No deposits recorded.</None> : <Table head={["Deposit", "Amount", "Status", "Stages", "Record"]}>{v.deposits.map((d) => <tr key={d.id}><Td>{d.deposit_type}</Td><Td>{formatINR(d.amount)}</Td><Td>{d.headline}</Td>
          <Td className="text-xs">{depositStageText(d.stages)}</Td>
          <Td>{canEdit && <form action={A.depositStageAction} className="flex flex-wrap gap-1"><Hid tx={id} deposit={d.id} /><Select name="stage">{["approved", "due", "paid", "acknowledged", "refunded"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Input type="date" name="date" required /><Input name="evidence" placeholder="payment evidence" /><Input name="receipt" placeholder="receipt ref" /><Button variant="ghost">Save</Button></form>}</Td></tr>)}</Table>}
        {canEdit && <form action={A.depositAction} className="mt-2 grid gap-2 sm:grid-cols-4"><Hid tx={id} /><Input name="type" required placeholder="security deposit" /><Input name="amount" inputMode="decimal" placeholder="amount ₹ (blank = unknown)" /><Input name="responsible" placeholder="responsible" /><Input type="date" name="due_date" /><Select name="refundable" defaultValue=""><option value="">refundable?</option><option value="yes">yes</option><option value="no">no</option></Select><Input name="conditions" placeholder="refund conditions" /><Button variant="secondary">Propose deposit</Button></form>}
      </Sec>

      <Sec id="execution" n={13} title="Execution milestones" help="Commercially agreed, legally approved, signed, executed, possession, occupied and handover are separate facts, each with its own evidence.">
        <Table head={["Milestone", "Achieved", "Expected", "Record"]}>{MILESTONE_KINDS.map((k) => { const m = v.milestoneRows.find((x) => x.kind === k); return (
          <tr key={k}><Td>{MILESTONE_LABEL[k]}</Td><Td>{m?.achieved_on ? <Badge tone="ok">{m.achieved_on}</Badge> : "No"}{m?.evidence ? <div className="text-xs text-ink-soft">{m.evidence}</div> : null}</Td><Td>{m?.expected_on ?? "—"}{m?.outstanding_conditions ? <div className="text-xs">conditions: {m.outstanding_conditions}</div> : null}</Td>
            <Td>{canEdit && <form action={A.milestoneAction} className="flex flex-wrap gap-1"><Hid tx={id} kind={k} /><Input type="date" name="expected_on" title="expected" /><Input type="date" name="achieved_on" title="achieved" /><Input name="evidence" placeholder="evidence" />{k === "executed" && <Select name="document" defaultValue=""><option value="">executed agreement…</option>{v.documents.filter((d) => d.doc_kind === "executed_agreement").map((d) => <option key={d.id} value={d.id}>{d.title} v{d.version_no}</option>)}</Select>}{k === "possession_completed" && <Input name="outstanding" placeholder="outstanding conditions" />}<Button variant="ghost">Save</Button></form>}</Td></tr>); })}</Table>
        {v.tx.lease_handoff && <p className="mt-2 text-sm">Lease Lifecycle hand-off: <Badge tone={v.tx.lease_handoff.status === "delivered" ? "ok" : "warn"}>{lbl(v.tx.lease_handoff.status)}</Badge> {v.tx.lease_handoff.reason ?? ""}{v.tx.lease_handoff.lease_id ? <> · <Link className="text-brand underline" href={`/leases/${v.tx.lease_handoff.lease_id}`}>open lease</Link></> : null}</p>}
      </Sec>

      <Sec id="possession" n={14} title="Possession and fit-out">
        {v.fitout ? <p className="text-sm">Fit-out: {v.fitout.scope ?? "scope not set"} · contractor {v.fitout.contractor ?? "—"} · {v.fitout.start_date ?? "?"} → {v.fitout.target_completion ?? "?"} · progress {v.fitout.progress_pct ?? "unknown"}% · approvals {lbl(v.fitout.approvals_status).toLowerCase()}{v.fitout.delays ? ` · delays: ${v.fitout.delays}` : ""}</p> : <None>No fit-out recorded.</None>}
        {canEdit && <form action={A.fitoutAction} className="mt-2 grid gap-2 sm:grid-cols-4"><Hid tx={id} /><Input name="scope" placeholder="scope" defaultValue={v.fitout?.scope ?? ""} /><Input name="contractor" placeholder="contractor" defaultValue={v.fitout?.contractor ?? ""} /><Input type="date" name="start" defaultValue={v.fitout?.start_date ?? ""} /><Input type="date" name="target" defaultValue={v.fitout?.target_completion ?? ""} /><Input name="progress" inputMode="decimal" placeholder="progress %" defaultValue={v.fitout?.progress_pct ?? ""} /><Input name="delays" placeholder="delays" defaultValue={v.fitout?.delays ?? ""} /><Input name="outstanding" placeholder="outstanding work" defaultValue={v.fitout?.outstanding_work ?? ""} /><Select name="approvals" defaultValue={v.fitout?.approvals_status ?? "pending"}>{["pending", "approved", "rejected"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Button variant="secondary">Save fit-out</Button></form>}
      </Sec>

      <Sec id="handover" n={15} title="Handover">
        {v.handover.length === 0 ? <None>No handover items. Generate the checklist when possession approaches.</None> : <ul className="text-sm">{v.handover.map((h) => <li key={h.id} className="flex flex-wrap items-center gap-2 py-1"><Badge tone={h.status === "open" ? "warn" : "ok"}>{lbl(h.status)}</Badge> {lbl(h.item_kind)}: {h.description}{h.resolution_deadline ? ` (by ${h.resolution_deadline})` : ""}{h.evidence ? <span className="text-xs text-ink-soft"> — {h.evidence}</span> : null}
          {canEdit && h.status === "open" && <form action={A.handoverCloseAction} className="flex gap-1"><Hid tx={id} item={h.id} /><Input name="evidence" required placeholder="evidence" /><Input name="ack" placeholder="acknowledged by" /><Button variant="ghost">Done</Button></form>}</li>)}</ul>}
        {canEdit && <div className="mt-2 flex flex-wrap gap-2"><form action={A.handoverChecklistAction}><Hid tx={id} /><Button variant="secondary">Generate checklist</Button></form>
          <form action={A.handoverItemAction} className="flex flex-wrap gap-1"><Hid tx={id} /><Select name="kind">{["defect", "incomplete_work", "observation", "checklist"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Input name="description" required placeholder="description" /><Input name="responsible" placeholder="responsible" /><Input type="date" name="deadline" /><Button variant="ghost">Add</Button></form></div>}
      </Sec>

      <Sec id="closure" n={16} title="Closure pack">
        {v.blockers.length > 0 ? <StaleBanner>Completion blocked: {v.blockers.join(" · ")}</StaleBanner> : <p className="text-sm text-ok">All closure conditions resolved.</p>}
        <ul className="text-sm">{(packs.data ?? []).map((p) => <li key={p.id}><a className="text-brand underline" href={`/transactions/${id}/closure-pack/${p.id}`}>Closure pack v{p.version_no}</a> · {String(p.created_at).slice(0, 10)}</li>)}</ul>
        {canEdit && <div className="mt-2 flex gap-2"><form action={A.closurePackAction}><Hid tx={id} /><Button variant="secondary">Generate closure pack (.docx)</Button></form>{v.tx.status !== "completed" && <form action={A.completeAction}><Hid tx={id} /><Button disabled={v.blockers.length > 0}>Mark transaction complete</Button></form>}</div>}
      </Sec>

      {hasRole(app, "admin") && !v.tx.archived_at && <MoreFields label="Archive this transaction">
        <form action={A.archiveTransactionAction} className="grid gap-2 sm:grid-cols-3"><Hid tx={id} />
          <p className="text-xs text-ink-soft sm:col-span-3">Archiving hides the transaction and its approvals from Review, Today and the menu badge. The reason is kept on the timeline and in the audit log.</p>
          <Input name="reason" required placeholder="reason (e.g. test record, client withdrew)" className="sm:col-span-2" /><Button variant="secondary">Archive</Button></form>
      </MoreFields>}

      <section id="timeline"><Card title="Timeline (append-only history)">
        {v.events.length === 0 ? <EmptyState title="No history yet" /> : <ol className="space-y-1 text-sm">{[...v.events].reverse().slice(0, 100).map((e) => <li key={e.id}><span className="text-xs text-ink-soft">{String(e.occurred_at).slice(0, 16).replace("T", " ")}</span> {plainSummary(e.summary)}</li>)}</ol>}
      </Card></section>
    </div>
  );
}

function DocRow({ d, tx, canEdit }: { d: Record<string, any>; tx: string; canEdit: boolean }) {
  const mm = (d.reconciliation ?? []).filter((r: { status: string }) => r.status !== "match");
  return (
    <div className="border-b border-line py-2 text-sm">
      <b>{d.title} v{d.version_no}</b> <Badge>{lbl(d.doc_kind)}</Badge> <Badge tone={d.status === "superseded" ? "neutral" : "brand"}>{lbl(d.status)}</Badge> <Badge>{lbl(d.signing_status)}</Badge>
      {d.diff_report && <div className="text-xs">vs previous: {d.diff_report.summary.added} added, {d.diff_report.summary.removed} removed, {d.diff_report.summary.modified} modified; dates changed in {d.diff_report.summary.datesChanged}, financial terms in {d.diff_report.summary.financialChanged}</div>}
      {mm.length > 0 && <div className="text-xs text-warn">Differs from agreed terms: {mm.map((r: { label: string; agreed: string; document: string | null }) => `${r.label} agreed ${r.agreed} / document ${r.document ?? "not found"}`).join("; ")}</div>}
      {d.diff_report && <details className="text-xs"><summary className="cursor-pointer">Clause changes</summary>{d.diff_report.changes.map((c: { key: string; change: string; heading: string; before: string | null; after: string | null }) => <div key={`${c.key}${c.change}`} className="mt-1"><b>{c.change} {c.key}</b> {c.heading}{c.before ? <div className="text-bad">− {c.before}</div> : null}{c.after ? <div className="text-ok">+ {c.after}</div> : null}</div>)}</details>}
      {canEdit && d.status !== "superseded" && <form action={A.documentStatusAction} className="mt-1 flex flex-wrap gap-1"><input type="hidden" name="tx" value={tx} /><input type="hidden" name="doc" value={d.id} /><Select name="status" defaultValue={d.status}>{["draft", "submitted", "client_review", "counterparty_review", "agreed", "signed", "executed"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Select name="signing" defaultValue={d.signing_status}>{["unsigned", "partially_signed", "signed"].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select><Button variant="ghost">Save</Button></form>}
    </div>
  );
}

function DocForm({ tx, kinds, section }: { tx: string; kinds: string[]; section: string }) {
  return (
    <details className="mt-2"><summary className="cursor-pointer text-sm font-medium">Add a version</summary>
      <form action={A.documentAction} className="mt-2 grid gap-2"><input type="hidden" name="tx" value={tx} /><input type="hidden" name="section" value={section} />
        <Select name="doc_kind">{kinds.map((k) => <option key={k} value={k}>{lbl(k)}</option>)}</Select><Input name="title" required placeholder="title (same title = same document family)" /><Input name="file_ref" placeholder="file / link (optional)" />
        <Textarea name="body" rows={6} required placeholder="Paste the document text (numbered clauses compare best)" /><Button variant="secondary">Save version</Button></form></details>
  );
}
