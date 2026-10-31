import { describe, it, expect } from "vitest";
import { crmOnlyChanges, detectConflicts } from "./export";

describe("official CRM conflict (acceptance test)", () => {
  it("shows a competing CRM update instead of overwriting it", () => {
    const base = { stage: "loi", expected_fee: 3000000, expected_close: "2026-12-31" };
    const local = { stage: "documentation", expected_fee: 3200000, expected_close: "2026-12-31" };
    const external = { stage: "loi", expected_fee: 2800000, expected_close: "2027-01-31" };
    const c = detectConflicts(base, local, external);
    expect(c).toEqual([{ field: "expected_fee", base: 3000000, local: 3200000, external: 2800000 }]);
    // the CRM's newer close date is not re-entered from our stale copy
    expect(crmOnlyChanges(base, local, external)).toEqual(["expected_close"]);
  });
  it("no conflict when the CRM did not change, or changed to the value we propose", () => {
    expect(detectConflicts({ stage: "loi" }, { stage: "signed" }, { stage: "loi" })).toEqual([]);
    expect(detectConflicts({ stage: "loi" }, { stage: "signed" }, { stage: "signed" })).toEqual([]);
    expect(detectConflicts({ expected_fee: 100 }, { expected_fee: 100 }, { expected_fee: "100" })).toEqual([]);
  });
});
