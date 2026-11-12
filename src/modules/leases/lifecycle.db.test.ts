/**
 * SPEC §18 — 30 end-to-end scenarios against the local DB (WS1, RLS user clients, mock AI: no OPENAI key).
 * Scenario numbers are in the test names. Runs sequentially on one lease built up step by step.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { adminClient, tag, userClient, USERS, WS1 } from "../../../tests/helpers";
import {
  addDocument, addFinancialRecord, alternativeProperties, confirmDate, confirmTermVersion, createLease, depositRecovery, dispatchDueReminders, escalationView, getLease,
  initHandover, addHandoverItem, leaseAudit, leaseContextForOrg, openRenewal, paymentStatus, receiveExecutedLease, renewalDecisionSupport, renewalPipeline, scanOpportunities, setHandoverItem,
  setStatus, startTermination, syncReminders, updateRenewal, updateTermination, upcomingDates, addManualDate, addTermVersion, setObligationStatus, obligationTracker, type W,
} from "./service";
import { answerLeaseQuestion } from "./assist";
import { AMENDMENT_PAGES, DRAFT_LOI_PAGES, EXECUTED_LEASE_PAGES } from "./fixtures";

const T0 = "2027-02-01";
let w: W; let leaseId: string; let orgId: string; let assetId: string; let tenantName: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const dates = async () => (await getLease(w, leaseId))!.dates as Row[];
const live = (rows: Row[], t: string) => rows.filter((d) => d.date_type === t && !d.superseded_by && !d.archived_at);

beforeAll(async () => {
  const db = await userClient("owner");
  w = { db, ws: WS1, userId: USERS.owner.id };
  tenantName = tag("Acme Analytics");
  orgId = (await db.from("organisation").insert({ workspace_id: WS1, display_name: tenantName, owner_user_id: USERS.owner.id }).select("id").single()).data!.id;
  assetId = (await db.from("asset").insert({ workspace_id: WS1, name: tag("Tower A"), owner_user_id: USERS.owner.id }).select("id").single()).data!.id;
});

describe("Module 15 — lease lifecycle (§18)", () => {
  it("#1 #2 create a lease associated with a company and property; drafts start pre-execution", async () => {
    await expect(createLease(w, { tenantOrgId: orgId, status: "active" })).rejects.toThrow(/pre-execution/);
    const l = await createLease(w, { tenantOrgId: orgId, assetId, reference: tag("L"), status: "awaiting_execution", microMarket: "Baner",
      terms: { monthlyRent: 1000000, chargeableArea: 25000, areaBasis: "chargeable", camMonthly: null } });
    leaseId = l.id;
    const d = (await getLease(w, leaseId))!;
    expect(d.lease).toMatchObject({ tenant_org_id: orgId, asset_id: assetId, lifecycle_status: "awaiting_execution", tenant_name: tenantName });
    expect(d.history[0]).toMatchObject({ to_status: "awaiting_execution" });
    expect(d.terms[0]).toMatchObject({ version: 1, status: "current", source: "original" });
  });

  it("#27 a draft LOI is never treated as executed; its dates are needs_review", async () => {
    const r = await addDocument(w, leaseId, { title: "LOI draft", docType: "loi", executionState: "draft", pages: DRAFT_LOI_PAGES });
    expect(r.dates.every((d) => d.verification_status === "needs_review")).toBe(true);
    await expect(setStatus(w, leaseId, "executed", { documentId: r.document.id, executionDate: "2026-12-15", today: T0 })).rejects.toThrow(/never treated as executed/);
    await expect(confirmTermVersion(w, r.termVersion!.id)).rejects.toThrow(/draft\/unsigned/);
  });

  let execDocId: string;
  it("#3 #4 #5 #6 #7 #8 #9 upload executed lease; terms, dates, lock-in, notice, escalation, break extracted with page refs", async () => {
    const r = await addDocument(w, leaseId, { title: "Lease deed", docType: "lease_agreement", executionState: "executed", pages: EXECUTED_LEASE_PAGES });
    execDocId = r.document.id;
    const by = (t: string) => r.dates.find((d) => d.date_type === t)!;
    expect(by("commencement")).toMatchObject({ page: 1, origin: "extracted" });
    expect(by("commencement").clause_text).toMatch(/commencing on 1st January 2027/);
    expect(by("expiry").page).toBe(1);
    expect(by("lockin_end")).toMatchObject({ calculated_date: "2029-12-31", page: 2 });
    expect(by("lockin_end").method).toMatch(/edate/);
    expect(by("lockin_end").convention).toMatchObject({ counting: "period_inclusive_end", monthRule: "eom_clamp" });
    expect(by("termination_notice_deadline").clause_text).toMatch(/not less than six \(6\) months prior/);
    expect(by("escalation")).toMatchObject({ calculated_date: "2030-01-01", page: 2 });
    expect(by("break_option")).toMatchObject({ verification_status: "needs_review", page: 3 });
    expect(r.termVersion).toMatchObject({ status: "proposed", source: "extracted" });
    expect(r.termVersion!.terms).toMatchObject({ monthlyRent: 1000000, camMonthly: 120000, securityDeposit: 6000000, lockinMonths: 36 });
    const d = (await getLease(w, leaseId))!;
    expect(d.obligations.find((o) => o.category === "insurance")).toMatchObject({ responsible: "tenant", page: 3, document_id: execDocId });
    // re-upload of the same file is idempotent (S8)
    const again = await addDocument(w, leaseId, { title: "Lease deed", docType: "lease_agreement", executionState: "executed", pages: EXECUTED_LEASE_PAGES });
    expect(again.duplicate).toBe(true);
  });

  it("#10 #11 uncertain dates need an explicit choice; dates differing across documents are flagged conflicting", async () => {
    const rows = await dates();
    const comm = live(rows, "commencement");
    expect(comm.length).toBe(2);
    expect(comm.every((d) => d.verification_status === "conflicting")).toBe(true);
    expect(comm[0].review_reason).toMatch(/Documents disagree/);
    const brk = live(rows, "break_option")[0];
    await expect(confirmDate(w, brk.id, { today: T0 })).rejects.toThrow(/choose the correct date/);
  });

  it("human review confirms dates (only then 'confirmed contractual deadline'); executed + active need evidence", async () => {
    const rows = await dates();
    const comm = live(rows, "commencement").find((d) => d.document_id === execDocId)!;
    await expect(confirmDate(w, comm.id, { today: T0 })).rejects.toThrow(/choose/);
    const c = await confirmDate(w, comm.id, { date: "2027-01-01", today: T0 });
    expect(c).toMatchObject({ verification_status: "confirmed", confirmed_by: USERS.owner.id });
    const after = await dates();
    expect(live(after, "commencement")).toHaveLength(1); // LOI row superseded, kept
    expect(after.filter((d) => d.date_type === "commencement")).toHaveLength(2);
    const ev = (await w.db.from("lease_event").select("*").eq("id", live(after, "commencement")[0].lease_event_id ?? "00000000-0000-0000-0000-000000000000").maybeSingle()).data;
    expect(ev).toBeNull(); // commencement isn't a radar event type
    await expect(setStatus(w, leaseId, "active", { today: T0 })).rejects.toThrow(/Cannot move/);
    await setStatus(w, leaseId, "executed", { documentId: execDocId, executionDate: "2026-12-15", today: T0 });
    await setStatus(w, leaseId, "active", { today: T0 });
    expect((await getLease(w, leaseId))!.lease.lifecycle_status).toBe("active");
  });

  it("#15 #16 expiry confirmed → mirrored to lease_event; dependent notice deadlines recalculated; renewal notice deadline", async () => {
    const exp = live(await dates(), "expiry").find((d) => d.document_id === execDocId)!;
    await confirmDate(w, exp.id, { date: "2035-12-31", today: T0 });
    const rows = await dates();
    const ev = (await w.db.from("lease_event").select("*").eq("lease_id", leaseId).eq("event_type", "expiry").is("archived_at", null)).data!;
    expect(ev[0]).toMatchObject({ event_date: "2035-12-31", confirmed: true, date_basis: "contractual" });
    const rn = live(rows, "renewal_notice_deadline").find((d) => d.document_id === execDocId)!;
    expect(rn.calculated_date).toBe("2035-06-30");
    expect(rn.method).toMatch(/edate\(2035-12-31, −6\)/);
    const up = await upcomingDates(w, { from: "2035-01-01", to: "2035-12-31", types: ["expiry", "renewal_notice_deadline"], includeUnverified: true, leaseId });
    expect(up.map((u) => u.date_type)).toEqual(expect.arrayContaining(["expiry", "renewal_notice_deadline"]));
    expect(up.find((u) => u.date_type === "expiry")!.verification_status).toBe("confirmed");
  });

  it("#12 #13 #26 amendment adds a version; original terms preserved; diff shown", async () => {
    const d0 = (await getLease(w, leaseId))!;
    const extracted = d0.terms.find((t) => t.source === "extracted" && t.document_id === execDocId)!;
    await confirmTermVersion(w, extracted.id);
    const r = await addDocument(w, leaseId, { title: "First amendment", docType: "lease_amendment", executionState: "amendment", pages: AMENDMENT_PAGES });
    expect(r.diff.map((x) => x.field)).toEqual(expect.arrayContaining(["monthlyRent", "camMonthly"]));
    expect(r.termVersion).toMatchObject({ source: "amendment", status: "proposed" });
    await confirmTermVersion(w, r.termVersion!.id);
    const d = (await getLease(w, leaseId))!;
    const v1 = d.terms.find((t) => t.version === 1)!;
    expect(v1).toMatchObject({ status: "superseded", source: "original" });
    expect(v1.terms.monthlyRent).toBe(1000000);
    expect(d.terms.find((t) => t.id === extracted.id)!.status).toBe("superseded");
    expect(d.currentTerms.monthlyRent).toBe(1050000);
    expect(d.documents.find((x) => x.id === execDocId)!.execution_state).toBe("executed");
  });

  it("#14 escalation calculated from confirmed commencement; expected vs actual flagged", async () => {
    // put the original rent back as current to check the spec example (₹10,00,000 +15% after 36 → ₹11,50,000)
    const v = await addTermVersion(w, leaseId, { terms: { monthlyRent: 1000000, camMonthly: 120000, escalation: { basis: "compounding", pct: 15, everyMonths: 36, clauseText: "2.4 The rent shall be escalated by 15% after every 36 months on the last paid rent.", page: 2 }, termMonths: 108 }, source: "manual", note: "test" });
    await confirmTermVersion(w, v.id);
    await addFinancialRecord(w, leaseId, { kind: "actual_rent_after_escalation", amount: 1140000, onDate: "2030-01-01" });
    const e = await escalationView(w, leaseId);
    expect(e.rows[0]).toMatchObject({ effectiveDate: "2030-01-01", expectedMonthlyRent: "1150000.00", page: 2 });
    expect(e.rows[0].check).toEqual({ status: "discrepancy", difference: "10000.00".replace(/^/, "-") });
    expect(paymentStatus((await getLease(w, leaseId))!.financial, "2027-02")).toBe("unknown");
  });

  it("#17 #18 renewal discussion, decision support (no auto-recommendation), agreement", async () => {
    const r = await openRenewal(w, leaseId, "Client asked about options");
    expect((await openRenewal(w, leaseId)).id).toBe(r.id); // no duplicate open renewals
    await updateRenewal(w, r.id, { stage: "discussion", tenantResponse: "Wants 10% lower rent", note: "Call with CFO" });
    const ds = await renewalDecisionSupport(w, leaseId, { proposedRentMonthly: 1100000, extensionMonths: 60, discountRatePct: 10, relocation: { newRentMonthly: 950000 } });
    expect(ds.recommendation).toBeNull();
    expect(ds.result?.missing.length).toBeGreaterThan(0);
    expect(ds.existing.monthlyRent).toBe(1000000);
    await expect(setStatus(w, leaseId, "renewal_agreed", { today: T0 })).rejects.toThrow();
    await setStatus(w, leaseId, "renewal_under_discussion", { today: T0 });
    await updateRenewal(w, r.id, { stage: "agreed", note: "Signed term sheet" });
    await setStatus(w, leaseId, "renewal_agreed", { today: T0 });
    const p = await renewalPipeline(w, T0);
    const mine = p.renewals.find((x) => x.id === r.id)!;
    expect(mine.stage).toBe("agreed");
    expect(mine.log.length).toBe(3);
    const task = (await w.db.from("task").select("id").eq("idempotency_key", `lease_renewal:${r.id}`)).data!;
    expect(task).toHaveLength(1);
  });

  it("#24 reminders via the orchestrator: from confirmed dates only, no duplicates, obsolete cancelled on date change", async () => {
    const s1 = await syncReminders(w, leaseId, T0); // confirmDate already synced
    expect(s1.planned).toBeGreaterThan(0);
    expect(s1.created).toBe(0);
    expect((await syncReminders(w, leaseId, T0)).created).toBe(0);
    const h = await addManualDate(w, leaseId, { dateType: "handover", date: "2027-02-10" });
    await confirmDate(w, h.id, { today: T0 });
    const admin = adminClient();
    const sent = await dispatchDueReminders(admin, WS1, T0);
    expect(sent.sent).toBeGreaterThanOrEqual(1);
    const rem = (await w.db.from("lease_reminder").select("*").eq("lease_id", leaseId).eq("date_type", "handover")).data!;
    const s = rem.find((r) => r.status === "sent")!;
    const ob = (await admin.from("outbox").select("id, payload").eq("workspace_id", WS1).eq("id", s.outbox_id).single()).data!;
    expect(ob.payload.category).toBe("lease_deadline");
    // date changes → new confirmed handover date supersedes; old scheduled reminders cancelled
    const h2 = await addManualDate(w, leaseId, { dateType: "handover", date: "2027-03-15" });
    await confirmDate(w, h2.id, { today: T0 });
    const rem2 = (await w.db.from("lease_reminder").select("*").eq("lease_id", leaseId).eq("date_type", "handover")).data!;
    expect(rem2.filter((r) => r.target_date === "2027-02-10" && r.status === "scheduled")).toHaveLength(0);
    expect(rem2.filter((r) => r.target_date === "2027-02-10" && r.status === "cancelled").length).toBeGreaterThan(0);
    expect(rem2.filter((r) => r.target_date === "2027-03-15" && r.status === "scheduled").length).toBe(2);
    expect((await dispatchDueReminders(admin, WS1, T0)).sent).toBe(0); // nothing new due; no double notifications
  });

  it("#22 #28 lease events → potential opportunities + orchestrator events; never a confirmed requirement", async () => {
    const before = (await w.db.from("requirement").select("id").eq("org_id", orgId)).data!.length;
    const opps = await scanOpportunities(w, "2035-01-15");
    const mine = opps.filter((o) => o.lease_id === leaseId);
    expect(mine.some((o) => o.kind === "expiry_approaching" && o.label === "potential")).toBe(true);
    const ev = (await adminClient().from("event_outbox").select("event_type, payload").eq("workspace_id", WS1).eq("subject_id", leaseId).eq("event_type", "lease.opportunity_identified")).data!;
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].payload.label).toBe("potential");
    await scanOpportunities(w, "2035-01-15");
    const ev2 = (await adminClient().from("event_outbox").select("id").eq("workspace_id", WS1).eq("subject_id", leaseId).eq("event_type", "lease.opportunity_identified")).data!;
    expect(ev2.length).toBe(ev.length); // deduped
    expect((await w.db.from("requirement").select("id").eq("org_id", orgId)).data!.length).toBe(before);
  });

  it("#23 alternative properties from Module 14 supply", async () => {
    const other = (await w.db.from("asset").insert({ workspace_id: WS1, name: tag("Tower B"), owner_user_id: USERS.owner.id }).select("id").single()).data!.id;
    const sp = (await w.db.from("space").insert({ workspace_id: WS1, asset_id: other, chargeable_sf: 24000, owner_user_id: USERS.owner.id }).select("id").single()).data!.id;
    await w.db.from("availability").insert({ workspace_id: WS1, space_id: sp, as_of: T0, status: "available", asking_rent_min: 90, owner_user_id: USERS.owner.id });
    const a = await alternativeProperties(w, leaseId, 500);
    expect(a.items.some((x) => x.assetId === other && x.areaFit === true)).toBe(true);
    expect(a.items.every((x) => x.assetId !== assetId)).toBe(true);
  });

  it("#25 assistant answers are grounded in lease records", async () => {
    const a = await answerLeaseQuestion(w, `What is the current rent for ${tenantName}?`, T0);
    expect(a).toMatchObject({ intent: "current_rent", grounded: true });
    expect(a.answer).toMatch(/1000000/);
    const n = await answerLeaseQuestion(w, "What are the contractual notice requirements?", T0, { leaseId });
    expect(n.rows.some((r) => /Lease deed v1 p\.3/.test(String(r.source)))).toBe(true);
    const ctx = await leaseContextForOrg(w, orgId, T0);
    expect(ctx[0].dates.some((d: Row) => d.contractual)).toBe(true);
  });

  it("obligation tracker: completion needs evidence", async () => {
    const o = (await obligationTracker(w)).find((x) => x.lease_id === leaseId && x.category === "insurance")!;
    await expect(setObligationStatus(w, o.id, "done")).rejects.toThrow(/evidence/);
    expect((await setObligationStatus(w, o.id, "done", "Policy #123 received")).status).toBe("done");
  });

  it("#19 #20 #21 termination process, handover checklist (customisable), security deposit recovery", async () => {
    const t = await startTermination(w, leaseId, { reason: "Consolidation", noticeDate: "2027-02-01", noticePeriodText: "6 months", proposedDate: "2027-08-01", depositAmount: 6000000 });
    expect(t.status).toBe("notice_served");
    await setStatus(w, leaseId, "active", { today: T0 });
    await setStatus(w, leaseId, "termination_notice_served", { note: "Served by courier, AWB 123", today: T0 });
    await initHandover(w, leaseId);
    expect((await initHandover(w, leaseId)).created).toBe(0);
    await addHandoverItem(w, leaseId, "Signage removal");
    const items = (await getLease(w, leaseId))!.handover;
    expect(items).toHaveLength(11);
    await expect(setHandoverItem(w, items[0].id, "done")).rejects.toThrow(/evidence/);
    for (const i of items) await setHandoverItem(w, i.id, "done", "checked on site");
    await updateTermination(w, t.id, { depositRecovered: 4000000, depositStatus: "partially_recovered" });
    const tt = (await getLease(w, leaseId))!.terminations[0];
    expect(depositRecovery(tt)).toEqual({ status: "partially_recovered", outstanding: "2000000.00" });
    await expect(setStatus(w, leaseId, "terminated", { today: T0 })).rejects.toThrow(/confirmed termination date/);
    await updateTermination(w, t.id, { confirmedDate: "2027-08-01", status: "completed" });
    await setStatus(w, leaseId, "terminated", { today: T0 });
    const rem = (await w.db.from("lease_reminder").select("status").eq("lease_id", leaseId).eq("status", "scheduled")).data!;
    expect(rem).toHaveLength(0); // obsolete reminders cancelled when the lease ends
    await setStatus(w, leaseId, "closed", { today: T0 });
  });

  it("#29 access permissions: other workspace users can't see the lease or its dates", async () => {
    const other = await userClient("other");
    expect((await other.from("lease").select("id").eq("id", leaseId)).data).toEqual([]);
    expect((await other.from("lease_date").select("id").eq("lease_id", leaseId)).data).toEqual([]);
    expect(await getLease({ db: other, ws: WS1, userId: USERS.other.id }, leaseId)).toBeNull();
  });

  it("#26 #30 complete audit + status history; nothing overwritten", async () => {
    const d = (await getLease(w, leaseId))!;
    expect(d.history.map((h) => h.to_status)).toEqual(["awaiting_execution", "executed", "active", "renewal_under_discussion", "renewal_agreed", "active", "termination_notice_served", "terminated", "closed"]);
    expect(d.terms.length).toBeGreaterThanOrEqual(5);
    const audit = await leaseAudit(w, leaseId);
    const conf = audit.filter((a) => a.entity_type === "lease_date" && a.after?.verification_status === "confirmed" && a.before?.verification_status !== "confirmed");
    expect(conf.length).toBeGreaterThanOrEqual(2);
    expect(conf.every((a) => a.actor_user_id === USERS.owner.id)).toBe(true);
  });
});

describe("Module 16 hand-off: receiveExecutedLease (CONTRACT.md)", () => {
  it("idempotent per transaction; executed only with document + execution date; never auto-active", async () => {
    const tx = crypto.randomUUID();
    const r1 = await receiveExecutedLease(w, tx, { tenantOrgId: orgId, assetId, executionDate: "2026-12-15", terms: { monthlyRent: 800000 },
      document: { title: "Executed lease (M16)", docType: "lease_agreement", executionState: "executed", pages: EXECUTED_LEASE_PAGES }, today: T0 });
    expect(r1).toMatchObject({ created: true, status: "executed" });
    expect(r1.dateIds.length).toBeGreaterThan(3);
    const r2 = await receiveExecutedLease(w, tx, { tenantOrgId: orgId, today: T0 });
    expect(r2.leaseId).toBe(r1.leaseId);
    expect(r2.created).toBe(false);
    const d = (await getLease(w, r1.leaseId))!;
    expect(d.lease.lifecycle_status).toBe("executed");
    expect(d.dates.every((x) => x.verification_status !== "confirmed")).toBe(true);
    expect(d.terms.find((t) => t.source === "transaction")!.status).toBe("proposed");
    const tx2 = crypto.randomUUID();
    const r3 = await receiveExecutedLease(w, tx2, { tenantNameRaw: tag("NoDoc Co"), today: T0 });
    expect(r3.status).toBe("awaiting_execution");
    expect(r3.warnings.join()).toMatch(/No executed document/);
  });
});
