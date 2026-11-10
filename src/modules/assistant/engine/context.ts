import "server-only";
import type { AppContext } from "@/lib/auth/context";
import type { ContextPackage, EntityRef, EntityType } from "../types";
import { TOOLS } from "../tools";
import { recallMemories } from "../memory/service";
import { securityEvent } from "./audit";

/**
 * Context engine: resolve the entities a request is about and assemble a COMPACT ContextPackage.
 * Never sends the whole DB: per-type row caps, char caps, summaries for long histories.
 * All reads go through ctx.db (RLS) AND filter workspace_id explicitly.
 */

const CAP_PER_TYPE = 3;
const CAP_RECORDS = 12;
const CAP_RECENT_MESSAGES = 8;
const CAP_MESSAGE_CHARS = 600;
const CAP_ATTACHMENT_EXCERPT = 1500;

interface Source { type: EntityType; table: string; label: string; cols: string; href: (id: string) => string }
export const ENTITY_SOURCES: Source[] = [
  { type: "company", table: "organisation", label: "display_name", cols: "id, display_name, legal_name, sector, is_gcc, headcount_min, headcount_max, updated_at", href: (id) => `/companies/${id}` },
  { type: "person", table: "person", label: "full_name", cols: "id, full_name, preferred_channel, do_not_contact, updated_at", href: (id) => `/people/${id}` },
  { type: "asset", table: "asset", label: "name", cols: "id, name, asset_kind, address, grade, total_area_sf, status, lat, lon, updated_at", href: (id) => `/buildings/${id}` },
  { type: "requirement", table: "requirement", label: "title", cols: "id, title, org_id, status, area_min_sf, area_max_sf, area_basis, decision_date, occupation_date, updated_at", href: (id) => `/requirements/${id}` },
  { type: "opportunity", table: "opportunity", label: "name", cols: "id, name, org_id, requirement_id, stage, outcome, next_action, next_action_due, updated_at", href: (id) => `/deals/${id}` },
  { type: "meeting", table: "meeting_visit", label: "title", cols: "id, title, start_at, location, linked_entity_type, linked_entity_id, opportunity_id, updated_at", href: (id) => `/calendar?meeting=${id}` },
];
const SOURCE_BY_TYPE = new Map(ENTITY_SOURCES.map((s) => [s.type, s]));

const STOP = new Set(("the a an and or of for to in on at with my me our we i you he she they it this that these those what who whom which when where why how " +
  "give everything important about prepare meeting tomorrow today compare three two properties property client company companies deal review find all " +
  "whose lease leases expires expire next months month send proposal is was did previously reject rejected please show list tell can could would " +
  "office buildings building may benefit from upcoming metro station preference outdated now prefers larger floor plates priority accounts commitments").split(" "));

/** Candidate name phrases: quoted strings, capitalised runs, and single distinctive tokens. */
export function candidatePhrases(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/["“']([^"”']{2,60})["”']/g)) out.add(m[1].trim());
  for (const m of text.matchAll(/\b([A-Z][\w&.-]*(?:\s+[A-Z0-9][\w&.-]*)*)/g)) {
    const words = m[1].split(/\s+/).filter((w) => !STOP.has(w.toLowerCase()));
    if (words.length) out.add(words.join(" "));
  }
  for (const w of text.split(/[^\w&.-]+/)) if (w.length >= 3 && !STOP.has(w.toLowerCase()) && /[A-Z0-9]/.test(w)) out.add(w);
  return [...new Set([...out].map((p) => p.replace(/^[.&-]+|[.&-]+$/g, "").trim()))].filter((p) => p.length >= 2).slice(0, 6);
}

const esc = (s: string) => s.replace(/[%_\\,()]/g, " ").trim();

/** Fetch a single record by id, workspace-filtered. null => not visible (RLS or other workspace). */
export async function fetchEntity(ctx: AppContext, ref: Pick<EntityRef, "type" | "id">): Promise<{ ref: EntityRef; row: Record<string, unknown> } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(ref.id)) return null;
  const q = (table: string, cols: string) => ctx.db.from(table).select(cols).eq("workspace_id", ctx.workspaceId).eq("id", ref.id).is("archived_at", null).maybeSingle();
  if (ref.type === "outreach") {
    // Tools refer to drafts as outreach entities with href /drafts; check outreach_item first, then draft.
    const { data: oi } = await q("outreach_item", "id, channel, status, person_id, org_id, draft_id, updated_at");
    if (oi) { const r = oi as unknown as Record<string, unknown>; return { ref: { type: "outreach", id: ref.id, label: `${r.channel} outreach`, href: `/outreach/${ref.id}` }, row: r }; }
    const { data: d } = await q("draft", "id, channel, subject, state, recipient_display, org_id, updated_at");
    if (d) { const r = d as unknown as Record<string, unknown>; return { ref: { type: "outreach", id: ref.id, label: String(r.subject ?? `${r.channel} draft`), href: "/drafts" }, row: r }; }
    return null;
  }
  if (ref.type === "meeting") {
    // Meeting refs may carry a meeting_prep id (Meetings module) or a meeting_visit id.
    const { data: prep } = await q("meeting_prep", "id, meeting_visit_id, meeting_type, purpose, org_id, opportunity_id, requirement_id, status, updated_at");
    if (prep) { const r = prep as unknown as Record<string, unknown>; return { ref: { type: "meeting", id: ref.id, label: String(r.purpose ?? "Meeting"), href: `/meetings/${ref.id}` }, row: r }; }
  }
  const src = SOURCE_BY_TYPE.get(ref.type);
  if (!src) return null;
  const { data } = await ctx.db.from(src.table).select(src.cols).eq("workspace_id", ctx.workspaceId).eq("id", ref.id).is("archived_at", null).maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  return { ref: { type: ref.type, id: ref.id, label: String(row[src.label] ?? ref.type), href: src.href(ref.id) }, row };
}

