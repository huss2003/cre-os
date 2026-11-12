import "server-only";
import type { Db } from "@/lib/supabase/server";
import { createTask } from "@/lib/services/tasks";
import { ChangeError, proposeChange, type PatchOp } from "@/lib/services/changes";
import { rejectChange } from "@/modules/changes/service";
import { errorMessage } from "@/modules/changes/http";
import { publishEvent } from "@/modules/orchestrator/events/publish";
import { ingestText } from "@/modules/signals/service";
import { atLocal, IST } from "@/lib/util/time";
import { allowedIds, parseUnitSpec, type CandidateLists } from "../extract";
import { cardObservations } from "./card-observations";
import { parseBusinessCard } from "../docs/card";
import { matchBuildings, type AssetRef, type BuildingSuggestion, type OrgTieContext } from "./matching";
import { processCapture, type CaptureRow, type StoredExtraction } from "../service";
import {
  analyse, applyPermissions, buildReceipt, matchAll, isReply, parsePermissions, PERMISSIONS_SETTING, sourceHash,
  type Analysis, type DocKind, type DraftObservation, type InputPermissions, type MatchResult, type Receipt, type ReviewCategory, type SourceType,
} from "./analysis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Input Engine service layer (Module 10) on top of the existing capture pipeline. Nothing here writes canonical
 * fields directly: material values go through proposeChange (S4); observations are evidence rows in
 * capture_observation (RLS via make_business_table). Re-running is idempotent (obs_key, task/proposal/event keys).
 */

export interface EngineMeta {
  ran_at: string; source_type: SourceType; source_hash: string; intents: string[]; matches: MatchResult[];
  clarifications: { question: string; ambiguity_index: number | null; options: { label: string; value: unknown }[] }[];
  auto_answers: number[]; optional_questions: number[]; receipt: Receipt; permissions: InputPermissions;
  duplicate_of: string | null; observation_ids: string[]; conflicts: { field: string; before: string; after: string; observation_id: string; proposal_id: string | null }[];
  events: string[];
  /** building / business-park names found in the note — suggestion links only, never associated automatically */
  buildings?: BuildingSuggestion[];
}
type WithEngine = StoredExtraction & { meta: StoredExtraction["meta"] & { input_engine?: EngineMeta; optional_questions?: number[] } };

export async function loadPermissions(db: Db, ws: string): Promise<InputPermissions> {
  const { data } = await db.from("workspace_setting").select("value").eq("workspace_id", ws).eq("key", PERMISSIONS_SETTING).maybeSingle();
  return parsePermissions(data?.value);
}

/** Admins only (RLS on workspace_setting decides); the settings are explicit, so rule 14 holds. */
export async function savePermissions(db: Db, ws: string, p: Partial<InputPermissions>) {
  const next = parsePermissions({ ...(await loadPermissions(db, ws)), ...p });
  const r = await db.from("workspace_setting").upsert({ workspace_id: ws, key: PERMISSIONS_SETTING, value: next }, { onConflict: "workspace_id,key" });
  if (r.error) throw new ChangeError("forbidden", r.error.message);
  return next;
}

/** Same rule as the document detector for images: an email or phone in a short text is a business card. */
export function looksLikeCard(t: string): boolean {
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= 80 && (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(t) || /(\+?\d[\d\s().-]{8,}\d)/.test(t));
}

/** Person proposal for a card read from a photo capture (S4): skipped when an email/phone on the card already belongs to a person. */
async function proposeCardPerson(admin: Db, ws: string, userId: string, c: CaptureRow, card: ReturnType<typeof parseBusinessCard>): Promise<string | null> {
  if (!card.name) return null;
  for (const v of [...card.emails, ...card.phones.map((p) => p.value)]) {
    const { data } = await admin.from("contact_method").select("person_id").eq("workspace_id", ws).ilike("value", v).is("archived_at", null).limit(1);
    if (data?.length) return null;
  }
  const lines = [card.title, card.company, ...card.emails, ...card.phones.map((p) => p.value)].filter(Boolean).join(", ");
  const cp = await proposeChange(admin, ws, { targetType: "person", operation: "create", patch: [{ op: "add", path: "/full_name", value: card.name }],
    reason: `New person "${card.name}" from a business card photo (OCR text is evidence; check spelling)${lines ? `: ${lines}` : ""}`.slice(0, 2000),
    proposedByKind: "job", ownerUserId: userId, actorUserId: userId, evidenceIds: [c.id], captureId: c.id, idempotencyKey: `capture:${c.id}:card_person`, classification: c.classification });
  return cp.id;
}

function sourceTypeOf(c: CaptureRow, doc: Row | null): SourceType {
  if (doc) {
    if (doc.detected_type === "audio") return "recording";
    if (doc.detected_type === "business_card") return "business_card";
    return "document";
  }
  if (c.kind === "audio") return "voice_note";
  if (c.kind === "image" || c.kind === "mixed") return "image";
  return "typed_note";
}
const SOURCE_LABEL: Record<SourceType, string> = { typed_note: "Note", voice_note: "Voice note", image: "Photo", business_card: "Business card", document: "Document", recording: "Recording", spreadsheet: "Spreadsheet" };
const MONTH_Q = /^Which (January|February|March|April|May|June|July|August|September|October|November|December) —/;
const WEEKDAY_Q = /^Which (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) is intended/;
const REQ_COLUMN: Record<string, string> = { area_target: "area_target_sf", area_target_sf: "area_target_sf", budget: "budget_max" };

// ------------------------------------------------------------------------------------------------ persistence (shared)
interface PersistCtx { db: Db; ws: string; userId: string; service: boolean; classification: string; captureId?: string | null; documentId?: string | null; sourceHash: string; observedAt: string }
interface Persisted { ids: string[]; byKey: Map<string, Row>; repeats: number; conflicts: EngineMeta["conflicts"]; duplicateOf: string | null }

