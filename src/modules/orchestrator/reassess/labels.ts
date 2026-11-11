/** Plain-language descriptions of requirement changes (pure; used in notices instead of raw column names). */
const FIELDS: Record<string, { label: string; unit?: string; kind?: "number" | "date" | "flag" }> = {
  area_min_sf: { label: "Minimum area", unit: "sq ft" },
  area_target_sf: { label: "Target area", unit: "sq ft" },
  area_max_sf: { label: "Maximum area", unit: "sq ft" },
  seats_target: { label: "Target seats", unit: "seats" },
  budget_max: { label: "Maximum budget" },
  occupation_date: { label: "Occupation date", kind: "date" },
  preferred_geography_ids: { label: "Preferred locations", kind: "flag" },
  constraints: { label: "Constraints", kind: "flag" },
};

export function fieldLabel(key: string): string {
  return FIELDS[key]?.label ?? key.replace(/_(sf|ids?)$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function fmt(v: unknown, kind?: string): string {
  if (v === null || v === undefined || v === "") return "not set";
  if (kind === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v.slice(0, 10) + "T00:00:00Z");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  return n !== null ? n.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : String(v);
}

/** e.g. { area_max_sf: [28000, 30000] } → "Maximum area 28,000 → 30,000 sq ft". */
export function describeChange(key: string, value: unknown): string {
  const f = FIELDS[key];
  const label = fieldLabel(key);
  if (Array.isArray(value) && value.length === 2) {
    const unit = f?.unit && value[1] !== null && value[1] !== undefined ? ` ${f.unit}` : "";
    return `${label} ${fmt(value[0], f?.kind)} → ${fmt(value[1], f?.kind)}${unit}`;
  }
  return `${label} updated`;
}

export function describeRequirementChanges(changed: Record<string, unknown> | null | undefined): string {
  const parts = Object.entries(changed ?? {}).map(([k, v]) => describeChange(k, v));
  return parts.length ? parts.join("; ") : "details updated";
}