/** Name search over the main entity tables (ilike, capped). */
export async function searchEntities(ctx: AppContext, text: string, types: EntityType[] = ENTITY_SOURCES.map((s) => s.type)): Promise<{ ref: EntityRef; row: Record<string, unknown>; score: number }[]> {
  const phrases = candidatePhrases(text).map(esc).filter(Boolean);
  if (!phrases.length) return [];
  const hits = new Map<string, { ref: EntityRef; row: Record<string, unknown>; score: number }>();
  await Promise.all(types.map(async (t) => {
    const src = SOURCE_BY_TYPE.get(t)!;
    const rows: Record<string, unknown>[] = [];
    for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
      const { data } = await ctx.db.from(src.table).select(src.cols).eq("workspace_id", ctx.workspaceId).is("archived_at", null).ilike(src.label, `%${p}%`).limit(CAP_PER_TYPE * 2);
      rows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
    }
    for (const r of rows) {
      const label = String(r[src.label] ?? "");
      const score = phrases.reduce((s, p) => s + (label.toLowerCase().includes(p.toLowerCase()) ? p.length : 0), 0) + (t === "company" ? 1 : 0);
      hits.set(`${t}:${r.id}`, { ref: { type: t, id: String(r.id), label, href: src.href(String(r.id)) }, row: r, score });
    }
  }));
  const byType = new Map<string, number>();
  return [...hits.values()].sort((a, b) => b.score - a.score).filter((h) => {
    const n = byType.get(h.ref.type) ?? 0; byType.set(h.ref.type, n + 1); return n < CAP_PER_TYPE;
  });
}

/** Pronoun / deictic references → types to pull from focus/conversation. */
const DEICTIC: [RegExp, EntityType[], number][] = [
  [/\b(these|those) (two|three|four|five|\d) (properties|buildings|options)\b/i, ["asset"], 0],
  [/\b(this|that|the) (property|building|option|previous option)\b|\bprevious option\b/i, ["asset"], 1],
  [/\b(this|that|the) (client|company|account|tenant)\b/i, ["company"], 1],
  [/\b(this|that|the) (deal|opportunity|mandate)\b/i, ["opportunity"], 1],
  [/\b(this|that|the) requirement\b/i, ["requirement"], 1],
  [/\b(this|that|the) meeting\b/i, ["meeting"], 1],
  [/\b(this|that|the) (proposal|draft|email|message|offer)\b/i, ["outreach"], 1],
  [/\b(he|she|him|her|his|this person|that person)\b/i, ["person"], 1],
];
const NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

export function resolveDeictic(request: string, focus: EntityRef | null, convRefs: EntityRef[]): EntityRef[] {
  const out: EntityRef[] = [];
  for (const [re, types, n] of DEICTIC) {
    const m = request.match(re);
    if (!m) continue;
    let count = n;
    if (count === 0) count = NUM[m[2]?.toLowerCase()] ?? (Number(m[2]) || 3);
    const pool = [...(focus ? [focus] : []), ...[...convRefs].reverse()].filter((r) => types.includes(r.type));
    const seen = new Set<string>();
    for (const r of pool) { if (seen.size >= count) break; if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } }
  }
  return out;
}

function compactRow(type: EntityType, row: Record<string, unknown>) {
  const out: Record<string, unknown> = { type };
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || v === "") continue;
    out[k === "updated_at" ? "observed_at" : k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
  }
  out.source = `${type} record`;
  return out;
}

export interface ConversationState {
  id: string | null; summary: string | null; entity_refs: EntityRef[];
  recent: { role: string; content: string }[];
}

