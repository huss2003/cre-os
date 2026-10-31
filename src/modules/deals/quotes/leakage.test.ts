import { describe, it, expect } from "vitest";
import { quoteLeakageCheck } from "./service";

describe("quote leakage prevention", () => {
  const q = { version: 2, valid_until: "2026-12-31", superseded_by: null, evidence: "landlord email", terms_json: { rent: 80, rent_basis: "chargeable" as const, cam_per_sf: 12, gst: "excluded" as const, inclusions: "power backup" } };
  it("clean current quote has no blocking issues", () => {
    expect(quoteLeakageCheck(q, { asOf: "2026-11-01", recipient: "CFO", watermark: true }).filter((i) => i.blocking)).toEqual([]);
  });
  it("expired, superseded, unwatermarked or recipient-less shares are blocked", () => {
    const codes = (x: Parameters<typeof quoteLeakageCheck>[0], o: Parameters<typeof quoteLeakageCheck>[1]) => quoteLeakageCheck(x, o).filter((i) => i.blocking).map((i) => i.code);
    expect(codes({ ...q, valid_until: "2026-10-01" }, { asOf: "2026-11-01" })).toContain("expired");
    expect(codes({ ...q, superseded_by: "x" }, { asOf: "2026-11-01" })).toContain("superseded");
    expect(codes(q, { asOf: "2026-11-01", watermark: false })).toContain("no_watermark");
    expect(codes(q, { asOf: "2026-11-01", recipient: "" })).toContain("no_recipient");
  });
  it("unknown CAM / GST / inclusions are warnings, never silently assumed", () => {
    const w = quoteLeakageCheck({ ...q, terms_json: { rent: 80, rent_basis: "chargeable" } }, { asOf: "2026-11-01" }).map((i) => i.code);
    expect(w).toEqual(expect.arrayContaining(["cam_unknown", "gst_unknown", "inclusions_unknown"]));
  });
});
