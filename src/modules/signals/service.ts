/**
 * Signal Engine service. Builds reviewable `signal` rows from Module 1 data:
 *  - signal_claim (company / person evidence, incl. job moves)  -> expansion / restructuring / leadership / ... signals
 *  - lease_event (expiry, lock-in, notice, break, option)        -> lease signals (types never merged)
 *  - pasted / adapter text                                        -> rule detection -> signal_claim -> signal
 * Every write goes through the caller's client (RLS for users; jobs pass the admin client AND filter workspace_id).
 * Idempotent: signals are keyed by dedupe_key, evidence by (signal, dedupe_key), tasks by task.idempotency_key.
 */
import type { Db } from "@/lib/supabase/server";
import { proposeChange } from "@/lib/services/changes";
import { detectSignals, hypothesisSummary } from "@/modules/intelligence/research/signals";
import {
  RULE_VERSION, categoryOf, leaseSignal, counterEvidence, assessConfidence, priorityOf, nextAction, missingInfo, dedupeKey,
  daysBetween, citiesIn, normName, DEFAULT_WEIGHTS, type Category, type ContextFacts, type PriorityWeights, type Verification,
} from "./engine";

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
    universeCap: typeof v.universeCap === "number" ? v.universeCap : 1500,
  };
}

// ------------------------------------------------------------------ entity resolution (deterministic)

