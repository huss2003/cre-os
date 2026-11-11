import { z } from "zod";
import { edate } from "@/lib/util/time";

/** Typed account-finder filter (spec §2.9). Every field optional; nothing here is ever turned into SQL text. */
export const AREA_BASES = ["any", "chargeable", "carpet", "builtup", "super_builtup"] as const;
export const EVENT_TYPES = ["expiry", "lockin_end", "notice_deadline", "break"] as const;
export const EVENT_LABEL: Record<(typeof EVENT_TYPES)[number], string> = { expiry: "expiry", lockin_end: "lock-in end", notice_deadline: "notice deadline", break: "break option" };
export const SCORE_BANDS = ["Very High", "High", "Medium", "Low"] as const;
export const REQ_STATUSES = ["draft", "estimated", "client_confirmed", "closed"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shortText = z.string().trim().min(1).max(80);

export const eventWindowSchema = z.union([
  z.object({ kind: z.literal("within_months"), months: z.number().int().min(1).max(120) }),
  z.object({ kind: z.literal("next_calendar_year") }),
  z.object({ kind: z.literal("this_calendar_year") }),
  z.object({ kind: z.literal("between"), from: isoDate, to: isoDate }),
]);
export type EventWindow = z.infer<typeof eventWindowSchema>;

export const accountFilterSchema = z.object({
  areaMinSf: z.number().min(0).max(50_000_000).optional(),
  areaMaxSf: z.number().min(0).max(50_000_000).optional(),
  areaBasis: z.enum(AREA_BASES).optional(),
  places: z.array(shortText).max(10).optional().describe("Micro-market / locality / city names, resolved against the geography table"),
  geographyIds: z.array(z.string().uuid()).max(50).optional(),
  grades: z.array(z.string().trim().min(1).max(10)).max(5).optional(),
  eventTypes: z.array(z.enum(EVENT_TYPES)).max(4).optional(),
  eventWindow: eventWindowSchema.optional(),
  sectors: z.array(shortText).max(10).optional(),
  knownContact: z.boolean().optional(),
  signalKinds: z.array(shortText).max(10).optional(),
  signalSince: isoDate.optional(),
  scoreBands: z.array(z.enum(SCORE_BANDS)).max(4).optional(),
  requirementStatuses: z.array(z.enum(REQ_STATUSES)).max(4).optional(),
  hasOpenOpportunity: z.boolean().optional(),
}).strict();
export type AccountFilter = z.infer<typeof accountFilterSchema>;

/** Resolve a window to inclusive [from, to] dates relative to `today` (IST date string). Deterministic (S5). */
export function resolveWindow(w: EventWindow | undefined, today: string): { from: string; to: string } | null {
  if (!w) return null;
  const y = Number(today.slice(0, 4));
  switch (w.kind) {
    case "within_months": return { from: today, to: edate(today, w.months) };
    case "next_calendar_year": return { from: `${y + 1}-01-01`, to: `${y + 1}-12-31` };
    case "this_calendar_year": return { from: today, to: `${y}-12-31` };
    case "between": return w.from <= w.to ? { from: w.from, to: w.to } : { from: w.to, to: w.from };
  }
}

export function isEmptyFilter(f: AccountFilter): boolean {
  return Object.values(f).every((v) => v === undefined || (Array.isArray(v) && v.length === 0));
}

const fmtSf = (n: number) => (n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString("en-IN"));

/** Human-readable chips; `key` identifies what to remove when the chip is dismissed. */
export function filterChips(f: AccountFilter): { key: keyof AccountFilter | "area" | "events"; label: string }[] {
  const c: { key: keyof AccountFilter | "area" | "events"; label: string }[] = [];
  if (f.areaMinSf !== undefined || f.areaMaxSf !== undefined) {
    const b = f.areaBasis && f.areaBasis !== "any" ? ` ${f.areaBasis.replace("_", " ")}` : "";
    const r = f.areaMinSf !== undefined && f.areaMaxSf !== undefined ? `${fmtSf(f.areaMinSf)}–${fmtSf(f.areaMaxSf)}`
      : f.areaMinSf !== undefined ? `≥ ${fmtSf(f.areaMinSf)}` : `≤ ${fmtSf(f.areaMaxSf!)}`;
    c.push({ key: "area", label: `Occupies ${r} SF${b}` });
  } else if (f.areaBasis && f.areaBasis !== "any") c.push({ key: "areaBasis", label: `Basis: ${f.areaBasis}` });
  if (f.places?.length) c.push({ key: "places", label: `In ${f.places.join(" / ")}` });
  if (f.grades?.length) c.push({ key: "grades", label: `Grade ${f.grades.join("/")}` });
  if (f.eventTypes?.length || f.eventWindow) {
    const t = (f.eventTypes?.length ? f.eventTypes : EVENT_TYPES).map((e) => EVENT_LABEL[e]).join(" / ");
    const w = !f.eventWindow ? "any time" : f.eventWindow.kind === "within_months" ? `within ${f.eventWindow.months} months`
      : f.eventWindow.kind === "next_calendar_year" ? "next calendar year" : f.eventWindow.kind === "this_calendar_year" ? "rest of this year"
      : `${f.eventWindow.from} → ${f.eventWindow.to}`;
    c.push({ key: "events", label: `Lease ${f.eventTypes?.length ? t : "event"} ${w}` });
  }
  if (f.sectors?.length) c.push({ key: "sectors", label: `Sector: ${f.sectors.join(", ")}` });
  if (f.knownContact) c.push({ key: "knownContact", label: "Contact I already know" });
  if (f.signalKinds?.length || f.signalSince) c.push({ key: "signalKinds", label: `Signal${f.signalKinds?.length ? `: ${f.signalKinds.join(", ")}` : ""}${f.signalSince ? ` since ${f.signalSince}` : ""}` });
  if (f.scoreBands?.length) c.push({ key: "scoreBands", label: `Lead priority: ${f.scoreBands.join("/")}` });
  if (f.requirementStatuses?.length) c.push({ key: "requirementStatuses", label: `Requirement: ${f.requirementStatuses.join("/")}` });
  if (f.hasOpenOpportunity !== undefined) c.push({ key: "hasOpenOpportunity", label: f.hasOpenOpportunity ? "Has open deal" : "No open deal" });
  return c;
}

/** Remove one chip's fields from a filter. */
export function dropChip(f: AccountFilter, key: string): AccountFilter {
  const n: AccountFilter = { ...f };
  if (key === "area") { delete n.areaMinSf; delete n.areaMaxSf; delete n.areaBasis; }
  else if (key === "events") { delete n.eventTypes; delete n.eventWindow; }
  else if (key === "signalKinds") { delete n.signalKinds; delete n.signalSince; }
  else delete (n as Record<string, unknown>)[key];
  return n;
}

/** URL-safe encoding for chips/links (base64url JSON). Decoding re-validates with zod. */
export function encodeFilter(f: AccountFilter): string {
  return Buffer.from(JSON.stringify(f), "utf8").toString("base64url");
}
export function decodeFilter(s: string | null | undefined): AccountFilter | null {
  if (!s) return null;
  try {
    const r = accountFilterSchema.safeParse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
    return r.success ? r.data : null;
  } catch { return null; }
}

/** Build a filter from the editable form fields on /search?mode=accounts (each field re-validated by zod). */
export function filterFromForm(get: (k: string) => string | undefined): AccountFilter | null {
  const num = (k: string) => { const v = get(k)?.replace(/,/g, "").trim(); if (!v) return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  const list = (k: string) => { const v = (get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean); return v.length ? v : undefined; };
  const win = get("win");
  const months = num("months");
  const f: Record<string, unknown> = {
    areaMinSf: num("amin"), areaMaxSf: num("amax"),
    areaBasis: get("basis") && get("basis") !== "any" ? get("basis") : undefined,
    places: list("places"), grades: list("grades")?.map((g) => g.toUpperCase()),
    eventTypes: list("ev"),
    eventWindow: win === "next_year" ? { kind: "next_calendar_year" } : win === "this_year" ? { kind: "this_calendar_year" }
      : win === "months" && months ? { kind: "within_months", months: Math.round(months) } : undefined,
    sectors: list("sectors"), knownContact: get("known") === "1" ? true : undefined,
    signalKinds: list("sig"), signalSince: get("since") || undefined,
    scoreBands: list("bands"), requirementStatuses: list("req"),
    hasOpenOpportunity: get("opp") === "1" ? true : get("opp") === "0" ? false : undefined,
  };
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  const r = accountFilterSchema.safeParse(f);
  return r.success ? r.data : null;
}
