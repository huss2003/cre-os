import { z } from "zod";
import { callStructured } from "@/lib/ai/gateway";
import { localDate } from "@/lib/util/time";
import { TxError, q, type TxCtx } from "./ctx";
import { record } from "./events";
import { extractTerms } from "./documents";
import { AGREED_STATUSES, isOpenIssue } from "./model";
import { addDocumentVersion, createIssue, createOffer, getTransaction, listOffers, listPoints, recordInspection } from "./service";
import { commandView } from "./command";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB rows are untyped here
type Row = any;

// ================================================================================================ Module 10 input engine
const IntakeSchema = z.object({
  terms: z.record(z.string(), z.string().nullable()),
  offeringParty: z.enum(["client", "landlord", "developer", "operator", "adviser", "other"]).nullable(),
  validUntil: z.string().nullable(),
  findings: z.string().nullable(),
  questions: z.array(z.string()),
});

/**
 * Proposals / LOIs / drafts / reports → extracted data held for human review (tx_intake). The document text is untrusted
 * evidence (S7). Mock mode = deterministic pattern extraction. Nothing becomes an offer or document version until accepted.
 */
export async function intakeDocument(ctx: TxCtx, txId: string, i: { kind: string; text: string; sourceRef?: string }) {
  await getTransaction(ctx, txId);
  const mockTerms = extractTerms(i.text);
  const r = await callStructured({
    workspaceId: ctx.workspaceId, workflow: "transactions.intake", tier: "luna", schema: IntakeSchema, schemaName: "tx_intake",
    system: "Extract commercial real-estate terms exactly as stated. Unknown → null. Never compute or infer figures. Durations in months, rates in ₹/SF/month.",
    input: `Document kind: ${i.kind}. Return terms keyed by: areaSf, rentPerSf, camPerSf, depositMonths, rentFreeMonths, escalationPct, lockInMonths, tenureMonths, fitoutContribution, possessionDate.`,
    evidence: i.text,
    mock: () => ({ terms: mockTerms as Record<string, string | null>, offeringParty: (/landlord|lessor/i.test(i.text) ? "landlord" : /operator/i.test(i.text) ? "operator" : null) as "landlord" | "operator" | null, validUntil: /valid (?:until|till) (\d{4}-\d{2}-\d{2})/i.exec(i.text)?.[1] ?? null, findings: null, questions: [] as string[] }),
  });
  const row = await q(ctx.db.from("tx_intake").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, intake_kind: i.kind, source_ref: i.sourceRef ?? null, evidence_text: i.text, extracted: r.data, mocked: r.mocked }).select().single(), "intake");
  await record(ctx, txId, { kind: "intake", summary: `${i.kind.replace(/_/g, " ")} received for review (${Object.keys(r.data.terms).length} terms extracted)`, subjectType: "tx_intake", subjectId: row.id, source: "input_engine" });
  return row as Row;
}

