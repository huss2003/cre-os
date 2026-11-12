/**
 * Signal taxonomy (spec §3 A–G) — categories, sub-types and deterministic text detection. Pure; no DB, no AI.
 * Untrusted text is only pattern-matched. Detection yields hypotheses, never facts.
 */
import { detectSignals, withinMonths } from "@/modules/intelligence/research/signals";
import type { Category } from "./engine";

export interface SubTypeDef { category: Category; label: string; outcomes?: string[] }

export const SUB_TYPES: Record<string, SubTypeDef> = {
  // A. Expansion
  new_office: { category: "expansion", label: "New office announcement" },
  new_location: { category: "expansion", label: "New geographical location" },
  pune_expansion: { category: "expansion", label: "Focus-city office expansion" },
  new_business_unit: { category: "expansion", label: "New business unit" },
  gcc: { category: "expansion", label: "GCC establishment or expansion" },
  local_hiring: { category: "expansion", label: "Increased local hiring" },
  hiring_campaign: { category: "expansion", label: "Large hiring campaign" },
  new_facility: { category: "expansion", label: "New operational facility" },
  business_commitment: { category: "expansion", label: "Increased business commitment / new project" },
  investment: { category: "expansion", label: "Major investment announcement" },
  funding: { category: "expansion", label: "Funding (not an office requirement on its own)" },
  growth_existing: { category: "expansion", label: "Growth in an existing location" },
  // B. Restructuring — outcomes are possibilities to verify, never conclusions.
  consolidation: { category: "restructuring", label: "Office consolidation", outcomes: ["consolidation", "space reduction", "relocation", "renewal negotiation"] },
  closure: { category: "restructuring", label: "Office closure", outcomes: ["lease termination", "subleasing", "space reduction"] },
  merger_acquisition: { category: "restructuring", label: "Merger or acquisition", outcomes: ["consolidation", "relocation", "change in office requirement"] },
  bu_restructuring: { category: "restructuring", label: "Business-unit restructuring", outcomes: ["change in office requirement"] },
  workforce_reduction: { category: "restructuring", label: "Workforce reduction (not automatically a space reduction)", outcomes: ["change in office requirement", "subleasing", "renewal negotiation"] },
  cost_reduction: { category: "restructuring", label: "Cost-reduction initiative", outcomes: ["renewal negotiation", "consolidation", "space reduction"] },
  hybrid_policy: { category: "restructuring", label: "Hybrid-work / attendance policy change", outcomes: ["change in office requirement"] },
  relocation: { category: "restructuring", label: "Relocation announcement", outcomes: ["relocation", "lease termination"] },
  portfolio_optimisation: { category: "restructuring", label: "Portfolio optimisation", outcomes: ["consolidation", "subleasing", "renewal negotiation"] },
  footprint_reduction: { category: "restructuring", label: "Office footprint reduction", outcomes: ["space reduction", "subleasing", "lease termination"] },
  outsourcing: { category: "restructuring", label: "Outsourcing / operational restructuring", outcomes: ["change in office requirement"] },
  // C. Lease & property (types are never interchangeable)
  lease_expiry: { category: "lease", label: "Lease expiry" },
  lease_expiry_past: { category: "lease", label: "Lease expiry date passed — verify" },
  lockin_end: { category: "lease", label: "Lock-in end" },
  notice_deadline: { category: "lease", label: "Notice deadline" },
  break_option: { category: "lease", label: "Break option" },
  renewal: { category: "lease", label: "Renewal date / option" },
  handover: { category: "lease", label: "Handover date" },
  escalation: { category: "lease", label: "Rent escalation" },
  availability_change: { category: "lease", label: "Availability change" },
  occupancy_change: { category: "lease", label: "Occupancy change" },
  managed_office_expiry: { category: "lease", label: "Managed-office agreement expiry" },
  relocation_window: { category: "lease", label: "Potential relocation window" },
  // D. Commercial value
  rent_above_comparable: { category: "commercial", label: "Rent above comparable alternatives" },
  cheaper_same_micromarket: { category: "commercial", label: "More economical option in the same micro-market" },
  better_amenities: { category: "commercial", label: "Better amenities at comparable cost" },
  upgrade_same_cost: { category: "commercial", label: "Upgrade without higher occupancy cost" },
  occupancy_cost_reduction: { category: "commercial", label: "Total occupancy cost reduction" },
  configuration: { category: "commercial", label: "Better space configuration" },
  managed_vs_lease: { category: "commercial", label: "Managed office vs conventional lease" },
  // E. Leadership
  cre_leader: { category: "leadership", label: "Corporate real estate leader" },
  facilities_leader: { category: "leadership", label: "Facilities leader" },
  admin_head: { category: "leadership", label: "Administration head" },
  finance_leader: { category: "leadership", label: "Finance leader" },
  hr_leader: { category: "leadership", label: "HR leader" },
  procurement_leader: { category: "leadership", label: "Procurement leader" },
  business_head: { category: "leadership", label: "Business head" },
  gcc_leader: { category: "leadership", label: "GCC leader" },
  signatory: { category: "leadership", label: "Authorised signatory" },
  other_role: { category: "leadership", label: "Other role (may not influence CRE decisions)" },
  // F. Infrastructure & micro-market
  metro: { category: "infrastructure", label: "Metro connectivity" },
  road: { category: "infrastructure", label: "Road infrastructure" },
  airport: { category: "infrastructure", label: "Airport connectivity" },
  commercial_development: { category: "infrastructure", label: "New commercial development" },
  business_district: { category: "infrastructure", label: "New business district" },
  office_supply: { category: "infrastructure", label: "Upcoming office supply" },
  infra_delay: { category: "infrastructure", label: "Infrastructure delay" },
  accessibility: { category: "infrastructure", label: "Accessibility change" },
  amenities: { category: "infrastructure", label: "Amenities / ecosystem development" },
  // G. Macro & industry
  industry_expansion: { category: "macro", label: "Industry expansion" },
  industry_contraction: { category: "macro", label: "Industry contraction" },
  gcc_trend: { category: "macro", label: "GCC investment trend" },
  interest_rate: { category: "macro", label: "Interest-rate change" },
  corporate_cost_cutting: { category: "macro", label: "Corporate cost-cutting" },
  sector_hiring: { category: "macro", label: "Sector hiring trend" },
  regulatory: { category: "macro", label: "Economic / regulatory change" },
  tech_sector: { category: "macro", label: "Technology-sector development" },
  workplace_trend: { category: "macro", label: "Office attendance / workplace trend" },
};

