import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured, AiUnavailableError, aiConfigured } from "@/lib/ai/gateway";
import { stableHash } from "@/lib/util/crypto";
import { type AiCall, type EvidenceTier, type ResearchTier, TIER_POLICY, isoDate, expiryFor } from "../common";
import {
  type DossierInputs, type ClaimRow, type EmploymentRow, type LeaseRow, type RelationRow, type TransactionRow, type InteractionRow,
  type StakeholderRow, type IntroPathSummary, type Synthesis, type DossierSection,
  buildDossierSections, evidenceKeys, shouldRegenerate, nextRefreshAt, ruleSynthesis, synthesisSections, sourcesSection, selectDossierInteractions,
} from "./dossier";
import { findIntroPaths, type Edge } from "../network/graph";

type Row = Record<string, unknown>;

async function rows<T = Row>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function nameMap(db: Db, workspaceId: string, table: "organisation" | "person" | "asset" | "geography", ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const m = new Map<string, string>();
  if (uniq.length === 0) return m;
  const col = table === "organisation" ? "display_name" : table === "person" ? "full_name" : "name";
  const data = await rows<Row>(db.from(table).select(`id, ${col}`).eq("workspace_id", workspaceId).in("id", uniq));
  for (const r of data) m.set(String(r.id), String(r[col]));
  return m;
}