/** Reviewer accepts (optionally with corrected terms) → creates the right record; extraction alone never does. */
export async function acceptIntake(ctx: TxCtx, intakeId: string, edits: { terms?: Record<string, string | null>; offeringParty?: string; receivingParty?: string; title?: string; parentOfferId?: string | null; reason?: string } = {}) {
  const it = await q(ctx.db.from("tx_intake").select("*").eq("workspace_id", ctx.workspaceId).eq("id", intakeId).maybeSingle(), "intake");
  if (!it) throw new TxError(404, "intake not found");
  if (it.status !== "pending_review") throw new TxError(409, "already reviewed");
  const terms = { ...(it.extracted?.terms ?? {}), ...(edits.terms ?? {}) };
  let created: { type: string; id: string };
  if (["proposal", "counteroffer"].includes(it.intake_kind)) {
    const party = edits.offeringParty ?? it.extracted?.offeringParty;
    if (!party) throw new TxError(400, "who made this offer? (offering party not stated in the document)");
    const o = await createOffer(ctx, it.transaction_id, { offeringParty: party, receivingParty: edits.receivingParty ?? "client", offerDate: localDate(new Date()), validUntil: it.extracted?.validUntil ?? null, terms, parentOfferId: edits.parentOfferId ?? null, kind: edits.parentOfferId ? "counteroffer" : "offer", reason: edits.reason ?? (edits.parentOfferId ? "counteroffer received" : null), sourceDocument: it.source_ref ?? `intake ${intakeId}` });
    created = { type: "tx_offer", id: o.id };
  } else if (["loi", "term_sheet", "agreement_draft", "executed_agreement", "handover_document"].includes(it.intake_kind)) {
    const kind = it.intake_kind === "agreement_draft" ? "agreement" : it.intake_kind === "handover_document" ? "handover" : it.intake_kind;
    const d = await addDocumentVersion(ctx, it.transaction_id, { docKind: kind as any, title: edits.title ?? it.source_ref ?? kind, body: it.evidence_text, source: `intake ${intakeId}` });
    created = { type: "tx_document", id: d.id };
  } else {
    const ins = await recordInspection(ctx, it.transaction_id, { date: localDate(new Date()), type: it.intake_kind.replace(/_/g, " "), findings: it.extracted?.findings ?? it.evidence_text.slice(0, 2000), reportRef: it.source_ref ?? undefined });
    created = { type: "tx_inspection", id: ins.id };
  }
  await q(ctx.db.from("tx_intake").update({ status: "accepted", created_record_type: created.type, created_record_id: created.id, reviewed_by: ctx.userId, reviewed_at: new Date().toISOString() }).eq("id", intakeId), "intake");
  return created;
}

export async function rejectIntake(ctx: TxCtx, intakeId: string) {
  return q(ctx.db.from("tx_intake").update({ status: "rejected", reviewed_by: ctx.userId, reviewed_at: new Date().toISOString() }).eq("workspace_id", ctx.workspaceId).eq("id", intakeId).select().single(), "intake");
}

// ================================================================================================ Module 7 meetings
/** Context before a negotiation meeting — straight from the records. */
export async function meetingContext(ctx: TxCtx, txId: string) {
  const v = await commandView(ctx, txId);
  return {
    transaction: `${v.tx.name} (${v.tx.code}) — ${v.typeLabel}, stage ${v.currentStage?.title ?? "—"}`,
    latestOffer: v.negotiation.latestOffer ? { version: v.negotiation.latestOffer.version_no, party: v.negotiation.latestOffer.offering_party, terms: v.negotiation.latestOffer.terms } : null,
    agreed: v.negotiation.agreed.map((p) => `${p.label}: ${p.value}`), open: v.negotiation.disputed.concat(v.negotiation.proposed).map((p) => `${p.label}: ${p.value} (${p.status})`),
    openIssues: v.issues.open.map((i) => `${i.title} — next: ${i.next_action}`), pendingApprovals: v.pendingApprovals.map((a) => `${a.category}: ${a.version_label}`),
  };
}

/** Meeting decisions/commitments → timeline + issues (each commitment gets an owner and a next action). Decisions are recorded, not applied to terms. */
export async function recordMeetingOutcome(ctx: TxCtx, txId: string, m: { meetingId?: string | null; decisions: string[]; commitments: { action: string; ownerUserId: string; dueDate?: string | null; responsibleParty?: string }[] }) {
  for (const d of m.decisions) await record(ctx, txId, { kind: "meeting_decision", summary: `Meeting decision: ${d}`, subjectType: m.meetingId ? "meeting_visit" : "tx_transaction", subjectId: m.meetingId ?? txId, source: "meetings" });
  const issues = [];
  for (const c of m.commitments) issues.push(await createIssue(ctx, txId, { title: `Meeting commitment: ${c.action}`, category: "other", ownerUserId: c.ownerUserId, nextAction: c.action, dueDate: c.dueDate ?? null, noDueReason: c.dueDate ? null : "no date agreed in the meeting", responsibleParty: c.responsibleParty }));
  return { decisions: m.decisions.length, issues };
}

