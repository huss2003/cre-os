/**
 * Signal processing pipeline (spec §5): Discovered → Retrieved → Parsed → Normalised → (Duplicate) → Entity resolution
 * (→ Entity unresolved) → Evidence extracted → Signal candidate → Assessment pending → Review required, or Failed / Archived.
 * Every source item is kept (`signal_source_item`) with its original text, `source_object` provenance, status history and
 * error. Idempotent: the same idempotency key never creates a second item, signal, evidence row or task; a failed item can be
 * retried and resumes safely (signals/evidence are keyed). Text is untrusted evidence: pattern-matched only — it can never
 * trigger tools, permissions, outbound messages or SQL (S7).
 */
import { createHash } from "node:crypto";
import type { Db } from "@/lib/supabase/server";
import { checkHttpUrl } from "@/lib/util/url";
import { localDate, edate } from "@/lib/util/time";
import { citiesIn, normName, dedupeKey, daysBetween, type Category } from "./engine";
import { detectAll, plausibleCreLink, SUB_TYPES, type Detection } from "./taxonomy";
import { resolveOrganisation, type OrgResolution } from "./resolve";
import { settings, upsertSignal, orgContext, reassess, lcLabel, type OrgContext, SignalError } from "./service";
import { extractCompanyName, eventDateFromText, counterCue } from "./text";
import { useSource, markSourceResult, SourceAccessError, type AdapterId } from "./sources";

type Row = Record<string, any>;

export const PIPELINE_STATUSES = ["discovered", "retrieved", "parsed", "normalised", "duplicate", "entity_unresolved", "evidence_extracted",
  "signal_candidate", "assessment_pending", "review_required", "approved", "rejected", "converted_to_action", "archived", "failed"] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export const STATUS_LABEL: Record<PipelineStatus, string> = {
  discovered: "Discovered", retrieved: "Retrieved", parsed: "Parsed", normalised: "Normalised", duplicate: "Duplicate",
  entity_unresolved: "Entity unresolved", evidence_extracted: "Evidence extracted", signal_candidate: "Signal candidate",
  assessment_pending: "Assessment pending", review_required: "Review required", approved: "Approved", rejected: "Rejected",
  converted_to_action: "Converted to action", archived: "Archived", failed: "Failed",
};

export interface SourceItemInput {
  adapter: Exclude<AdapterId, "rss" | "database"> | "database" | "rss";
  text: string; title?: string; url?: string; sourceName?: string; publishedOn?: string;
  companyName?: string; orgId?: string; captureId?: string; idempotencyKey?: string; actorUserId?: string; registryId?: string; syncRunId?: string;
  /** The signal the user is looking at: counter-evidence pasted there is attached to it. */
  signalId?: string;
  /** Test hook: simulate an interruption after this stage (reliability tests). */
  failAfter?: PipelineStatus;
}
export interface ProcessResult { itemId: string; status: PipelineStatus; signalIds: string[]; signals: { id: string; created: boolean }[]; detected: number; created: number; duplicateOf?: string; error?: string; resolution?: OrgResolution | null; reused?: boolean;
  /** Signals this item was attached to as counter-evidence (with the re-assessed priority). */
  counterFor?: CounterUpdate[] }
export interface CounterUpdate { id: string; title: string; priorityBefore: number | null; priorityAfter: number | null; bandBefore: string | null; bandAfter: string | null }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normText = (t: string) => t.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
const ISO = /^\d{4}-\d{2}-\d{2}$/;
class Interrupted extends Error {}