/** Load everything the dossier contract needs, scoped to the workspace, with the person-move confidentiality filter applied. */
export async function loadDossierInputs(db: Db, workspaceId: string, orgId: string, me: string | null, today: string): Promise<DossierInputs> {
  const { data: org, error } = await db.from("organisation")
    .select("id, display_name, legal_name, cin, gstin, domain, sector, hq_country, headcount_min, headcount_max, is_gcc, updated_at, row_version")
    .eq("workspace_id", workspaceId).eq("id", orgId).maybeSingle();
  if (error) throw error;
  if (!org) throw new Error("organisation not found or not visible");

  const [relFrom, relTo, claims, emps, leases, txs, opps, reqs] = await Promise.all([
    rows<Row>(db.from("organisation_relation").select("id, to_org_id, relation_type, valid_from, valid_to, updated_at, row_version").eq("workspace_id", workspaceId).eq("from_org_id", orgId).is("archived_at", null)),
    rows<Row>(db.from("organisation_relation").select("id, from_org_id, relation_type, valid_from, valid_to, updated_at, row_version").eq("workspace_id", workspaceId).eq("to_org_id", orgId).is("archived_at", null)),
    rows<ClaimRow>(db.from("signal_claim").select("id, claim_type, predicate, value_json, status, evidence_tier, evidence_excerpt, source_url, source_locator, published_on, observed_on, effective_on, expires_on, created_at, row_version")
      .eq("workspace_id", workspaceId).eq("subject_type", "organisation").eq("subject_id", orgId).is("archived_at", null).order("observed_on", { ascending: false, nullsFirst: false }).limit(300)),
    rows<Row>(db.from("employment").select("id, person_id, title, function, seniority, start_date, end_date, is_current, fact_status, updated_at, row_version").eq("workspace_id", workspaceId).eq("org_id", orgId).is("archived_at", null)),
    rows<Row>(db.from("lease").select("id, asset_id, landlord_org_id, area_sf, area_basis, contractual_expiry, status, fact_status, updated_at, row_version").eq("workspace_id", workspaceId).eq("tenant_org_id", orgId).is("archived_at", null)),
    rows<Row>(db.from("market_transaction").select("id, asset_id, deal_type, period_start, period_precision, area_sf, rent_min, rent_max, rent_basis, source_object_id, updated_at, row_version").eq("workspace_id", workspaceId).eq("tenant_org_id", orgId).is("archived_at", null).limit(100)),
    rows<Row>(db.from("opportunity").select("id").eq("workspace_id", workspaceId).eq("org_id", orgId)),
    rows<Row>(db.from("requirement").select("id, title").eq("workspace_id", workspaceId).eq("org_id", orgId).is("archived_at", null)),
  ]);

  const orgNames = await nameMap(db, workspaceId, "organisation", [...relFrom.map((r) => r.to_org_id as string), ...relTo.map((r) => r.from_org_id as string), ...leases.map((l) => l.landlord_org_id as string)]);
  const relations: RelationRow[] = [
    ...relFrom.map((r) => ({ id: String(r.id), relation_type: String(r.relation_type), other_name: orgNames.get(String(r.to_org_id)) ?? "another organisation", direction: "from" as const, valid_from: r.valid_from as string | null, valid_to: r.valid_to as string | null, updated_at: String(r.updated_at), row_version: Number(r.row_version) })),
    ...relTo.map((r) => ({ id: String(r.id), relation_type: String(r.relation_type), other_name: orgNames.get(String(r.from_org_id)) ?? "another organisation", direction: "to" as const, valid_from: r.valid_from as string | null, valid_to: r.valid_to as string | null, updated_at: String(r.updated_at), row_version: Number(r.row_version) })),
  ];

  const personNames = await nameMap(db, workspaceId, "person", emps.map((e) => e.person_id as string));
  const employments: EmploymentRow[] = emps.map((e) => ({
    id: String(e.id), person_id: String(e.person_id), person_name: personNames.get(String(e.person_id)) ?? "(restricted person)",
    title: e.title as string | null, function: e.function as string | null, seniority: e.seniority as string | null,
    start_date: e.start_date as string | null, end_date: e.end_date as string | null, is_current: !!e.is_current,
    fact_status: e.fact_status as EmploymentRow["fact_status"], updated_at: String(e.updated_at), row_version: Number(e.row_version),
  }));

  const leaseIds = leases.map((l) => String(l.id));
  const events = leaseIds.length ? await rows<Row>(db.from("lease_event").select("id, lease_id, event_type, event_date, date_basis, confirmed, row_version").eq("workspace_id", workspaceId).in("lease_id", leaseIds).is("archived_at", null)) : [];
  const assetIds = [...leases.map((l) => l.asset_id as string), ...txs.map((t) => t.asset_id as string)];
  const assets = assetIds.filter(Boolean).length ? await rows<Row>(db.from("asset").select("id, name, locality_id").eq("workspace_id", workspaceId).in("id", [...new Set(assetIds.filter(Boolean))])) : [];
  const geo = await nameMap(db, workspaceId, "geography", assets.map((a) => a.locality_id as string));
  const assetById = new Map(assets.map((a) => [String(a.id), { name: String(a.name), locality: a.locality_id ? geo.get(String(a.locality_id)) ?? null : null }]));
  const leaseRows: LeaseRow[] = leases.map((l) => ({
    id: String(l.id), asset_name: l.asset_id ? assetById.get(String(l.asset_id))?.name ?? null : null, locality: l.asset_id ? assetById.get(String(l.asset_id))?.locality ?? null : null,
    area_sf: l.area_sf === null ? null : Number(l.area_sf), area_basis: l.area_basis as string | null, contractual_expiry: l.contractual_expiry as string | null,
    status: String(l.status), fact_status: l.fact_status as LeaseRow["fact_status"], landlord: l.landlord_org_id ? orgNames.get(String(l.landlord_org_id)) ?? null : null,
    updated_at: String(l.updated_at), row_version: Number(l.row_version),
    events: events.filter((e) => e.lease_id === l.id).map((e) => ({ id: String(e.id), event_type: String(e.event_type), event_date: e.event_date as string | null, date_basis: String(e.date_basis), confirmed: !!e.confirmed, row_version: Number(e.row_version) })),
  }));
  const transactions: TransactionRow[] = txs.map((t) => ({
    id: String(t.id), asset_name: t.asset_id ? assetById.get(String(t.asset_id))?.name ?? null : null, deal_type: t.deal_type as string | null,
    period_start: t.period_start as string | null, period_precision: String(t.period_precision), area_sf: t.area_sf === null ? null : Number(t.area_sf),
    rent_min: t.rent_min === null ? null : Number(t.rent_min), rent_max: t.rent_max === null ? null : Number(t.rent_max), rent_basis: t.rent_basis as string | null,
    source_object_id: t.source_object_id as string | null, updated_at: String(t.updated_at), row_version: Number(t.row_version),
  }));

  // interactions with confidentiality filter
  const oppIds = new Set(opps.map((o) => String(o.id)));
  const personIds = [...new Set(employments.map((e) => e.person_id))];
  const linkQueries = [
    rows<Row>(db.from("interaction_link").select("interaction_id").eq("workspace_id", workspaceId).eq("entity_type", "organisation").eq("entity_id", orgId)),
    oppIds.size ? rows<Row>(db.from("interaction_link").select("interaction_id").eq("workspace_id", workspaceId).eq("entity_type", "opportunity").in("entity_id", [...oppIds])) : Promise.resolve([] as Row[]),
    personIds.length ? rows<Row>(db.from("interaction_link").select("interaction_id").eq("workspace_id", workspaceId).eq("entity_type", "person").in("entity_id", personIds)) : Promise.resolve([] as Row[]),
  ];
  const candidateIds = [...new Set((await Promise.all(linkQueries)).flat().map((r) => String(r.interaction_id)))].slice(0, 500);
  let interactions: InteractionRow[] = [];
  if (candidateIds.length) {
    const [allLinks, ints] = await Promise.all([
      rows<Row>(db.from("interaction_link").select("interaction_id, entity_type, entity_id").eq("workspace_id", workspaceId).in("interaction_id", candidateIds)),
      rows<Row>(db.from("interaction").select("id, occurred_at, channel, direction, subject, objections, is_meaningful, row_version").eq("workspace_id", workspaceId).in("id", candidateIds).is("archived_at", null)),
    ]);
    const empHere = new Map<string, { start_date: string | null; end_date: string | null }>();
    for (const e of employments) empHere.set(e.person_id, { start_date: e.start_date, end_date: e.is_current ? null : e.end_date });
    const keep = selectDossierInteractions(
      ints.map((i) => ({ id: String(i.id), occurred_at: String(i.occurred_at), links: allLinks.filter((l) => l.interaction_id === i.id).map((l) => ({ entity_type: String(l.entity_type), entity_id: String(l.entity_id) })) })),
      orgId, oppIds, empHere,
    );
    interactions = ints.filter((i) => keep.has(String(i.id))).map((i) => ({
      id: String(i.id), occurred_at: String(i.occurred_at), channel: String(i.channel), direction: i.direction as string | null, subject: i.subject as string | null,
      objections: i.objections, is_meaningful: !!i.is_meaningful, row_version: Number(i.row_version),
    }));
  }

  // stakeholders on this org's requirements
  let stakeholders: StakeholderRow[] = [];
  if (reqs.length) {
    const sh = await rows<Row>(db.from("stakeholder").select("id, requirement_id, person_id, role, row_version").eq("workspace_id", workspaceId).in("requirement_id", reqs.map((r) => String(r.id))).is("archived_at", null));
    const pn = await nameMap(db, workspaceId, "person", sh.map((s) => s.person_id as string));
    stakeholders = sh.map((s) => ({ id: String(s.id), person_name: pn.get(String(s.person_id)) ?? "(restricted person)", role: String(s.role), requirement_title: String(reqs.find((r) => r.id === s.requirement_id)?.title ?? ""), row_version: Number(s.row_version) }));
  }

  // intro paths to current employees
  const currentIds = employments.filter((e) => e.is_current).map((e) => e.person_id);
  const introPaths = currentIds.length ? await introPathSummaries(db, workspaceId, me, currentIds, today) : [];

  return { org: org as DossierInputs["org"], relations, claims, employments, leases: leaseRows, transactions, interactions, stakeholders, introPaths };
}