// ================================================================================================ Module 13 intelligence memory
export async function relationshipContext(ctx: TxCtx, txId: string) {
  const tx = await getTransaction(ctx, txId);
  const prior = tx.client_org_id ? await q<Row[]>(ctx.db.from("tx_transaction").select("id, code, name, tx_type, status, completed_at").eq("workspace_id", ctx.workspaceId).eq("client_org_id", tx.client_org_id).neq("id", txId).limit(20), "prior") : [];
  const priorIds = prior.map((p) => p.id);
  const priorTerms = priorIds.length ? await q<Row[]>(ctx.db.from("tx_commercial_point").select("transaction_id, label, value, status").in("transaction_id", priorIds).is("superseded_at", null).in("status", AGREED_STATUSES), "prior terms") : [];
  const objections = tx.requirement_id || tx.opportunity_id ? await q<Row[]>(ctx.db.from("objection_log").select("category, objection, response, outcome, raised_on").eq("workspace_id", ctx.workspaceId)
    .or([tx.requirement_id ? `requirement_id.eq.${tx.requirement_id}` : null, tx.opportunity_id ? `opportunity_id.eq.${tx.opportunity_id}` : null].filter(Boolean).join(",")).limit(50), "objections") : [];
  const decisions = tx.requirement_id ? await q<Row[]>(ctx.db.from("decision_log").select("decided_on, decision, rationale").eq("workspace_id", ctx.workspaceId).eq("requirement_id", tx.requirement_id).limit(50), "decisions") : [];
  return { previousTransactions: prior, previousAgreedTerms: priorTerms, previousObjections: objections, decisions };
}

// ================================================================================================ Module 14 property supply
/** Matching / alternative properties from the requirement's latest shortlist (read-only; Module 14 owns matching). */
export async function supplyOptions(ctx: TxCtx, txId: string) {
  const tx = await getTransaction(ctx, txId);
  if (!tx.requirement_id) return { requirementLinked: false, options: [] as Row[] };
  const opts = await q<Row[]>(ctx.db.from("shortlist_option").select("id, space_id, asset_id, version, eligible, fit_score, completeness_score, option_status").eq("workspace_id", ctx.workspaceId).eq("requirement_id", tx.requirement_id).order("version", { ascending: false }).order("fit_score", { ascending: false }).limit(30), "shortlist");
  const latest = opts.length ? Math.max(...opts.map((o) => o.version)) : 0;
  const quotes = await q<Row[]>(ctx.db.from("quote").select("id, space_id, version, valid_until, superseded_by").eq("workspace_id", ctx.workspaceId).eq("requirement_id", tx.requirement_id).is("superseded_by", null), "quotes");
  const cur = opts.filter((o) => o.version === latest);
  const labels = await spaceLabels(ctx, cur.map((o) => o.space_id).filter(Boolean), cur.map((o) => o.asset_id).filter(Boolean));
  return { requirementLinked: true, options: cur.map((o) => ({ ...o, label: labels.get(o.space_id) ?? labels.get(o.asset_id) ?? "Unnamed space", inTransaction: (tx.space_ids ?? []).includes(o.space_id), quote: quotes.find((qq) => qq.space_id === o.space_id) ?? null })) };
}

