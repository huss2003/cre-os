/**
 * Comparison workbook with REAL formulas (spec "Editable artifacts": XLSX formulas reconcile). Each scenario sheet holds
 * the engine's monthly cash flows as values and computes Total / discount factor / PV / TCO / NPV / equivalent monthly
 * with Excel formulas; the Comparison sheet references them and shows the engine value next to the formula value.
 */
import ExcelJS from "exceljs";
import type { DocModel } from "./model";

export const sheetNameFor = (i: number, name: string) => `S${i + 1} ${name.replace(/[\\/?*[\]:']/g, " ")}`.slice(0, 31).trim();
export const colLetter = (n: number) => { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export interface ScenarioCells { sheet: string; tco: string; npv: string; annuity: string; equivalentMonthly: string }

export async function buildComparisonXlsx(m: DocModel): Promise<{ buffer: Buffer; cells: ScenarioCells[] }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = m.brand.name;
  wb.created = new Date(m.generatedAt);
  const headFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${m.brand.primary}` } };
  const headFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" }, name: m.brand.font };
  const money = "#,##0.00";

  const summary = wb.addWorksheet("Comparison");
  const cells: ScenarioCells[] = [];

  m.scenarios.forEach((r, i) => {
    const name = sheetNameFor(i, r.name);
    const ws = wb.addWorksheet(name);
    ws.getCell("A1").value = "Scenario"; ws.getCell("B1").value = r.name;
    ws.getCell("A2").value = "Monthly discount rate"; ws.getCell("B2").value = { formula: "(1+B3)^(1/12)-1" } as ExcelJS.CellFormulaValue;
    ws.getCell("A3").value = "Annual discount rate"; ws.getCell("B3").value = m.annualRatePct[r.outputHash] !== undefined ? Number(m.annualRatePct[r.outputHash]) / 100 : annualFromMonthly(r.monthlyDiscountRate);
    ws.getCell("B3").numFmt = "0.00%"; ws.getCell("B2").numFmt = "0.0000000000";
    ws.getCell("C1").value = `Engine ${r.engineVersion} · output ${r.outputHash.slice(0, 12)} · base date ${r.baseDate}`;
    const cats = [...new Set(r.cashflows.map((c) => c.category))].sort();
    const head = ["Period", "Date", ...cats, "Total", "Discount factor", "PV"];
    const HR = 5;
    head.forEach((h, k) => { const c = ws.getCell(HR, k + 1); c.value = h; c.fill = headFill; c.font = headFont; });
    const totalCol = colLetter(2 + cats.length), dfCol = colLetter(3 + cats.length), pvCol = colLetter(4 + cats.length);
    const firstCat = colLetter(2), lastCat = colLetter(1 + cats.length);
    const byKey = new Map(r.cashflows.map((c) => [`${c.period}|${c.category}`, Number(c.amount)]));
    for (let p = 0; p <= r.horizonMonths; p++) {
      const row = HR + 1 + p;
      ws.getCell(`A${row}`).value = p;
      ws.getCell(`B${row}`).value = edateLabel(r.baseDate, p);
      cats.forEach((cat, k) => { const v = byKey.get(`${p}|${cat}`); const c = ws.getCell(row, 3 + k); c.value = v ?? 0; c.numFmt = money; });
      ws.getCell(`${totalCol}${row}`).value = { formula: cats.length ? `SUM(${firstCat}${row}:${lastCat}${row})` : "0" } as ExcelJS.CellFormulaValue;
      ws.getCell(`${dfCol}${row}`).value = { formula: `1/(1+$B$2)^A${row}` } as ExcelJS.CellFormulaValue;
      ws.getCell(`${pvCol}${row}`).value = { formula: `${totalCol}${row}*${dfCol}${row}` } as ExcelJS.CellFormulaValue;
      ws.getCell(`${totalCol}${row}`).numFmt = money; ws.getCell(`${pvCol}${row}`).numFmt = money; ws.getCell(`${dfCol}${row}`).numFmt = "0.000000";
    }
    const first = HR + 1, last = HR + 1 + r.horizonMonths, sr = last + 2;
    const put = (rr: number, label: string, formula: string) => {
      ws.getCell(`A${rr}`).value = label; ws.getCell(`A${rr}`).font = { bold: true };
      ws.getCell(`B${rr}`).value = { formula } as ExcelJS.CellFormulaValue; ws.getCell(`B${rr}`).numFmt = money;
    };
    put(sr, "Nominal TCO", `SUM(${totalCol}${first}:${totalCol}${last})`);
    put(sr + 1, "NPV", `SUM(${pvCol}${first}:${pvCol}${last})`);
    put(sr + 2, "Annuity factor", r.horizonMonths >= 1 ? `SUM(${dfCol}${first + 1}:${dfCol}${last})` : "1");
    ws.getCell(`B${sr + 2}`).numFmt = "0.0000000000";
    put(sr + 3, "Equivalent monthly", `B${sr + 1}/B${sr + 2}`);
    ws.getColumn(1).width = 22; ws.getColumn(2).width = 14;
    for (let k = 3; k <= head.length; k++) ws.getColumn(k).width = 16;
    ws.views = [{ state: "frozen", ySplit: HR, xSplit: 2 }];
    cells.push({ sheet: name, tco: `B${sr}`, npv: `B${sr + 1}`, annuity: `B${sr + 2}`, equivalentMonthly: `B${sr + 3}` });
  });

  // ---------------------------------------------------------------- comparison sheet
  summary.getCell("A1").value = m.title; summary.getCell("A1").font = { bold: true, size: 14, name: m.brand.font };
  summary.getCell("A2").value = m.watermark; summary.getCell("A2").font = { italic: true, color: { argb: `FF${m.brand.accent}` } };
  const hdr = ["Scenario", "Kind", "Nominal TCO", "NPV", "Equivalent monthly", "Engine NPV", "Formula − engine", "Rank (engine)", "Output hash"];
  hdr.forEach((h, k) => { const c = summary.getCell(4, k + 1); c.value = h; c.fill = headFill; c.font = headFont; });
  m.scenarios.forEach((r, i) => {
    const row = 5 + i, ref = cells[i], q = `'${ref.sheet}'!`;
    const cmp = m.comparison.find((c) => c.outputHash === r.outputHash);
    summary.getCell(`A${row}`).value = r.name;
    summary.getCell(`B${row}`).value = r.kind;
    summary.getCell(`C${row}`).value = { formula: `${q}${ref.tco}` } as ExcelJS.CellFormulaValue;
    summary.getCell(`D${row}`).value = { formula: `${q}${ref.npv}` } as ExcelJS.CellFormulaValue;
    summary.getCell(`E${row}`).value = { formula: `${q}${ref.equivalentMonthly}` } as ExcelJS.CellFormulaValue;
    summary.getCell(`F${row}`).value = Number(r.totals.npv);
    summary.getCell(`G${row}`).value = { formula: `D${row}-F${row}` } as ExcelJS.CellFormulaValue;
    summary.getCell(`H${row}`).value = cmp?.rank ?? null;
    summary.getCell(`I${row}`).value = r.outputHash;
    for (const c of ["C", "D", "E", "F", "G"]) summary.getCell(`${c}${row}`).numFmt = money;
  });
  let ar = 6 + m.scenarios.length;
  const block = (title: string, lines: string[]) => {
    summary.getCell(`A${ar}`).value = title; summary.getCell(`A${ar}`).font = { bold: true }; ar++;
    for (const l of lines) { summary.getCell(`A${ar}`).value = l; ar++; }
    ar++;
  };
  block("Assumptions", m.assumptions);
  block("Data freshness", m.freshness);
  block("Template", [`${m.template.name} (id ${m.template.id ?? "built-in"}, version ${m.template.version ?? 0})`, `Generated ${m.generatedAt}`]);
  if (m.brand.disclaimer) block("Disclaimer", [m.brand.disclaimer]);
  summary.getColumn(1).width = 34; for (let k = 2; k <= 9; k++) summary.getColumn(k).width = 18;

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, cells };
}

function annualFromMonthly(rm: string): number {
  return Math.pow(1 + Number(rm), 12) - 1;
}
function edateLabel(base: string, months: number): string {
  const [y, mo, d] = base.split("-").map(Number);
  const total = y * 12 + (mo - 1) + months;
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
