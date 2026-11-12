"use server";
/** Module 16 server actions. Plain form posts; result shown via ?ok= / ?err= on the transaction page. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import type { TxCtx } from "./ctx";
import * as S from "./service";
import { generateClosurePack } from "./closure-pack";
import { acceptIntake, intakeDocument, rejectIntake } from "./integrations";
import { OFFER_TERM_FIELDS } from "./model";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const n = (f: FormData, k: string) => (s(f, k) === "" ? null : s(f, k));
async function ctx(): Promise<TxCtx> { const a = await requireContext("editor"); return { db: a.db, workspaceId: a.workspaceId!, userId: a.userId }; }

async function run(txId: string, section: string, fn: (c: TxCtx) => Promise<unknown>, ok: string) {
  let msg: string;
  try { await fn(await ctx()); msg = `ok=${encodeURIComponent(ok)}`; }
  catch (e) { msg = `err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`; }
  revalidatePath(`/transactions/${txId}`);
  redirect(`/transactions/${txId}?${msg}#${section}`);
}

export async function createTransactionAction(f: FormData) {
  let id = ""; let err = "";
  try {
    const tx = await S.createTransaction(await ctx(), {
      name: s(f, "name"), txType: s(f, "tx_type"), requirementId: n(f, "requirement_id"), opportunityId: n(f, "opportunity_id"), priority: s(f, "priority") || "normal",
      propertyLabels: s(f, "properties").split(",").map((x) => x.trim()).filter(Boolean), expectedCompletion: n(f, "expected_completion"), templateId: n(f, "template_id"),
    });
    id = tx.id;
  } catch (e) { err = e instanceof Error ? e.message : String(e); }
  if (err) redirect(`/transactions?err=${encodeURIComponent(err)}`);
  redirect(`/transactions/${id}?ok=${encodeURIComponent("Transaction created")}`);
}

export async function saveTemplateAction(f: FormData) {
  let err = "";
  try { await S.saveTemplate(await ctx(), { txType: s(f, "tx_type"), name: s(f, "name"), stages: s(f, "stages").split("\n"), isDefault: s(f, "is_default") === "on" }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  redirect(`/transactions?${err ? `err=${encodeURIComponent(err)}` : "ok=Template+saved"}`);
}

const termsFrom = (f: FormData) => Object.fromEntries(OFFER_TERM_FIELDS.map((t) => [t.key, n(f, `t_${t.key}`)]));

export async function stageAction(f: FormData) { const id = s(f, "tx"); await run(id, "overview", (c) => S.advanceStage(c, id, s(f, "stage"), s(f, "status") as "done"), "Stage updated"); }
export async function offerAction(f: FormData) {
  const id = s(f, "tx");
  await run(id, "offers", (c) => S.createOffer(c, id, { parentOfferId: n(f, "parent"), offeringParty: s(f, "offering_party"), receivingParty: s(f, "receiving_party") || "client", offerDate: s(f, "offer_date"), validUntil: n(f, "valid_until"), propertyLabel: n(f, "property"), reason: n(f, "reason"), sourceDocument: n(f, "source"), terms: termsFrom(f) }), "Offer version saved");
}
export async function respondOfferAction(f: FormData) { const id = s(f, "tx"); await run(id, "offers", (c) => S.respondToOffer(c, s(f, "offer"), s(f, "status") as "accepted", s(f, "note")), "Response recorded"); }
export async function positionAction(f: FormData) { const id = s(f, "tx"); await run(id, "requirements", (c) => S.addPosition(c, id, { kind: s(f, "kind") as "client_requirement", termKey: s(f, "term"), value: n(f, "value"), source: s(f, "source") }), "Position recorded"); }
export async function pointAction(f: FormData) { const id = s(f, "tx"); await run(id, "negotiation", (c) => S.setPointStatus(c, s(f, "point"), s(f, "status"), { evidence: n(f, "evidence") ?? undefined, documentId: n(f, "document") ?? undefined }), "Commercial point updated"); }
export async function issueAction(f: FormData) {
  const id = s(f, "tx");
  await run(id, "issues", async (c) => S.createIssue(c, id, { title: s(f, "title"), category: s(f, "category"), description: n(f, "description") ?? undefined, ownerUserId: c.userId, nextAction: s(f, "next_action"), dueDate: n(f, "due_date"), noDueReason: n(f, "no_due_reason"), stakeholderId: n(f, "stakeholder"), responsibleParty: n(f, "responsible") ?? undefined, blocking: s(f, "blocking") === "on", priority: s(f, "priority") || "normal", dependsOn: f.getAll("depends_on").map(String).filter(Boolean) }), "Issue raised");
}
export async function updateIssueAction(f: FormData) { const id = s(f, "tx"); await run(id, "issues", (c) => S.updateIssue(c, s(f, "issue"), { status: n(f, "status") ?? undefined, nextAction: n(f, "next_action") ?? undefined, resolution: n(f, "resolution") ?? undefined }), "Issue updated"); }
export async function inspectionAction(f: FormData) { const id = s(f, "tx"); await run(id, "inspections", (c) => S.recordInspection(c, id, { date: s(f, "date"), type: s(f, "type"), propertyLabel: n(f, "property") ?? undefined, participants: s(f, "participants").split(",").map((x) => x.trim()).filter(Boolean), findings: n(f, "findings") ?? undefined, outstandingConcerns: n(f, "concerns") ?? undefined, responsibleParty: n(f, "responsible") ?? undefined, reportRef: n(f, "report") ?? undefined }), "Inspection recorded"); }
export async function clarificationAction(f: FormData) { const id = s(f, "tx"); await run(id, "inspections", (c) => S.requestClarification(c, id, { topic: s(f, "topic"), question: s(f, "question"), requiredValue: n(f, "required") ?? undefined, requiredNumeric: n(f, "required_num") === null ? null : Number(s(f, "required_num")), responsibleParty: n(f, "responsible") ?? undefined }), "Clarification requested"); }
export async function clarificationResponseAction(f: FormData) { const id = s(f, "tx"); await run(id, "inspections", (c) => S.respondClarification(c, s(f, "clar"), { response: s(f, "response"), responseNumeric: n(f, "response_num") === null ? null : Number(s(f, "response_num")) }), "Response recorded"); }
export async function docRequestAction(f: FormData) { const id = s(f, "tx"); await run(id, "legal", (c) => S.requestDocument(c, id, { docType: s(f, "doc_type"), title: s(f, "title"), responsibleParty: n(f, "responsible") ?? undefined, dueDate: n(f, "due_date") }), "Document requested"); }
export async function docReceivedAction(f: FormData) { const id = s(f, "tx"); await run(id, "legal", (c) => S.markDocumentReceived(c, s(f, "req"), s(f, "file_ref")), "Marked received (not verified)"); }
export async function docVerifyAction(f: FormData) { const id = s(f, "tx"); await run(id, "legal", (c) => S.verifyDocument(c, s(f, "req"), s(f, "note")), "Document verified"); }
export async function stakeholderAction(f: FormData) { const id = s(f, "tx"); await run(id, "stakeholders", (c) => S.addStakeholder(c, id, { name: s(f, "name"), category: s(f, "category"), organisation: n(f, "organisation") ?? undefined, designation: n(f, "designation") ?? undefined, role: n(f, "role") ?? undefined, contact: n(f, "contact") ?? undefined, responsibilities: n(f, "responsibilities") ?? undefined, decisionAuthority: s(f, "authority") || "none", userId: n(f, "user_id") }), "Stakeholder added"); }
export async function stakeholderTaskAction(f: FormData) { const id = s(f, "tx"); await run(id, "stakeholders", (c) => S.assignStakeholderTask(c, id, s(f, "stakeholder"), { title: s(f, "title"), dueDate: n(f, "due_date") }), "Pending action assigned"); }
export async function documentAction(f: FormData) { const id = s(f, "tx"); await run(id, s(f, "section") || "legal", (c) => S.addDocumentVersion(c, id, { docKind: s(f, "doc_kind") as "loi", title: s(f, "title"), body: s(f, "body"), fileRef: n(f, "file_ref") ?? undefined }), "Document version saved"); }
export async function documentStatusAction(f: FormData) { const id = s(f, "tx"); await run(id, "loi", (c) => S.setDocumentStatus(c, s(f, "doc"), s(f, "status"), n(f, "signing") ?? undefined), "Document status updated"); }
export async function approvalAction(f: FormData) { const id = s(f, "tx"); await run(id, "approvals", (c) => S.requestApproval(c, id, { category: s(f, "category"), subjectType: s(f, "subject_type"), subjectId: s(f, "subject_type") === "commercial_position" ? id : s(f, "subject_id"), reviewerUserId: n(f, "reviewer") ?? c.userId, reviewerStakeholderId: n(f, "reviewer_stakeholder"), deadline: n(f, "deadline") }), "Approval requested"); }
export async function decideApprovalAction(f: FormData) { const id = s(f, "tx"); await run(id, "approvals", (c) => S.decideApproval(c, s(f, "approval"), { decision: s(f, "decision") as "approved", reviewedHash: s(f, "hash"), comments: n(f, "comments") ?? undefined }), "Decision recorded"); }
export async function externalDecisionAction(f: FormData) { const id = s(f, "tx"); await run(id, "approvals", (c) => S.recordExternalDecision(c, s(f, "approval"), { decision: s(f, "decision") as "approved", evidence: s(f, "evidence") }), "External decision recorded"); }
export async function communicationAction(f: FormData) { const id = s(f, "tx"); await run(id, "approvals", (c) => S.draftCommunication(c, id, { recipientDisplay: n(f, "to") ?? undefined, recipientAddress: n(f, "address") ?? undefined, subject: n(f, "subject") ?? undefined, body: s(f, "body") }), "Draft saved for review — send it yourself from Drafts"); }
export async function depositAction(f: FormData) { const id = s(f, "tx"); await run(id, "financial", (c) => S.recordDeposit(c, id, { depositType: s(f, "type"), amount: n(f, "amount") === null ? null : Number(s(f, "amount")), responsibleParty: n(f, "responsible") ?? undefined, dueDate: n(f, "due_date"), refundable: s(f, "refundable") === "" ? null : s(f, "refundable") === "yes", refundConditions: n(f, "conditions") ?? undefined }), "Deposit recorded"); }
export async function depositStageAction(f: FormData) { const id = s(f, "tx"); await run(id, "financial", (c) => S.updateDepositStage(c, s(f, "deposit"), s(f, "stage") as "paid", { date: s(f, "date"), evidence: n(f, "evidence") ?? undefined, receiptRef: n(f, "receipt") ?? undefined }), "Deposit stage recorded"); }
export async function milestoneAction(f: FormData) { const id = s(f, "tx"); await run(id, "execution", (c) => S.setMilestone(c, id, s(f, "kind"), { expectedOn: n(f, "expected_on") ?? undefined, achievedOn: n(f, "achieved_on") ?? undefined, evidence: n(f, "evidence") ?? undefined, documentId: n(f, "document") ?? undefined, outstandingConditions: n(f, "outstanding") ?? undefined }), "Milestone saved"); }
export async function fitoutAction(f: FormData) { const id = s(f, "tx"); await run(id, "possession", (c) => S.saveFitout(c, id, { scope: n(f, "scope"), contractor: n(f, "contractor"), start_date: n(f, "start"), target_completion: n(f, "target"), progress_pct: n(f, "progress") === null ? null : Number(s(f, "progress")), delays: n(f, "delays"), outstanding_work: n(f, "outstanding"), approvals_status: s(f, "approvals") || "pending" }), "Fit-out saved"); }
export async function handoverChecklistAction(f: FormData) { const id = s(f, "tx"); await run(id, "handover", (c) => S.generateHandoverChecklist(c, id), "Checklist generated"); }
export async function handoverItemAction(f: FormData) { const id = s(f, "tx"); await run(id, "handover", (c) => S.addHandoverItem(c, id, { kind: s(f, "kind") as "defect", description: s(f, "description"), responsibleParty: n(f, "responsible") ?? undefined, resolutionDeadline: n(f, "deadline") }), "Handover item added"); }
export async function handoverCloseAction(f: FormData) { const id = s(f, "tx"); await run(id, "handover", (c) => S.closeHandoverItem(c, s(f, "item"), s(f, "evidence"), n(f, "ack") ?? undefined), "Handover item closed"); }
export async function closurePackAction(f: FormData) { const id = s(f, "tx"); await run(id, "closure", (c) => generateClosurePack(c, id), "Closure pack generated"); }
export async function completeAction(f: FormData) { const id = s(f, "tx"); await run(id, "closure", (c) => S.completeTransaction(c, id), "Transaction completed"); }
export async function intakeAction(f: FormData) { const id = s(f, "tx"); await run(id, "offers", (c) => intakeDocument(c, id, { kind: s(f, "kind"), text: s(f, "text"), sourceRef: n(f, "source") ?? undefined }), "Received for review — check the extracted terms"); }
export async function acceptIntakeAction(f: FormData) { const id = s(f, "tx"); await run(id, "offers", (c) => acceptIntake(c, s(f, "intake"), { offeringParty: n(f, "offering_party") ?? undefined, parentOfferId: n(f, "parent"), reason: n(f, "reason") ?? undefined, title: n(f, "title") ?? undefined }), "Intake accepted"); }
export async function rejectIntakeAction(f: FormData) { const id = s(f, "tx"); await run(id, "offers", (c) => rejectIntake(c, s(f, "intake")), "Intake rejected"); }
export async function archiveTransactionAction(f: FormData) {
  const id = s(f, "tx"); let err = "";
  try { const a = await requireContext("admin"); await S.archiveTransaction({ db: a.db, workspaceId: a.workspaceId!, userId: a.userId }, id, s(f, "reason")); }
  catch (e) { err = e instanceof Error ? e.message : String(e); }
  revalidatePath("/transactions"); revalidatePath(`/transactions/${id}`);
  if (err) redirect(`/transactions/${id}?err=${encodeURIComponent(err)}`);
  redirect(`/transactions?ok=${encodeURIComponent("Transaction archived")}`);
}