export async function buildContext(opts: {
  ctx: AppContext; request: string; focus?: EntityRef | null; conversation: ConversationState;
  attachmentIds?: string[]; runId?: string; lastToolEntities?: EntityRef[];
}): Promise<ContextPackage & { focusDenied: boolean }> {
  const { ctx, request } = opts;
  const missing: string[] = [];
  let focus: EntityRef | null = null;
  let focusDenied = false;
  const records: Record<string, unknown>[] = [];
  const resolved: EntityRef[] = [];
  const add = (ref: EntityRef, row?: Record<string, unknown>) => {
    if (resolved.some((r) => r.id === ref.id)) return;
    resolved.push(ref);
    if (row && records.length < CAP_RECORDS) records.push(compactRow(ref.type, row));
  };

  if (opts.focus?.id) {
    const f = await fetchEntity(ctx, opts.focus);
    if (f) { focus = f.ref; add(f.ref, f.row); }
    else {
      focusDenied = true;
      // Never echo the label the client sent: it may be the name of a record the user cannot see.
      missing.push("The record this page refers to was not found or you do not have access to it.");
      await securityEvent(ctx, "access_denied", null, { where: "context.focus", type: opts.focus.type, id: opts.focus.id, run_id: opts.runId ?? null });
    }
  }

  const convRefs = [...opts.conversation.entity_refs, ...(opts.lastToolEntities ?? [])];
  for (const r of resolveDeictic(request, focus, convRefs)) {
    const f = await fetchEntity(ctx, r);
    if (f) add(f.ref, f.row);
  }

  const hits = await searchEntities(ctx, request);
  for (const h of hits) add(h.ref, h.row);
  const phrases = candidatePhrases(request);
  if (phrases.length && !hits.length && !resolved.length) missing.push(`No record in this workspace matched: ${phrases.slice(0, 3).join(", ")}.`);

  if (/\b(metro|station|infrastructure|flyover|airport|ring road|expressway)\b/i.test(request)) {
    const names = candidatePhrases(request).map(esc).filter(Boolean);
    const ors = ["kind.ilike.%metro%", "name.ilike.%metro%", ...names.map((n) => `name.ilike.%${n}%`)].join(",");
    const { data: infra } = await ctx.db.from("infrastructure").select("id, name, kind, status, lat, lon, expected_date, updated_at")
      .eq("workspace_id", ctx.workspaceId).is("archived_at", null).or(ors).order("updated_at", { ascending: false }).limit(3);
    for (const r of (infra ?? []) as Record<string, unknown>[]) if (records.length < CAP_RECORDS) records.push({ ...compactRow("signal", r), type: "infrastructure", source: "infrastructure record" });
    if (!infra?.length) missing.push("No infrastructure project with stored coordinates was found, so straight-line distances to it cannot be computed.");
  }

  let memories: ContextPackage["memories"] = [];
  try { memories = (await recallMemories(ctx, resolved, { limit: 12 })) ?? []; }
  catch { missing.push("Memory could not be loaded for this request."); }
  memories = memories.slice(0, 12).map((m) => ({ ...m, content: m.content.slice(0, 300) }));
  if (memories.some((m) => m.stale)) missing.push("Some remembered facts are past their review date — treat them as possibly stale.");

  let attachments: ContextPackage["attachments"] = [];
  if (opts.attachmentIds?.length) {
    const { data } = await ctx.db.from("assistant_attachment").select("id, file_name, extracted_text")
      .eq("workspace_id", ctx.workspaceId).in("id", opts.attachmentIds.slice(0, 5));
    attachments = (data ?? []).map((a) => ({ id: a.id as string, name: a.file_name as string, excerpt: String(a.extracted_text ?? "").slice(0, CAP_ATTACHMENT_EXCERPT) }));
    if (attachments.length < opts.attachmentIds.length) missing.push("Some attachments were not found.");
  }

  const ist = new Date().toLocaleString("en-IN", { timeZone: ctx.timezone || "Asia/Kolkata" });
  return {
    user: { id: ctx.userId, name: ctx.email, role: ctx.role },
    workspace: { id: ctx.workspaceId, name: ctx.workspaceName, timezone: ctx.timezone },
    now: `${new Date().toISOString()} (${ist} IST)`,
    request,
    focus,
    resolved,
    records,
    memories,
    conversation: {
      summary: opts.conversation.summary,
      recent: opts.conversation.recent.slice(-CAP_RECENT_MESSAGES).map((m) => ({ role: m.role, content: m.content.slice(0, CAP_MESSAGE_CHARS) })),
    },
    attachments,
    missing,
    tools: TOOLS.map((t) => ({ id: t.id, category: t.category })),
    focusDenied,
  };
}

/** Render the package as the trusted context section of the prompt (attachments go as evidence separately). */
export function renderContext(p: ContextPackage): string {
  const lines = [
    `Now: ${p.now}. Workspace: ${p.workspace.name}. User role: ${p.user.role}.`,
    p.focus ? `Current page record: ${p.focus.type} "${p.focus.label}" (id ${p.focus.id}).` : "",
    p.resolved.length ? `Resolved entities:\n${p.resolved.map((r) => `- ${r.type} "${r.label}" id=${r.id}`).join("\n")}` : "Resolved entities: none.",
    p.records.length ? `Records (compact, with observed_at):\n${JSON.stringify(p.records).slice(0, 6000)}` : "",
    p.memories.length ? `Memories:\n${p.memories.map((m) => `- [${m.category}${m.stated ? ", stated" : ", inferred"}, conf ${m.confidence}, ${m.capturedAt.slice(0, 10)}${m.stale ? ", STALE" : ""}] ${m.content}`).join("\n")}` : "",
    p.conversation.summary ? `Conversation summary: ${p.conversation.summary.slice(0, 2000)}` : "",
    p.missing.length ? `Known gaps:\n${p.missing.map((m) => `- ${m}`).join("\n")}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}
