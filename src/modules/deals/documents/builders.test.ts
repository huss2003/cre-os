/**
 * Acceptance test "Editable artifacts": XLSX formulas reconcile to the engine; PPTX/DOCX are editable OOXML (native
 * text, not images) carrying the tenant brand, template id/version, freshness and the confidentiality watermark.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { evaluate, compareScenarios } from "../finance/engine";
import type { FinanceInput } from "../finance/types";
import { buildComparisonXlsx } from "./xlsx";
import { buildShortlistPptx } from "./pptx";
import { buildProposalDocx } from "./docx";
import { brandFrom, type DocModel } from "./model";

const A: FinanceInput = {
  name: "Option A", kind: "conventional", baseDate: "2027-01-15", horizonMonths: 60, annualDiscountRatePct: 12,
  area: { chargeableSf: 20000, carpetSf: 14000, plannedSeats: 180 }, tenureMonths: 60,
  rent: { basis: "chargeable", rate: 85, escalation: { pct: 15, everyMonths: 36 }, rentFreeMonths: 3 },
  cam: { mode: "mixed", fixedMonthly: 25000, ratePerSf: 12 }, parking: { slots: 20, ratePerSlot: 3500 },
  deposit: { months: 6 }, capex: { fitoutCost: 30000000, landlordContribution: 5000000, reinstatement: { amount: 2000000, period: 60 } },
  financing: { partnerName: "Partner X", principal: 20000000, annualInterestRate: 11, termMonths: 36, upfrontFee: 200000 },
  taxes: { treatment: "excluded", gstRatePct: 18 },
};
const B: FinanceInput = { ...A, name: "Option B — managed", kind: "managed", area: { plannedSeats: 180 }, rent: { basis: "seat", rate: 14500, escalation: { pct: 5, everyMonths: 12 } },
  cam: null, parking: null, deposit: { amount: 7830000 }, capex: null, financing: null, tenureMonths: 36, afterTenure: "continue_same_terms" };

function model(): DocModel {
  const results = [evaluate(A), evaluate(B)];
  return {
    purpose: "comparison_xlsx", title: "Financial comparison — Acme Pune", clientName: "Acme", generatedAt: "2026-11-01T00:00:00.000Z",
    brand: brandFrom({ name: "Tenant Advisory", primary: "#004B87", accent: "#E4002B", font: "Arial", disclaimer: "Indicative only." }, "fallback"),
    template: { id: "tpl-1", version: 3, name: "Tenant comparison master" },
    requirement: { title: "Acme Pune", status: "client_confirmed", lines: [["Area", "18,000 / 20,000 / 22,000 SF"]], missing: [] },
    options: [{ rank: 1, label: "Tower 1 · Floor 5", eligibility: "eligible", fitScore: 88, completenessScore: 90, area: "20,000 SF chargeable", cost: "₹97 / unit / month", availability: "available from 2027-01-01 (as of 2026-10-25)", flags: [], disqualifiers: [], verification: [] },
      { rank: 2, label: "Tower 9", eligibility: "needs_verification", fitScore: 70, completenessScore: 50, area: "unknown", cost: "unknown", availability: "no snapshot — unverified", flags: ["Vacancy unverified"], disqualifiers: [], verification: ["Space area unknown"] }],
    scenarios: results, annualRatePct: Object.fromEntries(results.map((r) => [r.outputHash, "12"])), comparison: compareScenarios([A, B]).rows,
    assumptions: ["60-month horizon"], freshness: ["Quote v2 valid until 2026-12-31"], watermark: "Confidential — prepared for Acme. Not for onward distribution.",
  };
}

/** Tiny evaluator for the formula subset the workbook uses: numbers, refs, sheet refs, SUM(range), + - * / ^ and parens. */
function makeEval(wb: ExcelJS.Workbook) {
  const memo = new Map<string, number>();
  const colNum = (c: string) => c.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const cellVal = (sheet: string, addr: string): number => {
    const key = `${sheet}!${addr}`;
    if (memo.has(key)) return memo.get(key)!;
    const ws = wb.getWorksheet(sheet)!;
    const v = ws.getCell(addr.replace(/\$/g, "")).value as unknown;
    let out: number;
    if (v && typeof v === "object" && "formula" in (v as object)) out = evalFormula(sheet, (v as { formula: string }).formula);
    else out = typeof v === "number" ? v : Number(v ?? 0);
    memo.set(key, out);
    return out;
  };
  const range = (sheet: string, a: string, b: string): number[] => {
    const [, c1, r1] = a.replace(/\$/g, "").match(/([A-Z]+)(\d+)/)!; const [, c2, r2] = b.replace(/\$/g, "").match(/([A-Z]+)(\d+)/)!;
    const out: number[] = [];
    for (let r = Number(r1); r <= Number(r2); r++) for (let c = colNum(c1); c <= colNum(c2); c++) {
      let s = ""; let n = c; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
      out.push(cellVal(sheet, `${s}${r}`));
    }
    return out;
  };
  function evalFormula(sheet: string, f: string): number {
    let expr = f.replace(/SUM\(((?:'[^']+'!)?\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)\)/g, (_m, a: string, b: string) => {
      const sm = a.match(/^'([^']+)'!(.*)$/);
      return `(${range(sm ? sm[1] : sheet, sm ? sm[2] : a, b).reduce((x, y) => x + y, 0)})`;
    });
    expr = expr.replace(/'([^']+)'!(\$?[A-Z]+\$?\d+)/g, (_m, s: string, a: string) => `(${cellVal(s, a)})`);
    expr = expr.replace(/\$?\b([A-Z]{1,3})\$?(\d+)\b/g, (_m, c: string, r: string) => `(${cellVal(sheet, `${c}${r}`)})`);
    expr = expr.replace(/\^/g, "**");
    return Function(`"use strict"; return (${expr});`)() as number;
  }
  return { cellVal };
}

