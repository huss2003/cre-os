/**
 * Configurable, versioned rule set (spec §7, §13): derived fields, fact/inference/hypothesis/unknown labels, independent
 * evidence counting, hiring checks, funding-alone rule and the contextual summary (§11). Pure functions; the active rule set
 * is loaded from `signal_rule_version` (workspace, admin-editable) or falls back to DEFAULT_RULES. No model may override these.
 */
import type { Db } from "@/lib/supabase/server";
import { DEFAULT_WEIGHTS, LEASE_WINDOW_DAYS, daysBetween, citiesIn, type Category, type PriorityWeights } from "./engine";
import { SUB_TYPES } from "./taxonomy";
import { plural } from "./text";

export const RULES_VERSION = "signals-2";

export interface RuleSet {
  version: string;
  weights: PriorityWeights;
  leaseWindowDays: Record<string, number>;
  /** Freshness thresholds (days since latest evidence). */
  freshness: { fresh: number; stale: number };
  /** Source reliability by evidence tier / adapter. */
  reliability: Record<string, "high" | "medium" | "low">;
  categoryRelevance: Record<Category, number>;
  /** Jaccard similarity of word shingles above which two excerpts are treated as the same announcement. */
  sameAnnouncementSimilarity: number;
}

export const DEFAULT_RULES: RuleSet = {
  version: RULES_VERSION,
  weights: DEFAULT_WEIGHTS,
  leaseWindowDays: { ...LEASE_WINDOW_DAYS, handover: 180, managed_office_expiry: 270 },
  freshness: { fresh: 30, stale: 180 },
  reliability: {
    documentary_current: "high", corroborated_public: "high", credible_reported: "medium", single_unverified: "low", inference: "low",
    database: "high", user_upload: "medium", manual_paste: "low",
  },
  categoryRelevance: { lease: 1, expansion: 0.9, restructuring: 0.8, leadership: 0.6, commercial: 0.7, infrastructure: 0.4, macro: 0.2 },
  sameAnnouncementSimilarity: 0.5,
};

export async function activeRules(db: Db, ws: string): Promise<RuleSet & { id: string | null }> {
  const { data } = await db.from("signal_rule_version").select("id, version, rules").eq("workspace_id", ws).eq("active", true).maybeSingle();
  if (!data) return { ...DEFAULT_RULES, id: null };
  const r = (data.rules ?? {}) as Partial<RuleSet>;
  return {
    ...DEFAULT_RULES, ...r, id: data.id, version: data.version,
    weights: { ...DEFAULT_RULES.weights, ...(r.weights ?? {}) }, reliability: { ...DEFAULT_RULES.reliability, ...(r.reliability ?? {}) },
    categoryRelevance: { ...DEFAULT_RULES.categoryRelevance, ...(r.categoryRelevance ?? {}) },
    leaseWindowDays: { ...DEFAULT_RULES.leaseWindowDays, ...(r.leaseWindowDays ?? {}) },
  };
}

