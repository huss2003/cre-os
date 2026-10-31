/**
 * Revenue/controller maths (spec Part I §8 "Revenue/controller", "Post-signature fee protection"). Pure, decimal.
 * Gross fee, credited share, invoiced, recognised and collected are kept SEPARATE — never summed into one "revenue".
 */
import Decimal from "decimal.js";

export interface FeeMilestoneRow {
  id?: string; opportunity_id?: string;
  gross_fee?: number | string | null; credit_share?: number | string | null; milestone?: string | null; exclusions?: string | null;
  invoiced_amount?: number | string | null; invoiced_on?: string | null;
  recognised_amount?: number | string | null; recognised_on?: string | null;
  collected_amount?: number | string | null; collected_on?: string | null;
  currency?: string | null; tax_basis?: string | null; evidence?: string | null;
}
export interface FeeSummary {
  gross: string; credited: string; invoiced: string; recognised: string; collected: string;
  receivable: string; uninvoicedGross: string; creditShareUnknown: number; currency: string;
}
const D = (x: unknown) => (x === null || x === undefined || x === "" ? null : new Decimal(x as string));
const f2 = (x: Decimal) => x.toDecimalPlaces(2).toFixed(2);

export function feeSummary(rows: FeeMilestoneRow[], opportunityCreditShare?: number | string | null): FeeSummary {
  let gross = new Decimal(0), credited = new Decimal(0), inv = new Decimal(0), rec = new Decimal(0), col = new Decimal(0);
  let unknownShare = 0;
  const currencies = new Set(rows.map((r) => r.currency ?? "INR"));
  if (currencies.size > 1) throw new Error("fee milestones in more than one currency cannot be summed");
  for (const r of rows) {
    const g = D(r.gross_fee);
    if (g) {
      gross = gross.plus(g);
      const share = D(r.credit_share) ?? D(opportunityCreditShare);
      if (share) credited = credited.plus(g.times(share)); else unknownShare++;
    }
    inv = inv.plus(D(r.invoiced_amount) ?? 0);
    rec = rec.plus(D(r.recognised_amount) ?? 0);
    col = col.plus(D(r.collected_amount) ?? 0);
  }
  return {
    gross: f2(gross), credited: f2(credited), invoiced: f2(inv), recognised: f2(rec), collected: f2(col),
    receivable: f2(inv.minus(col)), uninvoicedGross: f2(Decimal.max(0, gross.minus(inv))), creditShareUnknown: unknownShare,
    currency: [...currencies][0] ?? "INR",
  };
}

export interface FeeProtectionIssue { severity: "high" | "medium"; issue: string }

/** Post-signature fee protection checklist (attribution evidence, invoice prerequisites, receivables, credit). */
export function feeProtectionIssues(opp: { stage: string; outcome?: string | null; expected_fee?: number | string | null; credit_share?: number | string | null; crm_external_id?: string | null },
  rows: FeeMilestoneRow[], asOf: string, receivableDays = 60): FeeProtectionIssue[] {
  const out: FeeProtectionIssue[] = [];
  const signedOrLater = ["signed", "possession", "invoiced", "recognised", "collected"].includes(opp.stage);
  if (signedOrLater && rows.length === 0) out.push({ severity: "high", issue: "Signed deal without any fee milestone recorded" });
  if (signedOrLater && !opp.crm_external_id) out.push({ severity: "medium", issue: "No official CRM id: attribution is not reconciled with the official CRM" });
  if ((opp.credit_share === null || opp.credit_share === undefined) && rows.some((r) => r.credit_share === null || r.credit_share === undefined))
    out.push({ severity: "medium", issue: "Credit share not recorded: credited fee cannot be computed" });
  for (const r of rows) {
    const label = r.milestone ?? "fee milestone";
    if ((D(r.invoiced_amount) || D(r.recognised_amount) || D(r.collected_amount)) && !(r.evidence ?? "").trim())
      out.push({ severity: "high", issue: `${label}: amounts recorded without evidence` });
    const inv = D(r.invoiced_amount), col = D(r.collected_amount);
    if (col && !inv) out.push({ severity: "high", issue: `${label}: collection recorded without an invoice` });
    if (col && inv && col.gt(inv)) out.push({ severity: "high", issue: `${label}: collected exceeds invoiced (credit note or error?)` });
    if (inv && r.invoiced_on && (!col || col.lt(inv))) {
      const days = Math.round((Date.parse(asOf) - Date.parse(r.invoiced_on)) / 86_400_000);
      if (days > receivableDays) out.push({ severity: "high", issue: `${label}: ₹${f2(inv.minus(col ?? 0))} outstanding ${days} days after invoice` });
    }
    const g = D(r.gross_fee);
    if (g && inv && inv.gt(g)) out.push({ severity: "medium", issue: `${label}: invoiced exceeds gross fee` });
    if (!signedOrLater && (inv || D(r.recognised_amount))) out.push({ severity: "medium", issue: `${label}: invoiced/recognised before the deal is signed` });
  }
  return out;
}