export async function loadEdges(db: Db, workspaceId: string): Promise<Edge[]> {
  return rows<Edge>(db.from("relationship_edge").select("id, from_user_id, from_person_id, to_person_id, edge_type, warmth, intro_permission, last_meaningful_contact, valid_to").eq("workspace_id", workspaceId).is("archived_at", null).limit(5000));
}

export async function introPathSummaries(db: Db, workspaceId: string, me: string | null, targets: string[], today: string): Promise<IntroPathSummary[]> {
  const edges = await loadEdges(db, workspaceId);
  const paths = findIntroPaths(edges, me ?? "", targets, today).slice(0, 15);
  const names = await nameMap(db, workspaceId, "person", paths.flatMap((p) => p.hops.filter((h) => h.kind === "person").map((h) => h.id)));
  return paths.map((p) => ({
    target_person_id: p.target_person_id,
    target_name: names.get(p.target_person_id) ?? "(restricted person)",
    hops: p.hops.map((h) => (h.kind === "me" ? "You" : h.kind === "colleague" ? "Colleague" : names.get(h.id) ?? "(restricted person)")),
    warmth: p.warmth, needs_permission: p.needs_permission, last_contact: p.last_contact,
  }));
}

// ------------------------------------------------------------------ dossier generation
const SynthesisSchema = z.object({
  timing_hypothesis: z.string().nullable(),
  next_best_question: z.string(),
  falsification_questions: z.array(z.string()).max(6),
});

