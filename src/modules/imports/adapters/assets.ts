/*
 * asset_list_v1 / ready_asset_v1 (spec Part III adapters 1-2, Part V file 1 and 9).
 * One building master, many source observations. Never invents upcoming status, completion dates or availability.
 */
import type { AdapterOptions, AssetObservationRecord, RowOutcome, SheetMapResult } from "../types";
import { exactKey, num, range, text } from "../normalize";
import { type Adapter, type RoleInput, RowRecord, f, issue, quarantine, records } from "./framework";

const ASSET_FIELDS = [
  f("building", "Building name", ["building name"], true),
  f("locality", "Locality name", ["locality name", "locality"], true),
  f("floor_size", "Floor size (sft)", ["floor size sft", "floor size"], true),
  f("total_area", "Total area (sft)", ["total area sft", "total area"], true),
  f("floors", "Floors", ["floors"], true),
  f("status", "Status", ["status"], true),
  f("transactions", "Transactions", ["transactions"], true),
];

/** A floor-plate range whose max is more than this multiple of its min is treated as a typo (min/max unknown). */
export const FLOOR_RANGE_MAX_SPREAD = 10;
/** Areas above this need campus-vs-tower scope verification (Part V: 11,395,916 SF observation). */
export const AREA_SCOPE_REVIEW_SF = 5_000_000;

function mapAssetRow(rec: RowRecord, sheet: string, label: string, opts: AdapterOptions, withRent: boolean): RowOutcome {
  const building = text(rec.get("building"));
  const locality = text(rec.get("locality"));
  if (!building || !locality) {
    return quarantine(sheet, rec.row, "missing_required", [
      issue("missing_required", `Building name and locality are required (got ${building ?? "blank"} / ${locality ?? "blank"})`, "review"),
    ]);
  }
  const issues = [];
  const flags: string[] = [];
  const fs = range(rec.get("floor_size"));
  if (!fs.ok) flags.push("floor_size_unparsed");
  // Real data: "45,000 - 35,000" (reversed) and "7,420 - 8" (typo) were silently sorted into min/max (an 8 sf floor plate).
  // Reversed ranges are flagged for review; an implausible spread (> 10x) keeps the raw text but leaves min/max unknown.
  const fsNums = (fs.text ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (fs.ok && fs.min !== null && fs.max !== null && fsNums.length === 2) {
    const implausible = fs.min > 0 && fs.max / fs.min > FLOOR_RANGE_MAX_SPREAD;
    if (fsNums[0] > fsNums[1] || implausible) {
      flags.push("floor_size_range_suspect");
      issues.push(issue("floor_size_range_suspect", `Floor size "${fs.text}" is ${implausible ? "implausible (min/max spread > " + FLOOR_RANGE_MAX_SPREAD + "x) — kept as text, min/max left unknown" : "reversed (larger value first) — verify"}`, "review",
        { floor_size_text: fs.text, parsed_min: fs.min, parsed_max: fs.max }));
      if (implausible) { fs.min = null; fs.max = null; }
    }
  }
  const ta = num(rec.get("total_area"));
  let total: number | null = null;
  let sourceZero = false;
  if (!ta.ok) flags.push("total_area_unparsed");
  else if (ta.value === 0) {
    sourceZero = true; // "zero in source; area unverified" — never a building with no area
    flags.push("total_area_source_zero");
  } else total = ta.value;
  if (total !== null && total >= AREA_SCOPE_REVIEW_SF) {
    issues.push(issue("area_scope_verify", `Total area ${total.toLocaleString("en-IN")} SF: verify campus vs tower scope`, "review", { total_area_sf: total }));
  }
  const tx = num(rec.get("transactions"));
  let avgRent: number | null = null;
  let asOf: string | null = null;
  if (withRent) {
    const r = num(rec.get("avg_rent"));
    if (r.value !== null && r.ok) {
      if (opts.as_of) {
        avgRent = r.value;
        asOf = opts.as_of;
      } else {
        flags.push("rent_without_as_of");
        issues.push(issue("rent_without_as_of", "Average rent populated but the batch has no as-of date; rent kept raw only", "review", { raw: r.raw }));
      }
    } else if (!r.ok) flags.push("avg_rent_unparsed");
  }
  const record: AssetObservationRecord = {
    kind: "asset_observation",
    identity_key: `${exactKey(building)}|${exactKey(locality)}`,
    sourceTabLabel: label as AssetObservationRecord["sourceTabLabel"],
    building_name: building,
    locality,
    floor_size_text: fs.text,
    floor_size_min_sf: fs.min,
    floor_size_max_sf: fs.max,
    total_area_sf: total,
    total_area_source_zero: sourceZero,
    floors_text: text(rec.get("floors")),
    status_raw: text(rec.get("status")),
    transactions_count: tx.ok && tx.value !== null ? Math.round(tx.value) : null,
    avg_rent: avgRent,
    as_of: asOf,
    fields: rec.rawFields(),
  };
  return { sheet, rowNumber: rec.row.rowNumber, status: "accepted", record, issues, flags };
}

function mapAssets(label: (sheet: string) => string, withRent: boolean) {
  return (input: RoleInput, opts: AdapterOptions): SheetMapResult => {
    const lbl = label(input.sheet.name);
    return {
      outcomes: records(input).map((r) => mapAssetRow(r, input.sheet.name, lbl, opts, withRent)),
      controls: [],
      issues: [],
    };
  };
}

export const assetListV1: Adapter = {
  id: "asset_list_v1",
  version: "1.0.0",
  label: "Asset inventory (existing / upcoming)",
  roles: [
    {
      role: "assets_existing",
      label: "Asset list with header row",
      fields: ASSET_FIELDS,
      map: mapAssets((s) => (/upcoming/i.test(s) ? "upcoming_inventory_label" : "existing"), false),
    },
    {
      role: "assets_headerless",
      label: "Headerless asset tab (approved 7-column positional map; first row is data)",
      fields: ASSET_FIELDS,
      headerless: true,
      positionalDefault: ["building", "locality", "floor_size", "total_area", "floors", "status", "transactions"],
      map: mapAssets((s) => (/upcoming/i.test(s) ? "upcoming_inventory_label" : "existing"), false),
    },
  ],
};

export const readyAssetV1: Adapter = {
  id: "ready_asset_v1",
  version: "1.0.0",
  label: "Ready buildings snapshot",
  roles: [
    {
      role: "ready",
      label: "Ready buildings list",
      fields: [
        ...ASSET_FIELDS.filter((x) => x.key !== "transactions"),
        f("transactions", "Transactions (agreements in software)", ["transactions agreements data available in the software", "transactions"], true),
        f("avg_rent", "Average building rental", ["average building rental", "average rental", "avg rent"], true),
      ],
      map: mapAssets(() => "ready_snapshot", true),
    },
  ],
};