/** B8: "Tower A, floor 13, unit 1301" for spaces (and building names for asset-only options). Never ids. */
export function spaceLabel(assetName: string | null | undefined, floor: string | null | undefined, unit: string | null | undefined): string {
  const f = floor ? (/^floors?\b/i.test(floor.trim()) ? floor.trim() : `floor ${floor.trim()}`) : null;
  return [assetName ?? "Unknown building", f, unit ? `unit ${unit}` : null].filter(Boolean).join(", ");
}
async function spaceLabels(ctx: TxCtx, spaceIds: string[], assetIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const spaces = spaceIds.length ? ((await ctx.db.from("space").select("id, asset_id, floor_text, unit").eq("workspace_id", ctx.workspaceId).in("id", spaceIds)).data ?? []) as Row[] : [];
  const aIds = [...new Set([...assetIds, ...spaces.map((s) => s.asset_id).filter(Boolean)])];
  const assets = aIds.length ? ((await ctx.db.from("asset").select("id, name").eq("workspace_id", ctx.workspaceId).in("id", aIds)).data ?? []) as Row[] : [];
  const an = new Map(assets.map((a) => [a.id, a.name as string]));
  for (const a of assets) out.set(a.id, a.name);
  for (const s of spaces) out.set(s.id, spaceLabel(an.get(s.asset_id), s.floor_text, s.unit));
  return out;
}

// ================================================================================================ Module 12 assistant (grounded answers)
export const ASSISTANT_QUESTIONS = ["blocking", "latest_agreed_rent", "unresolved_terms", "last_landlord_counteroffer", "pending_approvals", "outstanding_documents", "next_action", "responsible_stakeholder", "agreement_changes", "before_possession"] as const;
export type AssistantQuestion = (typeof ASSISTANT_QUESTIONS)[number];

/** Answers only from records; "not recorded" when there is nothing — never an invented outcome or approval. */
export async function answer(ctx: TxCtx, txId: string, question: AssistantQuestion): Promise<{ answer: string; facts: unknown[] }> {
  const v = await commandView(ctx, txId);
  switch (question) {
    case "blocking": return { answer: v.blockingNow.length ? v.blockingNow.join("; ") : "Nothing recorded as blocking.", facts: v.blockingNow };
    case "latest_agreed_rent": {
      const p = v.negotiation.agreed.find((x) => x.term_key === "rentPerSf");
      return { answer: p ? `₹${p.value}/SF/month (${p.status.replace(/_/g, " ")}; evidence: ${p.agreed_evidence ?? "—"})` : "No rent has been agreed yet.", facts: p ? [p] : [] };
    }
    case "unresolved_terms": { const u = v.points.filter((p) => !AGREED_STATUSES.includes(p.status)); return { answer: u.length ? u.map((p) => `${p.label}: ${p.value ?? "unknown"} (${p.status})`).join("; ") : "No unresolved commercial points recorded.", facts: u }; }
    case "last_landlord_counteroffer": {
      const o = [...(await listOffers(ctx, txId))].reverse().find((x) => ["landlord", "developer", "operator"].includes(x.offering_party));
      return { answer: o ? `v${o.version_no} (${o.kind}) on ${o.offer_date}: ${Object.entries(o.terms).map(([k, val]) => `${k}=${val}`).join(", ")}; response ${o.response_status}` : "No landlord/operator offer recorded.", facts: o ? [o] : [] };
    }
    case "pending_approvals": return { answer: v.pendingApprovals.length ? v.pendingApprovals.map((a) => `${a.category}: ${a.version_label} (${a.status})`).join("; ") : "No approvals pending.", facts: v.pendingApprovals };
    case "outstanding_documents": return { answer: v.outstandingDocuments.length ? v.outstandingDocuments.map((d) => `${d.title} (${d.status})`).join("; ") : "No outstanding document requests.", facts: v.outstandingDocuments };
    case "next_action": return { answer: v.nextActions[0] ? `${v.nextActions[0].what} — ${v.nextActions[0].why}${v.nextActions[0].due ? ` (due ${v.nextActions[0].due})` : ""}` : "No next action recorded.", facts: v.nextActions.slice(0, 5) };
    case "responsible_stakeholder": {
      const r = v.issues.open.map((i) => ({ issue: i.title, owner: i.internal_owner_user_id, stakeholder: v.stakeholders.find((s) => s.id === i.stakeholder_id)?.name ?? i.responsible_party ?? "—" }));
      return { answer: r.length ? r.map((x) => `${x.issue}: ${x.stakeholder}`).join("; ") : "No open issues with an assigned stakeholder.", facts: r };
    }
    case "agreement_changes": {
      const d = [...v.documents].reverse().find((x) => x.family === "agreement" && x.diff_report);
      if (!d) return { answer: "No later agreement version to compare.", facts: [] };
      const s = d.diff_report.summary; const mm = (d.reconciliation ?? []).filter((r: Row) => r.status !== "match");
      return { answer: `${d.title} v${d.version_no}: ${s.added} added, ${s.removed} removed, ${s.modified} modified clauses; ${mm.length} difference(s) from agreed terms${mm.length ? ` (${mm.map((x: Row) => x.label).join(", ")})` : ""}.`, facts: [d.diff_report, mm] };
    }
    case "before_possession": {
      const items = [...v.milestones.filter((m) => !m.achieved && ["executed", "signed", "legally_approved"].includes(m.kind)).map((m) => `${m.label} not achieved`),
        ...v.milestoneRows.filter((m) => m.kind === "possession_completed" && m.outstanding_conditions).map((m) => `Conditions: ${m.outstanding_conditions}`),
        ...v.deposits.filter((d) => !d.paid_on && d.due_date).map((d) => `Deposit ${d.deposit_type} not paid`), ...v.issues.open.filter((i) => i.category === "possession").map((i) => i.title)];
      return { answer: items.length ? items.join("; ") : "Nothing recorded as outstanding before possession.", facts: items };
    }
  }
}