export const subTypeLabel = (s: string | null | undefined) => (s && SUB_TYPES[s]?.label) || null;

/** Lease event type (lease_event.event_type + derived types) → sub-type. */
export const LEASE_SUBTYPE: Record<string, string> = {
  expiry: "lease_expiry", lease_expiry_past: "lease_expiry_past", lockin_end: "lockin_end", notice_deadline: "notice_deadline",
  break: "break_option", option: "renewal", escalation: "escalation", handover: "handover", managed_office_expiry: "managed_office_expiry",
};

/** Existing claim / detector kinds → default sub-type. */
const KIND_SUBTYPE: Record<string, string> = {
  expansion: "pune_expansion", new_office: "new_office", gcc_plan: "gcc", hiring: "local_hiring", funding: "funding", investment: "investment",
  consolidation: "consolidation", rto: "hybrid_policy", layoff: "workforce_reduction", workforce_reduction: "workforce_reduction",
  relocation: "relocation", merger: "merger_acquisition", acquisition: "merger_acquisition", restructuring: "bu_restructuring", closure: "closure",
  leadership_change: "business_head", job_move: "business_head", appointment: "business_head",
  infrastructure: "metro", metro: "metro", office_supply: "office_supply", macro: "industry_expansion", industry_trend: "industry_expansion",
  interest_rate: "interest_rate", rent_benchmark: "rent_above_comparable", better_value_option: "cheaper_same_micromarket",
  lease_expiry: "lease_expiry", lease_renewal: "renewal",
};

// ---------------------------------------------------------------- text rules for sub-types the base detector does not cover