export interface Resolution { orgId: string | null; candidates: { id: string; name: string }[]; method: "exact" | "alias" | "none" | "ambiguous" }
/** Exact name / legal name / approved alias only. Fuzzy hits are returned as candidates for review, never auto-linked. */
export async function resolveOrg(db: Db, ws: string, name: string): Promise<Resolution> {
  const n = name.trim();
  if (!n) return { orgId: null, candidates: [], method: "none" };
  const exact = await all<Row>(db.from("organisation").select("id, display_name").eq("workspace_id", ws).is("archived_at", null)
    .or(`display_name.ilike.${esc(n)},legal_name.ilike.${esc(n)}`).limit(3));
  if (exact.length === 1) return { orgId: exact[0].id, candidates: [], method: "exact" };
  if (exact.length > 1) return { orgId: null, candidates: exact.map((r) => ({ id: r.id, name: r.display_name })), method: "ambiguous" };
  const alias = await all<Row>(db.from("entity_alias").select("entity_id").eq("workspace_id", ws).eq("entity_type", "organisation")
    .eq("canonical_alias", normName(n)).is("archived_at", null).limit(3));
  const ids = [...new Set(alias.map((a) => a.entity_id))];
  if (ids.length === 1) return { orgId: ids[0], candidates: [], method: "alias" };
  const fuzzy = await all<Row>(db.from("organisation").select("id, display_name").eq("workspace_id", ws).is("archived_at", null)
    .ilike("display_name", `%${normName(n).split(" ")[0] ?? n}%`).limit(5));
  return { orgId: null, candidates: fuzzy.map((r) => ({ id: r.id, name: r.display_name })), method: ids.length > 1 ? "ambiguous" : "none" };
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

interface Evidence { role: "support" | "counter" | "context"; key: string; claimId?: string; leaseEventId?: string; sourceName?: string | null; url?: string | null; excerpt?: string | null; tier?: string | null; status?: string | null; published?: string | null; note?: string | null }
interface Draft {
  category: Category; kind: string; title: string; summary: string; creRelevance: string; orgId?: string | null; personId?: string | null;
  leaseId?: string | null; leaseEventId?: string | null; nameRaw?: string | null; location?: string | null; eventDate?: string | null;
  eventDateBasis?: string | null; daysAway?: number | null; verification: Verification; evidence: Evidence[]; key: string;
  recommended?: { text: string; actionKind: string }; processing?: string;
}

async function upsertSignal(db: Db, ws: string, d: Draft, s: Settings, today: string, ctxCache: Map<string, OrgContext>): Promise<{ id: string; created: boolean }> {
  const ctx = d.orgId ? ctxCache.get(d.orgId) ?? await orgContext(db, ws, d.orgId).then((c) => (ctxCache.set(d.orgId!, c), c)) : null;
  const { data: existing } = await db.from("signal").select("id, status").eq("workspace_id", ws).eq("dedupe_key", d.key).maybeSingle();
  let id = existing?.id as string | undefined;
  let created = false;
  if (!id) {
    const { data, error } = await db.from("signal").insert({
      workspace_id: ws, category: d.category, kind: d.kind, title: d.title, summary: d.summary, cre_relevance: d.creRelevance,
      org_id: d.orgId ?? null, person_id: d.personId ?? null, lease_id: d.leaseId ?? null, lease_event_id: d.leaseEventId ?? null,
      entity_name_raw: d.nameRaw ?? null, location_text: d.location ?? null, event_date: d.eventDate ?? null, event_date_basis: d.eventDateBasis ?? null,
      verification: d.verification, dedupe_key: d.key, rule_version: RULE_VERSION,
      processing_status: d.processing ?? (d.orgId || d.personId ? "review_required" : "entity_unresolved"),
    }).select("id").single();
    if (error) {
      if (!/duplicate key/.test(error.message)) throw new SignalError(error.message);
      const again = await db.from("signal").select("id").eq("workspace_id", ws).eq("dedupe_key", d.key).single();
      id = again.data!.id;
    } else { id = data.id; created = true; }
  }
  for (const e of d.evidence) {
    await db.from("signal_evidence").upsert({
      workspace_id: ws, signal_id: id, role: e.role, dedupe_key: e.key, signal_claim_id: e.claimId ?? null, lease_event_id: e.leaseEventId ?? null,
      source_name: e.sourceName ?? null, source_url: e.url ?? null, excerpt: e.excerpt?.slice(0, 1000) ?? null, evidence_tier: e.tier ?? null,
      fact_status: e.status ?? null, published_on: e.published ?? null, note: e.note ?? null,
    }, { onConflict: "workspace_id,signal_id,dedupe_key", ignoreDuplicates: true });
  }
  await reassess(db, ws, id!, s, today, ctx ?? null, d);
  return { id: id!, created };
}

/** Recompute confidence, counter-evidence, priority, missing info and next action from ALL stored evidence. */
async function reassess(db: Db, ws: string, id: string, s: Settings, today: string, ctx: OrgContext | null, d?: Partial<Draft>) {
  const sig = (await db.from("signal").select("*").eq("workspace_id", ws).eq("id", id).single()).data as Row;
  const ev = await all<Row>(db.from("signal_evidence").select("*").eq("workspace_id", ws).eq("signal_id", id).is("archived_at", null));
  const support = ev.filter((e) => e.role === "support");
  const texts = support.map((e) => `${e.excerpt ?? ""} ${e.note ?? ""}`);
  const latest = support.map((e) => e.published_on).filter(Boolean).sort().pop() ?? null;
  const focus = s.focusCities.map((c) => c.toLowerCase());
  const inFocusGeo = citiesIn([...texts, sig.location_text ?? "", ...(ctx?.locations ?? [])]).some((c) => focus.includes(c.toLowerCase()))
    || sig.category === "lease";
  const f = facts(ctx);
  const person = sig.person_id ? (await db.from("employment").select("title, function").eq("workspace_id", ws).eq("person_id", sig.person_id).eq("is_current", true).limit(1).maybeSingle()).data : null;
  const counters = [
    ...counterEvidence({ category: sig.category, kind: sig.kind, texts, focusCities: s.focusCities, sourceCount: new Set(support.map((e) => e.source_url ?? e.source_name ?? e.id)).size,
      latestEvidenceOn: latest, today, hasOccupancyInFocus: inFocusGeo && f.hasLease, personFunction: person ? `${person.title ?? ""} ${person.function ?? ""}` : null }),
    ...ev.filter((e) => e.role === "counter").map((e) => e.excerpt ?? e.note ?? "Counter-evidence recorded."),
  ];
  const leaseEv = sig.category === "lease"
    ? [{ tier: sig.verification === "fact" ? "documentary_current" : "credible_reported", status: sig.verification === "fact" ? "currently_confirmed" : "reported", source: "lease record", published_on: null }]
    : [];
  const conf = assessConfidence([...leaseEv, ...support.map((e) => ({ tier: e.evidence_tier, status: e.fact_status, source: e.source_url ?? e.source_name, published_on: e.published_on }))], counters);
  const daysAway = d?.daysAway ?? (sig.event_date ? daysBetween(today, sig.event_date) : null);
  const leaseWithin18m = (ctx?.leaseEvents ?? []).some((e) => e.event_date && daysBetween(today, e.event_date) >= 0 && daysBetween(today, e.event_date) <= 548);
  const pr = priorityOf({
    category: sig.category, daysAway, confidence: conf.confidence, inFocusGeo, hasContact: f.hasContact,
    hasOpenOpportunity: !!ctx?.opportunities.some((o) => o.outcome === "open"), hasRequirement: f.hasRequirement, leaseWithin18m,
    freshnessDays: latest ? daysBetween(latest, today) : null, needsVerification: sig.verification !== "fact",
  }, s.weights);
  const na = d?.recommended ?? nextAction(sig.category, sig.kind, f);
  const ov = sig.priority_override as Row | null;
  const contextJson = ctx ? {
    company: ctx.org?.display_name, sector: ctx.org?.sector, locations: ctx.locations,
    leases: ctx.leases.map((l) => ({ id: l.id, asset: l.asset?.name, area_sf: l.area_sf, expiry: l.contractual_expiry })),
    lease_events: ctx.leaseEvents.map((e) => ({ type: e.event_type, date: e.event_date, basis: e.date_basis, confirmed: e.confirmed })),
    requirements: ctx.requirements.map((r) => ({ id: r.id, title: r.title })), contacts: ctx.contacts,
    opportunities: ctx.opportunities.map((o) => ({ id: o.id, name: o.name, stage: o.stage, outcome: o.outcome })),
    last_interaction_on: ctx.lastInteractionOn, open_tasks: ctx.openTasks, counter_evidence: counters,
  } : { counter_evidence: counters };
  await db.from("signal").update({
    confidence: conf.confidence, confidence_reasons: conf.reasons, latest_evidence_on: latest,
    priority: pr.score, priority_band: ov?.band ?? pr.band, priority_reasons: ov ? [...pr.reasons, `Overridden to ${ov.band}: ${ov.reason}`] : pr.reasons,
    recommended_action: contextual(na.text, sig, ctx), action_kind: na.actionKind, missing_info: missingInfo(sig.category, f), context_json: contextJson,
  }).eq("workspace_id", ws).eq("id", id);
}

/** "Potential Pune expansion. Existing Kharadi occupancy and a known facilities contact are recorded. ..." */
function contextual(action: string, sig: Row, ctx: OrgContext | null): string {
  if (!ctx) return action;
  const bits: string[] = [];
  if (ctx.locations.length) bits.push(`existing occupancy at ${ctx.locations.slice(0, 2).join(", ")}`);
  const c = ctx.contacts.find((p) => CRE_TITLE.test(`${p.title ?? ""} ${p.function ?? ""}`));
  if (c) bits.push(`known contact ${c.name}${c.title ? ` (${c.title})` : ""}`);
  if (ctx.lastInteractionOn) bits.push(`last interaction ${ctx.lastInteractionOn}`);
  return bits.length ? `${action} On record: ${bits.join("; ")}. Capacity unverified.` : action;
}

// ------------------------------------------------------------------ generators

const today0 = () => new Date().toISOString().slice(0, 10);

export async function scanLeaseEvents(db: Db, ws: string, s: Settings, today = today0(), cache = new Map<string, OrgContext>()) {
  const from = new Date(Date.parse(today) - 365 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(today) + 540 * 86_400_000).toISOString().slice(0, 10);
  const evs = await all<Row>(db.from("lease_event").select("id, lease_id, event_type, event_date, date_basis, confirmed, notice_days, lease:lease_id(tenant_org_id, tenant_name_raw, asset:asset_id(name, locality:locality_id(name)))")
    .eq("workspace_id", ws).is("archived_at", null).gte("event_date", from).lte("event_date", to).limit(2000));
  let created = 0;
  for (const e of evs) {
    const spec = leaseSignal(e as never, today);
    if (!spec) continue;
    const orgId = e.lease?.tenant_org_id ?? null;
    const who = orgId ? (cache.get(orgId)?.org?.display_name ?? null) : e.lease?.tenant_name_raw;
    const where = [e.lease?.asset?.name, e.lease?.asset?.locality?.name].filter(Boolean).join(", ");
    const r = await upsertSignal(db, ws, {
      category: "lease", kind: spec.kind, title: spec.title, key: `lease:${e.id}:${spec.kind}`,
      summary: `${spec.title}${where ? ` at ${where}` : ""}. Date basis: ${e.date_basis}${e.confirmed ? ", confirmed" : ", not confirmed"}.`,
      creRelevance: spec.past ? "A passed expiry needs checking; it is not evidence of a current space need." : "A dated lease event creates a decision window for the occupier (renew, relocate, resize).",
      orgId, leaseId: e.lease_id, leaseEventId: e.id, nameRaw: who ?? null, location: where || null, eventDate: e.event_date, eventDateBasis: e.date_basis,
      daysAway: spec.daysAway, verification: spec.verification, recommended: { text: spec.recommended, actionKind: spec.actionKind },
      evidence: [{ role: "support", key: `lease_event:${e.id}`, leaseEventId: e.id, sourceName: "Lease record", tier: e.confirmed ? "documentary_current" : null, status: e.confirmed ? "currently_confirmed" : "reported", note: `${e.event_type} ${e.event_date} (${e.date_basis})` }],
      processing: orgId ? "review_required" : "entity_unresolved",
    }, s, today, cache);
    if (r.created) created++;
  }
  return created;
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
    case "macro": return "Indirect context for account reviews.";
    default: return "Review relevance.";
  }
}

