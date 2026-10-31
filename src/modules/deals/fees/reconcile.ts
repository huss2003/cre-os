/**
 * Official finance reconciliation (workflow 21 / 17). The finance system's invoice + collection export is
 * AUTHORITATIVE: rows are matched to fee milestones and every difference becomes an exception plus a change proposal
 * (high_value → human approval). Recorded amounts are never overwritten directly. The import file is untrusted data:
 * it is parsed deterministically and kept verbatim as evidence, never interpreted by a model.
 */
import Papa from "papaparse";
import Decimal from "decimal.js";
import type { FeeRowB } from "./ledger";

export interface FinanceRow {
  rowNo: number; raw: Record<string, string>;
  invoiceNo: string | null; dealRef: string | null; invoiceDate: string | null; invoiceAmount: string | null; dueDate: string | null;
  collectedAmount: string | null; collectedDate: string | null; currency: string | null; errors: string[];
}

const ALIASES: Record<string, string[]> = {
  invoiceNo: ["invoice_no", "invoice number", "invoice no", "invoice", "inv no", "invoice_number", "voucher no", "document no"],
  dealRef: ["deal_ref", "fee_id", "fee milestone id", "crm_id", "crm id", "opportunity id", "deal id", "reference", "deal"],
  invoiceDate: ["invoice_date", "invoice date", "date", "voucher date"],
  invoiceAmount: ["invoice_amount", "invoice amount", "invoice value", "amount", "invoiced", "taxable value"],
  dueDate: ["due_date", "due date", "due on", "payment due"],
  collectedAmount: ["collected_amount", "collected", "received", "amount received", "receipt amount", "collection"],
  collectedDate: ["collected_date", "collected on", "received on", "receipt date", "collection date"],
  currency: ["currency", "ccy"],
};
const norm = (h: string) => h.trim().toLowerCase().replace(/[_\s]+/g, " ");

/** Amount: "1,23,456.50", "₹ 10,000", "INR 5000" → "123456.50". Blank → null. Anything else → error (never 0). */
export function parseAmount(v: string | undefined | null): { value: string | null; error?: string } {
  const s = (v ?? "").trim();
  if (!s || s === "-" || /^(na|n\/a)$/i.test(s)) return { value: null };
  const c = s.replace(/₹|inr|rs\.?/gi, "").replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(c)) return { value: null, error: `not an amount: "${s}"` };
  const d = new Decimal(c);
  if (d.isNeg()) return { value: null, error: `negative amount "${s}" (credit note?) — handle manually` };
  return { value: d.toDecimalPlaces(2).toFixed(2) };
}

/** Date: yyyy-mm-dd, or dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (Indian day-first convention). Blank → null. */
export function parseDate(v: string | undefined | null): { value: string | null; error?: string } {
  const s = (v ?? "").trim();
  if (!s) return { value: null };
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else return { value: null, error: `not a date: "${s}"` };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { value: null, error: `invalid date: "${s}"` };
  return { value: dt.toISOString().slice(0, 10) };
}

export function parseFinanceCsv(text: string): { rows: FinanceRow[]; unmappedColumns: string[]; error?: string } {
  const p = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" });
  const headers = p.meta.fields ?? [];
  const col: Record<string, string | undefined> = {};
  for (const [k, al] of Object.entries(ALIASES)) col[k] = headers.find((h) => al.map(norm).includes(norm(h)));
  if (!col.invoiceNo && !col.dealRef) return { rows: [], unmappedColumns: headers, error: "the file needs an invoice number column or a deal reference (fee id / CRM id) column" };
  if (!col.invoiceAmount && !col.collectedAmount) return { rows: [], unmappedColumns: headers, error: "the file needs an invoice amount or a collected amount column" };
  const used = new Set(Object.values(col).filter(Boolean));
  const rows = p.data.map((raw, i) => {
    const get = (k: string) => (col[k] ? raw[col[k]!] : undefined);
    const errors: string[] = [];
    const amt = (k: string) => { const r = parseAmount(get(k)); if (r.error) errors.push(r.error); return r.value; };
    const dt = (k: string) => { const r = parseDate(get(k)); if (r.error) errors.push(r.error); return r.value; };
    const t = (k: string) => (get(k) ?? "").trim() || null;
    return {
      rowNo: i + 1, raw, invoiceNo: t("invoiceNo"), dealRef: t("dealRef"), invoiceDate: dt("invoiceDate"), invoiceAmount: amt("invoiceAmount"),
      dueDate: dt("dueDate"), collectedAmount: amt("collectedAmount"), collectedDate: dt("collectedDate"), currency: t("currency")?.toUpperCase() ?? null, errors,
    } satisfies FinanceRow;
  });
  return { rows, unmappedColumns: headers.filter((h) => !used.has(h)) };
}