export async function processSourceItem(db: Db, ws: string, input: SourceItemInput): Promise<ProcessResult> {
  const text = (input.text ?? "").slice(0, 20_000).trim();
  if (text.length < 20) throw new SignalError("Paste at least a sentence of evidence.");
  const link = checkHttpUrl(input.url, "Source link"); if (link.error) throw new SignalError(link.error);
  const url = link.value ?? null;
  if (input.publishedOn && !ISO.test(input.publishedOn)) throw new SignalError("Published date must be YYYY-MM-DD.");
  const today = localDate();
  const key = input.idempotencyKey ?? `${input.adapter}:${sha(`${url ?? ""}|${normText(text)}|${(input.companyName ?? input.orgId ?? "").toLowerCase()}`).slice(0, 40)}`;

  // Idempotency: an existing, non-failed item is returned as-is (retried jobs never duplicate).
  const { data: existing } = await db.from("signal_source_item").select("*").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
  if (existing && existing.status !== "failed" && existing.status !== "discovered" && existing.status !== "retrieved" && existing.status !== "parsed" && existing.status !== "normalised") {
    const sids = (existing.signal_ids ?? []) as string[];
    return { itemId: existing.id, status: existing.status, signalIds: sids, signals: sids.map((id) => ({ id, created: false })), detected: sids.length, created: 0, duplicateOf: existing.duplicate_of ?? undefined, resolution: existing.resolution ?? null, reused: true };
  }

  // Source entitlement gate BEFORE anything is stored or processed (§16).
  let registry: Row;
  try { registry = await useSource(db, ws, input.adapter as AdapterId, today, input.registryId); }
  catch (e) {
    if (e instanceof SourceAccessError) throw new SignalError(`Source not permitted: ${e.message}`);
    throw e;
  }

  let item: Row = existing ?? null;
  const history = (item?.status_history ?? []) as Row[];
  const set = async (status: PipelineStatus, patch: Row = {}) => {
    history.push({ status, at: new Date().toISOString(), ...(patch.error ? { error: patch.error } : {}) });
    const { data, error } = await db.from("signal_source_item").update({ status, status_history: history, ...patch }).eq("workspace_id", ws).eq("id", item.id).select("*").single();
    if (error) throw new SignalError(error.message);
    item = data;
    if (input.failAfter === status) throw new Interrupted(`Interrupted after ${status}`);
  };

  try {
    if (!item) {
      history.push({ status: "discovered", at: new Date().toISOString() });
      const ins = await db.from("signal_source_item").insert({
        workspace_id: ws, registry_id: registry.id, sync_run_id: input.syncRunId ?? null, adapter: input.adapter, idempotency_key: key, status: "discovered",
        status_history: history, title: input.title?.slice(0, 300) ?? null, source_name: input.sourceName?.slice(0, 200) ?? null, url,
        published_on: input.publishedOn ?? null, raw_text: text, capture_id: input.captureId ?? null, owner_user_id: input.actorUserId ?? undefined,
      }).select("*").single();
      if (ins.error) {
        if (!/duplicate key/.test(ins.error.message)) throw new SignalError(ins.error.message);
        const again = await db.from("signal_source_item").select("*").eq("workspace_id", ws).eq("idempotency_key", key).single();
        const sids = (again.data!.signal_ids ?? []) as string[];
        return { itemId: again.data!.id, status: again.data!.status, signalIds: sids, signals: sids.map((id) => ({ id, created: false })), detected: sids.length, created: 0, reused: true };
      }
      item = ins.data;
    } else {
      await db.from("signal_source_item").update({ attempts: (item.attempts ?? 0) + 1, error: null }).eq("workspace_id", ws).eq("id", item.id);
    }

    // Retrieved: keep the original material + provenance in source_object.
    if (!item.source_object_id) {
      const so = await db.from("source_object").insert({
        workspace_id: ws, kind: input.adapter === "user_upload" ? "capture" : url ? "web" : "manual", uri: url, sha256: sha(text), retrieved_at: new Date().toISOString(),
        meta: { adapter: input.adapter, source_name: input.sourceName ?? null, title: input.title ?? null, published_on: input.publishedOn ?? null, idempotency_key: key, capture_id: input.captureId ?? null, untrusted: true },
        owner_user_id: input.actorUserId ?? undefined,
      }).select("id").single();
      if (so.error) throw new SignalError(so.error.message);
      await set("retrieved", { source_object_id: so.data.id });
    } else await set("retrieved");

    // Parsed: deterministic detection only.
    const s = await settings(db, ws);
    const dets = detectAll(text, s.focusCities);
    const cities = citiesIn([text]);
    const dates = [...text.matchAll(/\b(20\d\d-\d\d-\d\d)\b/g)].map((m) => m[1]);
    // Company field left blank: take the name from the text ("Quillwave Robotics announces …") — a candidate, never auto-merged.
    const extracted = !input.companyName?.trim() && !input.orgId ? extractCompanyName(text) : null;
    const geo = await textGeography(db, ws, text);
    await set("parsed", { parsed: { detections: dets, cities, dates, company: input.companyName ?? null, company_from_text: extracted, geography: geo } });

    // Normalised.
    const company = input.companyName?.trim() || extracted || null;
    const contentHash = sha(normText(text));
    await set("normalised", { content_hash: contentHash, parsed: { ...item.parsed, company_normalised: company ? normName(company) : null, cities, published_on: input.publishedOn ?? null } });

    // Duplicate: same content already processed (republished article). Keep it as evidence; never a second signal.
    const { data: dup } = await db.from("signal_source_item").select("id, signal_ids").eq("workspace_id", ws).eq("content_hash", contentHash).neq("id", item.id)
      .not("status", "in", "(failed,duplicate,discovered,retrieved,parsed,normalised)").order("created_at").limit(1).maybeSingle();

    // Entity resolution (§6): never merges on a similar name; unresolved items are kept with candidates.
    let resolution: OrgResolution | null = null;
    let orgId = input.orgId ?? null;
    if (orgId) {
      const { data: o } = await db.from("organisation").select("id").eq("workspace_id", ws).eq("id", orgId).maybeSingle();
      if (!o) throw new SignalError("Company not found in this workspace.");
      resolution = { orgId, method: "external_id", candidates: [], reasons: ["Company chosen by the user."], rawName: company };
    } else if (company || url) {
      resolution = await resolveOrganisation(db, ws, { name: company, url });
      orgId = resolution.orgId;
    }

    // Counter-evidence ("hires will work remotely", "no additional office space") about a company with an open signal — or
    // pasted on a signal — is attached to that signal as AGAINST evidence and the signal is re-assessed; nothing new is created.
    if (counterCue(text)) {
      const targets = await openSignalsFor(db, ws, { signalId: input.signalId, orgId, name: orgId ? null : company });
      if (targets.length) {
        await set("evidence_extracted", { resolution });
        const counterFor: CounterUpdate[] = [];
        for (const t of targets) {
          await db.from("signal_evidence").upsert({ workspace_id: ws, signal_id: t.id, role: "counter", dedupe_key: `item:${item.id}:counter`, source_name: input.sourceName ?? "Pasted text",
            source_url: url, excerpt: text.slice(0, 1000), fact_status: "reported", published_on: input.publishedOn ?? null, source_item_id: item.id, source_object_id: item.source_object_id ?? null,
            owner_user_id: input.actorUserId ?? undefined }, { onConflict: "workspace_id,signal_id,dedupe_key", ignoreDuplicates: true });
          await reassess(db, ws, t.id, s, today, t.org_id ? await orgContext(db, ws, t.org_id) : null);
          const { data: after } = await db.from("signal").select("priority, priority_band").eq("workspace_id", ws).eq("id", t.id).single();
          const u: CounterUpdate = { id: t.id, title: t.title, priorityBefore: t.priority, priorityAfter: after?.priority ?? null, bandBefore: t.priority_band, bandAfter: after?.priority_band ?? null };
          counterFor.push(u);
          await db.from("signal_review").insert({ workspace_id: ws, signal_id: t.id, action: "add_counter", from_status: t.status, to_status: t.status, reason: null,
            data: { source_item_id: item.id, pasted: true, priority_before: u.priorityBefore, priority_after: u.priorityAfter }, actor_user_id: input.actorUserId ?? null });
        }
        const ids = targets.map((t) => t.id);
        await set("signal_candidate");
        await set("review_required", { signal_ids: ids, error: null });
        await markSourceResult(db, ws, registry.id, true);
        return { itemId: item.id, status: "review_required", signalIds: ids, signals: ids.map((id) => ({ id, created: false })), detected: 0, created: 0, resolution, counterFor };
      }
    }

    if (!dets.length) {
      await set("archived", { error: null, parsed: { ...item.parsed, archived_reason: "No CRE signal detected in the text." } });
      await markSourceResult(db, ws, registry.id, true);
      return { itemId: item.id, status: "archived", signalIds: [], signals: [], detected: 0, created: 0, resolution: null };
    }

    const macroOnly = dets.every((d) => d.category === "macro" || d.category === "infrastructure");
    if (!orgId && !macroOnly) await set("entity_unresolved", { resolution });
    else await set("evidence_extracted", { resolution });

    const cache = new Map<string, OrgContext>();
    const ctx = orgId ? await orgContext(db, ws, orgId).then((c) => (cache.set(orgId!, c), c)) : null;
    const infraNoTarget = macroOnly ? !(await anyRecordedPropertyIn(db, ws, cities)) : false;
    if (item.status !== "evidence_extracted") await set("evidence_extracted");
    await set("signal_candidate");

    const ids: string[] = [];
    const sigs: { id: string; created: boolean }[] = [];
    let created = 0;
    for (const d of dets) {
      if (d.category === "macro" && !plausibleCreLink(d.context)) continue;
      const entity = orgId ?? (macroOnly ? `topic:${d.subType}:${cities.join("-") || "general"}` : `name:${normName(company ?? "unknown")}`);
      // Module 1 evidence atom (signal_claim) for a resolved company — rule-detected hypothesis, linked to the source object.
      let claimId: string | undefined;
      if (orgId) {
        const { data: cdup } = await db.from("signal_claim").select("id").eq("workspace_id", ws).eq("subject_id", orgId).eq("claim_type", d.kind).eq("evidence_excerpt", d.context).limit(1);
        claimId = cdup?.[0]?.id;
        if (!claimId) {
          const { data: cl, error } = await db.from("signal_claim").insert({
            workspace_id: ws, subject_type: "organisation", subject_id: orgId, claim_type: d.kind, predicate: d.rule,
            value_json: { text: d.context, rule: d.rule, sub_type: d.subType, forecast: d.forecast, source_name: input.sourceName ?? null, source_item_id: item.id },
            status: "ai_inference", evidence_tier: "single_unverified", evidence_excerpt: d.context, source_url: url, source_locator: input.sourceName ?? "pasted",
            source_object_id: item.source_object_id, published_on: input.publishedOn ?? null, observed_on: today, owner_user_id: input.actorUserId ?? undefined,
          }).select("id").single();
          if (error) throw new SignalError(error.message);
          claimId = cl.id;
        }
      }
      // Lease text: link to the company's lease; dates come only from the text ("within N months", a stated date) — never guessed.
      let lease: { leaseId: string | null; eventDate: string | null; daysAway: number | null } = { leaseId: null, eventDate: null, daysAway: null };
      // Event date stated in the text ("from Q1 2027", "by March 2027", "next quarter", a calendar date).
      const td = eventDateFromText(d.context, input.publishedOn ?? today) ?? eventDateFromText(text, input.publishedOn ?? today);
      if (td) { lease.eventDate = td.date; lease.daysAway = daysBetween(today, td.date); }
      if (d.category === "lease") {
        if (ctx?.leases.length) {
          const cityHit = ctx.leases.filter((l) => citiesIn([d.context]).some((ct) => JSON.stringify(l.asset ?? {}).toLowerCase().includes(ct.toLowerCase())));
          lease.leaseId = ((cityHit.length ? cityHit : ctx.leases).slice().sort((a, b) => String(a.contractual_expiry ?? "9999").localeCompare(String(b.contractual_expiry ?? "9999")))[0])?.id ?? null;
        }
        if (d.withinMonths) { lease.eventDate = edate(input.publishedOn ?? today, d.withinMonths); lease.daysAway = daysBetween(today, lease.eventDate); }
      }
      const draft = draftFor(d, { company, orgId, ctx, url, sourceName: input.sourceName ?? null, publishedOn: input.publishedOn ?? null, itemId: item.id,
        sourceObjectId: item.source_object_id, independenceKey: dup ? `item:${dup.id}` : `item:${item.id}`, today, entity, resolution, infraNoTarget, cities, claimId, isDuplicate: !!dup, geo });
      const basis = !lease.eventDate ? null : d.category === "lease" && d.withinMonths ? "reported" : td?.basis ?? "reported";
      const r = await upsertSignal(db, ws, { ...draft, leaseId: lease.leaseId, eventDate: lease.eventDate, eventDateBasis: basis, daysAway: lease.daysAway }, s, today, cache);
      ids.push(r.id); if (r.created) created++;
      if (!sigs.some((x) => x.id === r.id)) sigs.push(r);
    }
    await set("assessment_pending", { signal_ids: [...new Set(ids)] });
    const final: PipelineStatus = dup ? "duplicate" : "review_required";
    await set(final, { duplicate_of: dup?.id ?? null, error: null });
    await markSourceResult(db, ws, registry.id, true);
    return { itemId: item.id, status: final, signalIds: [...new Set(ids)], signals: sigs, detected: dets.length, created, duplicateOf: dup?.id, resolution };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (item?.id) {
      history.push({ status: "failed", at: new Date().toISOString(), error: msg.slice(0, 300) });
      await db.from("signal_source_item").update({ status: "failed", status_history: history, error: msg.slice(0, 500) }).eq("workspace_id", ws).eq("id", item.id);
    }
    await markSourceResult(db, ws, registry.id, false, msg);
    if (e instanceof Interrupted) return { itemId: item.id, status: "failed", signalIds: item.signal_ids ?? [], signals: [], detected: 0, created: 0, error: msg };
    throw e;
  }
}