describe("comparison XLSX (formulas reconcile to engine)", () => {
  it("TCO / NPV / equivalent monthly formulas match the engine to the paisa", async () => {
    const m = model();
    const { buffer, cells } = await buildComparisonXlsx(m);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ev = makeEval(wb);
    m.scenarios.forEach((r, i) => {
      const c = cells[i];
      expect(Math.abs(ev.cellVal(c.sheet, c.tco) - Number(r.totals.nominalTco))).toBeLessThan(0.005);
      expect(Math.abs(ev.cellVal(c.sheet, c.npv) - Number(r.totals.npv))).toBeLessThan(0.01);
      expect(Math.abs(ev.cellVal(c.sheet, c.equivalentMonthly) - Number(r.totals.equivalentMonthly))).toBeLessThan(0.01);
      expect(Math.abs(ev.cellVal("Comparison", `G${5 + i}`))).toBeLessThan(0.01); // formula − engine
    });
    // cells really are formulas (editable), not pasted values
    const ws = wb.getWorksheet(cells[0].sheet)!;
    expect((ws.getCell(cells[0].npv).value as { formula: string }).formula).toMatch(/^SUM\(/);
    expect((wb.getWorksheet("Comparison")!.getCell("D5").value as { formula: string }).formula).toContain(cells[0].sheet);
  });
});

describe("PPTX / DOCX are editable and branded", () => {
  it("deck has native text slides with watermark, template version and verification flags", async () => {
    const m = { ...model(), purpose: "shortlist_deck" as const };
    const buf = await buildShortlistPptx(m);
    const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBeGreaterThanOrEqual(5);
    const xml = (await Promise.all(slides.map((s) => zip.file(s)!.async("string")))).join("\n");
    const master = (await Promise.all(Object.keys(zip.files).filter((f) => /slideLayout|slideMaster/.test(f) && f.endsWith(".xml")).map((f) => zip.file(f)!.async("string")))).join("\n");
    expect(xml).toContain("Tower 1 · Floor 5");
    expect(xml).toContain("Vacancy unverified");
    expect(xml + master).toContain("Confidential — prepared for Acme");
    expect(xml + master).toContain("Tenant comparison master v3");
    expect(xml + master).toContain("004B87");
  });
  it("proposal DOCX has headings, tables, watermark header and the tenant font", async () => {
    const m = { ...model(), purpose: "proposal" as const };
    const zip = await JSZip.loadAsync(await buildProposalDocx(m));
    const doc = await zip.file("word/document.xml")!.async("string");
    const headers = (await Promise.all(Object.keys(zip.files).filter((f) => /word\/header\d*\.xml/.test(f)).map((f) => zip.file(f)!.async("string")))).join();
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain("Recommended options");
    expect(doc).toContain("Financial comparison");
    expect(doc).toContain("Indicative only.");
    expect(headers).toContain("Confidential — prepared for Acme");
    expect(doc + (await zip.file("word/styles.xml")!.async("string"))).toContain("Arial");
  });
});