export interface GenerateOptions { now?: Date; force?: boolean; ai?: AiCall; userId?: string | null; tierOverride?: ResearchTier }
export interface GenerateResult { status: "generated" | "skipped"; reason: string; dossier: Row; synthesis_status?: "ok" | "fallback_no_ai"; degraded_reason?: string | null }

export async function generateDossier(db: Db, workspaceId: string, orgId: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const now = opts.now ?? new Date();
  const today = isoDate(now)!;
  const ai = opts.ai ?? (callStructured as AiCall);

  const { data: watch } = await db.from("watchlist").select("id, tier, refresh_cadence_days, owner_user_id").eq("workspace_id", workspaceId).eq("org_id", orgId).maybeSingle();
  const tier: ResearchTier = opts.tierOverride ?? (watch?.tier as ResearchTier) ?? "universe";
  const cadence = Number(watch?.refresh_cadence_days ?? TIER_POLICY[tier].cadenceDays);
  const me = opts.userId ?? (watch?.owner_user_id as string | null) ?? null;

  const inputs = await loadDossierInputs(db, workspaceId, orgId, me, today);
  const fingerprint = stableHash(evidenceKeys(inputs, tier));

  const { data: prev } = await db.from("research_dossier").select("*").eq("workspace_id", workspaceId).eq("org_id", orgId).eq("is_current", true).maybeSingle();
  const decision = shouldRegenerate(prev ? { evidence_fingerprint: String(prev.evidence_fingerprint), next_refresh_at: String(prev.next_refresh_at) } : null, fingerprint, now, opts.force);
  if (!decision.run && prev) {
    if (watch) await db.from("watchlist").update({ next_due_at: prev.next_refresh_at }).eq("workspace_id", workspaceId).eq("id", watch.id);
    return { status: "skipped", reason: decision.reason, dossier: prev };
  }

  const built = buildDossierSections(inputs, today);
  const rule = ruleSynthesis(inputs, built, today);
  let synthesis: Synthesis = rule;
  let synthesisStatus: "ok" | "fallback_no_ai" = "ok";
  let degraded: string | null = null;
  let model: string | null = null;
  try {
    const res = await ai({
      workspaceId, workflow: "research.dossier", tier: tier === "critical" ? "sol" : "luna",
      system: "You are a prospect researcher for a commercial-real-estate adviser in Pune. Produce a timing hypothesis, the single next best discovery question and falsification questions. Use only the evidence given. If timing is not supported by a dated event or live signal, return null. Never invent contacts, numbers or dates. Hiring is not an office-size commitment.",
      input: `Company: ${inputs.org.display_name}\nUnknown sections: ${built.sections.filter((s) => s.status === "unknown").map((s) => s.key).join(", ") || "none"}\nRule-based draft timing: ${rule.timing_hypothesis ?? "null"}`,
      evidence: built.sections.flatMap((s) => s.claims.filter((c) => !c.expired).map((c) => `[${s.key}|${c.evidence_tier}|${c.observed_on ?? "?"}] ${c.text}`)).join("\n").slice(0, 12000),
      schema: SynthesisSchema, schemaName: "dossier_synthesis", maxOutputTokens: 800,
      mock: () => ({ timing_hypothesis: rule.timing_hypothesis, next_best_question: rule.next_best_question, falsification_questions: rule.falsification_questions }),
    });
    model = res.model;
    synthesis = { ...res.data, timing_basis: res.mocked ? rule.timing_basis : `model:${res.model}` };
    // never let a model assert timing without any dated evidence
    if (!rule.timing_hypothesis && synthesis.timing_hypothesis) synthesis.timing_hypothesis = null;
  } catch (e) {
    if (!(e instanceof AiUnavailableError)) throw e;
    synthesisStatus = "fallback_no_ai";
    degraded = e.reason;
  }

  const label = synthesisStatus === "ok" ? (model ?? "rule") : `rule (AI ${degraded})`;
  const all: DossierSection[] = [...built.sections, ...synthesisSections(synthesis, today, label)];
  all.push(sourcesSection(all));

  if (prev) await db.from("research_dossier").update({ is_current: false }).eq("workspace_id", workspaceId).eq("id", prev.id);
  const next = nextRefreshAt(tier, now, cadence);
  const { data: inserted, error } = await db.from("research_dossier").insert({
    workspace_id: workspaceId, org_id: orgId, tier, refresh_cadence_days: cadence, version: (prev ? Number(prev.version) : 0) + 1, is_current: true,
    sections: all, falsification_questions: synthesis.falsification_questions, evidence_fingerprint: fingerprint,
    evidence_count: built.evidenceCount, expired_claim_count: built.expiredCount, synthesis_status: synthesisStatus, degraded_reason: degraded,
    model, generated_at: now.toISOString(), next_refresh_at: next.toISOString(), owner_user_id: opts.userId ?? undefined,
  }).select().single();
  if (error) throw error;
  if (watch) await db.from("watchlist").update({ last_researched_at: now.toISOString(), next_due_at: next.toISOString() }).eq("workspace_id", workspaceId).eq("id", watch.id);
  return { status: "generated", reason: decision.reason, dossier: inserted, synthesis_status: synthesisStatus, degraded_reason: degraded };
}

