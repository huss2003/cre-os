import { describe, it, expect } from "vitest";
import { latestLiveAvailability } from "./inventory";
import { matchPath, readyPurpose } from "./purpose";

const live = { archived_at: null, asset: { archived_at: null } };
describe("supply inventory display", () => {
  it("one row per space (latest snapshot); archived spaces/buildings dropped", () => {
    const rows = [
      { id: "old", space_id: "s1", as_of: "2026-10-01", created_at: "a", space: live },
      { id: "new", space_id: "s1", as_of: "2026-11-01", created_at: "a", space: live },
      { id: "arch-asset", space_id: "s2", as_of: "2026-11-01", space: { archived_at: null, asset: { archived_at: "2026-11-02" } } },
      { id: "arch-space", space_id: "s3", as_of: "2026-11-01", space: { archived_at: "x", asset: { archived_at: null } } },
    ];
    expect(latestLiveAvailability(rows).map((r) => r.id)).toEqual(["new"]);
  });
});

describe("ready-to-present purpose", () => {
  it("survives the redirect", () => {
    expect(readyPurpose("site_visit")).toBe("site_visit");
    expect(readyPurpose("junk")).toBe("presentation");
    expect(matchPath("r1", "site_visit")).toBe("/buildings/supply?tab=match&requirement=r1&purpose=site_visit");
    expect(matchPath("r1", "presentation")).not.toContain("purpose");
  });
});
