/**
 * Signal Engine service. Builds reviewable `signal` rows from Module 1 data:
 *  - signal_claim (company / person evidence, incl. job moves)  -> expansion / restructuring / leadership / ... signals
 *  - lease_event (expiry, lock-in, notice, break, option)        -> lease signals (types never merged)
 *  - pasted / adapter text                                        -> rule detection -> signal_claim -> signal
 * Every write goes through the caller's client (RLS for users; jobs pass the admin client AND filter workspace_id).
 * Idempotent: signals are keyed by dedupe_key, evidence by (signal, dedupe_key), tasks by task.idempotency_key.
 */
import type { Db } from "@/lib/supabase/server";
import { knownBeforeSignal } from "@/modules/intelligence/memory/integrate/hooks";
import { proposeChange } from "@/lib/services/changes";
import { detectSignals, hypothesisSummary } from "@/modules/intelligence/research/signals";
import {
  RULE_VERSION, categoryOf, leaseSignal, counterEvidence, assessConfidence, priorityOf, nextAction, missingInfo, dedupeKey,
  daysBetween, citiesIn, normName, DEFAULT_WEIGHTS, type Category, type ContextFacts, type PriorityWeights, type Verification,
} from "./engine";
import { containsLike } from "@/lib/util/like";
import { edate, localDate, atLocal } from "@/lib/util/time";
import { shortAction } from "./text";
const addDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
import { checkHttpUrl } from "@/lib/util/url";
import { DEFAULT_RULES, activeRules, derive, buildLabels, contextSummary, independentGroups, evidenceLabel } from "./rules";
import { LEASE_SUBTYPE, subTypeForKind, SUB_TYPES, leadershipSubType } from "./taxonomy";
import { resolveOrganisation } from "./resolve";

type Row = Record<string, any>;
export class SignalError extends Error {}

async function all<T = Row>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new SignalError(error.message);
  return (data ?? []) as T[];
}

export interface Settings { focusCities: string[]; weights: PriorityWeights; universeCap: number }
export async function settings(db: Db, ws: string): Promise<Settings> {
  const { data } = await db.from("workspace_setting").select("value").eq("workspace_id", ws).eq("key", "signals").maybeSingle();
  const v = (data?.value ?? {}) as Partial<Settings> & { weights?: Partial<PriorityWeights> };
  return {
    focusCities: Array.isArray(v.focusCities) && v.focusCities.length ? v.focusCities : ["Pune"],
    weights: { ...DEFAULT_WEIGHTS, ...(v.weights ?? {}) },
    universeCap: typeof v.universeCap === "number" ? v.universeCap : 1200,
  };
}

// ------------------------------------------------------------------ entity resolution (deterministic)

export interface Resolution { orgId: string | null; candidates: { id: string; name: string }[]; method: "exact" | "alias" | "none" | "ambiguous" }
/** Compatibility wrapper over resolveOrganisation (resolve.ts). Fuzzy hits are candidates for review, never auto-linked. */
export async function resolveOrg(db: Db, ws: string, name: string, hints: { url?: string | null; domain?: string | null } = {}): Promise<Resolution & { reasons: string[]; fullCandidates: { id: string; name: string; reasons: string[] }[] }> {
  if (!name.trim()) return { orgId: null, candidates: [], method: "none", reasons: [], fullCandidates: [] };
  const r = await resolveOrganisation(db, ws, { name, ...hints });
  const method: Resolution["method"] = r.orgId ? (r.method === "alias" ? "alias" : "exact") : r.method === "ambiguous" ? "ambiguous" : "none";
  return { orgId: r.orgId, method, candidates: r.candidates.map((c) => ({ id: c.id, name: c.name })), reasons: r.reasons, fullCandidates: r.candidates };
}
const esc = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

// ------------------------------------------------------------------ Module 1 context for a company

export interface OrgContext {
  org: Row | null; locations: string[]; leases: Row[]; leaseEvents: Row[]; requirements: Row[]; contacts: Row[];
  lastInteractionOn: string | null; opportunities: Row[]; openTasks: number;
}
export async function orgContext(db: Db, ws: string, orgId: string): Promise<OrgContext> {
  const [org, leases, reqs, emps, opps, tasks, links] = await Promise.all([
    db.from("organisation").select("id, display_name, sector").eq("workspace_id", ws).eq("id", orgId).maybeSingle().then((r) => r.data),
    all<Row>(db.from("lease").select("id, asset_id, area_sf, contractual_expiry, asset:asset_id(name, locality:locality_id(name), mm:micro_market_id(name))").eq("workspace_id", ws).eq("tenant_org_id", orgId).is("archived_at", null).limit(50)),
    all<Row>(db.from("requirement").select("id, title, status").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).limit(20)),
    all<Row>(db.from("employment").select("person_id, title, function, person:person_id(full_name)").eq("workspace_id", ws).eq("org_id", orgId).eq("is_current", true).is("archived_at", null).limit(30)),
    all<Row>(db.from("opportunity").select("id, name, stage, outcome").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).limit(20)),
    db.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("linked_entity_type", "organisation").eq("linked_entity_id", orgId).eq("status", "open").then((r) => r.count ?? 0),
    all<Row>(db.from("interaction_link").select("interaction:interaction_id(occurred_at)").eq("workspace_id", ws).eq("entity_type", "organisation").eq("entity_id", orgId).limit(200)),
  ]);
  const leaseIds = leases.map((l) => l.id);
  const leaseEvents = leaseIds.length ? await all<Row>(db.from("lease_event").select("id, lease_id, event_type, event_date, date_basis, confirmed").eq("workspace_id", ws).in("lease_id", leaseIds).is("archived_at", null)) : [];
  const locations = [...new Set(leases.flatMap((l) => [l.asset?.locality?.name, l.asset?.mm?.name, l.asset?.name]).filter(Boolean))] as string[];
  const dates = links.map((l) => l.interaction?.occurred_at).filter(Boolean).sort();
  return {
    org: org ?? null, locations, leases, leaseEvents, requirements: reqs,
    contacts: emps.map((e) => ({ person_id: e.person_id, name: e.person?.full_name ?? "", title: e.title, function: e.function })),
    lastInteractionOn: dates.length ? String(dates[dates.length - 1]).slice(0, 10) : null,
    opportunities: opps, openTasks: tasks,
  };
}

const CRE_TITLE = /real estate|facilit|admin|workplace|procure|cfo|finance|site|country head|managing director|ceo|coo|gcc/i;
function facts(c: OrgContext | null): ContextFacts {
  return {
    hasLease: !!c?.leases.length, hasContact: !!c?.contacts.some((p) => CRE_TITLE.test(`${p.title ?? ""} ${p.function ?? ""}`)),
    hasRequirement: !!c?.requirements.length, occupancyVerified: false, locations: c?.locations ?? [],
  };
}

// ------------------------------------------------------------------ upsert one signal (grouping + evidence)

export interface Evidence { role: "support" | "counter" | "context"; key: string; claimId?: string; leaseEventId?: string; sourceName?: string | null; url?: string | null; excerpt?: string | null; tier?: string | null; status?: string | null; published?: string | null; note?: string | null; sourceItemId?: string | null; sourceObjectId?: string | null; independenceKey?: string | null; label?: Verification | null }
export interface Draft {
  category: Category; kind: string; title: string; summary: string; creRelevance: string; orgId?: string | null; personId?: string | null;
  leaseId?: string | null; leaseEventId?: string | null; nameRaw?: string | null; location?: string | null; eventDate?: string | null;
  eventDateBasis?: string | null; daysAway?: number | null; verification: Verification; evidence: Evidence[]; key: string;
  recommended?: { text: string; actionKind: string }; processing?: string;
  subType?: string | null; forecast?: boolean; role?: string | null; entityCandidates?: { id: string; name: string; reasons: string[] }[]; entityResolution?: Record<string, unknown> | null;
  /** Extra counter-evidence flags computed by the generator (outdated lease, property gone, no target in micro-market). */
  flags?: { leaseOutdated?: boolean; propertyUnavailable?: boolean; infraNoTarget?: boolean };
  /** Micro-market / locality named in the evidence text (wins over the company's recorded occupancy). */
  textGeo?: { microMarket: string; locality: string | null } | null;
}

