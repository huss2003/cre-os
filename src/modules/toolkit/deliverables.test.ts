import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { analysisFlags, buildDecisionSummary, buildProposal, buildWorkbook, flatten, prepare, type DeliverableModel } from "./deliverables";
import { buildBrief } from "./brief";
import { DEFAULT_BRAND } from "@/modules/deals/documents/model";

const lease = prepare({ id: "a1", kind: "lease_economics", title: "Tower A lease", status: "approved", version: 2, formula_version: "lease-1.0", missing: [],
  inputs: { rent: { value: 95, fact_status: "estimated" }, tenure_months: 60 }, outputs: { total_cost: 1234567.5, recommended: { name: "Tower A" }, risks: ["Escalation above market"] } });
const nego = prepare({ id: "a2", kind: "negotiation", title: "Nego", status: "needs_info", version: 1, formula_version: "nego-1.0", missing: ["walk-away rent"], inputs: {}, outputs: { trade_offs: "Longer lock-in for rent-free" } });
const model: DeliverableModel = { brand: DEFAULT_BRAND, title: "Proposal — Pune HQ", preparedFor: "CFO", asOf: "2026-11-10",
  brief: buildBrief({ requirement: { id: "r1", title: "Pune HQ", row_version: 1, constraints: {} } as never, stakeholders: [], pendingProposals: [] }), analyses: [lease, nego] };
const docText = async (b: Buffer) => (await (await JSZip.loadAsync(b)).file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

describe("deliverable labelling", () => {
  it("flags missing info and unapproved analyses", () => {
    expect(analysisFlags({ status: "approved", missing: [] })).toEqual([]);
    expect(analysisFlags({ status: "needs_info", missing: ["x"] }).join(" ")).toMatch(/MISSING INFO: x.*UNVERIFIED/);
  });
  it("labels figures under estimated status and blank values", () => {
    const l = flatten({ rent: { value: 95, fact_status: "estimated" }, area: null, ok: 1 });
    expect(l.find((x) => x.path === "rent.value")!.flag).toMatch(/ESTIMATED/);
    expect(l.find((x) => x.path === "area")!.flag).toBe("MISSING");
    expect(l.find((x) => x.path === "ok")!.flag).toBeNull();
    expect(lease.recommendation).toBe("Tower A");
  });
});

describe("deliverable files", () => {
  it("proposal DOCX carries brief, figures and labels", async () => {
    const t = await docText(await buildProposal(model));
    expect(t).toContain("Your requirement");
    expect(t).toContain("Tower A lease");
    expect(t).toContain("MISSING INFO: walk-away rent");
    expect(t).toContain("lease-1.0");
  });
  it("decision summary has every required section", async () => {
    const t = await docText(await buildDecisionSummary(model));
    for (const h of ["Options considered", "Recommended option", "Financial implications", "Trade-offs", "Risks", "Assumptions", "Outstanding approvals"]) expect(t).toContain(h);
    expect(t).toContain("Tower A (from Lease economics");
    expect(t).toContain("Analysis \"Nego\" (needs info)");
  });
  it("workbook has a summary plus one sheet per analysis with inputs, outputs and formula version", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(model)) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "1 Lease economics", "2 Negotiation"]);
    const s1 = wb.getWorksheet("1 Lease economics")!;
    const vals = s1.getSheetValues().flat().map(String).join("|");
    expect(vals).toContain("lease-1.0");
    expect(vals).toContain("rent.value");
    expect(vals).toMatch(/ESTIMATED/);
    expect(vals).toContain("total_cost");
  });
});
