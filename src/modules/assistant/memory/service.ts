import "server-only";
import type { AppContext } from "@/lib/auth/context";
import type { ContextPackage, EntityRef } from "../types";

/**
 * Assistant memory (spec §4). Rules:
 * - stated vs inferred never conflated (inferred is always labelled "inferred");
 * - correction keeps the old row (status outdated + superseded_by_id) and adds a new row with source + date;
 * - forget blanks content (status forgotten); restrict hides from model context unless the memory's owner explicitly asks;
 * - person memories store the employer at capture time; employer-scoped memories (source_ref.scope = 'employer')
 *   are never recalled once the person has moved to another employer;
 * - sensitive personal categories are refused.
 * Every query filters workspace_id explicitly in addition to RLS (ctx.db).
 */
export type MemCtx = Pick<AppContext, "db" | "workspaceId" | "userId">;
export type MemoryCategory = "person" | "company" | "requirement" | "relationship";
export type MemoryStatus = "active" | "outdated" | "restricted" | "forgotten";
export type Sensitivity = "normal" | "confidential" | "restricted";
export const CATEGORIES: MemoryCategory[] = ["person", "company", "requirement", "relationship"];
export const REVIEW_DAYS = 180;
const FORGOTTEN = "[forgotten at the user's request]";

export class MemoryError extends Error {}

export interface MemoryRow {
  id: string; workspace_id: string; category: MemoryCategory; entity_type: string; entity_id: string; org_context_id: string | null;
  content: string; source: string; source_ref: Record<string, unknown> | null; provided_by: string | null; stated: boolean;
  confidence: number; sensitivity: Sensitivity; status: MemoryStatus; captured_at: string; last_verified_at: string | null;
  review_at: string | null; supersedes_id: string | null; superseded_by_id: string | null; owner_user_id: string | null;
  created_at: string; updated_at: string;
}

/** Sensitive personal categories we never store (spec: "Do not store unnecessary sensitive personal information"). */
const SENSITIVE: [RegExp, string][] = [
  [/\b(health|medical|illness|disease|diagnos\w*|cancer|diabet\w*|pregnan\w*|surgery|hospital\w*|therapy|mental|depress\w*|medication)\b/i, "health"],
  [/\b(religio\w*|hindu|muslim|christian|sikh|jain|buddhist|jewish|church|mosque|temple-goer)\b/i, "religion"],
  [/\b(caste|ethnicit\w*|race)\b/i, "caste or ethnicity"],
  [/\b(politic\w*|votes? for|party member)\b/i, "political views"],
  [/\b(sexual\w*|gay|lesbian|transgender)\b/i, "sexual orientation"],
  [/\b(disabilit\w*|disabled)\b/i, "disability"],
  [/\b(criminal|arrest\w*|convict\w*)\b/i, "criminal history"],
  [/\b(aadhaar|passport (no|number)|pan (no|number)|bank account|credit card)\b/i, "identity or financial account numbers"],
];
export function sensitiveCategory(text: string): string | null {
  for (const [re, label] of SENSITIVE) if (re.test(text)) return label;
  return null;
}