export { isOpenIssue, listPoints };

// ================================================================================================ W6 revised quotation
/**
 * Orchestrator consumer for `commercial.quote_received` (master spec W6 steps 10–11, 6.4): open transactions on the same
 * requirement or space get a reassessment mark, a timeline entry and an owner notification. Agreed terms are never
 * touched — the adviser decides whether the new quote matters. Admin client; explicit workspace filters (S2).
 */
export async function flagTransactionsForQuote(db: TxCtx["db"], ws: string, e: { id: string; subject_id: string | null }) {
  if (!e.subject_id) return { status: "skipped" as const, detail: "No quote on the event." };
  const { data: qt } = await db.from("quote").select("id, requirement_id, space_id").eq("workspace_id", ws).eq("id", e.subject_id).maybeSingle();
  if (!qt) return { status: "skipped" as const, detail: "Quote not found." };
  let txq = db.from("tx_transaction").select("id, code, owner_user_id, requirement_id, space_ids").eq("workspace_id", ws).eq("status", "active").is("archived_at", null).limit(50);
  const ors = [qt.requirement_id ? `requirement_id.eq.${qt.requirement_id}` : null, qt.space_id ? `space_ids.cs.{${qt.space_id}}` : null].filter(Boolean) as string[];
  if (!ors.length) return { status: "skipped" as const, detail: "Quote is not linked to a requirement or space." };
  txq = txq.or(ors.join(","));
  const { data: txs, error } = await txq;
  if (error) throw new Error(error.message);
  if (!txs?.length) return { status: "skipped" as const, detail: "No open transaction on this requirement or space." };
  const { markEntity } = await import("@/modules/orchestrator/reassess/marks");
  const { notifyUser } = await import("@/modules/orchestrator/notify/service");
  for (const t of txs as Row[]) {
    const reason = `A new/revised quotation was received for ${qt.space_id && (t.space_ids ?? []).includes(qt.space_id) ? "a space" : "the requirement"} in this transaction — check whether the commercial position is affected (agreed terms unchanged).`;
    await markEntity(db as never, ws, { entityType: "tx_transaction", entityId: t.id, mark: "review", reason, causeType: "quote", causeId: qt.id, eventId: e.id, dedupeKey: `quote:${qt.id}:tx:${t.id}`, owner: t.owner_user_id });
    const { data: seen } = await db.from("tx_event").select("id").eq("workspace_id", ws).eq("transaction_id", t.id).eq("subject_id", qt.id).eq("kind", "quote_received").limit(1);
    if (!seen?.length) await record({ db, workspaceId: ws }, t.id, { kind: "quote_received", summary: "Revised quotation received — reassess the commercial position", subjectType: "quote", subjectId: qt.id, source: "orchestrator" });
    if (t.owner_user_id) await notifyUser(db as never, ws, { userId: t.owner_user_id, category: "transaction", eventKey: `evt:${e.id}:tx:${t.id}`, title: `${t.code}: revised quotation received`, body: reason, record: { type: "tx_transaction", id: t.id }, href: `/transactions/${t.id}` });
  }
  return { status: "done" as const, detail: `${txs.length} transaction(s) flagged for reassessment.` };
}