// ------------------------------------------------------------------ watchlist & evidence intake
export async function upsertWatch(db: Db, workspaceId: string, input: { orgId: string; tier: ResearchTier; reason?: string | null; userId?: string | null }) {
  const cadence = TIER_POLICY[input.tier].cadenceDays;
  const { data: existing } = await db.from("watchlist").select("id, tier, last_researched_at").eq("workspace_id", workspaceId).eq("org_id", input.orgId).maybeSingle();
  if (existing) {
    const due = existing.last_researched_at ? new Date(new Date(String(existing.last_researched_at)).getTime() + cadence * 86_400_000).toISOString() : new Date().toISOString();
    const { data, error } = await db.from("watchlist").update({ tier: input.tier, refresh_cadence_days: cadence, reason: input.reason ?? null, active: true, next_due_at: due }).eq("workspace_id", workspaceId).eq("id", existing.id).select().single();
    if (error) throw error;
    return { watch: data, warning: await capacityWarning(db, workspaceId, input.tier) };
  }
  const { data, error } = await db.from("watchlist").insert({ workspace_id: workspaceId, org_id: input.orgId, tier: input.tier, refresh_cadence_days: cadence, reason: input.reason ?? null, owner_user_id: input.userId ?? undefined }).select().single();
  if (error) throw error;
  return { watch: data, warning: await capacityWarning(db, workspaceId, input.tier) };
}