export async function upsertSignal(db: Db, ws: string, d: Draft, s: Settings, today: string, ctxCache: Map<string, OrgContext>): Promise<{ id: string; created: boolean }> {
  const ctx = d.orgId ? ctxCache.get(d.orgId) ?? await orgContext(db, ws, d.orgId).then((c) => (ctxCache.set(d.orgId!, c), c)) : null;
  const { data: existing } = await db.from("signal").select("id, status, updated_at, rule_version, event_date, derived").eq("workspace_id", ws).eq("dedupe_key", d.key).maybeSingle();
  let id = existing?.id as string | undefined;
  let created = false;
  if (id && d.entityCandidates?.length && !d.orgId) await db.from("signal").update({ entity_candidates: d.entityCandidates, entity_resolution: d.entityResolution ?? null }).eq("workspace_id", ws).eq("id", id).is("org_id", null);
  if (!id) {
    const { data, error } = await db.from("signal").insert({
      workspace_id: ws, category: d.category, kind: d.kind, title: d.title, summary: d.summary, cre_relevance: d.creRelevance,
      org_id: d.orgId ?? null, person_id: d.personId ?? null, lease_id: d.leaseId ?? null, lease_event_id: d.leaseEventId ?? null,
      entity_name_raw: d.nameRaw ?? null, location_text: d.location ?? null, event_date: d.eventDate ?? null, event_date_basis: d.eventDateBasis ?? null,
      verification: d.verification, dedupe_key: d.key, rule_version: RULE_VERSION,
      sub_type: d.subType ?? subTypeForKind(d.kind), derived: { role: d.role ?? null, forecast: !!d.forecast, flags: d.flags ?? {}, text_micro_market: d.textGeo?.microMarket ?? null, text_locality: d.textGeo?.locality ?? null }, entity_candidates: d.entityCandidates ?? [], entity_resolution: d.entityResolution ?? null,
      processing_status: d.processing ?? (d.orgId || d.personId ? "review_required" : "entity_unresolved"),
    }).select("id").single();
    if (error) {
      if (!/duplicate key/.test(error.message)) throw new SignalError(error.message);
      const again = await db.from("signal").select("id").eq("workspace_id", ws).eq("dedupe_key", d.key).single();
      id = again.data!.id;
    } else { id = data.id; created = true; }
    // Module 13: the same kind of development was already recorded for this company — keep it as context, not "new".
    if (created) {
      const prior = await knownBeforeSignal(db, ws, { orgId: d.orgId, kind: d.kind, dedupeKey: d.key });
      if (prior) d = { ...d, evidence: [...d.evidence, { role: "context", key: `known-before:${prior.id}`, sourceName: "Earlier signal in CRE OS", excerpt: `Previously recorded on ${String(prior.detectedAt).slice(0, 10)}: ${prior.title}`, note: "Previously known development — check what is actually new." }] };
    }
  }
  let changed = created;
  // New evidence on a grouped signal can date it, or name its location, for the first time.
  if (existing) {
    const p: Row = {};
    if (d.eventDate && !existing.event_date) { p.event_date = d.eventDate; p.event_date_basis = d.eventDateBasis ?? null; }
    if (d.textGeo && !existing.derived?.text_micro_market) p.derived = { ...(existing.derived ?? {}), text_micro_market: d.textGeo.microMarket, text_locality: d.textGeo.locality };
    if (Object.keys(p).length) { await db.from("signal").update(p).eq("workspace_id", ws).eq("id", id!); changed = true; }
  }
  for (const e of d.evidence) {
    const up = await db.from("signal_evidence").upsert({
      workspace_id: ws, signal_id: id, role: e.role, dedupe_key: e.key, signal_claim_id: e.claimId ?? null, lease_event_id: e.leaseEventId ?? null,
      source_name: e.sourceName ?? null, source_url: e.url ?? null, excerpt: e.excerpt?.slice(0, 1000) ?? null, evidence_tier: e.tier ?? null,
      fact_status: e.status ?? null, published_on: e.published ?? null, note: e.note ?? null,
      source_item_id: e.sourceItemId ?? null, source_object_id: e.sourceObjectId ?? null, independence_key: e.independenceKey ?? null,
      label: e.label ?? (e.role === "support" ? evidenceLabel({ fact_status: e.status, evidence_tier: e.tier }, d.forecast) : null),
    }, { onConflict: "workspace_id,signal_id,dedupe_key", ignoreDuplicates: true }).select("id");
    if (up.data?.length) changed = true;
  }
  // Nothing new and already assessed today with the current rules → skip the (costly) reassessment; retries stay cheap.
  if (!changed && existing && String(existing.updated_at).slice(0, 10) === today && existing.rule_version === RULE_VERSION) return { id: id!, created };
  await reassess(db, ws, id!, s, today, ctx ?? null, d);
  return { id: id!, created };
}

const RULES_CACHE = new WeakMap<Settings, Promise<Awaited<ReturnType<typeof activeRules>>>>();
function rulesFor(db: Db, ws: string, s: Settings) {
  let p = RULES_CACHE.get(s);
  if (!p) { p = activeRules(db, ws); RULES_CACHE.set(s, p); }
  return p;
}

