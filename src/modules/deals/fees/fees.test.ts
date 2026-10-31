import { describe, it, expect } from "vitest";
import { feeProtectionIssues, feeSummary } from "./fees";

describe("fees: gross / credited / invoiced / recognised / collected stay separate", () => {
  it("sums each money stage independently with decimal maths", () => {
    const s = feeSummary([
      { gross_fee: 3000000, credit_share: 0.5, invoiced_amount: 1500000, invoiced_on: "2026-09-01", collected_amount: 1000000, collected_on: "2026-10-01", evidence: "INV-1" },
      { gross_fee: "1000000.10", credit_share: null, recognised_amount: 200000.2, recognised_on: "2026-10-01", evidence: "rev" },
    ], 0.25);
    expect(s.gross).toBe("4000000.10");
    expect(s.credited).toBe("1750000.03"); // 1,500,000 + 1,000,000.10 × 0.25 (opportunity share)
    expect(s.invoiced).toBe("1500000.00");
    expect(s.recognised).toBe("200000.20");
    expect(s.collected).toBe("1000000.00");
    expect(s.receivable).toBe("500000.00");
  });
  it("refuses to sum mixed currencies", () => {
    expect(() => feeSummary([{ gross_fee: 1, currency: "INR" }, { gross_fee: 1, currency: "USD" }])).toThrow(/currency/);
  });
  it("flags signed deals without fee records, missing evidence, overdue receivables and collected > invoiced", () => {
    const opp = { stage: "signed", expected_fee: 3000000, credit_share: null, crm_external_id: null };
    expect(feeProtectionIssues(opp, [], "2026-11-01").map((i) => i.issue).join()).toMatch(/without any fee milestone/);
    const issues = feeProtectionIssues(opp, [
      { milestone: "signing", gross_fee: 100, invoiced_amount: 100, invoiced_on: "2026-07-01", collected_amount: 120, collected_on: "2026-08-01", evidence: "" },
    ], "2026-11-01").map((i) => i.issue).join(" | ");
    expect(issues).toMatch(/without evidence/);
    expect(issues).toMatch(/collected exceeds invoiced/);
    expect(issues).toMatch(/official CRM id/);
    const overdue = feeProtectionIssues({ ...opp, credit_share: 0.5, crm_external_id: "X" }, [{ milestone: "m", invoiced_amount: 100, invoiced_on: "2026-07-01", evidence: "INV" }], "2026-11-01");
    expect(overdue.map((i) => i.issue).join()).toMatch(/outstanding 123 days/);
  });
});