interface Rule { kind: string; subType: string; re: RegExp }
const EXTRA: Rule[] = [
  { kind: "closure", subType: "closure", re: /\b(clos(?:e|es|ed|ing|ure of) (?:its |the |their )?(?:\w+ )?(?:office|centre|center|campus|facility)|shut(?:s|ting)? (?:down )?(?:its |the )?(?:\w+ )?(?:office|centre|center|campus))\b/i },
  { kind: "merger", subType: "merger_acquisition", re: /\b(acquir(?:e|es|ed|ing)|acquisition of|merg(?:e|es|er|ed|ing) with|amalgamat\w+)\b/i },
  { kind: "layoff", subType: "workforce_reduction", re: /\b(layoffs?|lay(?:s|ing)? off|job cuts?|retrench\w*|workforce reduction|reduc(?:e|es|ing) (?:its )?(?:workforce|headcount)|redundanc(?:y|ies))\b/i },
  { kind: "restructuring", subType: "cost_reduction", re: /\b(cost[- ](?:reduction|cutting|optimi[sz]ation)|cut(?:s|ting)? costs)\b/i },
  { kind: "relocation", subType: "relocation", re: /\b(relocat(?:e|es|ed|ing|ion)|mov(?:e|es|ing) (?:its )?(?:office|headquarters|hq|operations) to)\b/i },
  { kind: "restructuring", subType: "outsourcing", re: /\b(outsourc\w+)\b/i },
  { kind: "restructuring", subType: "footprint_reduction", re: /\b(reduc(?:e|es|ing) (?:its )?(?:office )?(?:footprint|space)|smaller (?:office|premises))\b/i },
  { kind: "infrastructure", subType: "metro", re: /\b(metro (?:line|station|corridor|connectivity|rail)|metro)\b/i },
  { kind: "infrastructure", subType: "road", re: /\b(ring road|flyover|expressway|highway|road widening|elevated road)\b/i },
  { kind: "infrastructure", subType: "airport", re: /\b(airport|terminal building)\b/i },
  { kind: "office_supply", subType: "office_supply", re: /\b(office supply|new (?:commercial|office|it) (?:tower|park|development|building)s?|sq\.? ?ft\.? of (?:new )?office (?:space|supply))\b/i },
  { kind: "infrastructure", subType: "infra_delay", re: /\b(delay(?:ed|s)?|postponed|pushed back)\b[^.]{0,60}\b(metro|road|airport|project|corridor)\b/i },
  { kind: "macro", subType: "interest_rate", re: /\b(repo rate|interest rates?|rate (?:cut|hike))\b/i },
  { kind: "macro", subType: "gcc_trend", re: /\b(GCCs? (?:in india|sector|industry|investment)|india (?:is|as) (?:a )?GCC)\b/i },
  { kind: "macro", subType: "workplace_trend", re: /\b(office attendance|occupancy rates?|workplace trends?|flex(?:ible)? workspace demand)\b/i },
  { kind: "macro", subType: "regulatory", re: /\b(SEZ (?:rules|policy|act)|regulation|policy change|budget announcement|tax (?:change|rules))\b/i },
  { kind: "rent_benchmark", subType: "rent_above_comparable", re: /\b(rent(?:al)?s? (?:in|at)[^.]{0,40}\b(?:rose|fell|increased|declined)|paying (?:above|more than) (?:market|comparable))\b/i },
];

export interface Detection { category: Category; kind: string; subType: string; rule: string; context: string; withinMonths?: number; forecast: boolean }

const FORECAST = /\b(will|plans? to|planned|proposed|expected|likely|could|may|to be (?:completed|commissioned)|by 20\d\d|upcoming|forecast)\b/i;
const NEG = /\b(no|not|never|den(?:y|ies|ied)|rule[sd]? out|without|unlikely)\b[^.]{0,30}$/i;

function ctx(text: string, idx: number, len: number) {
  const s = Math.max(0, idx - 80), e = Math.min(text.length, idx + len + 80);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ").trim()}${e < text.length ? "…" : ""}`;
}