async function capacityWarning(db: Db, workspaceId: string, tier: ResearchTier): Promise<string | null> {
  const { count } = await db.from("watchlist").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("tier", tier).eq("active", true);
  const cap = TIER_POLICY[tier].capacity;
  return (count ?? 0) > cap ? `${tier} tier has ${count} companies; the operating limit is ${cap}. Deep re-research beyond this is incompatible with low spend.` : null;
}

export const EvidenceInput = z.object({
  orgId: z.string().uuid(),
  claimType: z.enum(["identity", "footprint", "headcount", "hiring", "funding", "financial", "rto", "consolidation", "gcc_plan", "expansion", "relocation", "other"]),
  text: z.string().min(3).max(5000),
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "http(s) only").optional().nullable(),
  publishedOn: z.string().date().optional().nullable(),
  observedOn: z.string().date().optional().nullable(),
  expiresOn: z.string().date().optional().nullable(),
  evidenceTier: z.enum(["documentary_current", "credible_reported", "corroborated_public", "single_unverified", "inference"]).default("single_unverified"),
  function: z.string().max(80).optional().nullable(),
  location: z.string().max(80).optional().nullable(),
});

/**
 * Store a pasted note/URL as evidence (signal_claim). The text is UNTRUSTED data: stored verbatim as an excerpt, never executed,
 * never fetched (no scraping; the URL is a citation the user supplies). Status 'reported', not canonical.
 */
export async function addPastedEvidence(db: Db, workspaceId: string, raw: z.input<typeof EvidenceInput>, userId?: string | null) {
  const input = EvidenceInput.parse(raw);
  const observed = input.observedOn ?? isoDate(new Date())!;
  // Replay-safe: the same pasted text for the same company/claim type/day is stored once.
  const { data: dup } = await db.from("signal_claim").select("*").eq("workspace_id", workspaceId).eq("subject_type", "organisation").eq("subject_id", input.orgId)
    .eq("claim_type", input.claimType).eq("observed_on", observed).eq("evidence_excerpt", input.text).is("archived_at", null).limit(1);
  if (dup?.length) return dup[0];
  const { data, error } = await db.from("signal_claim").insert({
    workspace_id: workspaceId, subject_type: "organisation", subject_id: input.orgId, claim_type: input.claimType,
    predicate: input.text.slice(0, 160), value_json: { summary: input.text.slice(0, 500), ...(input.function ? { function: input.function } : {}), ...(input.location ? { location: input.location } : {}) },
    status: "reported", evidence_tier: input.evidenceTier as EvidenceTier, evidence_excerpt: input.text, source_url: input.url ?? null, source_locator: input.url ? null : "pasted by user",
    published_on: input.publishedOn ?? null, observed_on: observed, expires_on: expiryFor(input.claimType, observed, input.expiresOn ?? null), owner_user_id: userId ?? undefined,
  }).select().single();
  if (error) throw error;
  return data;
}

const WebClaims = z.object({
  claims: z.array(z.object({
    claim_type: z.enum(["identity", "footprint", "headcount", "hiring", "funding", "rto", "consolidation", "gcc_plan", "expansion", "relocation"]),
    summary: z.string(), source_url: z.string(), published_on: z.string().nullable(), evidence_excerpt: z.string(),
  })).max(12),
});

/**
 * Optional web research through the gateway's web search — ONLY when an API key is configured AND the workspace registry
 * allows 'gateway_web_search' within its rate limit. In mock mode research uses stored evidence and pasted notes only.
 */
