/* Regression (real-data e2e): comparables by locality ignored tracker deals not linked to a building master. */
import { describe, expect, it } from "vitest";
import { comparables, type TxLite } from "./series";
import { txLocality } from "./service";

const tx = (id: string, locality: string | null, rent: [number, number] | null): TxLite => ({
  id, asset_id: null, asset_name: null, locality, period_start: "2023-06-01", deal_type: "conventional", area_sf: 10000,
  rent_min: rent?.[0] ?? null, rent_max: rent?.[1] ?? null, rent_basis: null, tenant: `T${id}`, source_object_id: null,
});

describe("market comparables — locality of unlinked tracker deals", () => {
  it("falls back to the source row's locality label; the linked building's locality wins when present", () => {
    expect(txLocality("Viman Nagar", { locality_raw: "Kharadi" })).toBe("Viman Nagar");
    expect(txLocality(null, { locality_raw: " Kharadi " })).toBe("Kharadi");
    expect(txLocality(null, { locality_raw: "" })).toBeNull();
    expect(txLocality(null, null)).toBeNull();
    expect(txLocality(null, { locality_raw: 42 })).toBeNull();
  });

  it("Kharadi comps include unlinked deals (rent basis still never mixed: unknown basis stays 'basis unknown')", () => {
    const rows = [
      tx("1", txLocality(null, { locality_raw: "Kharadi" }), [80, 84]),
      tx("2", txLocality(null, { locality_raw: "Kharadi" }), [90, 95]),
      tx("3", txLocality(null, { locality_raw: "Baner" }), [60, 65]),
      tx("4", txLocality(null, {}), [70, 75]),
    ];
    const r = comparables(rows, { locality: "kharadi" });
    expect(r.rows.map((x) => x.id).sort()).toEqual(["1", "2"]);
    expect(r.stats).toEqual([{ basis: "basis unknown", n: 2, median: 87.25, p25: expect.any(Number), p75: expect.any(Number) }]);
  });
});
