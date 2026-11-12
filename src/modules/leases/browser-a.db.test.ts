/** Browser test A regressions against the local DB (WS1, owner RLS client, mock AI): B1/B4/B5/B7. */
import { describe, it, expect, beforeAll } from "vitest";
import { tag, userClient, USERS, WS1 } from "../../../tests/helpers";
import { addDocument, addTermVersion, confirmTermVersion, createLease, getLease, setStatus, startTermination, type W } from "./service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
let w: W;
const live = (rows: Row[], t: string) => rows.filter((d) => d.date_type === t && !d.superseded_by && !d.archived_at);

beforeAll(async () => { w = { db: await userClient("owner"), ws: WS1, userId: USERS.owner.id }; });

describe("browser test A — lease regressions", () => {
  it("B4: an amendment changing only rent keeps term 108 and lock-in 36", async () => {
    const l = await createLease(w, { tenantNameRaw: tag("BTA B4"), status: "draft", terms: { monthlyRent: 800000, termMonths: 108, lockinMonths: 36, securityDeposit: 6000000 } });
    const v2 = await addTermVersion(w, l.id, { terms: { monthlyRent: 880000 }, source: "amendment" });
    expect(v2.terms).toMatchObject({ monthlyRent: 880000, termMonths: 108, lockinMonths: 36, securityDeposit: 6000000 });
    await confirmTermVersion(w, v2.id);
    const d = (await getLease(w, l.id))!;
    expect(d.currentTerms).toMatchObject({ monthlyRent: 880000, termMonths: 108, lockinMonths: 36 });
    expect(d.terms.find((t: Row) => t.version === 1)?.status).toBe("superseded");
  });

  it("B1 + B5: single-paragraph deed gives commencement/expiry; a notice deadline left 'not known' is recalculated with the expiry's label", async () => {
    const l = await createLease(w, { tenantNameRaw: tag("BTA B5"), status: "draft" });
    // first document: notice clause only → expiry unknown
    await addDocument(w, l.id, { title: "notice only", docType: "lease_agreement", executionState: "executed", pages: ["The Lessee may terminate the lease by giving written notice not less than six months prior to expiry of the term."] });
    let rows = (await getLease(w, l.id))!.dates as Row[];
    expect(live(rows, "termination_notice_deadline")[0]).toMatchObject({ calculated_date: null });
    expect(live(rows, "termination_notice_deadline")[0].review_reason).toMatch(/not known/i);
    // second document: B1 paragraph
    await addDocument(w, l.id, { title: "deed", docType: "lease_agreement", executionState: "executed", pages: ["LEASE DEED This Lease Deed is executed on 15 December 2026 between Landlord and BTA Lease Test Co. The term of the lease shall commence on 1 January 2027 and the lease term shall be 9 years."] });
    rows = (await getLease(w, l.id))!.dates as Row[];
    expect(live(rows, "commencement")[0]).toMatchObject({ calculated_date: "2027-01-01" });
    expect(live(rows, "expiry")[0]).toMatchObject({ calculated_date: "2035-12-31" });
    const n = live(rows, "termination_notice_deadline");
    expect(n).toHaveLength(1);
    expect(n[0].calculated_date).toBe("2035-06-30");
    expect(n[0].review_reason ?? "").not.toMatch(/not known/i);
    expect(n[0].review_reason).toMatch(/expiry date 2035-12-31 \(calculated, not yet confirmed\)/);
    expect(n[0].clause_text).toMatch(/six months prior to expiry/);
    expect(n[0].method).toBeTruthy();
  });

  it("B7: recording a served termination notice moves the lease to termination_notice_served with evidence", async () => {
    const l = await createLease(w, { tenantNameRaw: tag("BTA B7"), status: "awaiting_execution" });
    const doc = await addDocument(w, l.id, { title: "deed", docType: "lease_agreement", executionState: "executed", pages: ["This Lease Deed is executed on 15 December 2026."] });
    await setStatus(w, l.id, "executed", { documentId: doc.document.id, executionDate: "2026-12-15", today: "2027-01-02" });
    await startTermination(w, l.id, { reason: "exit", noticeDate: "2027-03-01", noticePeriodText: "six months" });
    const d = (await getLease(w, l.id))!;
    expect(d.lease.lifecycle_status).toBe("termination_notice_served");
    expect(d.history.slice(-1)[0]).toMatchObject({ to_status: "termination_notice_served" });
    expect(d.history.slice(-1)[0].evidence).toMatchObject({ notice_date: "2027-03-01" });
  });
});