/** Full scan for one workspace (job + "Scan now" button). Bounded to the active research universe via watchlist when present. */
export async function scanWorkspace(db: Db, ws: string, opts: { today?: string; since?: string } = {}) {
  const s = await settings(db, ws);
  const cache = new Map<string, OrgContext>();
  const today = opts.today ?? today0();
  const lease = await scanLeaseEvents(db, ws, s, today, cache);
  const claims = await scanClaims(db, ws, s, { today, since: opts.since }, cache);
  // Unsnooze due signals.
  await db.from("signal").update({ status: "new", snoozed_until: null }).eq("workspace_id", ws).eq("status", "snoozed").lte("snoozed_until", today);
  return { lease, claims };
}

// ------------------------------------------------------------------ source adapter: pasted / fetched text (untrusted evidence)

export interface IngestInput { text: string; companyName?: string; orgId?: string; sourceName?: string; sourceUrl?: string; publishedOn?: string; actorUserId?: string }
/** Rule detection over untrusted text. Text is pattern-matched only — never executed, never trusted for permissions. */
export async function ingestText(db: Db, ws: string, input: IngestInput) {
  const text = (input.text ?? "").slice(0, 20_000).trim();
  if (text.length < 20) throw new SignalError("Paste at least a sentence of evidence.");
  const found = detectSignals(text);
  let orgId = input.orgId ?? null;
  let resolution: Resolution | null = null;
  if (!orgId && input.companyName) { resolution = await resolveOrg(db, ws, input.companyName); orgId = resolution.orgId; }
  const s = await settings(db, ws);
  const today = today0();
  const cache = new Map<string, OrgContext>();
  const out: { id: string; created: boolean }[] = [];
  if (!found.length) return { signals: out, detected: 0, resolution };
  for (const f of found) {
    const cat = categoryOf(f.kind)!;
    let claimId: string | undefined;
    if (orgId) {
      const { data: dup } = await db.from("signal_claim").select("id").eq("workspace_id", ws).eq("subject_id", orgId).eq("claim_type", f.kind)
        .eq("evidence_excerpt", f.context).limit(1);
      claimId = dup?.[0]?.id;
      if (!claimId) {
        const { data, error } = await db.from("signal_claim").insert({
          workspace_id: ws, subject_type: "organisation", subject_id: orgId, claim_type: f.kind, predicate: f.rule,
          value_json: { text: f.context, rule: f.rule, source_name: input.sourceName ?? null }, status: "ai_inference", evidence_tier: "single_unverified",
          evidence_excerpt: f.context, source_url: input.sourceUrl ?? null, source_locator: input.sourceName ?? "pasted",
          published_on: input.publishedOn ?? null, observed_on: today, owner_user_id: input.actorUserId ?? undefined,
        }).select("id").single();
        if (error) throw new SignalError(error.message);
        claimId = data.id;
      }
    }
    const entity = orgId ?? `name:${normName(input.companyName ?? "unknown")}`;
    const r = await upsertSignal(db, ws, {
      category: cat, kind: f.kind, key: dedupeKey(cat, f.kind, entity, input.publishedOn ?? today),
      title: `${input.companyName ?? "Unresolved company"}: possible ${f.kind.replace(/_/g, " ")}`,
      summary: hypothesisSummary(f), creRelevance: relevance(cat, f.kind), orgId, nameRaw: orgId ? null : input.companyName ?? null,
      location: citiesIn([f.context]).join(", ") || null, verification: "hypothesis",
      evidence: [{ role: "support", key: claimId ? `claim:${claimId}` : `text:${input.sourceUrl ?? ""}:${f.context.slice(0, 80)}`, claimId,
        sourceName: input.sourceName ?? "Pasted text", url: input.sourceUrl ?? null, excerpt: f.context, tier: "single_unverified", status: "ai_inference", published: input.publishedOn ?? null }],
      processing: orgId ? "review_required" : "entity_unresolved",
    }, s, today, cache);
    out.push(r);
  }
  return { signals: out, detected: found.length, resolution };
}