/** Plausible CRE link for macro items (spec §3G): must mention offices / workplace / occupiers / rents / hiring / GCC / rates in a property sense. */
const CRE_LINK = /\b(office|workplace|real estate|commercial property|occupier|lease|rent|space|gcc|hiring|headcount|attendance|campus|interest rate|repo rate|it park|sez)\b/i;
export const plausibleCreLink = (text: string) => CRE_LINK.test(text);

/**
 * All category/sub-type detections in a text. One detection per sub-type; base detector (intelligence/research/signals)
 * plus the extra rules above. Expansion text refines to GCC / hiring campaign / new office where stated.
 */
export function detectAll(text: string, focusCities: string[] = ["Pune"]): Detection[] {
  const t = (text ?? "").slice(0, 20_000);
  const out = new Map<string, Detection>();
  const focusRe = focusCities.length ? new RegExp(`\\b(${focusCities.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") : null;
  for (const d of detectSignals(t)) {
    const kind = d.kind as string;
    let sub = KIND_SUBTYPE[kind] ?? kind;
    if (kind === "expansion") sub = /new (?:office|campus|centre|center)/i.test(d.matched) ? "new_office" : focusRe?.test(d.context) ? "pune_expansion" : "growth_existing";
    if (kind === "hiring") sub = d.surge ? "hiring_campaign" : "local_hiring";
    if (kind === "lease_expiry") sub = "lease_expiry";
    if (kind === "leadership_change") sub = leadershipSubType(d.context);
    const cat = (SUB_TYPES[sub]?.category ?? "expansion") as Category;
    out.set(sub, { category: cat, kind: kind === "leadership_change" ? "leadership_change" : kind, subType: sub, rule: d.rule, context: d.context, withinMonths: d.withinMonths, forecast: FORECAST.test(d.context) });
  }
  for (const r of EXTRA) {
    if (out.has(r.subType)) continue;
    const re = new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : `${r.re.flags}g`);
    for (const m of t.matchAll(re)) {
      const idx = m.index ?? 0;
      if (NEG.test(t.slice(Math.max(0, idx - 40), idx))) continue;
      const c = ctx(t, idx, m[0].length);
      const cat = SUB_TYPES[r.subType].category;
      if (cat === "macro" && !plausibleCreLink(c)) break;
      out.set(r.subType, { category: cat, kind: r.kind, subType: r.subType, rule: `extra:${r.subType}`, context: c, withinMonths: withinMonths(t.slice(idx, idx + 200)) ?? undefined, forecast: FORECAST.test(c) });
      break;
    }
  }
  // "delay" is a refinement of a project mention; drop the generic metro/road duplicate when a delay was found.
  if (out.has("infra_delay")) { out.delete("road"); }
  // Layoffs explicitly ≠ space reduction: never also emit footprint_reduction from the same sentence unless stated.
  return [...out.values()];
}

export function subTypeForKind(kind: string): string | null { return KIND_SUBTYPE[kind] ?? (SUB_TYPES[kind] ? kind : null); }

/** Leadership role → sub-type (deterministic keyword rules). */
export function leadershipSubType(title: string | null | undefined): string {
  const t = (title ?? "").toLowerCase();
  if (/real estate|\bcre\b|workplace strategy/.test(t)) return "cre_leader";
  if (/facilit/.test(t)) return "facilities_leader";
  if (/\badmin/.test(t)) return "admin_head";
  if (/\bcfo\b|finance|controller|treasur/.test(t)) return "finance_leader";
  if (/\bhr\b|human resources|people|talent|chro/.test(t)) return "hr_leader";
  if (/procure|purchas|sourcing/.test(t)) return "procurement_leader";
  if (/\bgcc\b|capability cent|site (?:head|leader)|centre head|center head/.test(t)) return "gcc_leader";
  if (/signator|director|company secretary/.test(t)) return "signatory";
  if (/\bceo\b|\bcoo\b|managing director|country head|business head|general manager|president|vp|vice president/.test(t)) return "business_head";
  return "other_role";
}
export const CRE_DECISION_SUBTYPES = new Set(["cre_leader", "facilities_leader", "admin_head", "finance_leader", "hr_leader", "procurement_leader", "business_head", "gcc_leader", "signatory"]);