/** Recompute grouping, confidence, counter-evidence, priority, derived fields, labels and next action from ALL stored evidence. */
export async function reassess(db: Db, ws: string, id: string, s: Settings, today: string, ctx: OrgContext | null, d?: Partial<Draft>) {
  const sig = (await db.from("signal").select("*").eq("workspace_id", ws).eq("id", id).single()).data as Row;
  const rules = await rulesFor(db, ws, s);
  const weights = { ...rules.weights, ...s.weights };
  const ev = await all<Row>(db.from("signal_evidence").select("*").eq("workspace_id", ws).eq("signal_id", id).is("archived_at", null));
  const support = ev.filter((e) => e.role === "support");
  const texts = support.map((e) => `${e.excerpt ?? ""} ${e.note ?? ""}`);
  // Pasted / user-added evidence without a published date counts from the day it was added (IST), so freshness filters see it.
  const evDate = (e: Row) => e.published_on ?? (e.source_item_id || String(e.dedupe_key ?? "").startsWith("user:") ? localDate(new Date(e.created_at)) : null);
  const latest = support.map(evDate).filter(Boolean).sort().pop() ?? null;
  const focus = s.focusCities.map((c) => c.toLowerCase());
  const inFocusGeo = citiesIn([...texts, sig.location_text ?? "", ...(ctx?.locations ?? [])]).some((c) => focus.includes(c.toLowerCase()))
    || sig.category === "lease";
  const f = facts(ctx);
  // §8 grouping: repeats of one announcement (same host / near-identical text / same key) are one independent group.
  const groups = independentGroups(support as never, rules.sameAnnouncementSimilarity);
  const flags = d?.flags ?? (sig.derived?.flags as Draft["flags"]) ?? {};
  const person = sig.person_id ? (await db.from("employment").select("title, function").eq("workspace_id", ws).eq("person_id", sig.person_id).eq("is_current", true).limit(1).maybeSingle()).data : null;
  const userCounters = ev.filter((e) => e.role === "counter").map((e) => e.excerpt ?? e.note ?? "Counter-evidence recorded.");
  const ruleCounters = counterEvidence({ category: sig.category, kind: sig.kind, texts, focusCities: s.focusCities, sourceCount: support.length,
    independentCount: groups.count, latestEvidenceOn: latest, today, hasOccupancyInFocus: inFocusGeo && f.hasLease,
    personFunction: person ? `${person.title ?? ""} ${person.function ?? ""}` : sig.category === "leadership" ? (sig.derived?.role ?? null) : null,
    leaseOutdated: flags.leaseOutdated, propertyUnavailable: flags.propertyUnavailable, infraNoTarget: flags.infraNoTarget });
  if (sig.kind === "funding") ruleCounters.push("Funding alone does not create an office requirement.");
  // "Repeats are not independent" is a grouping note, not contradicting evidence.
  const groupingNotes = ruleCounters.filter((c) => GROUPING_NOTE.test(c));
  const textMm = (sig.derived?.text_micro_market as string | undefined) ?? d?.textGeo?.microMarket ?? null;
  const textLocality = (sig.derived?.text_locality as string | undefined) ?? d?.textGeo?.locality ?? null;
  const recordedMms = [...new Set((ctx?.leases ?? []).map((l) => l.asset?.mm?.name).filter(Boolean))] as string[];
  const locationNote = textMm && recordedMms.length && !placesOverlap([textMm, textLocality], recordedMms)
    ? `The text names ${textLocality ?? textMm}${textLocality && textLocality !== textMm ? ` (${textMm})` : ""}, but recorded occupancy is in ${recordedMms.join(", ")} — confirm which location this is about.` : null;
  const counters = [...ruleCounters.filter((c) => !GROUPING_NOTE.test(c)), ...(locationNote ? [locationNote] : []), ...userCounters];
  const leaseEv = (sig.category === "lease" || sig.category === "commercial") && (sig.lease_event_id || sig.lease_id)
    ? [{ tier: sig.verification === "fact" ? "documentary_current" : "credible_reported", status: sig.verification === "fact" ? "currently_confirmed" : "reported", source: "lease record", published_on: null }]
    : [];
  const conf = assessConfidence([...leaseEv, ...support.map((e, i) => ({ tier: e.evidence_tier, status: e.fact_status, source: `group-${groups.groupOf[i]}`, published_on: e.published_on }))], counters);
  const daysAway = d?.daysAway ?? (sig.event_date ? daysBetween(today, sig.event_date) : null);
  const leaseWithin18m = (ctx?.leaseEvents ?? []).some((e) => e.event_date && daysBetween(today, e.event_date) >= 0 && daysBetween(today, e.event_date) <= 548);
  const hasOpenOpportunity = !!ctx?.opportunities.some((o) => o.outcome === "open");
  const pr = priorityOf({
    category: sig.category, daysAway, confidence: conf.confidence, inFocusGeo, hasContact: f.hasContact,
    hasOpenOpportunity, hasRequirement: f.hasRequirement, leaseWithin18m,
    freshnessDays: latest ? daysBetween(latest, today) : null, needsVerification: sig.verification !== "fact",
    counterItems: userCounters.length,
  }, weights);
  const baseNa = d?.recommended ?? nextAction(sig.category, sig.kind, f);
  const subType = sig.sub_type ?? subTypeForKind(sig.kind);
  const outcomes = subType ? SUB_TYPES[subType]?.outcomes : undefined;
  const na = { ...baseNa, text: outcomes && !baseNa.text.includes("Possible outcomes") ? `${baseNa.text} Possible outcomes to verify: ${outcomes.join(", ")}.` : baseNa.text };
  const missing = missingInfo(sig.category, f);
  const ov = sig.priority_override as Row | null;
  const reviewDue = !!(ov?.review_on && ov.review_on <= today);
  const { data: watched } = sig.org_id ? await db.from("watchlist").select("id").eq("workspace_id", ws).eq("org_id", sig.org_id).eq("active", true).maybeSingle() : { data: null };
  const derived = derive({
    category: sig.category, subType, kinds: [sig.kind], orgResolved: !!(sig.org_id || sig.person_id), isWatched: !!watched, texts,
    location: sig.location_text, contextLocations: ctx?.locations ?? [], focusCities: s.focusCities, daysAway, confidence: conf.confidence,
    tiers: support.map((e) => e.evidence_tier).filter(Boolean), adapters: [], latestEvidenceOn: latest, today,
    hasLease: f.hasLease, hasRequirement: f.hasRequirement, hasOpenOpportunity, hasContact: f.hasContact, leaseWithin18m,
    missingInfo: missing, nextAction: na, forecast: sig.derived?.forecast ?? d?.forecast ?? false,
  }, rules);
  const contextFacts = ctx ? [
    ...(ctx.locations.length ? [`Recorded occupancy: ${ctx.locations.slice(0, 3).join(", ")}.`] : []),
    ...ctx.leaseEvents.filter((e) => e.event_date).slice(0, 3).map((e) => `Lease record: ${String(e.event_type).replace(/_/g, " ")} on ${e.event_date} (${e.date_basis}${e.confirmed ? ", confirmed" : ""}).`),
  ] : [];
  const labels = buildLabels({ evidence: support as never, creRelevance: sig.cre_relevance, title: sig.title, missingInfo: derived.missingInfo, contextFacts, forecast: !!(sig.derived?.forecast ?? d?.forecast) });
  const action = contextual(na.text, sig, ctx);
  const headline = `Potential ${lcLabel(SUB_TYPES[subType ?? ""]?.label ?? sig.kind.replace(/_/g, " "))}${sig.location_text ? ` (${sig.location_text})` : ""}`;
  const contextualSummary = contextSummary(headline, ctx ? { locations: occupancyLabels(ctx), leaseEvents: ctx.leaseEvents as never, contacts: ctx.contacts as never, lastInteractionOn: ctx.lastInteractionOn, requirements: ctx.requirements } : null, na.text, today);
  // The location named in the evidence wins over the company's recorded occupancy.
  const microMarket = textMm ?? sig.micro_market ?? recordedMms[0] ?? null;
  const sourceNames = [...new Set(support.map((e) => e.source_name).filter(Boolean))] as string[];
  const contextJson = ctx ? {
    company: ctx.org?.display_name, sector: ctx.org?.sector, locations: ctx.locations,
    leases: ctx.leases.map((l) => ({ id: l.id, asset: l.asset?.name, area_sf: l.area_sf, expiry: l.contractual_expiry })),
    lease_events: ctx.leaseEvents.map((e) => ({ type: e.event_type, date: e.event_date, basis: e.date_basis, confirmed: e.confirmed })),
    requirements: ctx.requirements.map((r) => ({ id: r.id, title: r.title, status: r.status })), contacts: ctx.contacts,
    opportunities: ctx.opportunities.map((o) => ({ id: o.id, name: o.name, stage: o.stage, outcome: o.outcome })),
    last_interaction_on: ctx.lastInteractionOn, open_tasks: ctx.openTasks, counter_evidence: counters, grouping_notes: groupingNotes, location_note: locationNote,
  } : { counter_evidence: counters, grouping_notes: groupingNotes, location_note: locationNote };
  const band = ov?.band ?? pr.band;
  const reasons = ov ? [...pr.reasons, `Overridden to ${ov.band} by user on ${String(ov.at).slice(0, 10)}: ${ov.reason}${ov.review_on ? ` (review by ${ov.review_on})` : ""}`, ...(reviewDue ? ["Override review date reached — confirm or clear the override."] : [])] : pr.reasons;
  await db.from("signal").update({
    confidence: conf.confidence, confidence_reasons: conf.reasons, latest_evidence_on: latest, last_confirmed_on: latest,
    priority: pr.score, priority_band: band, priority_reasons: reasons, priority_review_on: ov?.review_on ?? null,
    recommended_action: action, action_kind: na.actionKind, missing_info: derived.missingInfo, context_json: contextJson,
    sub_type: subType, derived: { ...derived, flags, forecast: sig.derived?.forecast ?? d?.forecast ?? false, role: sig.derived?.role ?? null, text_micro_market: textMm, text_locality: textLocality },
    labels, contextual_summary: contextualSummary, independent_evidence_count: groups.count, contradictory_count: counters.length,
    source_names: sourceNames, micro_market: microMarket, rule_version: rules.version, rule_version_id: rules.id,
  }).eq("workspace_id", ws).eq("id", id);
  // Historical assessments are preserved: append only when the outcome changed.
  const fingerprint = JSON.stringify([rules.version, conf.confidence, pr.score, band, counters.length, groups.count]);
  const { data: last } = await db.from("signal_assessment").select("fingerprint").eq("workspace_id", ws).eq("signal_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last?.fingerprint !== fingerprint) {
    await db.from("signal_assessment").insert({ workspace_id: ws, signal_id: id, rule_version: rules.version, confidence: conf.confidence, priority: pr.score, priority_band: band,
      reasons: { confidence: conf.reasons, priority: reasons, counter: counters }, derived, fingerprint, owner_user_id: sig.owner_user_id ?? undefined });
  }
}