export interface TextGeo { microMarket: string; locality: string | null }
const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Micro-market / locality named in the text, from the workspace's geography records (names + aliases). Locality wins (more specific). */
export async function textGeography(db: Db, ws: string, text: string): Promise<TextGeo | null> {
  const { data } = await db.from("geography").select("id, level, name, aliases, parent:parent_id(name, level)").eq("workspace_id", ws).is("archived_at", null).in("level", ["locality", "micro_market"]).limit(2000);
  const hits = ((data ?? []) as Row[]).filter((g) => [g.name, ...(g.aliases ?? [])].some((n: string) => n && n.length >= 3 && new RegExp(`(^|[^\\p{L}])${reEsc(n)}($|[^\\p{L}])`, "iu").test(text)));
  const loc = hits.find((g) => g.level === "locality");
  if (loc) return { microMarket: loc.parent?.level === "micro_market" ? loc.parent.name : loc.name, locality: loc.name };
  const mm = hits.find((g) => g.level === "micro_market");
  return mm ? { microMarket: mm.name, locality: null } : null;
}

/** Open signals a pasted counter-evidence item applies to: the signal the user is on, else the company's open signals. */
async function openSignalsFor(db: Db, ws: string, t: { signalId?: string; orgId: string | null; name: string | null }): Promise<Row[]> {
  const sel = "id, title, status, org_id, priority, priority_band, category";
  const closed = "(dismissed,rejected,known)";
  if (t.signalId) {
    const { data } = await db.from("signal").select(sel).eq("workspace_id", ws).eq("id", t.signalId).is("archived_at", null).maybeSingle();
    return data ? [data] : [];
  }
  if (!t.orgId && !t.name) return [];
  let q = db.from("signal").select(sel).eq("workspace_id", ws).is("archived_at", null).not("status", "in", closed)
    .in("category", ["expansion", "restructuring", "lease", "commercial"]).order("detected_at", { ascending: false }).limit(3);
  q = t.orgId ? q.eq("org_id", t.orgId) : q.is("org_id", null).ilike("entity_name_raw", t.name!.replace(/[%_\\]/g, ""));
  const { data } = await q;
  return (data ?? []) as Row[];
}