export async function webResearch(db: Db, workspaceId: string, orgId: string, opts: { ai?: AiCall; userId?: string | null } = {}) {
  if (!aiConfigured() && !opts.ai) return { status: "skipped" as const, reason: "Web research needs an OpenAI key; working from stored evidence and pasted notes." };
  const { data: reg } = await db.from("research_source_registry").select("*").eq("workspace_id", workspaceId).eq("acquisition_method", "gateway_web_search").eq("allowed", true).is("archived_at", null).limit(1).maybeSingle();
  if (!reg) return { status: "skipped" as const, reason: "No allowed 'gateway web search' source in the research source registry." };
  const today = isoDate(new Date())!;
  const used = reg.calls_day === today ? Number(reg.calls_today) : 0;
  if (reg.rate_limit_per_day !== null && used >= Number(reg.rate_limit_per_day)) return { status: "skipped" as const, reason: "Daily rate limit for web research reached." };
  const { data: org } = await db.from("organisation").select("display_name, domain").eq("workspace_id", workspaceId).eq("id", orgId).single();
  const ai = opts.ai ?? (callStructured as AiCall);
  try {
    const res = await ai({
      workspaceId, workflow: "research.web", tier: "luna", webSearch: true,
      system: "Find recent public, citable facts about this company's India/Pune office footprint, hiring, funding, RTO/consolidation/GCC plans. Return only facts with a source URL. Never use LinkedIn pages, paywalled or login-only content. Hiring is not an office commitment.",
      input: `Company: ${org?.display_name}${org?.domain ? ` (${org.domain})` : ""}`, schema: WebClaims, schemaName: "web_claims", maxOutputTokens: 1500,
    });
    await db.from("research_source_registry").update({ calls_today: used + 1, calls_day: today, last_success_at: new Date().toISOString(), last_error: null }).eq("workspace_id", workspaceId).eq("id", reg.id);
    let added = 0;
    for (const c of res.data.claims) {
      if (!/^https?:\/\//i.test(c.source_url) || /linkedin\.com/i.test(c.source_url)) continue;
      const { data: dup } = await db.from("signal_claim").select("id").eq("workspace_id", workspaceId).eq("subject_id", orgId).eq("claim_type", c.claim_type).eq("source_url", c.source_url).limit(1);
      if (dup?.length) continue;
      await addPastedEvidence(db, workspaceId, { orgId, claimType: c.claim_type, text: c.summary, url: c.source_url, publishedOn: /^\d{4}-\d{2}-\d{2}$/.test(c.published_on ?? "") ? c.published_on : null, evidenceTier: "single_unverified" }, opts.userId);
      added++;
    }
    return { status: "ok" as const, added };
  } catch (e) {
    if (e instanceof AiUnavailableError) {
      await db.from("research_source_registry").update({ last_error: e.reason }).eq("workspace_id", workspaceId).eq("id", reg.id);
      return { status: "degraded" as const, reason: e.reason === "budget_exceeded" ? "AI budget reached — research paused; stored evidence still shown." : `AI unavailable (${e.reason}).` };
    }
    throw e;
  }
}

/** Orgs whose research is due (interval elapsed) or whose evidence changed in the last day. Used by the scheduler. */
export async function dueForResearch(db: Db, workspaceId: string, now: Date, limit = 50): Promise<string[]> {
  const due = await rows<Row>(db.from("watchlist").select("org_id, tier").eq("workspace_id", workspaceId).eq("active", true).lte("next_due_at", now.toISOString()).order("next_due_at").limit(limit));
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const fresh = await rows<Row>(db.from("signal_claim").select("subject_id").eq("workspace_id", workspaceId).eq("subject_type", "organisation").gte("updated_at", since).limit(500));
  const freshIds = [...new Set(fresh.map((f) => String(f.subject_id)))].slice(0, 200);
  const watched = freshIds.length ? await rows<Row>(db.from("watchlist").select("org_id").eq("workspace_id", workspaceId).eq("active", true).in("tier", ["critical", "active"]).in("org_id", freshIds)) : [];
  return [...new Set([...due.map((d) => String(d.org_id)), ...watched.map((w) => String(w.org_id))])].slice(0, limit);
}
