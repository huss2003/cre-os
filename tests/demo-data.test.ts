import { describe, it, expect } from "vitest";
import { buildDemoDataset } from "../scripts/demo-data";

type Row = Record<string, unknown>;
describe("demo dataset generator", () => {
  for (const today of ["2026-10-31", "2026-11-11", "2027-03-01"]) it(`satisfies space_unit_uq and availability_dates_chk (${today})`, () => {
    const b = buildDemoDataset(today);
    const rows = (t: string) => (b.find((x) => x.table === t)?.rows ?? []) as Row[];
    const keys = rows("space").filter((r) => r.unit).map((r) => `${r.asset_id}|${String(r.floor_text).toLowerCase()}|${String(r.unit).toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
    const bad = rows("availability").filter((r) => r.valid_until && r.available_from && (r.valid_until as string) < (r.available_from as string));
    expect(bad).toEqual([]);
    expect(JSON.stringify(buildDemoDataset(today))).toBe(JSON.stringify(b)); // deterministic
  });
});
