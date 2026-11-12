import { describe, it, expect } from "vitest";
import { placeKeys, placesOverlap } from "./service";

describe("micro-market name matching", () => {
  it("strips parentheticals/aliases and normalises case", () => {
    expect(placeKeys("Kharadi (SBD East)")).toEqual(["kharadi", "sbd east"]);
    expect(placesOverlap(["SBD East", "Kharadi"], ["Kharadi"])).toBe(true);
    expect(placesOverlap(["Kharadi (SBD East)"], ["kharadi"])).toBe(true);
    expect(placesOverlap(["SBD East", null], ["Kharadi (SBD East)"])).toBe(true);
  });
  it("still flags a genuinely different location", () => {
    expect(placesOverlap(["Hinjewadi", "Hinjewadi Phase 1"], ["Kharadi"])).toBe(false);
  });
});
