/** Pure tests: toolkit-backed negotiation comparison, agreement diff/reconciliation, commitment detection, milestones, deposits. */
import { describe, it, expect } from "vitest";
import { comparePackages, offerVersionDiffs, type StoredOffer } from "./negotiation";
import { diffAgreements, extractTerms, mentionsCommercialTerms, reconcile } from "./documents";
import { DEFAULT_TEMPLATES, TX_TYPES, depositHeadline, depositStages, milestoneMatrix, isOverdue, canonical } from "./model";
import { clarificationOutcome } from "./service";

const offer = (id: string, v: number, terms: Record<string, string | number>): StoredOffer => ({ id, version_no: v, kind: v === 1 ? "offer" : "counteroffer", offering_party: "landlord", offer_date: "2026-11-01", terms });
// §5.2 spec example
const A = offer("a", 1, { rentPerSf: 100, camPerSf: 15, rentFreeMonths: 3, depositMonths: 6 });
const B = offer("b", 2, { rentPerSf: 95, camPerSf: 20, rentFreeMonths: 1, depositMonths: 4 });

describe("§5.2 concession package comparison (toolkit nego-1.0)", () => {
  it("Offer A vs B: never declares B better on headline rent; lists missing components", () => {
    const c = comparePackages(A, B);
    expect(c.verdict).toBe("cannot_determine");
    expect(c.verdictText).toMatch(/headline rent alone/);
    expect(c.missing.join(" ")).toMatch(/area/);
    expect(c.missing.join(" ")).toMatch(/tenure/);
    expect(c.tradeOffs.betterInB.join(" ")).toMatch(/Base rent/);
    expect(c.tradeOffs.worseInB.join(" ")).toMatch(/CAM/);
    expect(c.tradeOffs.worseInB.join(" ")).toMatch(/Rent-free/);
    expect(c.tradeOffs.betterInB.join(" ")).toMatch(/Deposit/);
  });
  it("with stated assumptions the toolkit values the full package: A is cheaper despite higher rent", () => {
    const c = comparePackages(A, B, { areaSf: 10000, tenureMonths: 60, leaseCommencement: "2027-01-01", discountRatePct: 0, parkingSlots: 0 });
    expect(c.formulaVersion).toBe("nego-1.0");
    expect(c.verdict).toBe("A_lower_modelled_cost");
    expect(c.financial!.cheaper).toBe("A");
    expect(Number(c.financial!.rentChange)).toBeLessThan(0); // B's rent is lower…
    expect(Number(c.financial!.nominalChange)).toBeGreaterThan(0); // …but the package costs more
    expect(c.assumptions.join(" ")).toMatch(/assumption, not in offer/);
  });
  it("offer version diffs come from toolkit diffOffers", () => {
    const d = offerVersionDiffs([A, B]);
    expect(d[1].terms.find((t) => t.key === "rentPerSf")!.status).toBe("improved");
    expect(d[1].terms.find((t) => t.key === "camPerSf")!.status).toBe("worse");
  });
});

const V1 = `1. Premises: 10,000 sq ft on floor 5.
2. Rent: base rent of ₹ 100 per sq ft per month.
3. Security deposit equal to 6 months rent.
4. Lock-in period of 36 months.
5. Possession on 2027-01-01.`;
const V2 = `1. Premises: 10,000 sq ft on floor 5.
2. Rent: base rent of ₹ 105 per sq ft per month.
3. Security deposit equal to 6 months rent.
5. Possession on 2027-02-01. The tenant shall complete fit-out within 90 days.
6. Signage: tenant may install signage.`;

describe("§11 agreement comparison (deterministic)", () => {
  it("added / removed / modified clauses, dates and financial terms", () => {
    const d = diffAgreements(V1, V2);
    expect(d.summary).toMatchObject({ added: 1, removed: 1, modified: 2 });
    expect(d.changes.find((c) => c.key === "2")!.financial).toBeTruthy();
    expect(d.changes.find((c) => c.key === "5")!.dates).toBeTruthy();
    expect(d.changes.find((c) => c.key === "5")!.obligations).toBeTruthy();
  });
  it("reconciliation vs agreed terms finds rent mismatch and missing lock-in", () => {
    const r = reconcile(V2, [{ term_key: "rentPerSf", label: "Rent", value: "100" }, { term_key: "depositMonths", label: "Deposit", value: "6" }, { term_key: "lockInMonths", label: "Lock-in", value: "36" }]);
    expect(r.find((x) => x.key === "rentPerSf")!.status).toBe("mismatch");
    expect(r.find((x) => x.key === "depositMonths")!.status).toBe("match");
    expect(r.find((x) => x.key === "lockInMonths")!.status).toBe("missing_in_document");
    expect(extractTerms(V1)).toMatchObject({ rentPerSf: "100", depositMonths: "6", lockInMonths: "36", areaSf: "10000", possessionDate: "2027-01-01" });
  });
});