const show = (v: unknown, unit?: string | null) => (v == null ? "unknown" : typeof v === "object" ? JSON.stringify(v) : `${v}${unit ? ` ${unit}` : ""}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Upsert observations with repeat + conflict detection (spec §6, §7, rules 6 & 10):
 *  - same content from the SAME underlying source (source_hash) => independent=false, repeat_of (never extra evidence);
 *  - same content from a different source => corroborates;
 *  - a different value for the same subject+field => NEW row (version+1, conflict_with = earlier row), earlier row untouched.
 * User decisions (confirmed / rejected / corrected) survive re-processing.
 */
async function persist(p: PersistCtx, drafts: DraftObservation[]): Promise<Persisted> {
  const keys = drafts.map((d) => d.obs_key);
  const { data: prior } = keys.length ? await p.db.from("capture_observation").select("*").eq("workspace_id", p.ws).in("obs_key", keys) : { data: [] };
  const priorBy = new Map(((prior ?? []) as Row[]).map((r) => [r.obs_key as string, r]));
  const out: Persisted = { ids: [], byKey: new Map(), repeats: 0, conflicts: [], duplicateOf: null };
  const repeatSources = new Set<string>();
  for (const d of drafts) {
    const before = priorBy.get(d.obs_key);
    const row: Row = {
      workspace_id: p.ws, obs_key: d.obs_key, capture_id: p.captureId ?? null, capture_document_id: p.documentId ?? null, intent: d.intent, fact_class: d.fact_class,
      field: d.field, raw_text: d.raw_text.slice(0, 2000), value_json: d.value_json ?? null, unit: d.unit, pricing_basis: d.pricing_basis, area_basis: d.area_basis,
      cam_treatment: d.cam_treatment, date_class: d.date_class, missing: d.missing, subject_type: d.subject_type, subject_id: d.subject_id, links: d.links,
      match_confidence: d.match_confidence, confidence: d.confidence, source_type: d.source_type, source_ref: d.source_ref, source_hash: p.sourceHash,
      content_hash: d.content_hash, observed_at: p.observedAt, extracted_at: new Date().toISOString(), verification: d.verification,
      review_category: d.review_category, status: d.status, owner_user_id: p.userId, classification: p.classification,
      independent: true, repeat_of: null, corroborates: null, conflict_with: null, version: 1,
    };
    if (before && ["confirmed", "rejected", "corrected"].includes(before.status)) {
      // keep the user's decision and corrected value; only provenance fields refresh
      for (const k of ["status", "verification", "value_json", "unit", "pricing_basis", "cam_treatment", "area_basis", "fact_class", "missing", "review_category", "subject_type", "subject_id"]) row[k] = before[k];
    }
    // ---- repeats / corroboration (other observations with the same content)
    const { data: twins } = await p.db.from("capture_observation").select("id, source_hash, capture_id, capture_document_id, created_at")
      .eq("workspace_id", p.ws).eq("content_hash", d.content_hash).neq("obs_key", d.obs_key).order("created_at").limit(5);
    const sameSource = (twins ?? []).find((t) => t.source_hash === p.sourceHash);
    if (sameSource) {
      row.independent = false; row.repeat_of = sameSource.id; out.repeats++;
      if (!before || !["confirmed", "rejected", "corrected"].includes(before.status)) { row.review_category = row.review_category ?? "potential_duplicate"; }
      repeatSources.add(String(sameSource.capture_id ?? sameSource.capture_document_id));
    } else if (twins?.length) row.corroborates = twins[0].id;
    // ---- conflicts against the latest earlier observation of the same subject+field (different source)
    if (d.subject_id && d.material && !sameSource) {
      const { data: last } = await p.db.from("capture_observation").select("id, value_json, unit, version, source_hash, status")
        .eq("workspace_id", p.ws).eq("subject_type", d.subject_type).eq("subject_id", d.subject_id).eq("field", d.field)
        .neq("obs_key", d.obs_key).neq("status", "rejected").order("version", { ascending: false }).order("created_at", { ascending: false }).limit(1);
      const prev = last?.[0];
      if (prev) {
        row.version = Number(prev.version) + 1;
        if (!same(prev.value_json, d.value_json) && d.value_json != null) {
          row.conflict_with = prev.id; row.review_category = "conflicting_commercial_value"; row.status = before?.status === "rejected" ? "rejected" : "pending_review";
          out.conflicts.push({ field: d.field, before: show(prev.value_json, prev.unit), after: show(d.value_json, d.unit), observation_id: "", proposal_id: null });
        }
      }
    }
    const { data: saved, error } = await p.db.from("capture_observation").upsert(row, { onConflict: "workspace_id,obs_key" }).select().single();
    if (error) throw error;
    out.ids.push(saved.id); out.byKey.set(d.obs_key, saved);
    const last = out.conflicts[out.conflicts.length - 1];
    if (last && !last.observation_id && saved.conflict_with) last.observation_id = saved.id;
  }
  if (drafts.length && out.repeats === drafts.length && repeatSources.size === 1) out.duplicateOf = [...repeatSources][0];
  return out;
}

/** Canonical requirement value differs => a conflict too (previous value kept on the record; change proposed for approval). */
async function canonicalConflicts(p: PersistCtx, saved: Map<string, Row>, drafts: DraftObservation[], tz: string): Promise<EngineMeta["conflicts"]> {
  const out: EngineMeta["conflicts"] = [];
  for (const d of drafts) {
    const col = REQ_COLUMN[d.field];
    if (d.subject_type !== "requirement" || !d.subject_id || !col || d.value_json == null || d.missing.includes("unit")) continue;
    const row = saved.get(d.obs_key);
    if (!row || row.status === "rejected" || row.independent === false) continue;
    const { data: req } = await p.db.from("requirement").select(`id, row_version, ${col}`).eq("workspace_id", p.ws).eq("id", d.subject_id).maybeSingle();
    const cur = (req as Row | null)?.[col];
    if (!req || cur == null || Number(cur) === Number(d.value_json)) continue;
    let proposalId: string | null = row.proposal_id ?? null;
    try {
      const cp = await proposeChange(p.db, p.ws, {
        targetType: "requirement", targetId: d.subject_id, expectedVersion: Number((req as Row).row_version), operation: "update",
        patch: [{ op: "replace", path: `/${col}`, value: d.value_json }], proposedByKind: "model", ownerUserId: p.userId, actorUserId: p.service ? p.userId : null,
        reason: `New ${d.field} "${d.raw_text}" (${d.source_type}, observed ${p.observedAt.slice(0, 10)}) differs from the saved ${cur}. Previous value kept until approved.`,
        evidenceIds: p.captureId ? [p.captureId] : [], captureId: p.captureId ?? undefined, idempotencyKey: `input:${d.obs_key}:conflict`, classification: p.classification,
      });
      proposalId = cp.id;
      await p.db.from("capture_observation").update({ proposal_id: cp.id, review_category: "conflicting_commercial_value", status: "pending_review" }).eq("workspace_id", p.ws).eq("id", row.id);
    } catch { /* stays in review without a proposal */ }
    out.push({ field: d.field, before: String(cur), after: show(d.value_json, d.unit), observation_id: row.id, proposal_id: proposalId });
    void tz;
  }
  return out;
}

async function emit(db: Db, ws: string, events: string[], type: string, subjectType: string | null, subjectId: string | null, payload: Row, dedupe: string) {
  try { await publishEvent(db, ws, { type, subjectType, subjectId, payload, dedupeKey: dedupe }); events.push(type); } catch { /* orchestrator unavailable: the capture is still saved */ }
}

// ------------------------------------------------------------------------------------------------ captures
/**
 * Run the Input Engine over a processed capture (call after processCapture; service-role client, explicit
 * workspace filter, acting for the capture owner). Applies configured low-risk automation only.
 */
export async function runInputEngine(admin: Db, ws: string, captureId: string): Promise<EngineMeta> {
  const { data: cap, error } = await admin.from("capture").select("*").eq("workspace_id", ws).eq("id", captureId).maybeSingle();
  if (error) throw error;
  if (!cap) throw new ChangeError("not_found", "capture");
  const c = cap as CaptureRow;
  const userId = c.owner_user_id!;
  const { data: wsRow } = await admin.from("workspace").select("timezone").eq("id", ws).single();
  const tz = (wsRow?.timezone as string) ?? IST;
  const perms = await loadPermissions(admin, ws);
  const docId = c.idempotency_key?.startsWith("capture_doc:") ? c.idempotency_key.slice("capture_doc:".length) : null;
  const { data: doc } = docId ? await admin.from("capture_document").select("id, detected_type, file_name, links, detection").eq("workspace_id", ws).eq("id", docId).maybeSingle() : { data: null };
  const text = c.transcript ?? c.raw_text ?? "";
  const ext = c.extraction as WithEngine | null;
  // a photo capture whose OCR text reads like a business card (email/phone, short) is handled as a card
  const ocr = !doc && (c.kind === "image" || c.kind === "mixed") ? ext?.meta.ocr : null;
  const ocrText = ocr?.length ? text.slice(ocr.offset, ocr.offset + ocr.length) : "";
  const card = ocrText && looksLikeCard(ocrText) ? parseBusinessCard(ocrText) : null;
  const sourceType: SourceType = card ? "business_card" : sourceTypeOf(c, doc as Row | null);
  const srcHash = sourceHash(text || `capture:${c.id}`);
  const events: string[] = [];

  if (!ext || c.status === "failed" || !text.trim()) {
    const receipt = buildReceipt({ sourceLabel: SOURCE_LABEL[sourceType], matches: [], questions: [], tasks: [], conflicts: [], repeats: 0, saved: 0, failed: c.error ?? (text.trim() ? "not processed yet" : "no text yet") });
    const meta: EngineMeta = { ran_at: new Date().toISOString(), source_type: sourceType, source_hash: srcHash, intents: [], matches: [], clarifications: [], auto_answers: [], optional_questions: [],
      receipt, permissions: perms, duplicate_of: null, observation_ids: [], conflicts: [], events };
    if (c.status === "failed") await emit(admin, ws, events, "capture.failed", "capture", c.id, { error: c.error }, `capture.failed:${c.id}:${(c.error ?? "").slice(0, 40)}`);
    if (ext) await admin.from("capture").update({ extraction: { ...ext, meta: { ...ext.meta, input_engine: meta } } }).eq("workspace_id", ws).eq("id", c.id);
    return meta;
  }

  // ---- low-risk automation under configured permissions: task weekday => next occurrence; informal month target => not a blocking question
  const review = ext.meta.review;
  const auto: number[] = [...(ext.meta.input_engine?.auto_answers ?? [])];
  const optional = new Set<number>(ext.meta.optional_questions ?? []);
  ext.ambiguities.forEach((a, i) => {
    if (a.kind !== "date" || String(i) in review.answers) return;
    if (a.task_index != null && WEEKDAY_Q.test(a.question) && perms.auto_create_tasks && a.options[0]) { review.answers[String(i)] = a.options[0].value; auto.push(i); }
    else if (a.fact_index != null && MONTH_Q.test(a.question)) optional.add(i);   // an informal target stays informal (rule 5)
  });

  // ---- optional: associate HIGH-confidence matches without asking (workspace permission; never merges records)
  if (perms.auto_associate_high_confidence) {
    for (const m of matchAll(ext, ext.meta.candidates, review.resolutions)) {
      if (m.tier === "high" && m.id && !review.resolutions[String(m.mention_index)] && allowedIds(ext.meta.candidates, ext.mentions[m.mention_index]).has(m.id)) {
        review.resolutions[String(m.mention_index)] = m.id;
        ext.meta.resolved = { ...(ext.meta.resolved ?? {}), [String(m.mention_index)]: m.id };
      }
    }
  }
  // ---- subject (the record this capture is about) and match confidence
  const resolved = ext.meta.resolved ?? {};
  const pIdx = ext.mentions.findIndex((m) => m.kind === "person"), oIdx = ext.mentions.findIndex((m) => m.kind === "organisation");
  const orgId = (oIdx >= 0 ? resolved[String(oIdx)] : null) ?? ext.meta.inferred_org?.org_id ?? (doc?.links as Row | undefined)?.organisation_id ?? null;
  const personId = pIdx >= 0 ? resolved[String(pIdx)] ?? null : (doc?.links as Row | undefined)?.person_id ?? null;
  let reqId: string | null = review.requirement_id ?? (ext.meta.requirement_candidates?.length === 1 ? ext.meta.requirement_candidates[0].id : null) ?? (doc?.links as Row | undefined)?.requirement_id ?? null;
  if (!reqId && orgId) {
    // the company's single open requirement (permission-scoped candidate search, as the capturing user)
    const { data: reqs } = await admin.schema("mudar_app").rpc("search_entity_candidates", { p_workspace: ws, p_entity_type: "requirement", p_query: "", p_user: userId, p_org: orgId, p_limit: 3 });
    if ((reqs ?? []).length === 1) reqId = (reqs as Row[])[0].id;
  }
  const subject = reqId ? { type: "requirement", id: reqId } : orgId ? { type: "organisation", id: orgId } : personId ? { type: "person", id: personId } : null;
  const contactHits: Record<number, string> = {};
  if (pIdx >= 0) {
    for (const v of [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)].map((m) => m[0].toLowerCase())) {
      const { data: cm } = await admin.from("contact_method").select("person_id").eq("workspace_id", ws).ilike("value", v).is("archived_at", null).limit(2);
      const ids = [...new Set((cm ?? []).map((r) => r.person_id as string))];
      if (ids.length === 1 && allowedIds(ext.meta.candidates, ext.mentions[pIdx]).has(ids[0])) contactHits[pIdx] = ids[0];
    }
  }
  const page = (s: number) => (text.includes("\f") ? text.slice(0, s).split("\f").length : null);
  const tsAt = (s: number) => { const before = text.slice(0, s); const m = [...before.matchAll(/\[(\d{2}:\d{2})\]/g)].pop(); return m ? m[1] : null; };
  const kind = c.kind === "audio" ? "transcript" : "text";
  const orgTie = await orgTieContext(admin, ws, text, ext.meta.candidates, [...Object.values(resolved), orgId].filter(Boolean) as string[]);
  const buildings = matchBuildings(text, await loadAssetRefs(admin, ws));
  const a: Analysis = analyse({ orgTie,
    prefix: `cap:${c.id}`, text, extraction: ext, candidates: ext.meta.candidates, resolutions: review.resolutions, contactHits, sourceType,
    docKind: (doc?.detected_type as DocKind) ?? null, subject,
    locator: (s, e) => ({ locator: `${kind}:${s}-${e}`, start: s, end: e, capture_id: c.id, page: page(s), timestamp: tsAt(s), file_name: doc?.file_name ?? null, document_id: docId }),
  });

  // answered budget/rent questions refine the observation (unit, basis, CAM) — the user's answer is the confirmation
  const answeredUnit = (start: number, end: number) => {
    const i = ext.ambiguities.findIndex((x) => x.kind === "unit" && x.start < end && start < x.end);
    if (i < 0 || !(String(i) in review.answers)) return null;
    return String(review.answers[String(i)]);
  };
  const drafts = a.observations.map((o) => {
    let d = applyPermissions(o, perms);
    const ans = (o.field === "budget" || o.field === "monthly_rent") ? answeredUnit(Number(o.source_ref.start), Number(o.source_ref.end)) : null;
    if (ans) {
      const spec = parseUnitSpec(ans);
      const cam = ans.split("|")[2]?.replace("cam_", "") ?? "unknown";
      if (spec?.basis) d = { ...d, pricing_basis: spec.basis, unit: spec.basis === "per_sf_month" ? "INR/sf/month" : spec.basis === "per_seat_month" ? "INR/seat/month" : "INR/month",
        cam_treatment: ["extra", "included"].includes(cam) ? cam : "unknown", missing: cam === "extra" || cam === "included" ? [] : ["cam"], verification: "user_confirmed", fact_class: "confirmed", review_category: null };
    }
    return d;
  });
  if (card) drafts.push(...cardObservations(card, { prefix: `cap:${c.id}`, text, fileName: c.storage_paths[0]?.split("/").pop() ?? null, sourceType: "business_card" }));
  const pctx: PersistCtx = { db: admin, ws, userId, service: true, classification: c.classification, captureId: c.id, documentId: docId, sourceHash: srcHash, observedAt: c.source_at };
  const saved = await persist(pctx, drafts);
  const canon = await canonicalConflicts(pctx, saved.byKey, drafts, tz);
  const conflicts = [...saved.conflicts.filter((x) => !canon.some((y) => y.observation_id === x.observation_id)), ...canon];
  if (card && pIdx < 0) { try { await proposeCardPerson(admin, ws, userId, c, card); } catch { /* proposal is best effort; the card fields are saved */ } }

  // ---- requirement proposal (only with a HIGH-confidence company and no open requirement; same key as the review pipeline)
  // company named in the note => its tier; company inferred from a HIGH-confidence person's single current employer => high
  const personTier = a.matches.find((m) => m.kind === "person")?.tier ?? null;
  const orgTier = a.matches.find((m) => m.kind === "organisation")?.tier ?? (ext.meta.inferred_org ? (personTier === "high" ? "high" : "medium") : null);
  const reqObs = drafts.filter((d) => d.intent === "new_property_requirement" && ["area_target", "preferred_location", "occupation_target", "budget"].includes(d.field));
  let requirementProposed: { status: "proposed" | "awaiting_match" | "none"; summary: string } = { status: "none", summary: "" };
  if (reqObs.length && !reqId) {
    const summary = reqObs.map((d) => d.field === "budget" ? `budget ${d.raw_text.replace(/^budget\s*(is|:)?\s*/i, "")} (${d.pricing_basis ?? "basis unknown"})`
      : d.field === "occupation_target" ? `target ${d.raw_text.replace(/^by\s+/i, "")} (${d.date_class})` : d.field === "area_target" ? `${d.raw_text}${d.fact_class === "estimate" ? " (approx.)" : ""}` : String(d.value_json)).join(", ");
    if (orgId && (orgTier === "high" || review.resolutions[String(oIdx)])) {
      const area = drafts.find((d) => d.field === "area_target" && d.value_json != null);
      const patch: PatchOp[] = [{ op: "add", path: "/org_id", value: orgId }, { op: "add", path: "/title", value: `Requirement (from capture ${c.source_at.slice(0, 10)})` }, { op: "add", path: "/status", value: "draft" }];
      if (area) patch.push({ op: "add", path: "/area_target_sf", value: area.value_json });
      try {
        const cp = await proposeChange(admin, ws, { targetType: "requirement", operation: "create", patch, proposedByKind: "model", ownerUserId: userId, actorUserId: userId,
          reason: `Tentative requirement from capture: ${summary}`, evidenceIds: [c.id], captureId: c.id, idempotencyKey: `capture:${c.id}:requirement`, classification: c.classification });
        requirementProposed = { status: "proposed", summary };
        await emit(admin, ws, events, "commercial.requirement_proposed", "change_proposal", cp.id, { capture_id: c.id, org_id: orgId }, `capture:${c.id}:requirement_proposed`);
      } catch { requirementProposed = { status: "awaiting_match", summary }; }
    } else requirementProposed = { status: "awaiting_match", summary };
  }

  // ---- tasks (only when permitted): weekday resolved to the next occurrence in the workspace time zone (IST by default)
  const tasks: { title: string; due: string | null; created: boolean }[] = [];
  for (const [n, t] of ext.tasks.entries()) {
    const ai = ext.ambiguities.findIndex((x) => x.task_index === n);
    const due = (ai >= 0 && typeof review.answers[String(ai)] === "string" ? String(review.answers[String(ai)]) : null) ?? t.due_date;
    if (!perms.auto_create_tasks) { tasks.push({ title: t.description, due, created: false }); continue; }
    const task = await createTask(admin, ws, { title: t.description.slice(0, 300), description: `From capture ${c.source_at.slice(0, 10)}${ai >= 0 && auto.includes(ai) ? " — due date is the next occurrence; change it if needed" : ""}`,
      dueAt: due ? atLocal(due, "18:00", tz).toISOString() : null, source: "capture", idempotencyKey: `capture:${c.id}:task:${n}`,
      linkedEntityType: personId ? "person" : orgId ? "organisation" : null, linkedEntityId: personId ?? orgId ?? null, classification: c.classification, ownerUserId: userId, assignedUserId: userId });
    tasks.push({ title: t.description, due, created: true });
    const o = saved.byKey.get(`cap:${c.id}:task:${n}`);
    if (o && o.task_id !== task.id) await admin.from("capture_observation").update({ task_id: task.id }).eq("workspace_id", ws).eq("id", o.id);
    await emit(admin, ws, events, "capture.task_scheduled", "task", task.id, { capture_id: c.id, due }, `capture:${c.id}:task:${n}:scheduled`);
  }
  // Module 5: objections / replies become proposed follow-ups
  if (perms.auto_create_tasks) for (const [k, o] of (ext.objections ?? []).entries()) {
    const t = await createTask(admin, ws, { title: `Address objection: ${o.text}`.slice(0, 300), description: `Raised in capture ${c.source_at.slice(0, 10)}`, source: "capture",
      idempotencyKey: `capture:${c.id}:objection:${k}`, linkedEntityType: personId ? "person" : orgId ? "organisation" : null, linkedEntityId: personId ?? orgId ?? null,
      classification: c.classification, ownerUserId: userId, assignedUserId: userId, dueAt: null });
    tasks.push({ title: t.title, due: null, created: true });
  }

  // ---- module integration events (orchestrator delivers them; dedupe keys make re-runs no-ops)
  const key = srcHash.slice(0, 12);
  await emit(admin, ws, events, "capture.processed", "capture", c.id, { intents: a.intents, observations: saved.ids.length, source_type: sourceType }, `capture.processed:${c.id}:${key}`);
  if (a.intents.includes("business_signal") && orgId) {
    try { await ingestText(admin, ws, { text: text.slice(0, 5000), orgId, sourceName: `capture:${c.id}`, actorUserId: userId }); events.push("signals.ingest"); } catch { /* too short / no signal rule matched */ }
  }
  if (a.intents.some((i) => i === "new_contact_information" || i === "contact_update")) await emit(admin, ws, events, "contact.info_added", personId ? "person" : "capture", personId ?? c.id, { capture_id: c.id, source: sourceType }, `capture:${c.id}:contact_info`);
  if (isReply(text) && personId) await emit(admin, ws, events, "outreach.reply_received", "person", personId, { capture_id: c.id, objections: (ext.objections ?? []).map((o) => o.text) }, `capture:${c.id}:reply`);
  if (a.intents.includes("meeting_note") && (doc?.links as Row | undefined)?.meeting_prep_id) await emit(admin, ws, events, "meeting.notes_uploaded", "meeting_prep", (doc!.links as Row).meeting_prep_id, { capture_id: c.id }, `capture:${c.id}:meeting_notes`);
  if (a.intents.includes("commercial_quotation") || a.intents.includes("new_property_requirement")) {
    for (const cf of conflicts) await emit(admin, ws, events, "commercial.offer_revised", subject?.type ?? null, subject?.id ?? null, { field: cf.field, before: cf.before, after: cf.after, observation_id: cf.observation_id, proposal_id: cf.proposal_id }, `input:conflict:${cf.observation_id}`);
  }

  // ---- clarifications: only material questions (unit/number) + any engine questions not already asked
  const asked = new Set<number>();
  const clarifications: EngineMeta["clarifications"] = [];
  ext.ambiguities.forEach((q, i) => {
    if ((q.kind === "unit" || q.kind === "number") && !(String(i) in review.answers)) { clarifications.push({ question: q.question, ambiguity_index: i, options: q.options }); asked.add(i); }
  });
  for (const cq of a.clarifications) {
    const o = saved.byKey.get(cq.obs_key);
    if (o?.verification === "user_confirmed") continue;
    const overlap = ext.ambiguities.findIndex((x) => x.kind === "unit" && x.start < Number(o?.source_ref?.end ?? 0) && Number(o?.source_ref?.start ?? 0) < x.end);
    if (overlap < 0) clarifications.push({ question: cq.question, ambiguity_index: null, options: cq.options });
  }
  const receipt = buildReceipt({ sourceLabel: SOURCE_LABEL[sourceType], duplicateOf: saved.duplicateOf, matches: a.matches, requirementProposed,
    questions: clarifications.map((q, i) => ({ key: String(i), obs_key: "", question: q.question, options: [], material: true })), tasks, conflicts, repeats: saved.repeats, saved: saved.ids.length,
    buildings, questionable: drafts.filter((d) => d.source_ref.questionable).map((d) => ({ raw_text: d.raw_text, reason: String(d.source_ref.questionable) })) });
  const meta: EngineMeta = { ran_at: new Date().toISOString(), source_type: sourceType, source_hash: srcHash, intents: a.intents, matches: a.matches, clarifications,
    auto_answers: [...new Set(auto)], optional_questions: [...optional], receipt, permissions: perms, duplicate_of: saved.duplicateOf, observation_ids: saved.ids, conflicts, events, buildings };
  await admin.from("capture").update({ extraction: { ...ext, meta: { ...ext.meta, review, optional_questions: [...optional], input_engine: meta } } }).eq("workspace_id", ws).eq("id", c.id);
  return meta;
}

// ------------------------------------------------------------------------------------------------ matching context (service role, explicit workspace filter)
/** Buildings/campuses of the workspace with aliases, parent campus and locality names (for note matching). */
export async function loadAssetRefs(db: Db, ws: string, limit = 3000): Promise<AssetRef[]> {
  const { data: assets } = await db.from("asset").select("id, name, parent_asset_id, locality_id").eq("workspace_id", ws).is("archived_at", null).limit(limit);
  const rows = (assets ?? []) as Row[];
  if (!rows.length) return [];
  const geoIds = [...new Set(rows.map((r) => r.locality_id).filter(Boolean))];
  const [{ data: geos }, { data: aliases }] = await Promise.all([
    geoIds.length ? db.from("geography").select("id, name").eq("workspace_id", ws).in("id", geoIds) : Promise.resolve({ data: [] as Row[] }),
    db.from("entity_alias").select("entity_id, raw_alias").eq("workspace_id", ws).eq("entity_type", "asset").is("archived_at", null).limit(limit * 3),
  ]);
  const geo = new Map(((geos ?? []) as Row[]).map((g) => [g.id, g.name as string]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const al = new Map<string, string[]>();
  for (const x of (aliases ?? []) as Row[]) al.set(x.entity_id, [...(al.get(x.entity_id) ?? []), x.raw_alias]);
  return rows.map((r) => ({ id: r.id, name: r.name, parentName: r.parent_asset_id ? byId.get(r.parent_asset_id)?.name ?? null : null,
    locality: (r.locality_id && geo.get(r.locality_id)) ?? (r.parent_asset_id && geo.get(byId.get(r.parent_asset_id)?.locality_id)) ?? null, aliases: al.get(r.id) ?? [] }));
}

/** Tie-break data for same-name company candidates: relations to already-linked companies and HQ cities. */
export async function orgTieContext(db: Db, ws: string, text: string, lists: CandidateLists, anchorIds: string[]): Promise<OrgTieContext | null> {
  const ids = [...new Set(lists.filter((l) => l.kind === "organisation" && l.candidates.length > 1).flatMap((l) => l.candidates.map((c) => c.id)))];
  if (!ids.length) return null;
  const anchors = [...new Set(anchorIds)].filter((x) => !ids.includes(x));
  const [{ data: orgs }, rels] = await Promise.all([
    db.from("organisation").select("id, hq_city").eq("workspace_id", ws).in("id", ids),
    anchors.length ? db.from("organisation_relation").select("from_org_id, to_org_id, relation_type").eq("workspace_id", ws).is("archived_at", null)
      .or(`and(from_org_id.in.(${ids.join(",")}),to_org_id.in.(${anchors.join(",")})),and(to_org_id.in.(${ids.join(",")}),from_org_id.in.(${anchors.join(",")}))`)
      : Promise.resolve({ data: [] as Row[] }),
  ]);
  const related: Record<string, string> = {};
  const say: Record<string, [string, string]> = { parent_of: ["parent of a linked company", "subsidiary of a linked company"], subsidiary_of: ["subsidiary of a linked company", "parent of a linked company"] };
  for (const r of (rels.data ?? []) as Row[]) {
    const cand = ids.includes(r.from_org_id) ? r.from_org_id : r.to_org_id;
    const fwd = cand === r.from_org_id;
    related[cand] = say[r.relation_type]?.[fwd ? 0 : 1] ?? `${String(r.relation_type).replace(/_/g, " ")} relation with a linked company`;
  }
  return { text, related, cityOf: Object.fromEntries(((orgs ?? []) as Row[]).map((o) => [o.id, (o.hq_city as string | null) ?? null])) };
}

// ------------------------------------------------------------------------------------------------ documents (page refs)
/** Commercial terms of an uploaded document as page-referenced observations (runs as the uploader; RLS applies). */
export async function analyseDocument(db: Db, ws: string, userId: string, doc: Row, pages: string[], opts: { ocr?: boolean; service?: boolean } = {}) {
  const text = pages.join("\n\f\n");
  if (!text.trim() || ["spreadsheet", "audio", "meeting_notes"].includes(doc.detected_type)) return { ids: [] as string[], conflicts: [] as EngineMeta["conflicts"] };
  const links = (doc.links ?? {}) as Row;
  const subject = links.requirement_id ? { type: "requirement", id: links.requirement_id } : links.asset_id ? { type: "asset", id: links.asset_id } : links.organisation_id ? { type: "organisation", id: links.organisation_id } : null;
  const sourceType: SourceType = doc.detected_type === "business_card" ? "business_card" : opts.ocr ? "image" : "document";
  const a = analyse({ prefix: `doc:${doc.id}`, text, extraction: null, sourceType, docKind: doc.detected_type as DocKind, subject, pageVerified: !opts.ocr,
    locator: (s, e) => ({ locator: `file:${s}-${e}`, start: s, end: e, page: text.slice(0, s).split("\f").length, file_name: doc.file_name, document_id: doc.id, snippet: text.slice(s, e) }) });
  const drafts = a.observations.filter((o) => o.fact_class !== "task").map((o) => applyPermissions(o, DEFAULT_DOC_PERMS));
  // business cards: the fields read from the card are extracted information too (not only the person/company proposals)
  if (doc.detected_type === "business_card") drafts.push(...cardObservations(parseBusinessCard(text), { prefix: `doc:${doc.id}`, text, fileName: doc.file_name, documentId: doc.id }));
  const pctx: PersistCtx = { db, ws, userId, service: !!opts.service, classification: doc.classification ?? "corporate_confidential", documentId: doc.id, sourceHash: String(doc.sha256 ?? sourceHash(text)), observedAt: doc.created_at ?? new Date().toISOString() };
  const saved = await persist(pctx, drafts);
  const canon = await canonicalConflicts(pctx, saved.byKey, drafts, IST);
  const conflicts = [...saved.conflicts.filter((x) => !canon.some((y) => y.observation_id === x.observation_id)), ...canon];
  const events: string[] = [];
  for (const cf of conflicts) await emit(db, ws, events, "commercial.offer_revised", subject?.type ?? null, subject?.id ?? null, { field: cf.field, before: cf.before, after: cf.after, observation_id: cf.observation_id, proposal_id: cf.proposal_id, capture_document_id: doc.id }, `input:conflict:${cf.observation_id}`);
  if (a.intents.includes("commercial_quotation")) await emit(db, ws, events, "capture.quotation_extracted", subject?.type ?? null, subject?.id ?? null, { capture_document_id: doc.id, terms: a.terms.length }, `capture_doc:${doc.id}:quotation`);
  return { ids: saved.ids, conflicts, intents: a.intents, terms: a.terms.length, repeats: saved.repeats, events };
}
const DEFAULT_DOC_PERMS: InputPermissions = { auto_save_internal_observations: true, auto_create_tasks: false, auto_associate_high_confidence: false };

// ------------------------------------------------------------------------------------------------ review actions (user client)
async function getObs(db: Db, ws: string, id: string) {
  const { data } = await db.from("capture_observation").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
  if (!data) throw new ChangeError("not_found", "observation");
  return data as Row;
}
async function logCorrection(db: Db, ws: string, userId: string, o: { capture_id?: string | null; observation_id?: string | null }, target: string, before: unknown, after: unknown, note?: string | null) {
  const { error } = await db.from("capture_correction").insert({ workspace_id: ws, capture_id: o.capture_id ?? null, observation_id: o.observation_id ?? null, target, before: before ?? null, after: after ?? null, note: note ?? null, corrected_by: userId, owner_user_id: userId });
  if (error) throw error;
}

/** Edit an extracted value. The original extraction stays in the correction history (before) and raw_text never changes. */
export async function correctObservation(db: Db, ws: string, userId: string, id: string, patch: { value?: unknown; unit?: string | null; pricing_basis?: string | null; area_basis?: string | null; cam_treatment?: string | null; note?: string }) {
  const o = await getObs(db, ws, id);
  const fields = ["value_json", "unit", "pricing_basis", "area_basis", "cam_treatment"] as const;
  const next: Row = {};
  if ("value" in patch) next.value_json = patch.value ?? null;
  for (const f of fields.slice(1)) if (f in patch) next[f] = (patch as Row)[f] ?? null;
  const before = Object.fromEntries(Object.keys(next).map((k) => [k, o[k]]));
  await logCorrection(db, ws, userId, { capture_id: o.capture_id, observation_id: id }, "value", before, next, patch.note);
  const missing = (o.missing as string[]).filter((m) => !(m === "unit" && next.unit) && !(m === "pricing_basis" && next.pricing_basis) && !(m === "cam" && next.cam_treatment && next.cam_treatment !== "unknown") && !(m === "area_basis" && next.area_basis && next.area_basis !== "unknown"));
  const { data, error } = await db.from("capture_observation").update({ ...next, missing, status: "corrected", verification: "user_confirmed", fact_class: o.fact_class === "estimate" || o.fact_class === "assumption" ? "confirmed" : o.fact_class, review_category: o.conflict_with ? o.review_category : null })
    .eq("workspace_id", ws).eq("id", id).select().single();
  if (error) throw error;
  return data as Row;
}
export async function confirmObservation(db: Db, ws: string, userId: string, id: string) {
  const o = await getObs(db, ws, id);
  if ((o.missing as string[]).some((m) => m === "unit" || m === "pricing_basis")) throw new ChangeError("invalid_state", "Answer the unit / pricing-basis question first — an unknown unit can't be confirmed.");
  await logCorrection(db, ws, userId, { capture_id: o.capture_id, observation_id: id }, "status", { status: o.status }, { status: "confirmed" });
  const { data, error } = await db.from("capture_observation").update({ status: "confirmed", verification: "user_confirmed", fact_class: ["estimate", "assumption"].includes(o.fact_class) ? "confirmed" : o.fact_class, review_category: null })
    .eq("workspace_id", ws).eq("id", id).select().single();
  if (error) throw error;
  return data as Row;
}
/** Reject: the observation and its proposal are rejected; nothing on the record changes; the row is kept for history. */
export async function rejectObservation(db: Db, ws: string, userId: string, id: string, note?: string) {
  const o = await getObs(db, ws, id);
  await logCorrection(db, ws, userId, { capture_id: o.capture_id, observation_id: id }, "status", { status: o.status }, { status: "rejected" }, note);
  // the linked proposal is rejected too when this user may decide it (material changes need an approver's role)
  let proposalRejected: boolean | null = null;
  if (o.proposal_id) { try { await rejectChange(db, o.proposal_id, { note: note ?? "Rejected in capture review" }); proposalRejected = true; } catch { proposalRejected = false; } }
  const { data, error } = await db.from("capture_observation").update({ status: "rejected", verification: "rejected", review_category: null }).eq("workspace_id", ws).eq("id", id).select().single();
  if (error) throw error;
  return { ...(data as Row), proposal_rejected: proposalRejected };
}
/** Associate with an existing record the user can see (never a merge). */
export async function associateObservation(db: Db, ws: string, userId: string, id: string, target: { type: "requirement" | "organisation" | "person" | "asset" | "quote"; id: string }) {
  const o = await getObs(db, ws, id);
  const { data: rec } = await db.from(target.type).select("id").eq("workspace_id", ws).eq("id", target.id).maybeSingle();
  if (!rec) throw new ChangeError("not_found", `${target.type} not found`);
  await logCorrection(db, ws, userId, { capture_id: o.capture_id, observation_id: id }, "association", { subject_type: o.subject_type, subject_id: o.subject_id }, target);
  const cat = o.review_category as ReviewCategory | null;
  const { data, error } = await db.from("capture_observation").update({ subject_type: target.type, subject_id: target.id, match_confidence: "high",
    review_category: cat === "uncertain_company_match" || cat === "uncertain_contact_match" ? null : cat }).eq("workspace_id", ws).eq("id", id).select().single();
  if (error) throw error;
  return data as Row;
}
/** Create a new record from an observation — as a proposal (S4), never a direct write. */
export async function createRecordFromObservation(db: Db, ws: string, userId: string, id: string, kind: "organisation" | "person", name: string) {
  const o = await getObs(db, ws, id);
  const patch: PatchOp[] = kind === "organisation" ? [{ op: "add", path: "/display_name", value: name.trim() }] : [{ op: "add", path: "/full_name", value: name.trim() }];
  const cp = await proposeChange(db, ws, { targetType: kind, operation: "create", patch, proposedByKind: "user", ownerUserId: userId, reason: `New ${kind} from capture observation "${o.raw_text}"`,
    idempotencyKey: `input:${o.obs_key}:create:${kind}`, captureId: o.capture_id ?? undefined, evidenceIds: o.capture_id ? [o.capture_id] : [] });
  await logCorrection(db, ws, userId, { capture_id: o.capture_id, observation_id: id }, "association", null, { create: kind, name, proposal_id: cp.id });
  return cp;
}
/** Ask for clarification: a task for the capture owner, linked to the observation's subject. */
export async function requestClarification(db: Db, ws: string, userId: string, id: string, question: string) {
  const o = await getObs(db, ws, id);
  const task = await createTask(db, ws, { title: `Clarify: ${question}`.slice(0, 300), description: `About "${o.raw_text}" (capture ${o.capture_id ?? o.capture_document_id})`, source: "capture",
    idempotencyKey: `input:${o.obs_key}:clarify`, linkedEntityType: o.subject_type ?? null, linkedEntityId: o.subject_id ?? null, ownerUserId: userId, assignedUserId: userId, dueAt: null });
  await logCorrection(db, ws, userId, { capture_id: o.capture_id, observation_id: id }, "status", null, { clarification: question, task_id: task.id });
  await db.from("capture_observation").update({ verification: "needs_clarification" }).eq("workspace_id", ws).eq("id", id);
  return task;
}

/** Transcript correction: history kept, then the capture is re-extracted through the normal review path. */
export async function correctTranscript(db: Db, ws: string, userId: string, captureId: string, text: string) {
  const { data: c } = await db.from("capture").select("id, transcript, raw_text").eq("workspace_id", ws).eq("id", captureId).maybeSingle();
  if (!c) throw new ChangeError("not_found", "capture");
  const t = text.trim();
  if (!t) throw new ChangeError("invalid_parameter", "The corrected transcript is empty.");
  if (t === String(c.transcript ?? c.raw_text ?? "").trim()) return t;              // unchanged: no history entry
  await logCorrection(db, ws, userId, { capture_id: captureId }, "transcript", { text: c.transcript ?? c.raw_text }, { text: t });
  return t;
}

// ------------------------------------------------------------------------------------------------ queues, history, search
export async function reviewQueue(db: Db, ws: string, limit = 200) {
  const { data, error } = await db.from("capture_observation").select("id, capture_id, capture_document_id, field, raw_text, value_json, unit, missing, review_category, match_confidence, links, conflict_with, proposal_id, source_type, source_ref, created_at")
    .eq("workspace_id", ws).eq("status", "pending_review").not("review_category", "is", null).is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const groups: Record<ReviewCategory, Row[]> = { uncertain_company_match: [], uncertain_contact_match: [], potential_duplicate: [], conflicting_commercial_value: [], missing_units_or_dates: [], unverified_lease_details: [], material_change_approval: [] };
  for (const r of data ?? []) groups[r.review_category as ReviewCategory]?.push(r);
  // material changes waiting for approval come from the existing proposal queue (capture-originated only)
  const { data: props } = await db.from("change_proposal").select("id, target_type, operation, reason, risk, state, capture_id, created_at").eq("workspace_id", ws)
    .not("capture_id", "is", null).eq("approval_required", true).in("state", ["proposed", "clarify"]).is("reversal_of", null).order("created_at", { ascending: false }).limit(50);
  groups.material_change_approval.push(...(props ?? []).map((p) => ({ ...p, proposal_id: p.id, raw_text: p.reason })));
  return groups;
}

export async function captureHistory(db: Db, ws: string, limit = 50) {
  const [{ data: caps }, { data: docs }] = await Promise.all([
    db.from("capture").select("id, kind, raw_text, status, error, created_at, source_at, extraction").eq("workspace_id", ws).is("archived_at", null).order("created_at", { ascending: false }).limit(limit),
    db.from("capture_document").select("id, file_name, detected_type, status, error, created_at, links, result").eq("workspace_id", ws).is("archived_at", null).order("created_at", { ascending: false }).limit(limit),
  ]);
  const capIds = (caps ?? []).map((c) => c.id), docIds = (docs ?? []).map((d) => d.id);
  const [{ data: obs }, { data: corr }] = await Promise.all([
    capIds.length || docIds.length ? db.from("capture_observation").select("capture_id, capture_document_id, subject_type, subject_id, status").eq("workspace_id", ws)
      .or([capIds.length ? `capture_id.in.(${capIds.join(",")})` : "", docIds.length ? `capture_document_id.in.(${docIds.join(",")})` : ""].filter(Boolean).join(",")) : Promise.resolve({ data: [] }),
    capIds.length ? db.from("capture_correction").select("capture_id, target, created_at").eq("workspace_id", ws).in("capture_id", capIds) : Promise.resolve({ data: [] }),
  ]);
  const byCap = (id: string, col: "capture_id" | "capture_document_id") => ((obs ?? []) as Row[]).filter((o) => o[col] === id);
  const items = [
    ...(caps ?? []).map((c) => {
      const o = byCap(c.id, "capture_id"); const eng = (c.extraction as WithEngine | null)?.meta?.input_engine;
      return { id: c.id, href: `/capture/${c.id}`, input: String(c.raw_text ?? "").slice(0, 160), type: c.kind === "audio" ? "Voice note" : c.kind === "image" ? "Photo" : "Note",
        uploaded_at: c.created_at, status: c.status, records: o.length, corrections: ((corr ?? []) as Row[]).filter((x) => x.capture_id === c.id).length,
        linked: [...new Set(o.filter((x) => x.subject_id).map((x) => `${x.subject_type}:${x.subject_id}`))], error: c.error, intents: eng?.intents ?? [] };
    }),
    ...(docs ?? []).map((d) => {
      const o = byCap(d.id, "capture_document_id");
      return { id: d.id, href: `/capture/documents/${d.id}`, input: d.file_name, type: `File (${d.detected_type})`, uploaded_at: d.created_at, status: d.status, records: o.length + ((d.result?.proposal_ids as string[] | undefined)?.length ?? 0),
        corrections: 0, linked: Object.entries((d.links ?? {}) as Row).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_id$/, "")}:${v}`), error: d.error, intents: [] as string[] };
    }),
  ].sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  return items.slice(0, limit);
}