async function anyRecordedPropertyIn(db: Db, ws: string, cities: string[]): Promise<boolean> {
  const { count } = await db.from("lease").select("id", { count: "exact", head: true }).eq("workspace_id", ws).is("archived_at", null);
  return (count ?? 0) > 0 && cities.length > 0;
}

interface DraftCtx { claimId?: string; isDuplicate?: boolean; company: string | null; orgId: string | null; ctx: OrgContext | null; url: string | null; sourceName: string | null; publishedOn: string | null; itemId: string; sourceObjectId: string | null; independenceKey: string; today: string; entity: string; resolution: OrgResolution | null; infraNoTarget: boolean; cities: string[]; geo?: TextGeo | null }

const RELEVANCE: Record<Category, string> = {
  expansion: "Expansion can create a new or larger space requirement — evidence of expansion, not proof of a space need.",
  restructuring: "May lead to consolidation, relocation, subleasing or renewal renegotiation — not automatic space reduction.",
  lease: "A lease event is a renew-or-relocate decision point — confirm the occupier's plans.",
  commercial: "A like-for-like comparison may show a better-value option.",
  leadership: "A new decision-maker can reopen real-estate decisions and creates a relationship path.",
  infrastructure: "Can change the attractiveness and accessibility of nearby micro-markets and properties.",
  macro: "Indirect context for account reviews.",
};

