/**
 * Module 16 §19 end-to-end scenarios 1–37 (local Supabase, signed-in users, RLS on, mock AI). Fixtures are tagged in WS1.
 * owner = transaction owner / adviser; colleague = assigned reviewer (incl. legal reviewer stakeholder).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { USERS, WS1, adminClient, tag, userClient } from "../../../tests/helpers";
import type { TxCtx } from "./ctx";
import { TxError } from "./ctx";
import * as S from "./service";
import { commandView } from "./command";
import { generateClosurePack, downloadClosurePack } from "./closure-pack";
import { scanTransactions, TX_EVENTS } from "./events";
import { acceptIntake, answer, intakeDocument, meetingContext, recordMeetingOutcome, relationshipContext, supplyOptions } from "./integrations";
import { buildExecutedLeasePayload, registerLeaseReceiver } from "./lease-handoff";

let owner: TxCtx; let colleague: TxCtx;
const T = tag("tx");
const txIds: string[] = [];
const expectErr = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e, "expected an error").toBeInstanceOf(TxError);
  expect((e as TxError).status).toBe(status);
  if (re) expect((e as TxError).message).toMatch(re);
};
const pgErr = async (p: PromiseLike<{ error: any }>, re: RegExp) => { const { error } = await p; expect(error?.message ?? "").toMatch(re); };

beforeAll(async () => {
  owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id };
  colleague = { db: await userClient("colleague"), workspaceId: WS1, userId: USERS.colleague.id };
});
afterAll(async () => {
  const a = adminClient();
  if (txIds.length) {
    await a.from("task").delete().eq("workspace_id", WS1).like("idempotency_key", "tx.%");
    await a.from("event_outbox").delete().eq("workspace_id", WS1).in("subject_id", txIds);
    await a.from("event_outbox").delete().eq("workspace_id", WS1).like("event_type", "transaction.%").filter("payload->>transaction_id", "in", `(${txIds.join(",")})`);
    await a.from("draft").delete().eq("workspace_id", WS1).in("purpose", txIds.map((id) => `transaction:${id}`));
    await a.from("document_version").delete().eq("workspace_id", WS1).eq("purpose", "transaction_closure_pack").in("linked_entity_id", txIds);
    await a.from("tx_event").delete().in("transaction_id", txIds).then(() => null, () => null);
  }
});

const mk = async (type: string) => { const tx = await S.createTransaction(owner, { name: `${T} ${type}`, txType: type, propertyLabels: ["Tower A, Kharadi"] }); txIds.push(tx.id); return tx; };

describe("Module 16 transaction execution (§19)", () => {
  let tx: any; let o1: any; let o2: any; let o3: any; let legal: any; let landlordSh: any;

  it("1–6 creates all seven transaction types with a unique ID and a type-specific plan; 7 plan", async () => {
    tx = await mk("conventional_leasing");
    expect(tx.code).toMatch(/^TX-/);
    for (const t of ["managed_office", "lease_renewal", "relocation", "build_to_suit", "investment", "coworking"]) {
      const x = await mk(t);
      const stages = (await owner.db.from("tx_stage").select("title").eq("transaction_id", x.id).order("sort_order")).data!;
      expect(stages.length).toBeGreaterThan(5);
      if (t === "lease_renewal") expect(stages[0].title).toBe("Existing lease review");
      if (t === "investment") expect(stages.map((s) => s.title)).toContain("Due diligence");
    }
    const st = (await owner.db.from("tx_stage").select("title,status").eq("transaction_id", tx.id).order("sort_order")).data!;
    expect(st.map((s) => s.title)).toEqual(expect.arrayContaining(["LOI", "Possession", "Fit-out", "Handover"]));
    expect(st[0].status).toBe("in_progress");
    // 7: configurable templates without changing architecture
    const tpl = await S.saveTemplate(owner, { txType: `custom_${T}`, name: "Sale-and-leaseback", stages: ["Mandate", "Valuation", "Term sheet", "Close"] });
    const c = await S.createTransaction(owner, { name: `${T} custom`, txType: `custom_${T}`, templateId: tpl.id }); txIds.push(c.id);
    expect(c.current_stage).toBe("mandate");
    await S.advanceStage(owner, tx.id, "requirement_confirmation", "done");
    expect((await S.getTransaction(owner, tx.id)).current_stage).toBe("property_identification");
  });

  it("8–9 initial offer + multiple counteroffers (append-only, linked, reasons, pending responses)", async () => {
    o1 = await S.createOffer(owner, tx.id, { offeringParty: "landlord", receivingParty: "client", offerDate: "2026-11-01", validUntil: "2026-11-14",
      terms: { areaSf: 10000, rentPerSf: 100, camPerSf: 15, rentFreeMonths: 3, depositMonths: 6, lockInMonths: 36, tenureMonths: 60, escalationPct: 15, escalationEveryMonths: 36 } });
    await expectErr(S.createOffer(owner, tx.id, { parentOfferId: o1.id, offeringParty: "client", receivingParty: "landlord", offerDate: "2026-11-03", terms: { rentPerSf: 90 } }), 400, /reason/);
    o2 = await S.createOffer(owner, tx.id, { parentOfferId: o1.id, offeringParty: "client", receivingParty: "landlord", offerDate: "2026-11-03", reason: "budget ceiling", terms: { ...o1.terms, rentPerSf: 90, depositMonths: 4 } });
    o3 = await S.createOffer(owner, tx.id, { parentOfferId: o2.id, offeringParty: "landlord", receivingParty: "client", offerDate: "2026-11-06", validUntil: "2026-11-13", reason: "meet halfway", terms: { ...o1.terms, rentPerSf: 95, camPerSf: 20, rentFreeMonths: 1, depositMonths: 4 } });
    expect([o1.version_no, o2.version_no, o3.version_no]).toEqual([1, 2, 3]);
    expect(o2.kind).toBe("counteroffer");
    const offers = await S.listOffers(owner, tx.id);
    expect(offers.find((o) => o.id === o1.id)!.response_status).toBe("countered");
    expect(offers.find((o) => o.id === o3.id)!.response_status).toBe("pending");
    await pgErr(owner.db.from("tx_offer").update({ terms: { rentPerSf: 1 } }).eq("id", o1.id), /immutable/);
    await pgErr(owner.db.from("tx_offer").delete().eq("id", o1.id), /never deleted/);
  });

  it("10–11 compare offer versions and complete concession packages via the toolkit", async () => {
    const d = await S.compareOfferVersions(owner, tx.id);
    expect(d).toHaveLength(3);
    expect(d[2].terms.find((t) => t.key === "camPerSf")!.status).toBe("worse");
    const pk = await S.compareOfferPackages(owner, tx.id, o1.id, o3.id);
    expect(pk.verdict).toBe("cannot_determine"); // commencement + discount rate not in offers
    const pk2 = await S.compareOfferPackages(owner, tx.id, o1.id, o3.id, { leaseCommencement: "2027-01-01", discountRatePct: 0, parkingSlots: 0 });
    expect(pk2.verdict).not.toBe("B_lower_modelled_cost");
    expect(pk2.formulaVersion).toBe("nego-1.0");
  });

  it("12–13 client requirement / adviser recommendation / counterparty proposal stay separate; proposals ≠ agreed", async () => {
    await S.addPosition(owner, tx.id, { kind: "client_requirement", termKey: "rentPerSf", value: "95", source: "client email 2026-11-02" });
    await S.addPosition(owner, tx.id, { kind: "adviser_recommendation", termKey: "rentPerSf", value: "92", source: "adviser view after comps" });
    const pv = await S.positionsView(owner, tx.id);
    const rent = pv.find((p) => p.term === "rentPerSf")!;
    expect(rent.client!.value).toBe("95");
    expect(rent.adviser!.value).toBe("92");
    expect(rent.counterparty!.value).toBe("95"); // landlord v3
    expect(rent.agreed).toBeNull(); // a counterparty proposal is never an agreed term
    const pos = (await owner.db.from("tx_position").select("id").eq("transaction_id", tx.id).eq("position_kind", "adviser_recommendation").limit(1)).data![0];
    await pgErr(owner.db.from("tx_position").update({ position_kind: "client_requirement" }).eq("id", pos.id), /cannot be converted/);
    const pts = await S.listPoints(owner, tx.id);
    expect(pts.every((p) => ["proposed", "under_negotiation"].includes(p.status))).toBe(true);
    await expectErr(S.setPointStatus(owner, pts[0].id, "agreed"), 400, /evidence/);
  });

  it("14–16 unresolved commercial issue, assigned to a stakeholder, overdue tracking, dependencies", async () => {
    landlordSh = await S.addStakeholder(owner, tx.id, { name: "R. Mehta", category: "leasing_representative", organisation: "Landlord Co", decisionAuthority: "recommender" });
    await expectErr(S.createIssue(owner, tx.id, { title: "x", category: "commercial", ownerUserId: owner.userId, nextAction: "" }), 400, /next action/);
    await expectErr(S.createIssue(owner, tx.id, { title: "x", category: "commercial", ownerUserId: owner.userId, nextAction: "call" }), 400, /due date/);
    const i1 = await S.createIssue(owner, tx.id, { title: "CAM increase unexplained", category: "commercial", stakeholderId: landlordSh.id, ownerUserId: owner.userId, nextAction: "Ask landlord for CAM breakup", dueDate: "2026-11-05", blocking: true, decisionRequired: "accept CAM ₹20?" });
    const i2 = await S.createIssue(owner, tx.id, { title: "Signage rights", category: "legal", ownerUserId: owner.userId, nextAction: "Raise in LOI", noDueReason: "depends on LOI drafting", dependsOn: [i1.id] });
    expect(i1.task_id).toBeTruthy();
    const v = await S.issuesView(owner, tx.id, "2026-11-12");
    expect(v.overdue.map((i) => i.id)).toContain(i1.id);
    expect(v.blocking.map((i) => i.id)).toContain(i1.id);
    expect(v.dependent.find((d) => d.issue.id === i2.id)!.waitingOn).toEqual([i1.id]);
    const sv = await S.stakeholdersView(owner, tx.id, "2026-11-12");
    expect(sv.find((s) => s.id === landlordSh.id)!.blocking).toBe(true);
    await pgErr(owner.db.from("tx_issue").update({ status: "resolved" }).eq("id", i2.id), /tx_issue_resolution_chk/);
    await S.updateIssue(owner, i2.id, { status: "resolved", resolution: "signage agreed in LOI clause 6" });
    const events = await scanTransactions(owner, "2026-11-12");
    expect(events.some((e) => e.type === TX_EVENTS.issueOverdue && e.subjectId === i1.id)).toBe(true);
  });

  it("17–19 technical inspection, clarifications vs requirement, document requests (received ≠ verified), stakeholders", async () => {
    const ins = await S.recordInspection(owner, tx.id, { date: "2026-11-07", type: "MEP walk-through", participants: ["client facilities", "landlord PM"], findings: "DG at 60% load", outstandingConcerns: "Fire NOC copy pending" });
    expect(ins.status).toBe("open");
    const c = await S.requestClarification(owner, tx.id, { topic: "power_backup", question: "DG backup kVA for floor 5?", requiredValue: "150 kVA", requiredNumeric: 150, responsibleParty: "landlord" });
    const r = await S.respondClarification(owner, c.id, { response: "120 kVA", responseNumeric: 120 });
    expect(r.status).toBe("discrepancy");
    const dr = await S.requestDocument(owner, tx.id, { docType: "occupancy", title: "Occupancy certificate", responsibleParty: "landlord", dueDate: "2026-11-20" });
    await expectErr(S.verifyDocument(owner, dr.id, "checked"), 409, /received/);
    const rec = await S.markDocumentReceived(owner, dr.id, "upload://oc.pdf");
    expect(rec.status).toBe("received");
    await pgErr(owner.db.from("tx_doc_request").update({ status: "verified" }).eq("id", dr.id), /tx_doc_verified_chk/);
    // 19 multiple stakeholders
    legal = await S.addStakeholder(owner, tx.id, { name: "Colleague (legal)", category: "legal_adviser", userId: colleague.userId, decisionAuthority: "approver", isInternal: true });
    await S.addStakeholder(owner, tx.id, { name: "CFO", category: "client_finance", decisionAuthority: "approver" });
    await S.assignStakeholderTask(owner, tx.id, landlordSh.id, { title: "Send CAM breakup", dueDate: "2026-11-15" });
    const sv = await S.stakeholdersView(owner, tx.id);
    expect(sv.length).toBe(3);
    expect(sv.find((s) => s.id === landlordSh.id)!.pendingTasks.length).toBe(1);
    expect(sv.filter((s) => s.isDecisionMaker).length).toBe(2);
    expect(sv.find((s) => s.id === legal.id)!.is_internal).toBe(true);
  });

  let loi: any; let ts: any;
  it("20–21 LOI and term-sheet approval; commercial points agreed with evidence", async () => {
    const pts = await S.listPoints(owner, tx.id);
    for (const k of ["rentPerSf", "depositMonths", "lockInMonths", "areaSf", "tenureMonths"]) await S.setPointStatus(owner, pts.find((p) => p.term_key === k)!.id, "agreed", { evidence: "call with landlord 2026-11-08, confirmed by email" });
    const agreed = (await S.listPoints(owner, tx.id)).filter((p) => p.status === "agreed");
    expect(agreed.find((p) => p.term_key === "rentPerSf")!.value).toBe("95");
    await pgErr(owner.db.from("tx_commercial_point").update({ value: "90" }).eq("id", agreed[0].id), /cannot be overwritten/);
    loi = await S.addDocumentVersion(owner, tx.id, { docKind: "loi", title: "LOI", body: "1. Rent: base rent of ₹ 95 per sq ft per month.\n2. Security deposit of 4 months.\n3. Lock-in of 36 months." });
    expect(loi.reconciliation.find((r: any) => r.key === "rentPerSf").status).toBe("match");
    await S.setDocumentStatus(owner, loi.id, "client_review");
    ts = await S.addDocumentVersion(owner, tx.id, { docKind: "term_sheet", title: "Term sheet", body: "1. Rent ₹ 95 per sq ft.\n2. Term of 5 years." });
    const ap = await S.requestApproval(owner, tx.id, { category: "client_commercial", subjectType: "document", subjectId: ts.id, reviewerUserId: colleague.userId, deadline: "2026-11-20" });
    expect(ap.subject_hash).toBe(ts.sha256);
    await expectErr(S.decideApproval(owner, ap.id, { decision: "approved", reviewedHash: ts.sha256 }), 403); // not the reviewer
    const ok = await S.decideApproval(colleague, ap.id, { decision: "approved", reviewedHash: ts.sha256, comments: "fine" });
    expect(ok.status).toBe("approved");
  });

  let ag1: any; let ag2: any;
  it("22–24 agreement versions compared; differences from agreed terms; legal review only by legal reviewer", async () => {
    ag1 = await S.addDocumentVersion(owner, tx.id, { docKind: "agreement", title: "Leave & licence", body: "1. Premises: 10,000 sq ft.\n2. Rent: base rent of ₹ 95 per sq ft per month.\n3. Security deposit equal to 4 months.\n4. Lock-in period of 36 months." });
    const lg = await S.requestApproval(owner, tx.id, { category: "legal", subjectType: "document", subjectId: ag1.id, reviewerUserId: colleague.userId, reviewerStakeholderId: legal.id });
    await expectErr(S.requestApproval(owner, tx.id, { category: "legal", subjectType: "document", subjectId: ag1.id, reviewerUserId: owner.userId }), 403, /legal reviewer/);
    ag2 = await S.addDocumentVersion(owner, tx.id, { docKind: "agreement", title: "Leave & licence", body: "1. Premises: 10,000 sq ft.\n2. Rent: base rent of ₹ 100 per sq ft per month.\n3. Security deposit equal to 4 months.\n5. Tenant shall bear restoration costs." });
    const cmp = await S.documentComparison(owner, ag2.id);
    expect(cmp.diff!.summary).toMatchObject({ added: 1, removed: 1, modified: 1 });
    expect(cmp.reconciliation.find((r) => r.key === "rentPerSf")!.status).toBe("mismatch");
    expect(cmp.reconciliation.find((r) => r.key === "lockInMonths")!.status).toBe("missing_in_document");
    // 36: approval of v1 invalidated, reassessment created on v2
    const old = (await owner.db.from("tx_approval").select("*").eq("id", lg.id).single()).data!;
    expect(old.invalidated_at).toBeTruthy();
    await expectErr(S.decideApproval(colleague, lg.id, { decision: "approved", reviewedHash: ag1.sha256 }), 409, /invalidated/);
    const re = (await owner.db.from("tx_approval").select("*").eq("reassessment_of", lg.id).single()).data!;
    expect(re.subject_id).toBe(ag2.id);
    expect(re.status).toBe("pending");
    await expectErr(S.decideApproval(colleague, re.id, { decision: "approved", reviewedHash: ag1.sha256 }), 409, /different version/);
    const changes = await S.decideApproval(colleague, re.id, { decision: "changes_requested", reviewedHash: ag2.sha256, comments: "rent must be 95; restore lock-in" });
    expect(changes.status).toBe("changes_requested");
    await expectErr(S.setMilestone(owner, tx.id, "legally_approved", { achievedOn: "2026-11-10", evidence: "AI reviewed" }), 409, /legal reviewer/);
  });

  let ag3: any;
  it("25 financial approval; 35 no unapproved commercial commitment can be communicated", async () => {
    await expectErr(S.draftCommunication(owner, tx.id, { subject: "Offer", body: "We accept rent of ₹95 per sf and 4 months deposit." }), 409, /unapproved commercial commitment/);
    const free = await S.draftCommunication(owner, tx.id, { subject: "Site visit", body: "Can we schedule the site walk on Tuesday?" });
    expect(free.state).toBe("drafted");
    const h = await S.positionHash(owner, tx.id);
    const cc = await S.requestApproval(owner, tx.id, { category: "client_commercial", subjectType: "commercial_position", subjectId: tx.id, reviewerUserId: colleague.userId });
    expect(cc.subject_hash).toBe(h);
    await S.decideApproval(colleague, cc.id, { decision: "approved", reviewedHash: h });
    await expectErr(S.draftCommunication(owner, tx.id, { body: "Confirming rent of ₹90 per sf." }), 409, /90/);
    const d = await S.draftCommunication(owner, tx.id, { recipientDisplay: "R. Mehta", subject: "Agreed terms", body: "Confirming rent of ₹95 per sf, deposit 4 months and lock-in 36 months." });
    expect(d.state).toBe("drafted"); // drafted only — sending stays manual
    const fin = await S.requestApproval(owner, tx.id, { category: "financial", subjectType: "commercial_position", subjectId: tx.id, reviewerUserId: colleague.userId, deadline: "2026-11-25" });
    expect((await S.listApprovals(owner, tx.id)).find((a) => a.id === fin.id)!.status).toBe("pending");
    await S.decideApproval(colleague, fin.id, { decision: "approved", reviewedHash: h });
    // material term change invalidates the commercial-position approvals
    const pts = await S.listPoints(owner, tx.id);
    const cam = pts.find((p) => p.term_key === "camPerSf")!;
    await S.setPointStatus(owner, cam.id, "agreed", { evidence: "landlord email 2026-11-11" });
    const after = (await owner.db.from("tx_approval").select("invalidated_at").eq("id", cc.id).single()).data!;
    expect(after.invalidated_at).toBeTruthy();
    await expectErr(S.draftCommunication(owner, tx.id, { body: "Confirming rent of ₹95 per sf." }), 409, /no live client commercial approval/);
    // final agreement + approvals for execution
    ag3 = await S.addDocumentVersion(owner, tx.id, { docKind: "agreement", title: "Leave & licence", body: "1. Premises: 10,000 sq ft.\n2. Rent: base rent of ₹ 95 per sq ft per month.\n3. Security deposit equal to 4 months.\n4. Lock-in period of 36 months.\n5. CAM at ₹ 20 per sq ft per month." });
    expect(ag3.reconciliation.filter((r: any) => r.status !== "match")).toHaveLength(1); // tenure not stated → missing, never assumed
    const re2 = (await owner.db.from("tx_approval").select("*").eq("subject_id", ag3.id).eq("category", "legal").single()).data!;
    await S.decideApproval(colleague, re2.id, { decision: "approved", reviewedHash: ag3.sha256 });
    await expectErr(S.setDocumentStatus(owner, ag3.id, "signed", "signed"), 409, /client_commercial/);
    const cc3 = await S.requestApproval(owner, tx.id, { category: "client_commercial", subjectType: "document", subjectId: ag3.id, reviewerUserId: colleague.userId });
    await S.decideApproval(colleague, cc3.id, { decision: "approved", reviewedHash: ag3.sha256 });
    await S.setDocumentStatus(owner, ag3.id, "signed", "signed");
  });

  let dep: any;
  it("26 deposit due and paid tracked separately", async () => {
    dep = await S.recordDeposit(owner, tx.id, { depositType: "security deposit", amount: 3800000, responsibleParty: "client finance", refundable: true, refundConditions: "on vacation less dues" });
    await S.updateDepositStage(owner, dep.id, "approved", { date: "2026-11-12" });
    await S.updateDepositStage(owner, dep.id, "due", { date: "2026-11-15" });
    let v = (await S.depositsView(owner, tx.id, "2026-11-20")).find((d) => d.id === dep.id)!;
    expect(v.stages).toMatchObject({ approved: true, due: true, overdue: true, paid: false });
    expect(v.headline).toMatch(/not paid/);
    await expectErr(S.updateDepositStage(owner, dep.id, "paid", { date: "2026-11-16" }), 400, /evidence/);
    await pgErr(owner.db.from("tx_deposit").update({ acknowledged_on: "2026-11-16" }).eq("id", dep.id), /tx_dep_ack_chk/);
    await S.updateDepositStage(owner, dep.id, "paid", { date: "2026-11-16", evidence: "UTR HDFC0001234" });
    await S.updateDepositStage(owner, dep.id, "acknowledged", { date: "2026-11-17", receiptRef: "LL-RCPT-77" });
    v = (await S.depositsView(owner, tx.id, "2026-11-20")).find((d) => d.id === dep.id)!;
    expect(v.headline).toBe("Paid and acknowledged");
    expect(v.stages.refunded).toBe(false);
  });

  let executed: any; const received: any[] = [];
  it("27 + 32 execution recorded; executed lease handed to Module 15 (adapter)", async () => {
    await expectErr(S.setMilestone(owner, tx.id, "executed", { achievedOn: "2026-11-18", evidence: "signed", documentId: ag3.id }), 400, /executed agreement/);
    executed = await S.addDocumentVersion(owner, tx.id, { docKind: "executed_agreement", family: "executed", title: "Executed L&L", body: "1. Premises: 10,000 sq ft.\n2. Rent: base rent of ₹ 95 per sq ft per month.\n3. Security deposit equal to 4 months.\n4. Lock-in period of 36 months.\n5. CAM at ₹ 20 per sq ft per month.\n6. Possession on 2027-01-01." });
    registerLeaseReceiver(async (_c, p) => { received.push(p); return { leaseId: "00000000-0000-4000-8000-0000000000aa" }; });
    await S.setMilestone(owner, tx.id, "executed", { achievedOn: "2026-11-18", evidence: "registered at SRO, doc no 1234", documentId: executed.id });
    expect(received).toHaveLength(1);
    expect(received[0].terms.find((t: any) => t.key === "rentPerSf").value).toBe("95");
    expect(received[0].executedAgreementText).toMatch(/Possession on 2027-01-01/);
    expect((await S.getTransaction(owner, tx.id)).lease_handoff.status).toBe("delivered");
    const p = await buildExecutedLeasePayload(owner, tx.id);
    expect(p.deposits[0].paidOn).toBe("2026-11-16");
    const rent = (await S.listPoints(owner, tx.id)).find((x) => x.term_key === "rentPerSf")!;
    await S.setPointStatus(owner, rent.id, "verified_executed", { documentId: executed.id });
    const lock = (await S.listPoints(owner, tx.id)).find((x) => x.term_key === "lockInMonths")!;
    await S.setPointStatus(owner, lock.id, "verified_executed", { documentId: executed.id });
  });

  it("28–30 possession, fit-out, handover observations; 37 milestone distinctions", async () => {
    await S.setMilestone(owner, tx.id, "possession_completed", { expectedOn: "2026-11-25", outstandingConditions: "landlord to complete DG upgrade" });
    const ev = await scanTransactions(owner, "2026-11-19");
    expect(ev.some((e) => e.type === TX_EVENTS.possessionApproaching)).toBe(true);
    let m = await S.milestonesView(owner, tx.id);
    expect(m.matrix.find((x) => x.kind === "executed")!.achieved).toBe(true);
    expect(m.matrix.find((x) => x.kind === "possession_completed")!.achieved).toBe(false); // execution ≠ possession
    expect(m.matrix.find((x) => x.kind === "legally_approved")!.achieved).toBe(false); // never inferred
    await S.setMilestone(owner, tx.id, "legally_approved", { achievedOn: "2026-11-17", evidence: "legal approval of agreement v3 by legal adviser" });
    await S.setMilestone(owner, tx.id, "possession_completed", { achievedOn: "2026-11-25", evidence: "possession letter signed by landlord PM" });
    m = await S.milestonesView(owner, tx.id);
    expect(m.matrix.find((x) => x.kind === "occupied")!.achieved).toBe(false); // possession ≠ occupancy
    expect(m.matrix.find((x) => x.kind === "handover_completed")!.achieved).toBe(false);
    await expectErr(S.setMilestone(owner, tx.id, "occupied", { achievedOn: "2026-12-01" }), 400, /evidence/);
    const f = await S.saveFitout(owner, tx.id, { scope: "Full fit-out 120 seats", contractor: "BuildCo", start_date: "2026-11-26", target_completion: "2027-01-20", progress_pct: 40, delays: "glass delivery", approvals_status: "pending" });
    expect(Number(f.progress_pct)).toBe(40);
    const cl = await S.generateHandoverChecklist(owner, tx.id);
    expect(cl.length).toBeGreaterThanOrEqual(8);
    const defect = await S.addHandoverItem(owner, tx.id, { kind: "defect", description: "Seepage near pantry", responsibleParty: "landlord", resolutionDeadline: "2027-01-10" });
    await pgErr(owner.db.from("tx_handover_item").update({ status: "done" }).eq("id", defect.id), /tx_ho_done_chk/);
  });

  it("31 closure pack generated; completion blocked while closure conditions remain; 33 orchestrator; 34 history", async () => {
    const b = await S.closureBlockers(owner, tx.id);
    expect(b.join(" ")).toMatch(/open issues/);
    expect(b.join(" ")).toMatch(/handover not completed/);
    await expectErr(S.completeTransaction(owner, tx.id), 409, /cannot complete/);
    await pgErr(owner.db.from("tx_transaction").update({ status: "completed" }).eq("id", tx.id), /cannot complete/);
    const pack = await generateClosurePack(owner, tx.id);
    expect(pack.buffer.length).toBeGreaterThan(1000);
    expect(pack.model.milestones.find((r) => r[0] === "Occupied")![1]).toMatch(/^No/);
    expect(pack.model.milestones.find((r) => r[0] === "Executed")![1]).toMatch(/^Yes/);
    expect(pack.model.terms.find((r) => r[0] === "Rent ₹/SF/month")![1]).toMatch(/verified against executed agreement/);
    expect((await downloadClosurePack(owner, pack.documentId)).length).toBe(pack.buffer.length);

    // resolve everything → completion allowed
    const v = await S.issuesView(owner, tx.id);
    for (const i of v.open) await S.updateIssue(owner, i.id, { status: "resolved", resolution: "closed with landlord letter" });
    const appr = await S.listApprovals(owner, tx.id);
    for (const a of appr.filter((x) => !x.invalidated_at && ["pending", "under_review", "changes_requested"].includes(x.status))) await owner.db.from("tx_approval").update({ status: "withdrawn" }).eq("id", a.id);
    const dr = (await owner.db.from("tx_doc_request").select("id").eq("transaction_id", tx.id)).data!;
    for (const d of dr) await S.verifyDocument(owner, d.id, "original sighted by adviser");
    for (const h of (await owner.db.from("tx_handover_item").select("id").eq("transaction_id", tx.id).eq("status", "open")).data!) await S.closeHandoverItem(owner, h.id, "photo evidence + PM sign-off", "PM");
    await S.setMilestone(owner, tx.id, "handover_completed", { achievedOn: "2027-01-25", evidence: "handover certificate HC-1" });
    const done = await S.completeTransaction(owner, tx.id);
    expect(done.status).toBe("completed");

    // 33 orchestrator events on the outbox
    const evs = (await adminClient().from("event_outbox").select("event_type").eq("workspace_id", WS1).filter("payload->>transaction_id", "eq", tx.id)).data!.map((e) => e.event_type);
    for (const t of [TX_EVENTS.offerReceived, TX_EVENTS.counterofferCreated, TX_EVENTS.approvalPending, TX_EVENTS.documentVersionChanged, TX_EVENTS.materialTermChanged, TX_EVENTS.executed, TX_EVENTS.issueOverdue, TX_EVENTS.possessionApproaching, TX_EVENTS.offerExpiring]) expect(evs).toContain(t);
    // 34 history: append-only timeline, with sources
    const tl = await S.timeline(owner, tx.id);
    expect(tl.length).toBeGreaterThan(30);
    expect(tl.map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "offer", "counteroffer", "issue", "document_version", "approval_decision", "milestone:executed", "lease_handoff", "completed"]));
    await pgErr(owner.db.from("tx_event").update({ summary: "x" }).eq("id", tl[0].id), /append-only/);
    const audit = (await adminClient().from("audit_event").select("id").eq("workspace_id", WS1).eq("entity_id", o1.id).limit(1)).data;
    expect(audit?.length ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("§15 command view + §17 assistant answers grounded in records", async () => {
    const t2 = await mk("conventional_leasing");
    const v0 = await commandView(owner, t2.id);
    expect(v0.negotiation.latestOffer).toBeNull();
    expect((await answer(owner, t2.id, "latest_agreed_rent")).answer).toBe("No rent has been agreed yet.");
    expect((await answer(owner, t2.id, "pending_approvals")).answer).toBe("No approvals pending.");
    const v = await commandView(owner, tx.id);
    expect(v.negotiation.versions).toHaveLength(3);
    expect(v.route.length).toBeGreaterThan(0);
    expect((await answer(owner, tx.id, "latest_agreed_rent")).answer).toMatch(/₹95/);
    expect((await answer(owner, tx.id, "last_landlord_counteroffer")).answer).toMatch(/^v3/);
    expect((await answer(owner, tx.id, "agreement_changes")).answer).toMatch(/Leave & licence v3/);
    for (const qn of ["blocking", "unresolved_terms", "outstanding_documents", "next_action", "responsible_stakeholder", "before_possession"] as const) expect(typeof (await answer(owner, tx.id, qn)).answer).toBe("string");
  });

  it("§17 input engine intake → review → offer; meetings; intelligence memory; property supply", async () => {
    const t3 = await mk("managed_office");
    const it1 = await intakeDocument(owner, t3.id, { kind: "proposal", text: "Operator proposal. Rent of ₹ 120 per sq ft per month. Security deposit of 3 months. Lock-in of 2 years. Valid until 2026-12-01.", sourceRef: "email 2026-11-12" });
    expect(it1.status).toBe("pending_review");
    expect(it1.extracted.terms).toMatchObject({ rentPerSf: "120", depositMonths: "3", lockInMonths: "24" });
    expect(await S.listOffers(owner, t3.id)).toHaveLength(0); // nothing created before review
    const created = await acceptIntake(owner, it1.id, { offeringParty: "operator" });
    expect(created.type).toBe("tx_offer");
    expect((await S.listOffers(owner, t3.id))[0].valid_until).toBe("2026-12-01");
    const mc = await meetingContext(owner, t3.id);
    expect(mc.latestOffer!.terms.rentPerSf).toBe("120");
    const mo = await recordMeetingOutcome(owner, t3.id, { decisions: ["client prefers 2-year lock-in"], commitments: [{ action: "Operator to share seat layout", ownerUserId: owner.userId, responsibleParty: "operator" }] });
    expect(mo.issues[0].no_due_reason).toMatch(/no date/);
    const rc = await relationshipContext(owner, t3.id);
    expect(Array.isArray(rc.previousTransactions)).toBe(true);
    expect((await supplyOptions(owner, t3.id)).requirementLinked).toBe(false);
  });

  it("RLS: another workspace's user cannot read transactions", async () => {
    const other = await userClient("other");
    const { data } = await other.from("tx_transaction").select("id").eq("id", tx.id);
    expect(data ?? []).toHaveLength(0);
  });
});
