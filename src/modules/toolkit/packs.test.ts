import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { DEFAULT_BRAND } from "@/modules/deals/documents/model";
import { PDFDocument } from "pdf-lib";
import { buildPackPptx, buildSiteVisitDocx, buildSiteVisitPdf, figuresFromAnalysis, imageInfo, quoteTerms, PACK_CHECKLIST, type PackModel } from "./packs";
import { evidenceSummary } from "./evidence";

const unverified = quoteTerms({ version: 2, approved_at: null, valid_until: "2026-10-31", terms_json: { rent: 85, rent_basis: "chargeable", deposit_months: 6, escalation_pct: 5, escalation_every_months: 36 } }, "2026-11-10");
const verified = quoteTerms({ version: 1, approved_at: "2026-10-01", valid_until: "2027-01-31", terms_json: { rent: 95, rent_basis: "carpet", cam_included: true } }, "2026-11-10");
const model: PackModel = {
  title: "Acme Pune — property pack", clientName: "Acme", generatedAt: "2026-11-10T00:00:00Z", brand: DEFAULT_BRAND, watermark: "Confidential",
  requirement: { title: "Acme Pune", lines: [["Area", "40,000 – 50,000 SF"], ["Budget", "Unknown"]], missing: ["Budget"] },
  properties: [
    { id: "a1", name: "EON Tower B", address: "Kharadi", location: "Kharadi, Pune East", grade: "A", floors: "12", amenities: ["Food court"], specs: [["power", "2 kVA/100 SF"]], commercial: unverified.terms, notes: unverified.notes },
    { id: "a2", name: "WTC Tower 2", address: null, location: null, grade: null, floors: null, amenities: [], specs: [], commercial: [{ label: "Rent (asking)", value: "₹90/SF/month", verification: "Estimated", source: "Availability snapshot" }], notes: [] },
    { id: "a3", name: "Panchshil BP", address: null, location: null, grade: null, floors: null, amenities: [], specs: [], commercial: verified.terms, notes: verified.notes },
  ],
  figures: [figuresFromAnalysis({ kind: "property_comparison", title: "Kharadi shortlist", current_version: 3, outputs: { properties: [{ name: "EON Tower B", rank: 1, score: 82, occupancyCost: 101, eligibility: "eligible", evidence: "quoted" }, { name: "WTC Tower 2", rank: 2, score: 70, occupancyCost: null, eligibility: "unconfirmed", evidence: "estimated" }], recommendation: { key: "a", explanation: "EON", tie: false } } })!],
  recommendation: ["EON Tower B best fits on score."], sources: ["Quote v2"],
};

async function zipText(buf: Buffer, re: RegExp) {
  expect(buf.subarray(0, 2).toString("latin1")).toBe("PK"); // zip signature
  const z = await JSZip.loadAsync(buf);
  const parts = await Promise.all(Object.keys(z.files).filter((n) => re.test(n)).map((n) => z.file(n)!.async("string")));
  return parts.join("\n");
}

describe("packs", () => {
  it("labels quote terms by verification and flags expiry", () => {
    expect(unverified.terms.find((t) => t.label === "Rent")).toMatchObject({ verification: "Unverified", value: "₹85/SF chargeable/month" });
    expect(unverified.terms.find((t) => t.label === "Lock-in")).toMatchObject({ verification: "Unknown", value: "Unknown" });
    expect(unverified.notes.join(" ")).toMatch(/expired on 2026-10-31/);
    expect(verified.terms.find((t) => t.label === "CAM")).toMatchObject({ verification: "Verified", value: "Included" });
    expect(quoteTerms({ version: 1, approved_at: "x", terms_json: { rent: 1 } }, "2026-11-10", true).terms[0].verification).toBe("Conflicting");
  });
  it("site visit pack is a valid DOCX with verification labels, checklist and feedback section", async () => {
    const xml = await zipText(await buildSiteVisitDocx(model), /^word\/document\.xml$/);
    for (const s of ["EON Tower B", "Unverified", "Estimated", "Verified", "Building access", "Client feedback", "Concerns / objections", "expired on 2026-10-31"]) expect(xml).toContain(s);
  });
  it("site visit pack covers every assessment topic, attached layouts and a blank feedback form", async () => {
    // 1×1 PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    expect(imageInfo(png)).toEqual({ type: "png", width: 1, height: 1 });
    expect(imageInfo(Buffer.from("not an image"))).toBeNull();
    const withMedia: PackModel = { ...model, properties: [{ ...model.properties[0], media: [{ kind: "floor_plan", title: "EON Tower B floor 5 plan", image: { data: png, type: "png", width: 1, height: 1 } }, { kind: "photo", title: "EON lobby", image: null }] }, ...model.properties.slice(1)] };
    const buf = await buildSiteVisitDocx(withMedia);
    const xml = await zipText(buf, /^word\/document\.xml$/);
    for (const c of PACK_CHECKLIST) expect(xml).toContain(c.label);
    for (const s of ["Commute", "Operational constraints", "Price concerns", "Stakeholder reactions", "Overall suitability", "Key commercials", "Floor plan: EON Tower B floor 5 plan", "Client feedback form", "No photos or floor plans attached"]) expect(xml).toContain(s);
    expect(Object.keys((await JSZip.loadAsync(buf)).files).some((n) => n.startsWith("word/media/"))).toBe(true);
    const pdf = await buildSiteVisitPdf(withMedia);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(2);
  });
  it("presentation deck is a valid PPTX with comparison figures and labels", async () => {
    const xml = await zipText(await buildPackPptx(model), /^ppt\/slides\/slide\d+\.xml$/);
    for (const s of ["Shortlist", "Commercial terms — EON Tower B", "Unverified", "WTC Tower 2 [Estimated]", "Property comparison", "Recommendation", "Kharadi shortlist"]) expect(xml).toContain(s);
  });
  it("evidence summary flags conflicts", () => {
    expect(evidenceSummary([{ verification: "verified" }, { verification: "conflicting" }])).toMatchObject({ total: 2, conflicting: 1, hasConflict: true });
    expect(evidenceSummary([]).hasConflict).toBe(false);
  });
});