// ------------------------------------------------------------------ review actions (all persisted + history)

export type SignalAction = "approve" | "reject" | "dismiss" | "snooze" | "investigate" | "known" | "assign_me" | "create_task"
  | "link_opportunity" | "propose_opportunity" | "add_evidence" | "add_counter" | "correct_company" | "override_priority" | "reopen";

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
    await db.from("signal_evidence").insert({ workspace_id: ws, signal_id: id, role: action === "add_counter" ? "counter" : "support",
      dedupe_key: `user:${Date.now()}`, source_name: data.source || "User note", source_url: data.url || null, excerpt: text.slice(0, 1000),
      evidence_tier: action === "add_counter" ? null : "single_unverified", fact_status: "reported", published_on: data.published_on || null });
  }
  if (action === "correct_company") {
    if (!data.org_id) throw new SignalError("Pick the correct company.");
    const { data: o } = await db.from("organisation").select("id").eq("workspace_id", ws).eq("id", data.org_id).maybeSingle();
    if (!o) throw new SignalError("Company not found.");
    log.from_org_id = sig.org_id; patch.org_id = o.id; patch.entity_name_raw = null;
    if (sig.processing_status === "entity_unresolved") patch.processing_status = "review_required";
  }
  if (action === "override_priority") {
    const band = data.band;
    if (!band || !["high", "medium", "low"].includes(band)) throw new SignalError("Pick a priority.");
    if (!reason) throw new SignalError("Give a reason for the override.");
    patch.priority_override = { band, reason, user_id: userId, at: new Date().toISOString(), review_on: data.review_on || null };
    patch.priority_band = band;
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from("signal").update(patch).eq("workspace_id", ws).eq("id", id).eq("row_version", sig.row_version);
    if (error) throw new SignalError(error.message);
  }
  await db.from("signal_review").insert({ workspace_id: ws, signal_id: id, action, from_status: sig.status, to_status: patch.status ?? sig.status, reason, data: log, actor_user_id: userId });
  if (["add_evidence", "add_counter", "correct_company", "override_priority"].includes(action)) {
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
  const { data, error } = await db.from("task").insert({
    workspace_id: ws, title: (title || sig.recommended_action || sig.title).slice(0, 300),
    description: `Signal: ${sig.title}\n${sig.summary ?? ""}\nMissing: ${(sig.missing_info ?? []).join(" ")}`.slice(0, 2000),
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

// ------------------------------------------------------------------ dashboard query

export const VIEWS = {
  all: "All", high: "High priority", expansion: "Expansion", restructuring: "Restructuring", lease: "Lease events",
  commercial: "Commercial", leadership: "Leadership", infrastructure: "Infrastructure", unverified: "Unverified", closed: "Dismissed & snoozed",
} as const;
export type View = keyof typeof VIEWS;

export interface ListFilter { view?: View; q?: string; confidence?: string; status?: string; assigned?: string; userId?: string; from?: string; to?: string }
export async function listSignals(db: Db, ws: string, f: ListFilter) {
  let q = db.from("signal").select("*, org:org_id(display_name, sector), person:person_id(full_name)").eq("workspace_id", ws).is("archived_at", null);
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
  if (f.assigned === "me" && f.userId) q = q.eq("assigned_user_id", f.userId);
  if (f.from) q = q.gte("detected_at", f.from);
  if (f.to) q = q.lte("detected_at", `${f.to}T23:59:59Z`);
  if (f.q) { const s = f.q.replace(/[,()%]/g, " ").trim(); q = q.or(`title.ilike.%${s}%,summary.ilike.%${s}%,location_text.ilike.%${s}%,entity_name_raw.ilike.%${s}%`); }
  const rows = await all<Row>(q.order("priority", { ascending: false }).order("detected_at", { ascending: false }).limit(200));
  // Company-name search also matches via the joined organisation.
  if (f.q && rows.length < 200) {
    const orgs = await all<Row>(db.from("organisation").select("id").eq("workspace_id", ws).ilike("display_name", `%${f.q}%`).limit(50));
    if (orgs.length) {
      const extra = await all<Row>(db.from("signal").select("*, org:org_id(display_name, sector), person:person_id(full_name)").eq("workspace_id", ws).in("org_id", orgs.map((o) => o.id)).is("archived_at", null).limit(100));
      for (const e of extra) if (!rows.some((r) => r.id === e.id)) rows.push(e);
    }
  }
  return rows;
}

export async function signalDetail(db: Db, ws: string, id: string) {
  const [sig, ev, hist] = await Promise.all([
    db.from("signal").select("*, org:org_id(display_name, sector), person:person_id(full_name)").eq("workspace_id", ws).eq("id", id).maybeSingle().then((r) => r.data),
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