/**
 * Requirement changed (commercial.requirement_changed) → open transactions on that requirement are marked for review,
 * get a timeline entry and the owner is notified. Agreed terms are never changed (spec 6.3; same pattern as quotes).
 */
export async function flagTransactionsForRequirement(db: TxCtx["db"], ws: string, e: { id: string; subject_id: string | null; payload?: Record<string, unknown> | null }) {
  if (!e.subject_id) return { status: "skipped" as const, detail: "No requirement on the event." };
  const { data: rq } = await db.from("requirement").select("id, title").eq("workspace_id", ws).eq("id", e.subject_id).maybeSingle();
  if (!rq) return { status: "skipped" as const, detail: "Requirement not found." };
  const { data: txs, error } = await db.from("tx_transaction").select("id, code, owner_user_id").eq("workspace_id", ws).eq("requirement_id", rq.id).eq("status", "active").is("archived_at", null).order("id").limit(50);
  if (error) throw new Error(error.message);
  if (!txs?.length) return { status: "skipped" as const, detail: "No open transaction on this requirement." };
  const changed = Object.keys(((e.payload ?? {}) as { changed?: Record<string, unknown> }).changed ?? {});
  const what = changed.length ? ` (${changed.slice(0, 5).map((k) => k.replace(/_/g, " ")).join(", ")})` : "";
  const { markEntity } = await import("@/modules/orchestrator/reassess/marks");
  const { notifyUser } = await import("@/modules/orchestrator/notify/service");
  for (const t of txs as Row[]) {
    const reason = `The client requirement “${rq.title ?? "requirement"}” changed${what} — check whether this transaction is still aligned (agreed terms unchanged).`;
    await markEntity(db as never, ws, { entityType: "tx_transaction", entityId: t.id, mark: "review", reason, causeType: "requirement", causeId: rq.id, eventId: e.id, dedupeKey: `requirement:${e.id}:tx:${t.id}`, owner: t.owner_user_id });
    const { data: seen } = await db.from("tx_event").select("id").eq("workspace_id", ws).eq("transaction_id", t.id).eq("kind", "requirement_changed").contains("payload", { event_id: e.id }).limit(1);
    if (!seen?.length) await record({ db, workspaceId: ws }, t.id, { kind: "requirement_changed", summary: `Requirement changed${what} — reassess alignment`, subjectType: "requirement", subjectId: rq.id, source: "orchestrator", payload: { event_id: e.id } });
    if (t.owner_user_id) await notifyUser(db as never, ws, { userId: t.owner_user_id, category: "transaction", eventKey: `evt:${e.id}:tx:${t.id}`, title: `${t.code}: client requirement changed`, body: reason, record: { type: "tx_transaction", id: t.id }, href: `/transactions/${t.id}` });
  }
  return { status: "done" as const, detail: `${txs.length} transaction(s) flagged for reassessment.` };
}
