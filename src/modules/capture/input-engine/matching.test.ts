import { describe, expect, it } from "vitest";
import { analyse, buildReceipt, matchTier } from "./analysis";
import { matchBuildings, questionable, tieBreakOrg } from "./matching";
import { LEGACY_FORMAT_NOTE, isLegacyOfficeName, legacyNote, SCANNED_PDF_NOTE } from "./office";
import { suspiciousArea, suspiciousRent, parseArea, parseRent } from "@/modules/imports/validate";

const assets = [
  { id: "eon", name: "EON Free Zone", locality: "Kharadi", aliases: [] },
  { id: "eonB", name: "Tower B", parentName: "EON Free Zone", locality: "Kharadi" },
  { id: "wtcB", name: "Tower B", parentName: "World Trade Center", locality: "Kharadi" },
  { id: "wtc", name: "World Trade Center", locality: "Kharadi", aliases: ["WTC Pune"] },
  { id: "panch", name: "Panchshil Business Park", locality: "Balewadi" },
];

describe("building / business-park matching in notes (suggestions only)", () => {
  it("EON Kharadi → EON Free Zone via name + locality (medium)", () => {
    const s = matchBuildings("Met the admin head, they like EON Kharadi for 40k sf", assets);
    const eon = s.find((x) => x.asset_id === "eon")!;
    expect(eon.tier).toBe("medium");
    expect(eon.text).toBe("EON Kharadi");
  });
  it("Tower B alone is ambiguous across campuses (low); with campus named it is high", () => {
    const amb = matchBuildings("Visit Tower B on Friday", assets).filter((x) => x.asset_id === "eonB" || x.asset_id === "wtcB");
    expect(amb).toHaveLength(2);
    expect(amb.every((x) => x.tier === "low")).toBe(true);
    const s = matchBuildings("EON Free Zone Tower B, 5th floor is available", assets);
    expect(s.find((x) => x.asset_id === "eonB")!.tier).toBe("high");
    expect(s.find((x) => x.asset_id === "eon")!.tier).toBe("high");
  });
  it("aliases match exactly; unrelated text gives nothing", () => {
    expect(matchBuildings("Quote from WTC Pune landlord", assets).find((x) => x.asset_id === "wtc")!.reason).toMatch(/alias/);
    expect(matchBuildings("Call Anil tomorrow about budget", assets)).toEqual([]);
  });
  it("receipt states suggestion only, never linked", () => {
    const r = buildReceipt({ sourceLabel: "Note", matches: [], questions: [], tasks: [], conflicts: [], repeats: 0, saved: 1, buildings: matchBuildings("EON Kharadi", assets) });
    expect(r.lines.some((l) => /suggestion only, not linked/.test(l.text))).toBe(true);
  });
});

describe("company tie-breakers", () => {
  const cands = [{ id: "a", entity_type: "organisation", label: "Acme India", score: 1 }, { id: "b", entity_type: "organisation", label: "Acme India", score: 1 }];
  it("parent/subsidiary relation to a linked company wins (medium, confirm)", () => {
    const r = matchTier({ kind: "organisation", text: "Acme India" }, cands, { tie: { text: "Acme India wants space", related: { b: "subsidiary of a linked company" }, cityOf: {} } });
    expect(r.tier).toBe("medium");
    expect(r.id).toBe("b");
    expect(r.reason).toMatch(/subsidiary/);
  });
  it("HQ city named in the note wins", () => {
    expect(tieBreakOrg(cands, { text: "Acme India Pune office expanding", related: {}, cityOf: { a: "Mumbai", b: "Pune" } })?.id).toBe("b");
  });
  it("no tie-breaker => stays low; never high", () => {
    const r = matchTier({ kind: "organisation", text: "Acme India" }, cands, { tie: { text: "Acme India", related: {}, cityOf: { a: "Pune", b: "Pune" } } });
    expect(r.tier).toBe("low");
    expect(r.id).toBeNull();
  });
});

describe("outlier check (questionable, never blocked)", () => {
  it("bands", () => {
    expect(questionable({ key: "rent_psf", value: 9, unit: "INR/sf/month", pricing_basis: "per_sf_month" })).toMatch(/15–400/);
    expect(questionable({ key: "rent_psf", value: 450, unit: "INR/sf/month", pricing_basis: "per_sf_month" })).toMatch(/check/);
    expect(questionable({ key: "rent_psf", value: 95, unit: "INR/sf/month", pricing_basis: "per_sf_month" })).toBeNull();
    expect(questionable({ key: "carpet_area", value: 60, unit: "sf", pricing_basis: null })).toMatch(/100/);
    expect(questionable({ key: "area", value: 2_500_000, unit: "sf", pricing_basis: null })).toMatch(/check/);
    expect(questionable({ key: "security_deposit", value: 36, unit: "months_rent", pricing_basis: null })).toMatch(/24 months/);
    expect(questionable({ key: "cam", value: 75, unit: "INR/sf/month", pricing_basis: "per_sf_month" })).toMatch(/60/);
  });
  it("analyse keeps the value, flags source_ref.questionable and lowers confidence", () => {
    const a = analyse({ prefix: "t", text: "Quoted rent ₹950 per sq ft per month, CAM extra", extraction: null, sourceType: "typed_note" });
    const o = a.observations.find((x) => x.field === "rent_psf")!;
    expect(o.value_json).toBe(950);
    expect(o.source_ref.questionable).toMatch(/outside/);
    expect(o.confidence).toBe(0.3);
  });
  it("import bands match (rent ₹15–400/sf, area ≤ 20 lakh sf)", () => {
    const n = (v: number) => ({ v, t: "n" as const });
    expect(suspiciousRent(parseRent({ v: "₹500/sf", t: "s" } as never))).toMatch(/15–400/);
    expect(suspiciousArea(parseArea(n(3_000_000) as never, "area sq ft"))).toMatch(/implausibly/);
  });
});

describe("legacy formats / scanned PDFs", () => {
  it("clear notes", () => {
    expect(LEGACY_FORMAT_NOTE).toBe("Old format — save as .docx/.pptx/.xlsx for full extraction");
    expect(legacyNote("old.doc")).toMatch(/kept as uploaded/);
    expect(isLegacyOfficeName("a.PPT") && isLegacyOfficeName("b.xls") && !isLegacyOfficeName("c.docx")).toBe(true);
    expect(SCANNED_PDF_NOTE).toMatch(/no text layer/);
  });
});