/** EntityRef.type → stored entity_type. */
export function entityTypeOf(t: string): string {
  return t === "company" ? "organisation" : t;
}
export function hrefFor(entityType: string, id: string): string {
  return entityType === "organisation" ? `/companies/${id}` : entityType === "person" ? `/people/${id}` : entityType === "requirement" ? `/requirements/${id}` : "#";
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** Stale = past its review date, or not verified (captured) in the last 180 days. Computed at read time. */
export function isStale(m: Pick<MemoryRow, "review_at" | "last_verified_at" | "captured_at">, now = new Date()): boolean {
  if (m.review_at && m.review_at < now.toISOString().slice(0, 10)) return true;
  const last = new Date(m.last_verified_at ?? m.captured_at);
  return now.getTime() - last.getTime() > REVIEW_DAYS * 86_400_000;
}

async function currentEmployer(ctx: MemCtx, personId: string): Promise<string | null> {
  const { data } = await ctx.db.from("employment").select("org_id, start_date, created_at").eq("workspace_id", ctx.workspaceId)
    .eq("person_id", personId).eq("is_current", true).is("archived_at", null).order("start_date", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(1);
  return (data?.[0]?.org_id as string | undefined) ?? null;
}

export interface SaveMemoryInput {
  category: MemoryCategory;
  entityType: string;           // person | organisation | requirement (EntityRef "company" accepted)
  entityId: string;
  content: string;
  source: string;               // 'conversation:<id>' | 'meeting:<id>' | 'user'
  sourceRef?: Record<string, unknown> | null;
  providedBy?: string | null;
  stated?: boolean;
  confidence?: number;
  sensitivity?: Sensitivity;
  reviewAt?: string | null;     // YYYY-MM-DD
  /** 'employer' = company-specific; never carried to the person's next employer. */
  scope?: "employer" | "general";
  supersedesId?: string | null;
  capturedAt?: Date;
}

export async function saveMemory(ctx: MemCtx, input: SaveMemoryInput): Promise<MemoryRow> {
  const content = input.content.trim();
  if (!content) throw new MemoryError("Memory content is empty.");
  if (!CATEGORIES.includes(input.category)) throw new MemoryError(`Unknown memory category: ${input.category}`);
  const s = sensitiveCategory(content);
  if (s) throw new MemoryError(`Not saved: this looks like sensitive personal information (${s}). CRE OS doesn't store that.`);
  const entityType = entityTypeOf(input.entityType);
  const confidence = Math.max(0, Math.min(1, input.confidence ?? (input.stated === false ? 0.5 : 0.8)));
  const captured = input.capturedAt ?? new Date();
  const orgContext = entityType === "person" ? await currentEmployer(ctx, input.entityId) : entityType === "organisation" ? input.entityId : null;
  const sourceRef = { ...(input.sourceRef ?? {}), ...(input.scope ? { scope: input.scope } : {}), captured_on: captured.toISOString().slice(0, 10) };
  const { data, error } = await ctx.db.from("assistant_memory").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId,
    category: input.category, entity_type: entityType, entity_id: input.entityId, org_context_id: orgContext,
    content, source: input.source, source_ref: sourceRef, provided_by: input.providedBy ?? null,
    stated: input.stated ?? true, confidence, sensitivity: input.sensitivity ?? "normal",
    status: input.sensitivity === "restricted" ? "restricted" : "active",
    captured_at: captured.toISOString(), review_at: input.reviewAt ?? addDays(captured, REVIEW_DAYS).toISOString().slice(0, 10),
    supersedes_id: input.supersedesId ?? null,
  }).select("*").single();
  if (error) throw new MemoryError(error.message);
  return data as MemoryRow;
}

export async function getMemory(ctx: MemCtx, id: string): Promise<MemoryRow | null> {
  const { data } = await ctx.db.from("assistant_memory").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle();
  return (data as MemoryRow) ?? null;
}
async function must(ctx: MemCtx, id: string) {
  const m = await getMemory(ctx, id);
  if (!m) throw new MemoryError("Memory not found.");
  return m;
}

/** Correction: old row → outdated (kept as history), new stated row with source + date. */
export async function correctMemory(ctx: MemCtx, id: string, newContent: string, source: { source: string; sourceRef?: Record<string, unknown> | null; providedBy?: string | null; stated?: boolean; confidence?: number }): Promise<{ old: MemoryRow; current: MemoryRow }> {
  const old = await must(ctx, id);
  if (old.status === "forgotten") throw new MemoryError("That memory was forgotten and can't be corrected.");
  if (old.status === "outdated") throw new MemoryError("That memory was already replaced — correct the current version.");
  const prevScope = (old.source_ref?.scope as SaveMemoryInput["scope"]) ?? undefined;
  const current = await saveMemory(ctx, {
    category: old.category, entityType: old.entity_type, entityId: old.entity_id, content: newContent,
    source: source.source, sourceRef: { ...(source.sourceRef ?? {}), corrects: old.id }, providedBy: source.providedBy ?? null,
    stated: source.stated ?? true, confidence: source.confidence ?? 0.9, sensitivity: old.sensitivity, scope: prevScope, supersedesId: old.id,
  });
  const { error } = await ctx.db.from("assistant_memory").update({ status: "outdated", superseded_by_id: current.id })
    .eq("workspace_id", ctx.workspaceId).eq("id", old.id);
  if (error) throw new MemoryError(error.message);
  return { old: { ...old, status: "outdated", superseded_by_id: current.id }, current };
}

export async function forgetMemory(ctx: MemCtx, id: string): Promise<MemoryRow> {
  await must(ctx, id);
  const { data, error } = await ctx.db.from("assistant_memory").update({ status: "forgotten", content: FORGOTTEN, source_ref: null, provided_by: null })
    .eq("workspace_id", ctx.workspaceId).eq("id", id).select("*").single();
  if (error) throw new MemoryError(error.message);
  return data as MemoryRow;
}