function draftFor(d: Detection, c: DraftCtx) {
  const who = c.ctx?.org?.display_name ?? c.company ?? (d.category === "infrastructure" || d.category === "macro" ? (c.cities.join(", ") || "Market") : "Unresolved company");
  const label = SUB_TYPES[d.subType]?.label ?? d.kind.replace(/_/g, " ");
  const funding = d.subType === "funding";
  return {
    category: d.category, kind: d.kind, subType: d.subType, forecast: d.forecast,
    // Grouping key uses the event kind (not the finer sub-type) so one announcement reported differently stays one signal.
    key: dedupeKey(d.category, d.kind, c.entity, c.publishedOn ?? c.today),
    title: `${who}: ${d.forecast && (d.category === "infrastructure" || d.category === "macro") ? "planned " : "possible "}${lcLabel(label)}`,
    summary: `${label} — rule-detected from “${d.context.slice(0, 260)}”.${funding ? " Funding alone does not create an office requirement." : ""}${d.kind === "hiring" ? " Hiring is not an office-size commitment." : ""} Verify before relying on it.`,
    creRelevance: funding ? "Funding may support growth plans; it does not by itself create an office requirement." : RELEVANCE[d.category],
    orgId: c.orgId, nameRaw: c.orgId ? null : c.company, location: [c.geo?.locality ?? (c.geo && !c.geo.locality ? c.geo.microMarket : null), d.category === "lease" ? c.cities.join(", ") : (citiesIn([d.context]).join(", ") || c.cities.join(", "))].filter(Boolean).join(", ") || null,
    textGeo: c.geo ?? null,
    verification: "hypothesis" as const,
    entityCandidates: c.orgId ? [] : c.resolution?.candidates ?? [],
    entityResolution: c.resolution ? { method: c.resolution.method, reasons: c.resolution.reasons, raw_name: c.resolution.rawName } : null,
    flags: { infraNoTarget: c.infraNoTarget },
    // A republished copy (duplicate item) is kept as its own evidence row, grouped with the original via independenceKey.
    evidence: [{ role: "support" as const, key: c.claimId && !c.isDuplicate ? `claim:${c.claimId}` : `item:${c.itemId}:${d.subType}`, claimId: c.claimId, sourceName: c.sourceName ?? "Pasted text", url: c.url, excerpt: d.context,
      tier: "single_unverified", status: "reported", published: c.publishedOn, sourceItemId: c.itemId, sourceObjectId: c.sourceObjectId,
      independenceKey: c.independenceKey, label: (d.forecast ? "hypothesis" : "inference") as "hypothesis" | "inference" }],
    processing: c.orgId || d.category === "infrastructure" || d.category === "macro" ? "review_required" : "entity_unresolved",
  };
}

