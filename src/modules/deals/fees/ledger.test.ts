/** Workflow 21 acceptance (pure): separate money statuses, forecast never collected, aging, slippage, cohort funnel. */
import { describe, it, expect } from "vitest";
import { cohortFunnel, feeLedger, ledgerTotals, receivablesAging, slippageReport, MONEY_STAGES } from "./ledger";

const opp = { id: "o1", name: "Acme", stage: "signed", outcome: "open", expected_fee: 5000000, credit_share: 0.5, expected_close: "2026-12-01", crm_external_id: "CRM-9" };

describe("revenue controller: fee ledger", () => {
  it("forecast fees are never shown as collected", () => {
    const lines = feeLedger({ ...opp, stage: "proposal_negotiation" }, []);
    const t = ledgerTotals(lines);
    expect(t.expected.amount).toBe("5000000.00");
    expect(lines.find((l) => l.stage === "expected")!.status).toBe("forecast");
    expect(t.collected.amount).toBe("0.00");
    expect(t.invoiced.amount).toBe("0.00");
    expect(t.recognised.amount).toBe("0.00");
  });

  it("every amount has a defined status and transaction link", () => {
    const rows = [
      { id: "f1", gross_fee: 4000000, credit_share: 0.5, contractual_amount: 4000000, contract_ref: "EL-1", attributed_on: "2026-10-01", attribution_ref: "memo 7",
        invoiced_amount: 2000000, invoiced_on: "2026-10-05", invoice_no: "INV-1", invoice_due_on: "2026-11-04", collected_amount: 1000000, collected_on: "2026-10-20", evidence: "INV-1, UTR 123" },
      { id: "f2", gross_fee: 1000000, milestone: "on possession" },
    ];
    const lines = feeLedger(opp, rows);
    expect(lines).toHaveLength(1 + rows.length * 5);
    for (const l of lines) {
      expect(l.status).toMatch(/^(forecast|agreed|credited|computed|recorded|missing_evidence|unknown)$/);
      expect(l.transaction.opportunityId).toBe("o1");
      expect(l.transaction.crmId).toBe("CRM-9");
      if (l.stage !== "expected") expect(l.transaction.feeMilestoneId).toMatch(/^f\d$/);
    }
    const f1 = lines.filter((l) => l.transaction.feeMilestoneId === "f1");
    expect(Object.fromEntries(f1.map((l) => [l.stage, l.status]))).toEqual({ contractual: "agreed", attributed: "credited", invoiced: "recorded", recognised: "unknown", collected: "recorded" });
    expect(f1.find((l) => l.stage === "invoiced")!.transaction.invoiceNo).toBe("INV-1");
    const f2 = lines.filter((l) => l.transaction.feeMilestoneId === "f2");
    expect(f2.find((l) => l.stage === "attributed")).toMatchObject({ status: "computed", amount: "500000.00" }); // opp credit share, not confirmed
    expect(f2.find((l) => l.stage === "invoiced")).toMatchObject({ status: "unknown", amount: null });          // unknown stays null, not 0
    const t = ledgerTotals(lines);
    expect(t.collected.amount).toBe("1000000.00");
    expect(t.attributed.amount).toBe("2500000.00");
    expect(Object.keys(t)).toEqual([...MONEY_STAGES]);
  });

  it("amounts without evidence are flagged missing_evidence", () => {
    const lines = feeLedger(opp, [{ id: "f", invoiced_amount: 10, invoiced_on: "2026-10-01", evidence: "" }]);
    expect(lines.find((l) => l.stage === "invoiced")!.status).toBe("missing_evidence");
  });
});

describe("revenue controller: reports", () => {
  it("receivables aging buckets by invoice due date (unknown due date is its own bucket)", () => {
    const rows = [
      { id: "a", invoiced_amount: 100, invoice_due_on: "2026-11-10" },                       // not due
      { id: "b", invoiced_amount: 100, collected_amount: 40, invoice_due_on: "2026-10-01" },  // 30 days
      { id: "c", invoiced_amount: 100, invoice_due_on: "2026-07-01" },                       // 122 days
      { id: "d", invoiced_amount: 100 },                                                      // unknown
      { id: "e", invoiced_amount: 100, collected_amount: 100, invoice_due_on: "2026-01-01" }, // settled
    ];
    const r = receivablesAging(rows, "2026-10-31");
    expect(r.buckets).toEqual({ not_due: "100.00", "1_30": "60.00", "31_60": "0.00", "61_90": "0.00", "90_plus": "100.00", due_date_unknown: "100.00" });
    expect(r.total).toBe("360.00");
    expect(r.items[0].feeMilestoneId).toBe("c");
  });

  it("slippage report from expected_close history: pushes, days slipped, passed dates", () => {
    const opps = [{ id: "o1", name: "A", stage: "loi", expected_close: "2026-10-15" }, { id: "o2", name: "B", stage: "signed", expected_close: "2026-09-01" }, { id: "o3", name: "C", stage: "engaged", expected_close: "2027-01-01" }];
    const hist = [
      { opportunity_id: "o1", old_expected_close: null, new_expected_close: "2026-08-01", changed_at: "2026-06-01T00:00:00Z" },
      { opportunity_id: "o1", old_expected_close: "2026-08-01", new_expected_close: "2026-09-15", changed_at: "2026-07-20T00:00:00Z" },
      { opportunity_id: "o1", old_expected_close: "2026-09-15", new_expected_close: "2026-10-15", changed_at: "2026-09-10T00:00:00Z" },
      { opportunity_id: "o2", old_expected_close: "2026-10-01", new_expected_close: "2026-09-01", changed_at: "2026-08-10T00:00:00Z" },
    ];
    const r = slippageReport(opps, hist, "2026-10-31");
    const a = r.rows.find((x) => x.opportunityId === "o1")!;
    expect(a).toMatchObject({ pushes: 2, slippedDays: 45 + 30, passedWithoutClose: true, daysPastExpected: 16, firstExpected: "2026-08-01" });
    expect(r.rows.find((x) => x.opportunityId === "o2")).toMatchObject({ pullIns: 1, passedWithoutClose: false }); // signed: not "passed"
    expect(r.rows.find((x) => x.opportunityId === "o3")).toBeUndefined();
    expect(r.passedCount).toBe(1);
  });

  it("cohort funnel comes from actual stage history", () => {
    const opps = [{ id: "a", stage: "engaged", outcome: "lost" }, { id: "b", stage: "signed", outcome: "won" }, { id: "c", stage: "research", outcome: "open" }];
    const hist = [
      { opportunity_id: "a", to_stage: "research", changed_at: "2026-08-03T00:00:00Z" }, { opportunity_id: "a", to_stage: "qualified_discussion", changed_at: "2026-08-20T00:00:00Z" },
      { opportunity_id: "b", to_stage: "engaged", changed_at: "2026-08-10T00:00:00Z" }, { opportunity_id: "b", to_stage: "signed", changed_at: "2026-10-10T00:00:00Z" },
      { opportunity_id: "c", to_stage: "research", changed_at: "2026-09-02T00:00:00Z" },
    ];
    const rows = cohortFunnel(opps, hist);
    expect(rows.map((r) => r.cohort)).toEqual(["2026-09", "2026-08"]);
    const aug = rows[1];
    expect(aug.opportunities).toBe(2);
    expect(aug.reached).toMatchObject({ engaged: 2, qualified_discussion: 2, loi: 1, signed: 1, collected: 0 }); // a reached QD even though now "engaged"
    expect(aug.conversionPct.signed).toBe("50.0");
    expect(aug).toMatchObject({ won: 1, lost: 1 });
  });
});