export async function correctionsFor(db: Db, ws: string, captureId: string) {
  const { data } = await db.from("capture_correction").select("id, observation_id, target, before, after, note, corrected_by, created_at").eq("workspace_id", ws).eq("capture_id", captureId).order("created_at", { ascending: false });
  return (data ?? []) as Row[];
}
export async function observationsFor(db: Db, ws: string, f: { captureId?: string; documentId?: string; subject?: { type: string; id: string } }) {
  let q = db.from("capture_observation").select("*").eq("workspace_id", ws).is("archived_at", null);
  if (f.captureId) q = q.eq("capture_id", f.captureId);
  if (f.documentId) q = q.eq("capture_document_id", f.documentId);
  if (f.subject) q = q.eq("subject_type", f.subject.type).eq("subject_id", f.subject.id);
  const { data, error } = await q.order("created_at");
  if (error) throw error;
  return (data ?? []) as Row[];
}

/** Assistant (Module 12): natural-language search over captured notes, files and their source-linked observations. */
export async function searchCaptures(db: Db, ws: string, query: string, opts: { days?: number; limit?: number } = {}) {
  const words = query.toLowerCase().replace(/[%,()]/g, " ").split(/\s+/).filter((w) => w.length >= 3).slice(0, 6);
  const since = new Date(Date.now() - (opts.days ?? 90) * 86_400_000).toISOString();
  const limit = Math.min(opts.limit ?? 10, 25);
  const ors = (cols: string[]) => (words.length ? words.flatMap((w) => cols.map((c) => `${c}.ilike.%${w}%`)).join(",") : null);
  let qc = db.from("capture").select("id, kind, raw_text, transcript, status, source_at, created_at").eq("workspace_id", ws).is("archived_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(limit);
  const oc = ors(["raw_text", "transcript"]); if (oc) qc = qc.or(oc);
  let qd = db.from("capture_document").select("id, file_name, detected_type, status, created_at").eq("workspace_id", ws).is("archived_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(limit);
  const od = ors(["file_name", "detected_type"]); if (od) qd = qd.or(od);
  let qo = db.from("capture_observation").select("id, capture_id, capture_document_id, field, raw_text, value_json, unit, fact_class, verification, source_type, source_ref, observed_at, status").eq("workspace_id", ws)
    .neq("status", "rejected").gte("created_at", since).order("created_at", { ascending: false }).limit(limit * 2);
  const oo = ors(["raw_text", "field"]); if (oo) qo = qo.or(oo);
  const [c, d, o] = await Promise.all([qc, qd, qo]);
  return {
    captures: (c.data ?? []).map((x) => ({ id: x.id, kind: x.kind, text: String(x.transcript ?? x.raw_text ?? "").slice(0, 400), status: x.status, captured_at: x.created_at, href: `/capture/${x.id}` })),
    documents: (d.data ?? []).map((x) => ({ id: x.id, file: x.file_name, type: x.detected_type, status: x.status, uploaded_at: x.created_at, href: `/capture/documents/${x.id}` })),
    observations: (o.data ?? []).map((x) => ({ ...x, href: x.capture_id ? `/capture/${x.capture_id}` : `/capture/documents/${x.capture_document_id}` })),
  };
}

/** The normal inline/job path: existing capture pipeline, then the Input Engine (its failure never loses the capture). */
export async function processAndAnalyse(admin: Db, ws: string, captureId: string, opts: Parameters<typeof processCapture>[3] = {}) {
  let processed: unknown;
  try { processed = await processCapture(admin, ws, captureId, opts); }
  catch (e) { processed = { status: "failed", error: errorMessage(e) }; }
  let engine: EngineMeta | null = null;
  try { engine = await runInputEngine(admin, ws, captureId); } catch { /* receipt missing; capture + review still work */ }
  return { processed, engine };
}

/** Capture dashboard counters (§13A): pending review items, files/captures still processing, failures. */
export async function dashboardCounts(db: Db, ws: string) {
  const head = { count: "exact" as const, head: true };
  const [p, c1, c2, f1, f2] = await Promise.all([
    db.from("capture_observation").select("id", head).eq("workspace_id", ws).eq("status", "pending_review").not("review_category", "is", null).is("archived_at", null),
    db.from("capture").select("id", head).eq("workspace_id", ws).in("status", ["received", "transcribing", "extracting"]).is("archived_at", null),
    db.from("capture_document").select("id", head).eq("workspace_id", ws).in("status", ["received", "processing"]).is("archived_at", null),
    db.from("capture").select("id", head).eq("workspace_id", ws).eq("status", "failed").is("archived_at", null),
    db.from("capture_document").select("id", head).eq("workspace_id", ws).eq("status", "failed").is("archived_at", null),
  ]);
  return { pending: p.count ?? 0, processing: (c1.count ?? 0) + (c2.count ?? 0), failed: (f1.count ?? 0) + (f2.count ?? 0) };
}