export async function restrictMemory(ctx: MemCtx, id: string): Promise<MemoryRow> {
  const m = await must(ctx, id);
  if (m.status === "forgotten" || m.status === "outdated") throw new MemoryError(`Can't restrict a ${m.status} memory.`);
  const { data, error } = await ctx.db.from("assistant_memory").update({ status: "restricted", sensitivity: "restricted" })
    .eq("workspace_id", ctx.workspaceId).eq("id", id).select("*").single();
  if (error) throw new MemoryError(error.message);
  return data as MemoryRow;
}

export async function verifyMemory(ctx: MemCtx, id: string, now = new Date()): Promise<MemoryRow> {
  const m = await must(ctx, id);
  if (m.status !== "active" && m.status !== "restricted") throw new MemoryError(`Can't verify a ${m.status} memory.`);
  const { data, error } = await ctx.db.from("assistant_memory").update({ last_verified_at: now.toISOString(), review_at: addDays(now, REVIEW_DAYS).toISOString().slice(0, 10) })
    .eq("workspace_id", ctx.workspaceId).eq("id", id).select("*").single();
  if (error) throw new MemoryError(error.message);
  return data as MemoryRow;
}

export interface MemoryFilter { category?: MemoryCategory | ""; entityType?: string; entityId?: string; status?: MemoryStatus | "all" | ""; q?: string; limit?: number }
export interface MemoryListItem extends MemoryRow { stale: boolean; entityLabel: string | null; href: string; history: MemoryRow[] }

/** For the memory page: rows + entity labels + superseded chain (oldest last). */
export async function listMemories(ctx: MemCtx, filter: MemoryFilter = {}): Promise<MemoryListItem[]> {
  let q = ctx.db.from("assistant_memory").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null);
  if (filter.category) q = q.eq("category", filter.category);
  if (filter.entityType) q = q.eq("entity_type", entityTypeOf(filter.entityType));
  if (filter.entityId) q = q.eq("entity_id", filter.entityId);
  const status = filter.status || "current";
  if (status === "current") q = q.in("status", ["active", "restricted"]);
  else if (status !== "all") q = q.eq("status", status);
  if (filter.q?.trim()) q = q.ilike("content", `%${filter.q.trim().replace(/[%_]/g, "")}%`);
  const { data, error } = await q.order("captured_at", { ascending: false }).limit(filter.limit ?? 200);
  if (error) throw new MemoryError(error.message);
  const rows = (data ?? []) as MemoryRow[];
  // history: walk supersedes_id chains
  const all = new Map<string, MemoryRow>(rows.map((r) => [r.id, r]));
  let need = rows.map((r) => r.supersedes_id).filter((x): x is string => !!x && !all.has(x));
  for (let i = 0; i < 10 && need.length; i++) {
    const { data: more } = await ctx.db.from("assistant_memory").select("*").eq("workspace_id", ctx.workspaceId).in("id", need);
    for (const r of (more ?? []) as MemoryRow[]) all.set(r.id, r);
    need = ((more ?? []) as MemoryRow[]).map((r) => r.supersedes_id).filter((x): x is string => !!x && !all.has(x));
  }
  const labels = await entityLabels(ctx, rows.map((r) => ({ type: r.entity_type, id: r.entity_id })));
  return rows.map((r) => {
    const history: MemoryRow[] = [];
    let p = r.supersedes_id ? all.get(r.supersedes_id) : undefined;
    while (p && history.length < 20) { history.push(p); p = p.supersedes_id ? all.get(p.supersedes_id) : undefined; }
    return { ...r, stale: r.status === "active" && isStale(r), entityLabel: labels.get(r.entity_id) ?? null, href: hrefFor(r.entity_type, r.entity_id), history };
  });
}

