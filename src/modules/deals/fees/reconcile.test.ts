/** Workflow 21 acceptance (pure): totals reconcile or exceptions are shown; official values are proposed, never written. */
import { describe, it, expect } from "vitest";
import { parseAmount, parseDate, parseFinanceCsv, reconcile, type FeeForRecon } from "./reconcile";

const fee = (id: string, o: Partial<FeeForRecon> = {}): FeeForRecon => ({ id, opportunity_id: "o1", row_version: 1, currency: "INR", invoiced_amount: null, invoiced_on: null, collected_amount: null, collected_on: null, invoice_no: null, ...o });

describe("finance CSV parsing", () => {
  it("maps common export headers, Indian number/date formats; blanks stay unknown, garbage is an error (never 0)", () => {
    expect(parseAmount("₹ 1,23,456.5")).toEqual({ value: "123456.50" });
    expect(parseAmount("")).toEqual({ value: null });
    expect(parseAmount("abc").error).toBeTruthy();
    expect(parseAmount("-500").error).toMatch(/negative/);
    expect(parseDate("05/11/2026")).toEqual({ value: "2026-11-05" });
    expect(parseDate("31/02/2026").error).toMatch(/invalid/);
    const p = parseFinanceCsv("Invoice No,Invoice Date,Invoice Amount,Due Date,Amount Received,Receipt Date,Notes\nINV-1,01-10-2026,\"2,00,000\",31/10/2026,,,x\n");
    expect(p.error).toBeUndefined();
    expect(p.rows[0]).toMatchObject({ invoiceNo: "INV-1", invoiceDate: "2026-10-01", invoiceAmount: "200000.00", dueDate: "2026-10-31", collectedAmount: null, errors: [] });
    expect(p.unmappedColumns).toEqual(["Notes"]);
    expect(parseFinanceCsv("foo,bar\n1,2").error).toMatch(/invoice number/);
  });
});

describe("reconciliation", () => {
  it("totals reconcile when the official export matches the recorded fees", () => {
    const fees = [fee("f1", { invoice_no: "INV-1", invoiced_amount: "200000.00", invoiced_on: "2026-10-01", collected_amount: "200000.00", collected_on: "2026-10-20" })];
    const rows = parseFinanceCsv("invoice_no,invoice_date,invoice_amount,collected_amount,collected_date\nINV-1,2026-10-01,200000,200000,2026-10-20").rows;
    const r = reconcile(rows, fees, []);
    expect(r.results[0]).toMatchObject({ status: "matched", matchMethod: "invoice_no", patch: {} });
    expect(r.totals).toMatchObject({ reconciles: true, difference: { invoiced: "0.00", collected: "0.00" } });
  });

  it("mismatched totals show exceptions and a proposed patch (official value), never a silent overwrite", () => {
    const fees = [
      fee("f1", { invoice_no: "INV-1", invoiced_amount: "200000.00", invoiced_on: "2026-10-01" }),
      fee("f2", { opportunity_id: "o2" }),                                                     // nothing recorded yet
      fee("f3", { invoice_no: "INV-9", invoiced_amount: "50000.00", invoiced_on: "2026-10-03" }), // recorded, absent from export
    ];
    const csv = "invoice_no,deal_ref,invoice_date,invoice_amount,due_date,collected_amount,collected_date\n"
      + "INV-1,,2026-10-01,210000,2026-10-31,100000,2026-10-25\n"   // amount differs + collection not recorded
      + "INV-2,CRM-2,2026-10-02,75000,2026-11-01,,\n"              // matched via CRM id → fill
      + "INV-3,CRM-404,2026-10-04,1000,,,\n";                      // no such deal
    const r = reconcile(parseFinanceCsv(csv).rows, fees, [{ id: "o2", crm_external_id: "CRM-2" }]);
    const [a, b, c] = r.results;
    expect(a.status).toBe("mismatch");
    expect(a.exceptions.join()).toMatch(/Invoiced amount differs: CRE OS 200000.00, official 210000.00/);
    expect(a.patch).toMatchObject({ invoiced_amount: "210000.00", collected_amount: "100000.00", collected_on: "2026-10-25", invoice_due_on: "2026-10-31" });
    expect(fees[0].invoiced_amount).toBe("200000.00");            // input untouched: proposals only
    expect(b).toMatchObject({ status: "missing_in_cre_os", matchMethod: "crm_id_amount", feeMilestoneId: "f2" });
    expect(b.patch).toMatchObject({ invoiced_amount: "75000.00", invoiced_on: "2026-10-02", invoice_no: "INV-2" });
    expect(c.status).toBe("unmatched");
    expect(r.notInExport.map((n) => n.feeMilestoneId)).toEqual(["f3"]);
    expect(r.totals.reconciles).toBe(false);
    expect(r.totals.official.invoiced).toBe("286000.00");
    expect(r.exceptionCount).toBeGreaterThanOrEqual(5);
  });

  it("invalid rows and duplicate invoices are exceptions, not guesses", () => {
    const r = reconcile(parseFinanceCsv("invoice_no,invoice_amount\nINV-1,12x\nINV-2,10\nINV-2,10").rows, [], []);
    expect(r.results.map((x) => x.status)).toEqual(["invalid", "unmatched", "invalid"]);
    expect(r.results[2].exceptions[0]).toMatch(/more than once/);
  });
});
