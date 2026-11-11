import { describe, it, expect } from "vitest";
import { ruleExtract } from "./extract";
import { factPreview, type StoredExtraction } from "./service";

const AT = "2026-10-31T12:30:00Z";
const stored = (answers: Record<string, string | number | null> = {}): StoredExtraction => {
  const ex = ruleExtract("spoke to Raj at Acme; 20k by March; maybe Baner; send options Friday", { sourceAt: AT });
  return { ...ex, meta: { mocked: true, model: "", extracted_at: AT, candidates: [], requirement_candidates: [], review: { resolutions: {}, answers },
    results: { facts: {}, tasks: {}, drafts: {} }, resolved: {}, warnings: [] } } as StoredExtraction;
};

describe("capture preview reflects answered clarifications", () => {
  it("move-in date is unknown until 'Which March?' is answered, then shows the answered value", () => {
    const s0 = stored();
    const occ0 = factPreview(s0).find((f) => f.field === "occupation_date")!;
    expect(occ0.value).toBeNull();
    const march = s0.ambiguities.findIndex((a) => /Which March/.test(a.question));
    const opt = s0.ambiguities[march].options.find((o) => String(o.value).startsWith("2027"))!.value;
    const occ1 = factPreview(stored({ [march]: opt })).find((f) => f.field === "occupation_date")!;
    expect(occ1.value).toBe("2027-03-31");
  });
  it("unit answer switches the previewed field; un-offered answers are ignored", () => {
    const s0 = stored();
    const unit = s0.ambiguities.findIndex((a) => a.kind === "unit");
    expect(unit).toBeGreaterThanOrEqual(0);
    const p = factPreview(stored({ [unit]: "area_target_sf" }));
    expect(p.find((f) => f.field === "area_target_sf")?.value).toBe(20000);
    const bogus = factPreview(stored({ [unit]: "nonsense" }));
    expect(bogus.find((f) => f.index === s0.ambiguities[unit].fact_index)?.value).toBeNull();
  });
});
