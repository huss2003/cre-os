import { describe, expect, it } from "vitest";
import { describeRequirementChanges, fieldLabel } from "./labels";

describe("requirement change labels", () => {
  it("uses plain labels and units instead of column names", () => {
    expect(describeRequirementChanges({ area_max_sf: [28000, 30000] })).toBe("Maximum area 28,000 → 30,000 sq ft");
    expect(describeRequirementChanges({ seats_target: [null, 280], occupation_date: [null, "2027-06-01"] })).toBe("Target seats not set → 280 seats; Occupation date not set → 1 Jun 2027");
    expect(describeRequirementChanges({ preferred_geography_ids: true })).toBe("Preferred locations updated");
    expect(describeRequirementChanges({})).toBe("details updated");
    expect(fieldLabel("area_max_sf")).not.toContain("_");
  });
});
