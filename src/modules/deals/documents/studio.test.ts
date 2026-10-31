/**
 * Workflow 12 acceptance (pure builders): generated documents are editable (native charts, shapes, tables), traceable
 * (sources + calc versions in every format), carry the uploaded master's theme/logo, and the market note has its own
 * template. The location map is a schematic from stored coordinates, skipped with a note when none exist.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { SaxesParser } from "saxes";
import { evaluate, compareScenarios } from "../finance/engine";
import type { FinanceInput } from "../finance/types";
import { brandFrom, type DocModel } from "./model";
import { buildShortlistPptx } from "./pptx";
import { buildProposalDocx } from "./docx";
import { buildMarketNoteDocx } from "./market-note";
import { buildComparisonXlsx } from "./xlsx";
import { extractTemplateTheme, imageSize } from "./theme";
import { buildMapModel, chartSpecs, haversineKm } from "./visuals";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const A: FinanceInput = { name: "Option A", kind: "conventional", baseDate: "2027-01-01", horizonMonths: 36, annualDiscountRatePct: 12, area: { chargeableSf: 20000 }, tenureMonths: 36, rent: { basis: "chargeable", rate: 85 } };
const B: FinanceInput = { ...A, name: "Option B", rent: { basis: "chargeable", rate: 90 } };

function model(over: Partial<DocModel> = {}): DocModel {
  const res = [evaluate(A), evaluate(B)];
  return {
    purpose: "proposal", title: "Proposal — Acme", clientName: "Acme", generatedAt: "2026-10-31T00:00:00.000Z",
    brand: brandFrom({ name: "Tenant Advisory" }, "x"), template: { id: "tpl", version: 2, name: "Master" },
    requirement: { title: "Acme", status: "client_confirmed", lines: [["Area", "20,000 SF"]], missing: [] },
    options: [
      { rank: 1, label: "Tower 1 · F5", eligibility: "eligible", fitScore: 90, completenessScore: 90, area: "20,000 SF", cost: "₹97", availability: "available (as of 2026-10-25)", flags: [], disqualifiers: [], verification: [], areaSf: 20000, costPerUnit: 97, lat: 18.5596, lon: 73.7799, locality: "Baner" },
      { rank: 2, label: "Tower 9", eligibility: "needs_verification", fitScore: 70, completenessScore: 50, area: "unknown", cost: "unknown", availability: "no snapshot — unverified", flags: ["Vacancy unverified"], disqualifiers: [], verification: [], areaSf: null, costPerUnit: null, lat: 18.5913, lon: 73.7389, locality: "Hinjewadi" },
    ],
    scenarios: res, annualRatePct: Object.fromEntries(res.map((r) => [r.outputHash, "12"])), comparison: compareScenarios([A, B]).rows,
    assumptions: ["36-month horizon"], freshness: ["Quote v2 valid until 2026-12-31"], watermark: "Confidential — prepared for Acme.",
    sources: ["Requirement \"Acme\" (abcd1234) row version 7 — client_confirmed", "Finance scenario \"Option A\": engine fin-1.0, output hash deadbeef"],
    targets: { areaMinSf: 18000, areaTargetSf: 20000, areaMaxSf: 22000, areaBasis: "chargeable", budgetMin: 70, budgetMax: 95, budgetBasis: "per_sf_month" },
    map: buildMapModel([{ label: "1. Tower 1", lat: 18.5596, lon: 73.7799, kind: "option" }, { label: "2. Tower 9", lat: 18.5913, lon: 73.7389, kind: "option" }, { label: "Baner", lat: 18.559, lon: 73.786, kind: "preferred_area" }]),
    templateCarryOver: ["Uploaded master \"Master\" v2 — carried over: theme colours", "Not carried over from the master: slide layouts"],
    version: { no: 3, familyId: "fam-1", parentId: "prev-1" },
    ...over,
  };
}
const wellFormed = (xml: string) => { const p = new SaxesParser({ xmlns: true }); p.write(xml).close(); return true; };
const allXml = async (zip: JSZip, re: RegExp) => (await Promise.all(Object.keys(zip.files).filter((f) => re.test(f)).map((f) => zip.file(f)!.async("string")))).join("\n");

describe("visual data", () => {
  it("charts use engine outputs and stored values; unknown values are excluded and said so", () => {
    const specs = chartSpecs(model());
    expect(specs.map((s) => s.key)).toEqual(["cost_comparison", "tco_npv", "area_vs_target", "cost_vs_budget"]);
    const area = specs.find((s) => s.key === "area_vs_target")!;
    expect(area.categories).toEqual(["1. Tower 1 · F5"]);
    expect(area.notes.join()).toMatch(/1 option\(s\) with unknown area are not plotted/);
    expect(specs[0].series[0].values[0]).toBe(Number(model().comparison[0].equivalentMonthly));
  });
  it("schematic map: projected points, km scale, and null when no coordinates", () => {
    const mp = buildMapModel([{ label: "a", lat: 18.5, lon: 73.8, kind: "option" }, { label: "b", lat: 18.6, lon: 73.9, kind: "option" }, { label: "c", lat: null, lon: null, kind: "option" }])!;
    expect(mp.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
    expect(mp.points[1].y).toBeLessThan(mp.points[0].y); // north is up
    expect(mp.missing).toEqual(["c"]);
    expect(mp.widthKm).toBeGreaterThan(10);
    expect(mp.scaleKm).toBeLessThanOrEqual(mp.widthKm * 0.3);
    expect(Math.round(haversineKm({ lat: 18.52, lon: 73.85 }, { lat: 19.07, lon: 72.88 }))).toBe(119); // Pune–Mumbai ≈ 119 km
    expect(buildMapModel([{ label: "x", lat: null, lon: null, kind: "option" }])).toBeNull();
  });
});

describe("uploaded master template", () => {
  it("extracts theme colours, fonts and logo; explicit brand settings still win", async () => {
    const zip = new JSZip();
    zip.file("ppt/theme/theme1.xml", `<a:theme xmlns:a="x"><a:themeElements><a:clrScheme name="t"><a:dk2><a:srgbClr val="0B0B0B"/></a:dk2><a:accent1><a:srgbClr val="112233"/></a:accent1><a:accent2><a:srgbClr val="445566"/></a:accent2></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`);
    zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", `<Relationships xmlns="x"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>`);
    zip.file("ppt/media/logo.png", PNG);
    const theme = await extractTemplateTheme(await zip.generateAsync({ type: "nodebuffer" }), "pptx");
    expect(theme).toMatchObject({ primary: "112233", accent: "445566", font: "Verdana", headingFont: "Georgia" });
    expect(theme.logo).toMatchObject({ type: "png", width: 1, height: 1 });
    expect(theme.carried.join()).toMatch(/logo \(logo.png/);
    expect(theme.notCarried.join()).toMatch(/slide layouts/);
    expect(brandFrom({}, "T", theme)).toMatchObject({ primary: "112233", font: "Verdana", headingFont: "Georgia" });
    expect(brandFrom({ primary: "#004B87" }, "T", theme).primary).toBe("004B87");
    expect(imageSize(PNG)).toEqual({ type: "png", width: 1, height: 1 });
    // the deck carries the extracted logo and fonts
    const deck = await JSZip.loadAsync(await buildShortlistPptx(model({ purpose: "shortlist_deck", brand: brandFrom({ name: "T" }, "T", theme) })));
    expect(Object.keys(deck.files).some((f) => /^ppt\/media\/.+\.png$/.test(f))).toBe(true);
    expect(await allXml(deck, /^ppt\/slides\/slide\d+\.xml$/)).toContain("Georgia");
    const bad = await extractTemplateTheme(Buffer.from("not a zip"), "docx");
    expect(bad.warnings[0]).toMatch(/not a readable Office file/);
  });
});

describe("generated documents are editable and traceable", () => {
  it("deck: native charts, schematic map with labels + scale, sources slide", async () => {
    const zip = await JSZip.loadAsync(await buildShortlistPptx(model({ purpose: "shortlist_deck" })));
    const charts = Object.keys(zip.files).filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f));
    expect(charts.length).toBe(4);
    const slides = await allXml(zip, /^ppt\/slides\/slide\d+\.xml$/);
    expect(slides).toContain("Location map (schematic)");
    expect(slides).toContain("1. Tower 1");
    expect(slides).toMatch(/\d+(\.\d+)? km/);
    expect(slides).toContain("Sources and calculation versions");
    expect(slides).toContain("output hash deadbeef");
    expect(slides).toContain("Not carried over from the master");
    const noMap = await JSZip.loadAsync(await buildShortlistPptx(model({ purpose: "shortlist_deck", map: null })));
    expect(await allXml(noMap, /^ppt\/slides\/slide\d+\.xml$/)).toContain("No map: none of the options");
  });

  it("proposal DOCX: native Word charts (with embedded data) and a map chart, well-formed, sources listed", async () => {
    const zip = await JSZip.loadAsync(await buildProposalDocx(model()));
    const doc = await zip.file("word/document.xml")!.async("string");
    expect(doc).not.toContain("[[CRECHART:");
    expect((doc.match(/<c:chart /g) ?? []).length).toBe(5); // 4 bar charts + map
    expect(doc).toMatch(/<w:document [^>]*xmlns:wp=/);
    expect(wellFormed(doc)).toBe(true);
    for (let n = 1; n <= 5; n++) {
      const c = await zip.file(`word/charts/chart${n}.xml`)!.async("string");
      expect(wellFormed(c)).toBe(true);
      expect(await zip.file(`word/charts/_rels/chart${n}.xml.rels`)!.async("string")).toContain(`cre_chart_data_${n}.xlsx`);
    }
    expect(await zip.file("word/charts/chart5.xml")!.async("string")).toContain("<c:scatterChart>");
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain("drawingml.chart+xml");
    expect(await zip.file("word/_rels/document.xml.rels")!.async("string")).toContain("charts/chart1.xml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await zip.file("word/embeddings/cre_chart_data_1.xlsx")!.async("nodebuffer")) as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Sheet1")!.getCell("B2").value).toBe(Number(model().comparison[0].equivalentMonthly));
    expect(doc).toContain("Sources and calculation versions");
    expect(doc).toContain("Plot width");
  });

  it("market note has its own template (not the proposal)", async () => {
    const m = model({ purpose: "market_note", title: "Market note — Acme", market: {
      geographies: ["Baner"], availabilitySummary: [{ status: "available", count: 1 }],
      askingRent: { min: 85, max: 95, basis: "chargeable", observations: 1, asOfRange: "2026-10-25" },
      observations: [{ metric: "vacancy_rate", geography: "Baner", period: "quarter 2026-07-01–2026-09-30", value: "14.2", unit: "%", source: "Licensed Q3 report (released 2026-10-10)" }],
    } });
    const zip = await JSZip.loadAsync(await buildMarketNoteDocx(m));
    const doc = await zip.file("word/document.xml")!.async("string");
    for (const h of ["Market observations", "Availability picture", "Caveats", "Sources and calculation versions", "vacancy_rate", "Licensed Q3 report"]) expect(doc).toContain(h);
    expect(doc).not.toContain("Recommended options");
    expect(doc).not.toContain("Financial comparison");
    const empty = await JSZip.loadAsync(await buildMarketNoteDocx(model({ purpose: "market_note", market: null, options: [] })));
    expect(await empty.file("word/document.xml")!.async("string")).toContain("No market observations stored");
  });

  it("comparison workbook lists the sources and calc versions", async () => {
    const { buffer } = await buildComparisonXlsx(model({ purpose: "comparison_xlsx" }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const texts: string[] = [];
    wb.getWorksheet("Comparison")!.eachRow((r) => r.eachCell((c) => texts.push(String(c.value))));
    expect(texts.join("\n")).toContain("Sources and calculation versions");
    expect(texts.join("\n")).toContain("output hash deadbeef");
  });
});