export type FeeForRecon = FeeRowB & { id: string; opportunity_id: string; row_version: number; currency?: string | null };
export interface ReconResult {
  row: FinanceRow; feeMilestoneId: string | null; opportunityId: string | null; matchMethod: "invoice_no" | "fee_id" | "crm_id_amount" | "none";
  status: "matched" | "mismatch" | "missing_in_cre_os" | "unmatched" | "invalid";
  exceptions: string[];
  /** Fields to propose on the fee milestone (official value wins, via approval). Empty = nothing to change. */
  patch: Record<string, string>;
}
export interface ReconTotals {
  official: { invoiced: string; collected: string }; recorded: { invoiced: string; collected: string };
  difference: { invoiced: string; collected: string }; reconciles: boolean;
}
export interface ReconReport { results: ReconResult[]; notInExport: { feeMilestoneId: string; opportunityId: string; invoiceNo: string | null; invoiced: string; invoicedOn: string | null }[]; totals: ReconTotals; exceptionCount: number }

const eqAmt = (a: unknown, b: string | null) => (a === null || a === undefined || a === "" ? b === null : b !== null && new Decimal(a as string).eq(b));

/** Pure matcher. Priority: invoice number → fee milestone id → official CRM id (+ amount, or the single un-invoiced milestone). */
export function reconcile(rows: FinanceRow[], fees: FeeForRecon[], opps: { id: string; crm_external_id: string | null }[]): ReconReport {
  const byInvoice = new Map(fees.filter((f) => f.invoice_no).map((f) => [f.invoice_no!.trim().toLowerCase(), f]));
  const byId = new Map(fees.map((f) => [f.id, f]));
  const oppByCrm = new Map(opps.filter((o) => o.crm_external_id).map((o) => [o.crm_external_id!.trim().toLowerCase(), o.id]));
  const seenInvoices = new Set<string>();
  const claimed = new Set<string>();
  const results: ReconResult[] = [];
  for (const row of rows) {
    const ex: string[] = [...row.errors];
    if (row.errors.length) { results.push({ row, feeMilestoneId: null, opportunityId: null, matchMethod: "none", status: "invalid", exceptions: ex, patch: {} }); continue; }
    if (row.invoiceNo) {
      const k = row.invoiceNo.toLowerCase();
      if (seenInvoices.has(k)) { results.push({ row, feeMilestoneId: null, opportunityId: null, matchMethod: "none", status: "invalid", exceptions: [`invoice ${row.invoiceNo} appears more than once in the export`], patch: {} }); continue; }
      seenInvoices.add(k);
    }
    let fee: FeeForRecon | undefined, method: ReconResult["matchMethod"] = "none";
    if (row.invoiceNo && byInvoice.has(row.invoiceNo.toLowerCase())) { fee = byInvoice.get(row.invoiceNo.toLowerCase()); method = "invoice_no"; }
    else if (row.dealRef && byId.has(row.dealRef)) { fee = byId.get(row.dealRef); method = "fee_id"; }
    else if (row.dealRef && oppByCrm.has(row.dealRef.toLowerCase())) {
      const oppId = oppByCrm.get(row.dealRef.toLowerCase())!;
      const cands = fees.filter((f) => f.opportunity_id === oppId && !claimed.has(f.id));
      const sameAmt = cands.filter((f) => row.invoiceAmount !== null && f.invoiced_amount !== null && f.invoiced_amount !== undefined && eqAmt(f.invoiced_amount, row.invoiceAmount) && (!f.invoice_no || !row.invoiceNo));
      const uninvoiced = cands.filter((f) => f.invoiced_amount === null || f.invoiced_amount === undefined);
      if (sameAmt.length === 1) fee = sameAmt[0];
      else if (sameAmt.length === 0 && uninvoiced.length === 1) fee = uninvoiced[0];
      else ex.push(cands.length ? `CRM id ${row.dealRef}: ${cands.length} fee milestones could match — record the invoice number on the right one` : `CRM id ${row.dealRef}: deal has no fee milestone to match`);
      if (fee) method = "crm_id_amount";
    }
    if (!fee) {
      if (!ex.length) ex.push(`no fee milestone matches invoice ${row.invoiceNo ?? "—"} / reference ${row.dealRef ?? "—"}`);
      results.push({ row, feeMilestoneId: null, opportunityId: null, matchMethod: "none", status: "unmatched", exceptions: ex, patch: {} });
      continue;
    }
    claimed.add(fee.id);
    const patch: Record<string, string> = {};
    let differs = false, fills = false;
    const cmp = (label: string, field: keyof FeeRowB, official: string | null, isAmount: boolean, needs?: [keyof FeeRowB, string | null, string]) => {
      if (official === null) return;
      const recorded = fee![field] as string | number | null | undefined;
      const same = isAmount ? eqAmt(recorded, official) : (recorded ?? null) === official;
      if (same) return;
      if (needs && needs[1] === null && (fee![needs[0]] === null || fee![needs[0]] === undefined)) { ex.push(`${label}: official value ${official} but the export has no ${needs[2]} — cannot propose`); differs = true; return; }
      if (recorded === null || recorded === undefined || recorded === "") { fills = true; ex.push(`${label} not recorded in CRE OS (official: ${official})`); }
      else { differs = true; ex.push(`${label} differs: CRE OS ${recorded}, official ${official}`); }
      patch[field as string] = official;
      if (needs && needs[1] !== null && !fee![needs[0]]) patch[needs[0] as string] = needs[1];
    };
    if (row.currency && (fee.currency ?? "INR") !== row.currency) { ex.push(`currency differs: CRE OS ${fee.currency ?? "INR"}, official ${row.currency}`); differs = true; }
    else {
      cmp("Invoiced amount", "invoiced_amount", row.invoiceAmount, true, ["invoiced_on", row.invoiceDate, "invoice date"]);
      cmp("Invoice date", "invoiced_on", row.invoiceDate, false);
      cmp("Invoice number", "invoice_no", row.invoiceNo, false);
      cmp("Invoice due date", "invoice_due_on", row.dueDate, false);
      cmp("Collected amount", "collected_amount", row.collectedAmount, true, ["collected_on", row.collectedDate, "collection date"]);
      cmp("Collection date", "collected_on", row.collectedDate, false);
    }
    if ((patch.invoice_no || patch.invoice_due_on) && !patch.invoiced_amount && (fee.invoiced_amount === null || fee.invoiced_amount === undefined)) {
      delete patch.invoice_no; delete patch.invoice_due_on;   // invoice details need the amount (DB rule)
    }
    results.push({ row, feeMilestoneId: fee.id, opportunityId: fee.opportunity_id, matchMethod: method, status: differs ? "mismatch" : fills ? "missing_in_cre_os" : "matched", exceptions: ex, patch });
  }
  // recorded invoices inside the export's date range that the export does not contain
  const dates = rows.map((r) => r.invoiceDate).filter(Boolean).sort() as string[];
  const notInExport: ReconReport["notInExport"] = [];
  if (dates.length) {
    const [lo, hi] = [dates[0], dates[dates.length - 1]];
    for (const f of fees) {
      if (claimed.has(f.id) || f.invoiced_amount === null || f.invoiced_amount === undefined) continue;
      if (f.invoiced_on && f.invoiced_on >= lo && f.invoiced_on <= hi)
        notInExport.push({ feeMilestoneId: f.id, opportunityId: f.opportunity_id, invoiceNo: f.invoice_no ?? null, invoiced: new Decimal(f.invoiced_amount as string).toFixed(2), invoicedOn: f.invoiced_on });
    }
  }
  const sum = (xs: (string | number | null | undefined)[]) => xs.reduce<Decimal>((a, x) => (x === null || x === undefined || x === "" ? a : a.plus(x as string)), new Decimal(0));
  const valid = results.filter((r) => r.status !== "invalid");
  const official = { invoiced: sum(valid.map((r) => r.row.invoiceAmount)), collected: sum(valid.map((r) => r.row.collectedAmount)) };
  const matchedFees = results.filter((r) => r.feeMilestoneId).map((r) => byId.get(r.feeMilestoneId!)!);
  const extra = notInExport.map((n) => byId.get(n.feeMilestoneId)!);
  const recorded = { invoiced: sum([...matchedFees, ...extra].map((f) => f.invoiced_amount)), collected: sum([...matchedFees, ...extra].map((f) => f.collected_amount)) };
  const exceptionCount = results.reduce((a, r) => a + r.exceptions.length, 0) + notInExport.length;
  return {
    results, notInExport, exceptionCount,
    totals: {
      official: { invoiced: official.invoiced.toFixed(2), collected: official.collected.toFixed(2) },
      recorded: { invoiced: recorded.invoiced.toFixed(2), collected: recorded.collected.toFixed(2) },
      difference: { invoiced: official.invoiced.minus(recorded.invoiced).toFixed(2), collected: official.collected.minus(recorded.collected).toFixed(2) },
      reconciles: official.invoiced.eq(recorded.invoiced) && official.collected.eq(recorded.collected) && exceptionCount === 0,
    },
  };
}