/** Retry a failed (or interrupted) item from its stored original text. */
export async function retrySourceItem(db: Db, ws: string, itemId: string) {
  const { data: it } = await db.from("signal_source_item").select("*").eq("workspace_id", ws).eq("id", itemId).maybeSingle();
  if (!it) throw new SignalError("Source item not found.");
  if (it.status !== "failed" && !["discovered", "retrieved", "parsed", "normalised"].includes(it.status)) return { itemId, status: it.status as PipelineStatus, signalIds: it.signal_ids ?? [], created: 0, reused: true };
  return processSourceItem(db, ws, { adapter: it.adapter, text: it.raw_text, title: it.title ?? undefined, url: it.url ?? undefined, sourceName: it.source_name ?? undefined,
    publishedOn: it.published_on ?? undefined, companyName: it.resolution?.rawName ?? it.parsed?.company ?? undefined, idempotencyKey: it.idempotency_key, registryId: it.registry_id ?? undefined });
}

export async function listSourceItems(db: Db, ws: string, f: { status?: string; limit?: number } = {}) {
  let q = db.from("signal_source_item").select("id, adapter, status, title, source_name, url, published_on, error, attempts, signal_ids, duplicate_of, resolution, created_at, updated_at")
    .eq("workspace_id", ws).is("archived_at", null).order("created_at", { ascending: false }).limit(Math.min(f.limit ?? 100, 500));
  if (f.status) q = q.eq("status", f.status);
  const { data, error } = await q;
  if (error) throw new SignalError(error.message);
  return data ?? [];
}

/** User-uploaded documents adapter: feeds a capture's extracted text through the pipeline (idempotent per capture). */
export async function processCapture(db: Db, ws: string, captureId: string, opts: { companyName?: string; orgId?: string; actorUserId?: string } = {}) {
  const { data: cap } = await db.from("capture").select("id, raw_text, transcript, source_at, kind").eq("workspace_id", ws).eq("id", captureId).maybeSingle();
  if (!cap) throw new SignalError("Capture not found.");
  const text = (cap.raw_text || cap.transcript || "").trim();
  if (!text) throw new SignalError("This capture has no extracted text yet.");
  return processSourceItem(db, ws, { adapter: "user_upload", text, sourceName: `Captured ${cap.kind}`, captureId, idempotencyKey: `user_upload:capture:${captureId}`,
    publishedOn: cap.source_at ? String(cap.source_at).slice(0, 10) : undefined, ...opts });
}
