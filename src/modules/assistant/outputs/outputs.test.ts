// Outputs (round 2): export renderers produce valid pptx/docx/pdf, map block honesty, deterministic style stats.
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import type { Block } from "../types";
import { buildModel, exportFileName, hasStructured, pdfSafe, render } from "./render";
import { buildMapBlock, projectPoints, validCoord } from "./map";
import { styleStats, styleHintText } from "./style";

const SAMPLE: Block[] = [
  { kind: "text", markdown: "Here are **three** options in Kharadi.\n- Fastest: Tower A\n- Cheapest: unknown" },
  { kind: "table", title: "Options", columns: ["Building", "Rent ₹/sf", "Area"], rows: [["Tower A", 85, "20,000 sf"], ["Tower B", null, "—"]], note: "Rents as quoted", sources: [{ label: "Quote v2", observedAt: "2026-10-01", status: "reported" }] },
  { kind: "ranked_list", title: "Shortlist", items: [{ rank: 1, entity: { type: "asset", id: "a", label: "Tower A" }, score: 88, why: "Metro 400 m", next: "Site visit" }] },
  { kind: "brief", title: "Acme", sections: [{ heading: "Why now", bullets: ["Lease expires 2027-03"] }] },
  { kind: "entity_card", entity: { type: "company", id: "c", label: "Acme" }, fields: [{ label: "HQ", value: null }] },
  { kind: "sources", items: [{ label: "Economic Times", href: "https://example.com/very/long/url/that/should/wrap/in/the/pdf/renderer/without/breaking/anything", status: "reported" }] },
  { kind: "missing", items: ["Tower B rent not quoted"] },
  { kind: "map", points: [{ id: "a", label: "Tower A", lat: 18.55, lon: 73.94, kind: "building" }], note: "Stored coordinates only." },
];
const model = () => buildModel(SAMPLE, { title: "Kharadi options", generatedAt: "2026-11-11T05:00:00Z" });

describe("export renderers", () => {
  it("normalises blocks into sections + appendix inputs, keeping unknowns", () => {
    const m = model();
    expect(hasStructured(SAMPLE)).toBe(true);
    expect(hasStructured([{ kind: "text", markdown: "hi" }])).toBe(false);
    const t = m.sections.find((s) => s.heading === "Options")!;
    expect(t.table!.rows[1]).toEqual(["Tower B", "Unknown", "—"]);
    expect(m.sources.map((s) => s.label)).toEqual(["Quote v2", "Economic Times"]);
    expect(m.missing).toEqual(["Tower B rent not quoted"]);
    expect(exportFileName("Kharadi options!", "2026-11-11", "pptx")).toBe("kharadi-options-2026-11-11.pptx");
    expect(exportFileName(null, "2026-11-11", "pdf")).toBe("assistant-answer-2026-11-11.pdf");
  });
  it("builds a valid pptx with an appendix slide", async () => {
    const buf = await render("pptx", model());
    const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBeGreaterThanOrEqual(6);
    const all = (await Promise.all(slides.map((s) => zip.file(s)!.async("string")))).join("");
    expect(all).toContain("Appendix — Sources");
    expect(all).toContain("Tower B rent not quoted");
  });
  it("builds a valid docx", async () => {
    const zip = await JSZip.loadAsync(await render("docx", model()));
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Kharadi options");
    expect(xml).toContain("Appendix — Missing information");
    expect(xml).toContain("Unknown");
  });
  it("builds a valid pdf (non-WinAnsi characters made safe)", async () => {
    const buf = await render("pdf", model());
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdfSafe("₹85 ✓ 漢")).toBe("Rs 85 x ?");
  });
});

describe("map block", () => {
  it("places only records with stored coordinates and lists the rest as missing", () => {
    const r = buildMapBlock([
      { id: "a", label: "Tower A", lat: "18.55", lon: "73.94", kind: "building" },
      { id: "b", label: "Tower B", lat: null, lon: null, kind: "building" },
      { id: "c", label: "Null Island", lat: 0, lon: 0, kind: "other" },
      { id: "s", label: "Metro", lat: 18.56, lon: 73.93, kind: "station" },
    ], { centerId: "a", radiiKm: [3, 1, 1] });
    expect(r.placed).toBe(2);
    expect(r.missing).toEqual(["No coordinates recorded for Tower B", "No coordinates recorded for Null Island"]);
    expect(r.block!.rings).toEqual([{ centerId: "a", radiiKm: [1, 3] }]);
    expect(r.block!.note).toMatch(/straight-line/);
    expect(validCoord(91, 0)).toBeNull();
    expect(buildMapBlock([{ id: "x", label: "X", lat: null, lon: null, kind: "other" }], { centerId: "x", radiiKm: [1] }).block).toBeNull();
    const xy = projectPoints([{ lat: 18.5, lon: 73.8 }, { lat: 18.6, lon: 73.9 }]);
    expect(xy[0].x).toBeLessThan(xy[1].x); expect(xy[0].y).toBeGreaterThan(xy[1].y);
  });
});

describe("style stats", () => {
  const msgs = [
    "Hi Rahul,\nThanks for the quick call today. Sharing the shortlist as discussed.\nPlease let me know a good time for a site visit.\nRegards,\nAsha",
    "Hi Meera,\nSharing the shortlist as discussed. Please let me know your thoughts.\nRegards,\nAsha",
    "Dear Mr. Shah,\nPlease find attached the comparison. Happy to discuss.\nBest regards,\nAsha",
  ];
  it("is deterministic and order-independent", () => {
    const a = styleStats(msgs); const b = styleStats([...msgs].reverse());
    expect(a).toEqual(b);
    expect(a.samples).toBe(3);
    expect(a.greetings[0]).toEqual({ text: "Hi", count: 2 });
    expect(a.signOffs[0]).toEqual({ text: "Regards", count: 2 });
    expect(a.commonPhrases.map((p) => p.text)).toContain("sharing the shortlist");
    expect(a.formality.contractionsPer100Words).toBe(0);
    expect(styleHintText({ stats: a })).toContain('Usual greeting: "Hi"');
  });
  it("handles no samples", () => {
    expect(styleStats([]).samples).toBe(0);
  });
});