const GROUPING_NOTE = /repeats are not independent|may all refer to one announcement/i;
/** "Amberline Tech Park (Kharadi)" per recorded lease — the same list section 6 shows. */
export function occupancyLabels(ctx: OrgContext | null): string[] {
  if (!ctx) return [];
  return [...new Set(ctx.leases.map((l) => {
    const name = l.asset?.name as string | undefined; const where = (l.asset?.locality?.name ?? l.asset?.mm?.name) as string | undefined;
    return name && where ? `${name} (${where})` : name ?? where ?? "";
  }).filter(Boolean))];
}
/** "Pune expansion" stays capitalised (a place); "New office" → "new office". */
export function lcLabel(label: string): string {
  const first = label.split(" ")[0];
  return citiesIn([first]).length || /^[A-Z]{2,}/.test(first) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** "Potential Pune expansion. Existing Kharadi occupancy and a known facilities contact are recorded. ..." */
function contextual(action: string, sig: Row, ctx: OrgContext | null): string {
  if (!ctx) return action;
  const bits: string[] = [];
  const occ = occupancyLabels(ctx);
  if (occ.length) bits.push(`existing occupancy at ${occ.slice(0, 3).join(", ")}`);
  const c = ctx.contacts.find((p) => CRE_TITLE.test(`${p.title ?? ""} ${p.function ?? ""}`));
  if (c) bits.push(`known contact ${c.name}${c.title ? ` (${c.title})` : ""}`);
  if (ctx.lastInteractionOn) bits.push(`last interaction ${ctx.lastInteractionOn}`);
  void sig;
  return bits.length ? `${action} On record: ${bits.join("; ")}. Capacity unverified.` : action;
}

// ------------------------------------------------------------------ generators

const today0 = () => new Date().toISOString().slice(0, 10);

/** Rows in pages with a stable order (one API response is capped at 1,000 rows; an unsorted .limit() drops rows at random). */
async function paged(build: () => any, cap = 20_000, page = 1000): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < cap; from += page) {
    const rows = await all<Row>(build().range(from, Math.min(from + page, cap) - 1));
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

export async function scanLeaseEvents(db: Db, ws: string, s: Settings, today = today0(), cache = new Map<string, OrgContext>(), orgIds?: string[]) {
  const from = new Date(Date.parse(today) - 365 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(today) + 540 * 86_400_000).toISOString().slice(0, 10);
  const evs = await paged(() => {
    let q = db.from("lease_event").select(`id, lease_id, event_type, event_date, date_basis, confirmed, notice_days, lease:lease_id${orgIds ? "!inner" : ""}(tenant_org_id, tenant_name_raw, rent_basis, asset:asset_id(name, locality:locality_id(name)))`)
      .eq("workspace_id", ws).is("archived_at", null).gte("event_date", from).lte("event_date", to);
    if (orgIds) q = q.in("lease.tenant_org_id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]);
    return q.order("event_date").order("id");
  });
  let created = 0;
  for (const e of evs) {
    const spec = leaseSignal(e as never, today);
    if (!spec) continue;
    const orgId = e.lease?.tenant_org_id ?? null;
    const who = orgId ? (cache.get(orgId)?.org?.display_name ?? null) : e.lease?.tenant_name_raw;
    const where = [e.lease?.asset?.name, e.lease?.asset?.locality?.name].filter(Boolean).join(", ");
    const managed = e.event_type === "expiry" && e.lease?.rent_basis === "seat" && !spec.past;
    const r = await upsertSignal(db, ws, {
      category: "lease", kind: spec.kind, title: managed ? spec.title.replace("Lease expiry", "Managed-office agreement expiry") : spec.title, key: `lease:${e.id}:${spec.kind}`,
      subType: managed ? "managed_office_expiry" : LEASE_SUBTYPE[spec.past ? "lease_expiry_past" : e.event_type] ?? null, flags: { leaseOutdated: spec.past },
      summary: `${spec.title}${where ? ` at ${where}` : ""}. Date basis: ${e.date_basis}${e.confirmed ? ", confirmed" : ", not confirmed"}.`,
      creRelevance: spec.past ? "A passed expiry needs checking; it is not evidence of a current space need." : "A dated lease event creates a decision window for the occupier (renew, relocate, resize).",
      orgId, leaseId: e.lease_id, leaseEventId: e.id, nameRaw: who ?? null, location: where || null, eventDate: e.event_date, eventDateBasis: e.date_basis,
      daysAway: spec.daysAway, verification: spec.verification, recommended: { text: spec.recommended, actionKind: spec.actionKind },
      evidence: [{ role: "support", key: `lease_event:${e.id}`, leaseEventId: e.id, sourceName: "Lease record", tier: e.confirmed ? "documentary_current" : null, status: e.confirmed ? "currently_confirmed" : "reported", note: `${e.event_type} ${e.event_date} (${e.date_basis})` }],
      processing: orgId ? "review_required" : "entity_unresolved",
    }, s, today, cache);
    if (r.created) created++;
    // A passed expiry never becomes a "needs space" claim — it becomes a verification task (idempotent).
    if (spec.past) await systemTask(db, ws, r.id, `signal:${r.id}:verify`, `Verify what happened at lease expiry (${e.event_date})${who ? ` — ${who}` : ""}: renewed, extended, relocated or vacated?`,
      orgId ? "organisation" : null, orgId, 7);
  }
  // Upcoming handovers (lease start in the future) — distinct from expiry / lock-in / notice.
  const hTo = new Date(Date.parse(today) + (DEFAULT_RULES.leaseWindowDays.handover ?? 180) * 86_400_000).toISOString().slice(0, 10);
  const starts = await paged(() => {
    let q = db.from("lease").select("id, tenant_org_id, tenant_name_raw, start_date, fact_status, asset:asset_id(name, locality:locality_id(name))")
      .eq("workspace_id", ws).is("archived_at", null).gt("start_date", today).lte("start_date", hTo);
    if (orgIds) q = q.in("tenant_org_id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]);
    return q.order("start_date").order("id");
  });
  for (const l of starts) {
    const d = daysBetween(today, l.start_date);
    const where = [l.asset?.name, l.asset?.locality?.name].filter(Boolean).join(", ");
    const r = await upsertSignal(db, ws, {
      category: "lease", kind: "lease_handover", subType: "handover", title: `Handover / lease start in ${d} days (${l.start_date})`, key: `lease_start:${l.id}`,
      summary: `Lease start (handover) recorded for ${l.start_date}${where ? ` at ${where}` : ""}. Fact status: ${l.fact_status}.`,
      creRelevance: "A handover date drives fit-out, move and exit of the previous premises — check both.", orgId: l.tenant_org_id ?? null, leaseId: l.id,
      nameRaw: l.tenant_org_id ? null : l.tenant_name_raw ?? null, location: where || null, eventDate: l.start_date, eventDateBasis: "contractual", daysAway: d,
      verification: l.fact_status === "currently_confirmed" ? "fact" : "inference",
      recommended: { text: "Confirm the handover date, fit-out status and what happens to the previous premises.", actionKind: "lease_event_verification" },
      evidence: [{ role: "support", key: `lease_start:${l.id}`, sourceName: "Lease record", status: l.fact_status, note: `start_date ${l.start_date}` }],
      processing: l.tenant_org_id ? "review_required" : "entity_unresolved",
    }, s, today, cache);
    if (r.created) created++;
  }
  return created;
}

/** Task created by the engine itself (no user action): idempotent, assigned to nobody, never sends anything. */
async function systemTask(db: Db, ws: string, signalId: string, key: string, title: string, entityType: string | null, entityId: string | null, dueDays: number) {
  const { data: ex } = await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
  if (ex) return ex.id as string;
  const { data, error } = await db.from("task").insert({ workspace_id: ws, title: title.slice(0, 300), description: `From signal ${signalId}`,
    due_at: new Date(Date.now() + dueDays * 86_400_000).toISOString(), priority: 50, linked_entity_type: entityType, linked_entity_id: entityId,
    source: "signal", idempotency_key: key, related_entities: [{ type: "signal", id: signalId }] }).select("id").single();
  if (error) { if (/duplicate key/.test(error.message)) return null; throw new SignalError(error.message); }
  await db.from("signal").update({ task_id: data.id }).eq("workspace_id", ws).eq("id", signalId).is("task_id", null);
  return data.id as string;
}

export async function scanClaims(db: Db, ws: string, s: Settings, opts: { today?: string; since?: string; orgIds?: string[] } = {}, cache = new Map<string, OrgContext>()) {
  const today = opts.today ?? today0();
  let q = db.from("signal_claim").select("*").eq("workspace_id", ws).is("archived_at", null).order("created_at", { ascending: false }).limit(1000);
  if (opts.since) q = q.gte("updated_at", opts.since);
  if (opts.orgIds?.length) q = q.in("subject_id", opts.orgIds);
  const claims = await all<Row>(q);
  let created = 0;
  for (const c of claims) {
    const cat = categoryOf(c.claim_type);
    if (!cat) continue;
    const date = c.effective_on ?? c.published_on ?? c.observed_on ?? String(c.created_at).slice(0, 10);
    const v = (c.value_json ?? {}) as Row;
    let orgId: string | null = c.subject_type === "organisation" ? c.subject_id : null;
    const personId: string | null = c.subject_type === "person" ? c.subject_id : null;
    if (c.claim_type === "job_move") orgId = v.to_org_id ?? null;
    const label = await entityLabel(db, ws, orgId, personId, cache);
    const text = c.evidence_excerpt ?? v.text ?? "";
    const location = v.location ?? citiesIn([text]).join(", ") ?? null;
    const title = c.claim_type === "job_move"
      ? `${label.person ?? "Person"} moved${v.title ? ` as ${v.title}` : ""}${label.org ? ` to ${label.org}` : ""}`
      : `${label.org ?? "Company"}: ${c.claim_type.replace(/_/g, " ")}${location ? ` (${location})` : ""}`;
    const r = await upsertSignal(db, ws, {
      category: cat, kind: c.claim_type, title, key: dedupeKey(cat, c.claim_type, orgId ?? personId ?? c.subject_id, date),
      summary: text ? text.slice(0, 400) : `${c.claim_type.replace(/_/g, " ")} reported.`,
      subType: c.claim_type === "job_move" || c.claim_type === "leadership_change" || c.claim_type === "appointment" ? leadershipSubType(v.title ?? text) : (v.sub_type ?? subTypeForKind(c.claim_type)),
      forecast: !!v.forecast, role: v.title ?? null,
      creRelevance: relevance(cat, c.claim_type), orgId, personId, location: location || null, eventDate: c.effective_on ?? null,
      eventDateBasis: c.effective_on ? "reported" : "unknown",
      verification: c.status === "currently_confirmed" ? "fact" : c.status === "ai_inference" ? "hypothesis" : "inference",
      evidence: [{ role: "support", key: `claim:${c.id}`, claimId: c.id, sourceName: c.source_locator ?? null, url: c.source_url, excerpt: text, tier: c.evidence_tier, status: c.status, published: c.published_on ?? c.observed_on }],
    }, s, today, cache);
    if (r.created) created++;
  }
  return created;
}

async function entityLabel(db: Db, ws: string, orgId: string | null, personId: string | null, cache: Map<string, OrgContext>) {
  const org = orgId ? (cache.get(orgId)?.org?.display_name ?? (await db.from("organisation").select("display_name").eq("workspace_id", ws).eq("id", orgId).maybeSingle()).data?.display_name) : null;
  const person = personId ? (await db.from("person").select("full_name").eq("workspace_id", ws).eq("id", personId).maybeSingle()).data?.full_name : null;
  return { org: org ?? null, person: person ?? null };
}

function relevance(cat: Category, kind: string): string {
  switch (cat) {
    case "expansion": return kind === "hiring" ? "Local hiring can lead to more seats; it is not proof of an office requirement." : "Expansion can create a new or larger space requirement — evidence of expansion, not proof of a space need.";
    case "restructuring": return "May lead to consolidation, relocation, subleasing or renewal renegotiation — not automatic space reduction.";
    case "leadership": return "A new decision-maker can reopen real-estate decisions and creates a relationship path.";
    case "infrastructure": return "Can change the attractiveness of nearby micro-markets and properties.";
    case "commercial": return "A like-for-like comparison may show a better-value option.";
    case "lease": return "A lease expiry is a renewal-or-relocation decision point — confirm the occupier's plans before the notice window closes.";
    case "macro": return "Indirect context for account reviews.";
    default: return "Review relevance.";
  }
}

/** Full scan for one workspace (job + "Scan now" button). Bounded to the active research universe via watchlist when present. */
/** Workspace scan (lease windows + claims + commercial). `orgIds` limits it to those companies (a targeted refresh). */
export async function scanWorkspace(db: Db, ws: string, opts: { today?: string; since?: string; orgIds?: string[] } = {}) {
  const s = await settings(db, ws);
  const cache = new Map<string, OrgContext>();
  const today = opts.today ?? today0();
  const lease = await scanLeaseEvents(db, ws, s, today, cache, opts.orgIds);
  const claims = await scanClaims(db, ws, s, { today, since: opts.since, orgIds: opts.orgIds }, cache);
  const { scanCommercialValue } = await import("./commercial");
  const commercial = await scanCommercialValue(db, ws, s, today, cache, opts.orgIds);
  await syncCompletedTasks(db, ws);
  // Unsnooze due signals.
  await db.from("signal").update({ status: "new", snoozed_until: null }).eq("workspace_id", ws).eq("status", "snoozed").lte("snoozed_until", today);
  return { lease, claims, commercial };
}

// ------------------------------------------------------------------ source adapter: pasted / fetched text (untrusted evidence)

export interface IngestInput { text: string; companyName?: string; orgId?: string; sourceName?: string; sourceUrl?: string; publishedOn?: string; actorUserId?: string; signalId?: string }
/**
 * Manual-paste adapter entry point (kept for existing callers). Delegates to the full pipeline (pipeline.ts): source item +
 * source_object provenance, entitlement gate, parse, dedupe, entity resolution, claims, signals. Untrusted text is only
 * pattern-matched — never executed, never trusted for permissions.
 */
export async function ingestText(db: Db, ws: string, input: IngestInput) {
  const { processSourceItem } = await import("./pipeline");
  const r = await processSourceItem(db, ws, { adapter: "manual_paste", text: input.text, companyName: input.companyName, orgId: input.orgId, sourceName: input.sourceName,
    url: input.sourceUrl, publishedOn: input.publishedOn, actorUserId: input.actorUserId, signalId: input.signalId });
  const res = r.resolution;
  const resolution: Resolution | null = res ? { orgId: res.orgId, candidates: res.candidates.map((c) => ({ id: c.id, name: c.name })), method: res.orgId ? (res.method === "alias" ? "alias" : "exact") : res.method === "ambiguous" ? "ambiguous" : "none" } : null;
  return { signals: r.signals, detected: r.detected, resolution, itemId: r.itemId, status: r.status, counterFor: r.counterFor ?? [], rawName: res?.rawName ?? null };
}

// ------------------------------------------------------------------ review actions (all persisted + history)

export type SignalAction = "approve" | "reject" | "dismiss" | "snooze" | "investigate" | "known" | "assign_me" | "create_task"
  | "link_opportunity" | "propose_opportunity" | "add_evidence" | "add_counter" | "correct_company" | "override_priority" | "reopen"
  | "clear_override" | "record_outcome" | "reevaluate";

const STATUS_FOR: Partial<Record<SignalAction, string>> = { approve: "approved", reject: "rejected", dismiss: "dismissed", snooze: "snoozed", investigate: "reviewing", known: "known", reopen: "new" };
const PROC_FOR: Record<string, string> = { approved: "approved", rejected: "rejected", dismissed: "archived", known: "archived", reviewing: "assessment_pending", new: "review_required", snoozed: "review_required", converted: "converted_to_action" };

export async function actOnSignal(db: Db, ws: string, userId: string, id: string, action: SignalAction, data: Record<string, string | undefined> = {}) {
  const { data: sig } = await db.from("signal").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!sig) throw new SignalError("Signal not found.");
  const reason = (data.reason ?? "").trim() || null;
  const patch: Row = {};
  const log: Row = {};
  const to = STATUS_FOR[action];
  if (to) {
    if ((action === "reject" || action === "dismiss") && !reason) throw new SignalError("Give a short reason.");
    if (action === "snooze") {
      const until = data.until ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new SignalError("Pick a date to snooze until.");
      if (until <= localDate()) throw new SignalError("Snooze until a date after today.");
      patch.snoozed_until = until; log.until = until;
    } else patch.snoozed_until = null;
    patch.status = to; patch.status_reason = reason; patch.processing_status = PROC_FOR[to];
  }
  if (action === "assign_me") patch.assigned_user_id = userId;
  if (action === "create_task" || action === "approve") {
    const taskId = await createTask(db, ws, userId, sig, data.title);
    patch.task_id = taskId; log.task_id = taskId;
    if (action === "create_task" && sig.status === "new") { patch.status = "reviewing"; patch.processing_status = "assessment_pending"; }
    if (action === "approve") { patch.status = "converted"; patch.processing_status = "converted_to_action"; }
  }
  if (action === "link_opportunity") {
    if (!data.opportunity_id) throw new SignalError("Pick an opportunity.");
    const { data: o } = await db.from("opportunity").select("id, org_id").eq("workspace_id", ws).eq("id", data.opportunity_id).maybeSingle();
    if (!o) throw new SignalError("Opportunity not found.");
    patch.opportunity_id = o.id; log.opportunity_id = o.id;
  }
  if (action === "propose_opportunity") {
    if (!sig.org_id) throw new SignalError("Link the signal to a company first.");
    const p = await proposeChange(db, ws, {
      targetType: "opportunity", operation: "create", reason: `From signal: ${sig.title}`, actorUserId: userId, proposedByKind: "user",
      idempotencyKey: `signals.opportunity:${sig.id}`,
      patch: [{ op: "add", path: "/org_id", value: sig.org_id }, { op: "add", path: "/name", value: (data.name || sig.title).slice(0, 200) }, { op: "add", path: "/stage", value: "research" }],
    } as never);
    log.proposal_id = (p as Row).id;
  }
  if (action === "add_evidence" || action === "add_counter") {
    const text = (data.text ?? "").trim();
    if (text.length < 5) throw new SignalError("Write the evidence.");
    const link = checkHttpUrl(data.url, "Source link"); if (link.error) throw new SignalError(link.error);
    await db.from("signal_evidence").insert({ workspace_id: ws, signal_id: id, role: action === "add_counter" ? "counter" : "support",
      dedupe_key: `user:${Date.now()}`, source_name: data.source || "User note", source_url: link.value, excerpt: text.slice(0, 1000),
      label: action === "add_counter" ? null : "inference", independence_key: link.value ? null : `user-note:${userId}:${Date.now()}`,
      evidence_tier: action === "add_counter" ? null : "single_unverified", fact_status: "reported", published_on: data.published_on || null });
  }
  if (action === "correct_company") {
    if (!data.org_id) throw new SignalError("Pick the correct company.");
    const { data: o } = await db.from("organisation").select("id, display_name").eq("workspace_id", ws).eq("id", data.org_id).maybeSingle();
    if (!o) throw new SignalError("Company not found.");
    const prevName = sig.org_id ? (await db.from("organisation").select("display_name").eq("workspace_id", ws).eq("id", sig.org_id).maybeSingle()).data?.display_name ?? null : sig.entity_name_raw ?? null;
    log.from_org_id = sig.org_id; log.raw_name = sig.entity_name_raw; log.from_name = prevName; log.to_name = o.display_name; patch.org_id = o.id;
    patch.title = retitle(sig.title, [prevName, sig.entity_name_raw, "Unresolved company"], o.display_name); patch.entity_name_raw = null; patch.entity_candidates = [];
    patch.entity_resolution = { method: "user_selected", by: userId, at: new Date().toISOString(), previous: sig.entity_resolution ?? null, raw_name: sig.entity_name_raw };
    if (sig.processing_status === "entity_unresolved") patch.processing_status = "review_required";
  }
  if (action === "override_priority") {
    const band = data.band;
    if (!band || !["high", "medium", "low"].includes(band)) throw new SignalError("Pick a priority.");
    if (!reason) throw new SignalError("Give a reason for the override.");
    if (data.review_on && (!/^\d{4}-\d{2}-\d{2}$/.test(data.review_on) || data.review_on <= localDate())) throw new SignalError("Review date must be a date after today.");
    patch.priority_override = { band, reason, user_id: userId, at: new Date().toISOString(), review_on: data.review_on || null };
    patch.priority_band = band; patch.priority_review_on = data.review_on || null;
    log.override = patch.priority_override; log.previous_band = sig.priority_band;
  }
  if (action === "clear_override") {
    if (!sig.priority_override) throw new SignalError("No override to clear.");
    patch.priority_override = null; patch.priority_review_on = null; log.cleared = sig.priority_override;
  }
  if (action === "record_outcome") {
    const outcome = (data.outcome ?? "").trim();
    if (outcome.length < 3) throw new SignalError("Describe the outcome.");
    const taskId = sig.task_id as string | null;
    if (!taskId) throw new SignalError("Create or approve a task first.");
    const { error } = await db.from("task").update({ status: "done", completion_evidence: outcome.slice(0, 2000), completed_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", taskId);
    if (error) throw new SignalError(error.message);
    log.task_id = taskId; log.outcome = outcome.slice(0, 500);
    if (["new", "reviewing", "approved"].includes(sig.status)) { patch.status = "converted"; patch.processing_status = "converted_to_action"; }
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from("signal").update(patch).eq("workspace_id", ws).eq("id", id).eq("row_version", sig.row_version);
    if (error) throw new SignalError(error.message);
  }
  await db.from("signal_review").insert({ workspace_id: ws, signal_id: id, action, from_status: sig.status, to_status: patch.status ?? sig.status, reason, data: log, actor_user_id: userId });
  if (["add_evidence", "add_counter", "correct_company", "override_priority", "clear_override", "reevaluate", "reopen"].includes(action)) {
    const ctx = (patch.org_id ?? sig.org_id) ? await orgContext(db, ws, patch.org_id ?? sig.org_id) : null;
    await reassess(db, ws, id, await settings(db, ws), today0(), ctx);
  }
  return { ok: true, ...log };
}

/** Task via the existing task table; idempotent per signal. Never sends anything (S3). */
async function createTask(db: Db, ws: string, userId: string, sig: Row, title?: string): Promise<string> {
  const key = `signal:${sig.id}`;
  const { data: ex } = await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
  if (ex) return ex.id;
  const due = sig.event_date && sig.event_date > today0()
    ? new Date(Math.min(Date.parse(sig.event_date), Date.now() + 14 * 86_400_000)).toISOString()
    : new Date(Date.now() + 7 * 86_400_000).toISOString();
  // Short, actionable title; the full recommended action and context go in the description.
  const { data, error } = await db.from("task").insert({
    workspace_id: ws, title: (title?.trim() || shortAction(sig.recommended_action || sig.title)).slice(0, 300),
    description: [`Signal: ${sig.title}`, sig.recommended_action ? `Recommended: ${sig.recommended_action}` : null, sig.summary ?? null,
      (sig.missing_info ?? []).length ? `Missing: ${(sig.missing_info ?? []).join(" ")}` : null].filter(Boolean).join("\n").slice(0, 2000),
    related_entities: [{ type: "signal", id: sig.id }],
    due_at: due, priority: sig.priority_band === "high" ? 80 : sig.priority_band === "medium" ? 60 : 40, assigned_user_id: userId,
    linked_entity_type: sig.org_id ? "organisation" : sig.person_id ? "person" : null, linked_entity_id: sig.org_id ?? sig.person_id ?? null,
    source: "signal", idempotency_key: key, owner_user_id: userId,
  }).select("id").single();
  if (error) throw new SignalError(error.message);
  // Leadership: also review the previous employer relationship (never transfers confidential data).
  if (sig.category === "leadership" && sig.person_id) {
    const prevKey = `signal:${sig.id}:prev`;
    const { data: ex2 } = await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", prevKey).maybeSingle();
    if (!ex2) await db.from("task").insert({ workspace_id: ws, title: "Review relationship coverage at the previous employer", description: `Signal: ${sig.title}`,
      due_at: new Date(Date.now() + 14 * 86_400_000).toISOString(), priority: 40, assigned_user_id: userId, linked_entity_type: "person",
      linked_entity_id: sig.person_id, source: "signal", idempotency_key: prevKey, owner_user_id: userId });
  }
  return data.id;
}

/** "Cobaltfern Technologies: possible …" → "Cobaltfern Systems: possible …" when the company is corrected. */
export function retitle(title: string, oldNames: (string | null | undefined)[], newName: string): string {
  for (const n of oldNames) if (n && title.toLowerCase().startsWith(`${n.toLowerCase()}:`)) return `${newName}${title.slice(n.length)}`;
  return title;
}

/**
 * A signal's follow-up task completed elsewhere (e.g. /tasks) is written back: one `task_completed` history event with the
 * completion evidence, and the signal is marked converted to action. Idempotent (one event per task). Returns signals updated.
 */
export async function syncCompletedTasks(db: Db, ws: string, signalIds?: string[]): Promise<number> {
  let q = db.from("signal").select("id, status, row_version, task_id, task:task_id(id, status, completion_evidence, completed_at)").eq("workspace_id", ws)
    .not("task_id", "is", null).is("archived_at", null).limit(500);
  if (signalIds?.length) q = q.in("id", signalIds);
  else q = q.in("status", ["new", "reviewing", "approved", "converted"]);
  const rows = (await all<Row>(q)).filter((r) => r.task?.status === "done");
  if (!rows.length) return 0;
  const done = await all<Row>(db.from("signal_review").select("signal_id, action, data").eq("workspace_id", ws).in("signal_id", rows.map((r) => r.id)).in("action", ["task_completed", "record_outcome"]));
  let n = 0;
  for (const r of rows) {
    if (done.some((h) => h.signal_id === r.id && h.data?.task_id === r.task_id)) continue;
    const to = ["new", "reviewing", "approved"].includes(r.status) ? "converted" : r.status;
    if (to !== r.status) await db.from("signal").update({ status: to, processing_status: "converted_to_action" }).eq("workspace_id", ws).eq("id", r.id).eq("row_version", r.row_version);
    const { error } = await db.from("signal_review").insert({ workspace_id: ws, signal_id: r.id, action: "task_completed", from_status: r.status, to_status: to,
      reason: null, data: { task_id: r.task_id, outcome: r.task.completion_evidence ? String(r.task.completion_evidence).slice(0, 500) : null, completed_at: r.task.completed_at ?? null } });
    if (!error) n++;
  }
  return n;
}

// ------------------------------------------------------------------ dashboard query

export const VIEWS = {
  all: "All", high: "High priority", expansion: "Expansion", restructuring: "Restructuring", lease: "Lease events",
  commercial: "Commercial", leadership: "Leadership", infrastructure: "Infrastructure", unverified: "Unverified", closed: "Dismissed & snoozed",
} as const;
export type View = keyof typeof VIEWS;

export interface ListFilter {
  view?: View; q?: string; confidence?: string; status?: string; assigned?: string; userId?: string; from?: string; to?: string;
  orgId?: string; industry?: string; microMarket?: string; category?: Category; subType?: string; eventFrom?: string; eventTo?: string;
  freshDays?: number; urgency?: string; source?: string; sort?: "priority" | "detected" | "event";
}
const LIST_SELECT = "*, org:org_id(display_name, sector), person:person_id(full_name), evidence:signal_evidence(source_name, source_url, role, published_on)";
const clean = (v: string) => v.replace(/[,()%*\\"]/g, " ").trim();
export async function listSignals(db: Db, ws: string, f: ListFilter) {
  const apply = (q: any) => {
    const v = f.view ?? "all";
    if (v === "closed") q = q.in("status", ["dismissed", "snoozed", "rejected", "known"]);
    else {
      if (!f.status) q = q.not("status", "in", "(dismissed,snoozed,rejected,known)");
      if (v === "high") q = q.eq("priority_band", "high");
      else if (v === "unverified") q = q.in("verification", ["hypothesis", "unknown"]);
      else if (v !== "all") q = q.eq("category", v);
    }
    if (f.status) q = q.eq("status", f.status);
    if (f.confidence) q = q.eq("confidence", f.confidence);
    if (f.urgency) q = q.eq("priority_band", f.urgency);
    if (f.category) q = q.eq("category", f.category);
    if (f.subType) q = q.eq("sub_type", f.subType);
    if (f.orgId) q = q.eq("org_id", f.orgId);
    if (f.microMarket) q = q.or(`micro_market.ilike.%${clean(f.microMarket)}%,location_text.ilike.%${clean(f.microMarket)}%`);
    if (f.source) q = q.contains("source_names", [f.source]);
    if (f.assigned === "me" && f.userId) q = q.eq("assigned_user_id", f.userId);
    else if (f.assigned === "unassigned") q = q.is("assigned_user_id", null);
    else if (f.assigned && /^[0-9a-f-]{36}$/i.test(f.assigned)) q = q.eq("assigned_user_id", f.assigned);
    // Detection dates are IST calendar days (the UI shows IST): [from 00:00 IST, to+1 00:00 IST).
    if (f.from) q = q.gte("detected_at", atLocal(f.from, "00:00").toISOString());
    if (f.to) q = q.lt("detected_at", atLocal(addDay(f.to), "00:00").toISOString());
    if (f.eventFrom) q = q.gte("event_date", f.eventFrom);
    if (f.eventTo) q = q.lte("event_date", f.eventTo);
    if (f.freshDays != null && f.freshDays >= 0) q = q.gte("latest_evidence_on", localDate(new Date(Date.now() - f.freshDays * 86_400_000)));
    return q;
  };
  const order = (q: any) => f.sort === "detected" ? q.order("detected_at", { ascending: false })
    : f.sort === "event" ? q.order("event_date", { ascending: true, nullsFirst: false }) : q.order("priority", { ascending: false }).order("detected_at", { ascending: false });
  let base = apply(db.from("signal").select(LIST_SELECT).eq("workspace_id", ws).is("archived_at", null));
  if (f.industry) {
    const orgs = await all<Row>(db.from("organisation").select("id").eq("workspace_id", ws).ilike("sector", containsLike(f.industry)).limit(500));
    if (!orgs.length) return [];
    base = base.in("org_id", orgs.map((o) => o.id));
  }
  if (f.q) { const s = clean(f.q); base = base.or(`title.ilike.%${s}%,summary.ilike.%${s}%,location_text.ilike.%${s}%,entity_name_raw.ilike.%${s}%,contextual_summary.ilike.%${s}%`); }
  const rows = await all<Row>(order(base).limit(200));
  if (f.q && rows.length < 200) {
    // Company names (joined organisation) and evidence excerpts are searched too — same filters applied.
    const [orgs, evs] = await Promise.all([
      all<Row>(db.from("organisation").select("id").eq("workspace_id", ws).ilike("display_name", containsLike(f.q)).limit(50)),
      all<Row>(db.from("signal_evidence").select("signal_id").eq("workspace_id", ws).ilike("excerpt", containsLike(f.q)).limit(100)),
    ]);
    const extraQs = [];
    if (orgs.length) extraQs.push(apply(db.from("signal").select(LIST_SELECT).eq("workspace_id", ws).is("archived_at", null)).in("org_id", orgs.map((o) => o.id)).limit(100));
    if (evs.length) extraQs.push(apply(db.from("signal").select(LIST_SELECT).eq("workspace_id", ws).is("archived_at", null)).in("id", [...new Set(evs.map((e) => e.signal_id))]).limit(100));
    for (const q of extraQs) for (const e of await all<Row>(q)) if (!rows.some((r) => r.id === e.id)) rows.push(e);
  }
  return rows;
}

export async function signalDetail(db: Db, ws: string, id: string) {
  const [sig, ev, hist] = await Promise.all([
    db.from("signal").select("*, org:org_id(display_name, sector), person:person_id(full_name), evidence:signal_evidence(source_name, source_url, role, published_on)").eq("workspace_id", ws).eq("id", id).maybeSingle().then((r) => r.data),
    all<Row>(db.from("signal_evidence").select("*").eq("workspace_id", ws).eq("signal_id", id).is("archived_at", null).order("created_at")),
    all<Row>(db.from("signal_review").select("*").eq("workspace_id", ws).eq("signal_id", id).order("created_at", { ascending: false }).limit(50)),
  ]);
  return sig ? { signal: sig as Row, evidence: ev, history: hist } : null;
}

export async function counts(db: Db, ws: string) {
  const rows = await all<Row>(db.from("signal").select("category, priority_band, status, verification").eq("workspace_id", ws).is("archived_at", null).limit(5000));
  const open = rows.filter((r) => !["dismissed", "snoozed", "rejected", "known"].includes(r.status));
  const c: Record<string, number> = { all: open.length, high: open.filter((r) => r.priority_band === "high").length,
    unverified: open.filter((r) => ["hypothesis", "unknown"].includes(r.verification)).length, closed: rows.length - open.length };
  for (const r of open) c[r.category] = (c[r.category] ?? 0) + 1;
  return c;
}

// ------------------------------------------------------------------ filter dropdowns (§10)

export interface FilterOptions { companies: { id: string; name: string }[]; industries: string[]; microMarkets: string[]; sources: string[]; subTypes: { category: string; subType: string; label: string }[]; assignees: { id: string; name: string }[] }
export async function filterOptions(db: Db, ws: string): Promise<FilterOptions> {
  // Page explicitly (stable order): the API caps each response, so a single .limit(5000) silently truncates big workspaces.
  const rows: Row[] = [];
  for (let from = 0, PAGE = 1000; from < 20_000; from += PAGE) {
    const page = await all<Row>(db.from("signal").select("id, org_id, sub_type, category, micro_market, source_names, assigned_user_id, org:org_id(display_name, sector)").eq("workspace_id", ws).is("archived_at", null).order("id").range(from, from + PAGE - 1));
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const companies = new Map<string, string>(); const industries = new Set<string>(); const mms = new Set<string>(); const sources = new Set<string>();
  const subs = new Map<string, { category: string; subType: string; label: string }>(); const assignees = new Set<string>();
  for (const r of rows) {
    if (r.org_id && r.org?.display_name) companies.set(r.org_id, r.org.display_name);
    if (r.org?.sector) industries.add(r.org.sector);
    if (r.micro_market) mms.add(r.micro_market);
    for (const s of r.source_names ?? []) sources.add(s);
    if (r.sub_type) subs.set(r.sub_type, { category: r.category, subType: r.sub_type, label: SUB_TYPES[r.sub_type]?.label ?? r.sub_type });
    if (r.assigned_user_id) assignees.add(r.assigned_user_id);
  }
  const ids = [...assignees];
  const { data: profiles } = ids.length ? await db.from("membership").select("user_id, display_name").eq("workspace_id", ws).in("user_id", ids) : { data: [] as Row[] };
  const sort = (a: string, b: string) => a.localeCompare(b);
  return {
    companies: [...companies].map(([id, name]) => ({ id, name })).sort((a, b) => sort(a.name, b.name)),
    industries: [...industries].sort(sort), microMarkets: [...mms].sort(sort), sources: [...sources].sort(sort),
    subTypes: [...subs.values()].sort((a, b) => sort(a.label, b.label)),
    assignees: ids.map((id) => ({ id, name: (profiles ?? []).find((p: Row) => p.user_id === id)?.display_name ?? "Team member" })),
  };
}

/** Place-name variants: "Kharadi (SBD East)" → ["kharadi", "sbd east"]; case/punctuation-insensitive. */
export function placeKeys(name: string | null | undefined): string[] {
  if (!name) return [];
  const norm = (x: string) => x.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const inner = [...name.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(/[\/,;]| or /));
  const outer = name.replace(/\([^)]*\)/g, " ").split(/[\/,;]| or /);
  return [...new Set([...outer, ...inner].map(norm).filter(Boolean))];
}
/** True when any text-side name (micro-market or locality, incl. aliases) matches any recorded micro-market. */
export function placesOverlap(text: (string | null | undefined)[], recorded: string[]): boolean {
  const r = new Set(recorded.flatMap(placeKeys));
  return text.flatMap(placeKeys).some((k) => r.has(k));
}