export async function entityLabels(ctx: MemCtx, refs: { type: string; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const by = (t: string) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const [p, o, r] = [by("person"), by("organisation"), by("requirement")];
  const [pp, oo, rr] = await Promise.all([
    p.length ? ctx.db.from("person").select("id, full_name").eq("workspace_id", ctx.workspaceId).in("id", p) : { data: [] },
    o.length ? ctx.db.from("organisation").select("id, display_name").eq("workspace_id", ctx.workspaceId).in("id", o) : { data: [] },
    r.length ? ctx.db.from("requirement").select("id, title").eq("workspace_id", ctx.workspaceId).in("id", r) : { data: [] },
  ]);
  for (const x of (pp.data ?? []) as { id: string; full_name: string }[]) out.set(x.id, x.full_name);
  for (const x of (oo.data ?? []) as { id: string; display_name: string }[]) out.set(x.id, x.display_name);
  for (const x of (rr.data ?? []) as { id: string; title: string | null }[]) out.set(x.id, x.title ?? "Requirement");
  return out;
}

export interface RecallOptions {
  /** Restricted memories are only included when the requester owns them AND explicitly asked for them. */
  includeRestricted?: boolean;
  q?: string;
  limit?: number;
  now?: Date;
}
type Recalled = ContextPackage["memories"][number] & { entityId: string; entityType: string; sensitivity: Sensitivity; source: string; label: string };

/**
 * Memories for the model's context package. Excludes forgotten/outdated; restricted only on explicit owner request;
 * employer-scoped person memories only while the person still works at the org they were captured at.
 * Ordered by entity match (focus first), recency, confidence; max 12. Inferred ones carry stated=false.
 */
export async function recallMemories(ctx: MemCtx, refs: EntityRef[], opts: RecallOptions = {}): Promise<Recalled[]> {
  const now = opts.now ?? new Date();
  const ids = [...new Set(refs.map((r) => r.id))];
  if (!ids.length && !opts.q?.trim()) return [];
  const statuses = opts.includeRestricted ? ["active", "restricted"] : ["active"];
  let q = ctx.db.from("assistant_memory").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null).in("status", statuses);
  if (ids.length) q = q.in("entity_id", ids);
  else q = q.textSearch("search", opts.q!.trim().split(/\s+/).filter(Boolean).join(" | "), { config: "simple" });
  const { data, error } = await q.order("captured_at", { ascending: false }).limit(200);
  if (error) throw new MemoryError(error.message);
  let rows = ((data ?? []) as MemoryRow[]).filter((m) => m.status === "active" || (m.owner_user_id === ctx.userId && m.sensitivity === "restricted"));
  if (!opts.includeRestricted) rows = rows.filter((m) => m.sensitivity !== "restricted");

  // employer scoping
  const people = [...new Set(rows.filter((m) => m.entity_type === "person").map((m) => m.entity_id))];
  const employer = new Map<string, string | null>();
  await Promise.all(people.map(async (pid) => employer.set(pid, await currentEmployer(ctx, pid))));
  rows = rows.filter((m) => {
    if (m.entity_type !== "person" || m.source_ref?.scope !== "employer") return true;
    return !!m.org_context_id && m.org_context_id === employer.get(m.entity_id);
  });

  const labels = await entityLabels(ctx, rows.map((r) => ({ type: r.entity_type, id: r.entity_id })));
  const focus = refs[0]?.id;
  const score = (m: MemoryRow) => {
    const ageDays = (now.getTime() - new Date(m.last_verified_at ?? m.captured_at).getTime()) / 86_400_000;
    return (ids.includes(m.entity_id) ? 3 : 0) + (m.entity_id === focus ? 1 : 0) + Math.max(0, 1 - ageDays / 365) + Number(m.confidence) + (m.stated ? 0.25 : 0) - (isStale(m, now) ? 0.5 : 0);
  };
  return rows.sort((a, b) => score(b) - score(a)).slice(0, opts.limit ?? 12).map((m) => ({
    id: m.id, category: m.category,
    content: m.stated ? m.content : `(inferred) ${m.content}`,
    stated: m.stated, confidence: Number(m.confidence), capturedAt: m.captured_at, stale: isStale(m, now),
    entityId: m.entity_id, entityType: m.entity_type, sensitivity: m.sensitivity, source: m.source, label: labels.get(m.entity_id) ?? "record",
  }));
}

/** Find the active memory a correction refers to: by entity + best word overlap with `hint`. */
export async function findMemoryToCorrect(ctx: MemCtx, entityType: string, entityId: string, hint?: string): Promise<MemoryRow | null> {
  const { data } = await ctx.db.from("assistant_memory").select("*").eq("workspace_id", ctx.workspaceId).eq("entity_type", entityTypeOf(entityType))
    .eq("entity_id", entityId).eq("status", "active").order("captured_at", { ascending: false }).limit(50);
  const rows = (data ?? []) as MemoryRow[];
  if (!rows.length) return null;
  if (!hint?.trim()) return rows[0];
  const words = new Set(hint.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const overlap = (m: MemoryRow) => m.content.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
  const best = rows.map((m) => ({ m, s: overlap(m) })).sort((a, b) => b.s - a.s)[0];
  return best.s > 0 ? best.m : null;
}