describe("rules", () => {
  it("commitment detection", () => {
    expect(mentionsCommercialTerms("We can do rent of ₹95 per sf")).toBe(true);
    expect(mentionsCommercialTerms("The client agrees to the proposal")).toBe(true);
    expect(mentionsCommercialTerms("Can we meet on Tuesday to walk the floor?")).toBe(false);
  });
  it("§13.3 deposit due is not paid", () => {
    const d = { proposed_on: "2026-11-01", approved_on: "2026-11-02", due_date: "2026-11-05", paid_on: null, acknowledged_on: null, refundable: true, refunded_on: null };
    expect(depositStages(d, "2026-11-10")).toMatchObject({ due: true, overdue: true, paid: false });
    expect(depositHeadline(d, "2026-11-10")).toBe("Due — overdue, not paid");
  });
  it("§16 milestone matrix never infers one milestone from another", () => {
    const m = milestoneMatrix([{ kind: "executed", achieved_on: "2026-11-10", expected_on: null }]);
    expect(m.find((x) => x.kind === "executed")!.achieved).toBe(true);
    for (const k of ["signed", "possession_completed", "occupied", "handover_completed", "commercially_agreed", "legally_approved"]) expect(m.find((x) => x.kind === k)!.achieved).toBe(false);
  });
  it("templates exist for the 7 types; overdue; clarification compare; canonical hash input", () => {
    for (const t of TX_TYPES) expect(DEFAULT_TEMPLATES[t].length).toBeGreaterThan(5);
    expect(isOverdue({ status: "open", due_date: "2026-11-01", blocking: false }, "2026-11-02")).toBe(true);
    expect(isOverdue({ status: "resolved", due_date: "2026-11-01", blocking: false }, "2026-11-02")).toBe(false);
    expect(clarificationOutcome({ required_numeric: 150, response_numeric: 120, required_value: null, response: "120 kVA" })).toBe("discrepancy");
    expect(canonical({ b: 1, a: null, c: "x" })).toBe(canonical({ c: "x", b: "1" }));
  });
});

describe("Browser test B display helpers", async () => {
  const M = await import("./model");
  const { executedPages } = await import("./lease-handoff");
  const { spaceLabel } = await import("./integrations");
  const L = await import("@/lib/util/labels");
  it("B5 ₹ with Indian grouping; stage booleans as ✓/— labels", () => {
    expect(L.formatINR(19000000)).toBe("₹1,90,00,000");
    expect(L.formatINR(null)).toBe("unknown");
    expect(M.depositStageText({ proposed: true, approved: false })).toBe("✓ Proposed · — Approved");
  });
  it("B6 numeric-only clarification shows its minimum", () => {
    expect(M.clarificationRequirement({ required_value: null, required_numeric: 400, topic: "electrical_capacity" })).toBe("≥ 400 kVA");
    expect(M.clarificationRequirement({ required_value: null, required_numeric: null })).toBe("—");
  });
  it("B7 timeline: codes → words, ids dropped, rupees grouped", () => {
    expect(M.plainSummary("Transaction TX-1 created (conventional_leasing) with 15-stage plan")).toBe("Transaction TX-1 created (conventional leasing) with 15-stage plan");
    expect(M.plainSummary("client_commercial approval requested for offer v1")).toBe("Client commercial approval requested for offer v1");
    expect(M.plainSummary("Executed lease handed to Lease Lifecycle (lease 30438849-1111-2222-3333-444455556666)")).toBe("Executed lease handed to Lease Lifecycle");
    expect(M.plainSummary("Deposit proposed: security ₹19000000")).toBe("Deposit proposed: security ₹1,90,00,000");
    expect(L.codeLabel("in_progress")).toBe("In progress"); expect(L.codeLabel("executed_agreement")).toBe("Executed agreement");
    expect(L.codeLabel("approach_attempted")).toBe("Approach attempted"); expect(L.codeLabel("cam_per_sf")).toBe("CAM per SF");
  });
  it("B8 property options use names", () => {
    expect(spaceLabel("Tower A", "13", "1301")).toBe("Tower A, floor 13, unit 1301");
    expect(spaceLabel("Tower A", "Floors 5–6", null)).toBe("Tower A, Floors 5–6");
  });
  it("B13 prefill requirement from the deal", () => {
    expect(M.prefillRequirement("o1", [{ id: "o1", requirement_id: "r1" }])).toBe("r1");
    expect(M.prefillRequirement(undefined, [{ id: "o1", requirement_id: "r1" }])).toBe("");
  });
  it("B3 executed text 'Lease start 1 March 2027' becomes a commencement the leases extractor reads", async () => {
    const { buildExtraction } = await import("@/modules/leases/extract");
    const pages = executedPages("1. Premises 8,000 sq ft.\n2. Lease start 1 March 2027.\n3. Lock-in period of 36 months.");
    expect(buildExtraction(pages).dates.find((d) => d.date_type === "commencement")?.calculated_date).toBe("2027-03-01");
    expect(executedPages("Commencement date: 1 April 2027.")).toHaveLength(1); // extractor already finds it: no supplement
  });
});