/** Admin: publish a new rule version (old versions kept; signals keep the version they were assessed with). */
export async function publishRules(db: Db, ws: string, userId: string, version: string, rules: Partial<RuleSet>, notes?: string) {
  if (!/^[a-z0-9._-]{2,40}$/i.test(version)) throw new Error("Version must be 2–40 letters, digits, dot, dash or underscore.");
  await db.from("signal_rule_version").update({ active: false }).eq("workspace_id", ws).eq("active", true);
  const { data, error } = await db.from("signal_rule_version").insert({ workspace_id: ws, version, rules, active: true, notes: notes ?? null, created_by: userId }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

// ---------------------------------------------------------------- independent evidence (§7, §8)

export interface EvidenceLite { id?: string; role: string; source_name?: string | null; source_url?: string | null; excerpt?: string | null; published_on?: string | null; independence_key?: string | null; lease_event_id?: string | null }

const host = (u?: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : null; } catch { return null; } };
function shingles(s: string): Set<string> {
  const w = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((x) => x.length > 2);
  const out = new Set<string>();
  for (let i = 0; i < w.length - 2; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
export function similarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Groups supporting evidence into independent groups: same explicit independence key, same host, or near-identical text
 * (republished announcement) = one group. Returns group id per evidence index and the count.
 */
export function independentGroups(ev: EvidenceLite[], threshold = DEFAULT_RULES.sameAnnouncementSimilarity): { count: number; groupOf: number[] } {
  const groupOf: number[] = new Array(ev.length).fill(-1);
  let g = 0;
  for (let i = 0; i < ev.length; i++) {
    if (groupOf[i] >= 0) continue;
    groupOf[i] = g;
    for (let j = i + 1; j < ev.length; j++) {
      if (groupOf[j] >= 0) continue;
      const a = ev[i], b = ev[j];
      const same = (a.independence_key && a.independence_key === b.independence_key)
        || (host(a.source_url) && host(a.source_url) === host(b.source_url))
        || similarity(a.excerpt ?? "", b.excerpt ?? "") >= threshold;
      if (same) groupOf[j] = g;
    }
    g++;
  }
  return { count: g, groupOf };
}

// ---------------------------------------------------------------- derived fields

export type Level = "high" | "medium" | "low" | "unknown";
export interface LevelOf { level: Level; reason: string }
export interface Derived {
  ruleVersion: string; category: Category; subType: string | null;
  companyRelevance: LevelOf; geographicRelevance: LevelOf; creRelevance: LevelOf; timingRelevance: LevelOf;
  evidenceStrength: LevelOf; sourceReliability: LevelOf; freshness: LevelOf; commercialImpact: LevelOf;
  missingInfo: string[]; nextAction: { text: string; actionKind: string };
  hiring?: { location: string; remote: "yes" | "no" | "unknown"; roleType: string; occupancyImplication: string; existingCapacity: string };
  fundingOnly?: boolean;
}

export interface DeriveInput {
  category: Category; subType: string | null; kinds: string[]; orgResolved: boolean; isWatched: boolean; texts: string[];
  location: string | null; contextLocations: string[]; focusCities: string[]; daysAway: number | null; confidence: string;
  tiers: string[]; adapters: string[]; latestEvidenceOn: string | null; today: string;
  hasLease: boolean; hasRequirement: boolean; hasOpenOpportunity: boolean; hasContact: boolean; leaseWithin18m: boolean;
  missingInfo: string[]; nextAction: { text: string; actionKind: string }; forecast?: boolean;
}

const REMOTE = /\b(remote(?:ly)?|remote[- ]first|work(?:ing)? from home|wfh|distributed team)\b/i;
const HYBRID = /\bhybrid\b/i;
const ONSITE = /\b(on[- ]?site|in[- ]office|from (?:our|the) (?:office|campus))\b/i;

export function hiringCheck(texts: string[], focusCities: string[], contextLocations: string[]) {
  const all = texts.join(" ");
  const cities = citiesIn(texts);
  const roleType = /\b(engineer\w*|developer\w*|software|data|tech\w*)\b/i.test(all) ? "technology"
    : /\b(sales|business development|account)\b/i.test(all) ? "sales"
    : /\b(operations|support|bpo|process|customer service|back office)\b/i.test(all) ? "operations / support"
    : /\b(manufactur|plant|factory|warehouse)\b/i.test(all) ? "industrial (not office)" : "unknown";
  const remote: "yes" | "no" | "unknown" = REMOTE.test(all) ? "yes" : ONSITE.test(all) || HYBRID.test(all) ? "no" : "unknown";
  const inFocus = cities.some((c) => focusCities.some((f) => f.toLowerCase() === c.toLowerCase()));
  const location = cities.length ? cities.join(", ") : "unknown (not stated)";
  const occupancyImplication = remote === "yes" ? "Remote roles — little or no office demand implied."
    : roleType === "industrial (not office)" ? "Plant / warehouse roles — not office demand."
    : !cities.length ? "Hiring location not stated — office implication unknown."
    : inFocus ? `Roles in ${location}${HYBRID.test(all) ? " (hybrid — fewer seats than heads)" : ""}; seat need depends on attendance policy and existing capacity.`
    : `Roles outside ${focusCities.join("/")} — not focus-market demand.`;
  return { location, remote, roleType, occupancyImplication, existingCapacity: contextLocations.length ? `Existing occupancy at ${contextLocations.slice(0, 2).join(", ")}; spare capacity unverified.` : "No occupancy on record; capacity unknown." };
}

export function derive(i: DeriveInput, rules: RuleSet = DEFAULT_RULES): Derived {
  const lv = (level: Level, reason: string): LevelOf => ({ level, reason });
  const focus = i.focusCities.map((c) => c.toLowerCase());
  const cities = citiesIn([...i.texts, i.location ?? ""]);
  const inFocus = cities.some((c) => focus.includes(c.toLowerCase())) || i.contextLocations.some((l) => focus.some((f) => l.toLowerCase().includes(f)));
  const fundingOnly = i.kinds.length > 0 && i.kinds.every((k) => k === "funding");
  const fresh = i.latestEvidenceOn ? daysBetween(i.latestEvidenceOn, i.today) : null;
  const tierRel = i.tiers.map((t) => rules.reliability[t]).concat(i.adapters.map((a) => rules.reliability[a])).filter(Boolean);
  const rel: Level = tierRel.includes("high") ? "high" : tierRel.includes("medium") ? "medium" : tierRel.length ? "low" : "unknown";
  const creBase = rules.categoryRelevance[i.category] ?? 0.5;
  const d: Derived = {
    ruleVersion: rules.version, category: i.category, subType: i.subType,
    companyRelevance: !i.orgResolved ? lv("unknown", "Company not resolved to a record yet.")
      : i.hasOpenOpportunity || i.hasRequirement ? lv("high", "Existing requirement or open deal with this company.")
      : i.isWatched || i.hasLease ? lv("medium", i.isWatched ? "Company is on the watchlist." : "Company has a lease on record.")
      : lv("low", "Company is in the database but not watched and has no lease, requirement or deal."),
    geographicRelevance: i.category === "lease" ? lv("high", "Lease on record in your market.")
      : inFocus ? lv("high", `Mentions ${i.focusCities.join("/")} or a recorded ${i.focusCities.join("/")} location.`)
      : cities.length ? lv("low", `Mentions ${cities.join(", ")} — outside the focus market.`) : lv("unknown", "No location stated."),
    creRelevance: fundingOnly ? lv("low", "Funding alone does not create an office requirement.")
      : i.category === "macro" ? lv("low", "Indirect: macro / industry context only.")
      : creBase >= 0.8 ? lv("high", `${SUB_TYPES[i.subType ?? ""]?.label ?? i.category} is a direct occupancy decision driver.`)
      : creBase >= 0.5 ? lv("medium", "Can lead to an occupancy decision; needs verification.") : lv("low", "Indirect CRE effect."),
    timingRelevance: i.daysAway == null ? lv("unknown", "No dated event.")
      : i.daysAway < 0 ? lv("low", `Event date passed ${-i.daysAway} days ago — verify what happened.`)
      : i.daysAway <= 180 ? lv("high", `Event in ${i.daysAway} days.`) : i.daysAway <= 540 ? lv("medium", `Event in ${i.daysAway} days.`) : lv("low", `Event in ${i.daysAway} days.`),
    evidenceStrength: lv(i.confidence === "high" ? "high" : i.confidence === "medium" ? "medium" : i.confidence === "low" ? "low" : "unknown", `Confidence ${i.confidence} (evidence strength, not model certainty).`),
    sourceReliability: lv(rel, rel === "unknown" ? "No source tier recorded." : `Best source tier: ${rel}.`),
    freshness: fresh == null ? lv("unknown", "Evidence date unknown.") : fresh <= rules.freshness.fresh ? lv("high", `Latest evidence ${fresh} days old.`)
      : fresh <= rules.freshness.stale ? lv("medium", `Latest evidence ${fresh} days old.`) : lv("low", `Latest evidence ${fresh} days old — stale.`),
    commercialImpact: i.leaseWithin18m || i.hasRequirement ? lv("high", [i.leaseWithin18m && "lease event within 18 months", i.hasRequirement && "requirement on record"].filter(Boolean).join(", ") + ".")
      : i.hasLease ? lv("medium", "Lease on record; size of opportunity unverified.") : lv("unknown", "No lease, area or requirement on record — impact unknown (not inferred)."),
    missingInfo: [...i.missingInfo, ...(fundingOnly ? ["Funding alone does not create an office requirement — confirm any space plan separately."] : [])],
    nextAction: i.nextAction,
  };
  if (i.forecast && (i.category === "infrastructure" || i.category === "macro")) d.missingInfo.push("Stated as a plan / forecast — not a confirmed fact.");
  if (i.kinds.includes("hiring") || i.subType === "local_hiring" || i.subType === "hiring_campaign") d.hiring = hiringCheck(i.texts, i.focusCities, i.contextLocations);
  if (fundingOnly) d.fundingOnly = true;
  return d;
}

// ---------------------------------------------------------------- labels: fact / inference / hypothesis / unknown

export interface LabelInput {
  evidence: { label?: string | null; fact_status?: string | null; evidence_tier?: string | null; source_name?: string | null; excerpt?: string | null; published_on?: string | null; role: string; note?: string | null }[];
  creRelevance: string | null; title: string; missingInfo: string[]; contextFacts: string[]; forecast: boolean;
}
export function evidenceLabel(e: { fact_status?: string | null; evidence_tier?: string | null; lease_event_id?: string | null }, forecast = false): "fact" | "inference" | "hypothesis" | "unknown" {
  if (forecast) return "hypothesis";
  if (e.fact_status === "currently_confirmed" || e.evidence_tier === "documentary_current") return "fact";
  if (e.fact_status === "ai_inference" || e.evidence_tier === "inference") return "hypothesis";
  if (e.fact_status === "reported" || e.evidence_tier === "credible_reported" || e.evidence_tier === "corroborated_public" || e.evidence_tier === "single_unverified") return "inference";
  return "unknown";
}
export function buildLabels(i: LabelInput) {
  const facts: string[] = [...i.contextFacts], inferences: string[] = [], hypotheses: string[] = [];
  for (const e of i.evidence.filter((x) => x.role === "support")) {
    const src = `${e.source_name ?? "Source"}${e.published_on ? ` (${e.published_on})` : ""}`;
    const what = (e.excerpt ?? e.note ?? "").slice(0, 200);
    const l = e.label ?? evidenceLabel(e);
    if (l === "fact") facts.push(`${src}: ${what}`);
    // That a source *reported* something is a fact about the source; its content is an inference until confirmed.
    else { facts.push(`${src} reported this.`); (l === "hypothesis" ? hypotheses : inferences).push(`${what}${l === "hypothesis" ? " (rule-detected or forecast — verify)" : " (reported, unconfirmed)"}`); }
  }
  if (i.creRelevance) inferences.push(i.creRelevance);
  hypotheses.push(`${i.title} may create a CRE opportunity — requires validation.`);
  if (i.forecast) hypotheses.push("The development is stated as planned / expected, not completed.");
  return { facts: [...new Set(facts)], inferences: [...new Set(inferences)], hypotheses: [...new Set(hypotheses)], unknowns: [...new Set(i.missingInfo)] };
}

// ---------------------------------------------------------------- contextual summary (§11 Kharadi example)

export interface SummaryCtx { locations: string[]; leaseEvents: { event_type: string; event_date: string | null }[]; contacts: { name: string; title?: string | null; function?: string | null }[]; lastInteractionOn: string | null; requirements: unknown[] }
const CRE_TITLE = /real estate|facilit|admin|workplace|procure|cfo|finance|site|country head|managing director|ceo|coo|gcc/i;
const LEASE_WORD: Record<string, string> = { expiry: "lease expiry", lockin_end: "lock-in end", notice_deadline: "notice deadline", break: "break option", option: "renewal option", escalation: "rent escalation" };
const monthsUntil = (from: string, to: string) => Math.round(daysBetween(from, to) / 30.44);

/**
 * "Potential Pune expansion. Existing Kharadi occupancy and a known facilities contact are recorded. Current spare capacity is
 * unverified. Recommended action: …". Uses only recorded facts — never invents requirement, budget, area or move-in date.
 */
export function contextSummary(headline: string, c: SummaryCtx | null, action: string, today: string): string {
  const parts = [headline.endsWith(".") ? headline : `${headline}.`];
  if (c) {
    const rec: string[] = [];
    if (c.locations.length) rec.push(`existing ${joinAnd(c.locations.slice(0, 3))} occupancy`);
    const next = c.leaseEvents.filter((e) => e.event_date && e.event_date >= today).sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)))[0];
    if (next?.event_date) rec.push(`a known ${LEASE_WORD[next.event_type] ?? next.event_type} in ${plural(monthsUntil(today, next.event_date), "month")}`);
    const ct = c.contacts.find((p) => CRE_TITLE.test(`${p.title ?? ""} ${p.function ?? ""}`));
    if (ct) rec.push(`a known ${/facilit/i.test(ct.title ?? "") ? "facilities" : /admin/i.test(ct.title ?? "") ? "administration" : "decision-maker"} contact (${ct.name})`);
    if (rec.length) parts.push(`${cap(joinAnd(rec))} ${rec.length > 1 ? "are" : "is"} recorded.`);
    if (c.lastInteractionOn) parts.push(`The last interaction was ${plural(monthsUntil(c.lastInteractionOn, today), "month")} ago (${c.lastInteractionOn}).`);
    if (c.locations.length) parts.push("Current spare capacity is unverified.");
    if (!c.requirements.length) parts.push("No requirement, budget, area or move-in date is recorded.");
  } else parts.push("The company is not yet linked to a record; no occupancy or contacts are known.");
  parts.push(`Recommended action: ${action}`);
  return parts.join(" ");
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const joinAnd = (a: string[]) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
