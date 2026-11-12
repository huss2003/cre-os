import "server-only";
import type { AppContext } from "@/lib/auth/context";
import type { ContextPackage, EntityRef, EntityType } from "../types";
import { TOOLS } from "../tools";
import { recallMemories } from "../memory/service";
import { securityEvent } from "./audit";
import { containsLike, escapeLike } from "@/lib/util/like";

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
  { type: "requirement", table: "requirement", label: "title", cols: "id, title, org_id, status, area_min_sf, area_target_sf, area_max_sf, area_basis, seats_min, seats_target, seats_max, decision_date, occupation_date, updated_at", href: (id) => `/requirements/${id}` },
  { type: "opportunity", table: "opportunity", label: "name", cols: "id, name, org_id, requirement_id, stage, outcome, next_action, next_action_due, updated_at", href: (id) => `/deals/${id}` },
  { type: "meeting", table: "meeting_visit", label: "title", cols: "id, title, start_at, location, linked_entity_type, linked_entity_id, opportunity_id, updated_at", href: (id) => `/calendar?meeting=${id}` },
];
const TYPE_PLURAL: Partial<Record<EntityType, string>> = { company: "companies", person: "contacts", asset: "buildings", requirement: "requirements", opportunity: "deals", meeting: "meetings" };
const SOURCE_BY_TYPE = new Map(ENTITY_SOURCES.map((s) => [s.type, s]));

const STOP = new Set(("the a an and or of for to in on at with my me our we i you he she they it this that these those what who whom which when where why how " +
  "give everything important about prepare meeting tomorrow today compare three two properties property client company companies deal review find all " +
  "whose lease leases expires expire next months month send proposal is was did previously reject rejected please show list tell can could would " +
  "office buildings building may benefit from upcoming metro station preference outdated now prefers larger floor plates priority accounts commitments " +
  "summarise summarize summary draft write use same new not instead actually also then identify relevant decision-makers decision-maker follow-up " +
  "high-priority low-priority last first previous people person contact contacts requirement opportunity account account's client's").split(" "));

/** Measurement / currency tokens that are never part of a name (12.14: "SF" matched "…sfg" in a company name). */
const UNIT = /^(sf|sft|sqft|sq\.?ft|sq|ft|psf|inr|rs\.?|lakh|lakhs|crore|crores|cr|k|seats?|desks?|months?|years?|%)$/i;
const UNIT_SEQ = /₹|\bsq\.?\s*ft\b|\bsq\.?\s*m\b|\bper\s+(?:sq\.?\s*)?(?:ft|sf)\b/gi;
/** A lowercase token kept as a name part: has a digit or an inner hyphen (e.g. tags like "abc-x8k2yf"), not purely numeric. */
const tagLike = (w: string) => /^[a-z][\w]*-[\w-]*\w$|^(?=.*[a-z])(?=.*\d)[\w-]+$/i.test(w) && !/^[\d.,-]+$/.test(w);
const nameWord = (w: string) => /^[A-Z0-9]/.test(w) || tagLike(w);
const isNumeric = (w: string) => /^[\d.,]+[k%]?$/i.test(w);

/**
 * Candidate name phrases: quoted strings, capitalised runs (which may continue with tag-like lowercase tokens), and
 * single distinctive tokens. Units (SF, sq ft, ₹, psf…) and bare numbers are dropped. Runs keep a stop word when it
 * is followed by a 1–2 character suffix, so "Property A" / "Tower B" stay together.
 */
export function candidatePhrases(text: string): string[] {
  const out: string[] = [];
  const push = (p: string) => { const c = p.replace(/^[.&'-]+|[.&,'-]+$/g, "").trim(); if (c.length >= 2 && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c); };
  for (const m of text.matchAll(/["“]([^"”]{2,60})["”]/g)) push(m[1].trim());
  const clean = text.replace(UNIT_SEQ, " ");
  const tokens = clean.split(/\s+/).filter(Boolean);
  // capitalised runs (a run breaks on punctuation such as , ; : ? ! — and on non-name words)
  let run: string[] = [];
  const flush = () => {
    let w = run.map((x) => x.replace(/[.,;:?!)]+$/, "").replace(/'s$/i, "")).filter((x) => x && !UNIT.test(x) && !isNumeric(x));
    // strip leading stop words, but keep "Property" in "Property A"
    while (w.length && STOP.has(w[0].toLowerCase()) && !(w.length > 1 && w[1].length <= 2 && /^[A-Z0-9]/.test(w[1]))) w = w.slice(1);
    while (w.length && STOP.has(w[w.length - 1].toLowerCase()) && !(w[w.length - 1].length <= 2 && w.length > 1)) w = w.slice(0, -1);
    if (w.length && !(w.length === 1 && (w[0].length < 3 || STOP.has(w[0].toLowerCase())))) push(w.join(" "));
    run = [];
  };
  for (const raw of tokens) {
    const bare = raw.replace(/^[("“'‘]+/, "");
    const word = bare.replace(/[.,;:?!)”"’]+$/, "");
    const breaks = /[,;:?!)”"’]$/.test(bare) || /[.]$/.test(bare) && !/^[A-Z]\.$/.test(bare);
    if (word && (run.length ? nameWord(word) : /^[A-Z]/.test(word))) { run.push(word); if (breaks) flush(); }
    else flush();
  }
  flush();
  for (const w0 of clean.split(/[^\w&.-]+/)) {
    const w = w0.replace(/^[.&-]+|[.&-]+$/g, "");
    if (w.length >= 3 && !STOP.has(w.toLowerCase()) && !UNIT.test(w) && !isNumeric(w) && (/[A-Z]/.test(w) || tagLike(w))) push(w);
  }
  return out.slice(0, 8);
}

/** Match tier of one phrase against a label: 3 exact, 2 prefix, 1 contains, 0 none. */
export function matchTier(label: string, phrase: string): number {
  const l = label.toLowerCase().trim(), p = phrase.toLowerCase().trim();
  if (!p) return 0;
  if (l === p) return 3;
  if (l.startsWith(p) && !/[\w]/.test(l[p.length] ?? " ")) return 2;
  if (l.includes(p)) return 1;
  return tokensInOrder(l, p) ? 1 : 0;
}
/** "Northwind GCC" ~ "Northwind Halberd GCC India": every word of a 2+ word phrase appears in the label as a whole word, in order. */
export function tokensInOrder(label: string, phrase: string): boolean {
  const ws = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (ws.length < 2) return false;
  const lw = label.toLowerCase().split(/[^\w&-]+/).filter(Boolean);
  let i = 0;
  for (const w of lw) if (i < ws.length && w === ws[i]) i++;
  return i === ws.length;
}
/** Score a label: the best phrase match (exact > prefix > contains, then longer phrase). Single-word prefix/contains matches are weak. */
export function scoreLabel(label: string, phrases: string[]): { score: number; strong: boolean } {
  let best = 0, strong = false;
  for (const p of phrases) {
    const tier = matchTier(label, p);
    if (!tier) continue;
    const s = tier * 1000 + p.length;
    if (s > best) { best = s; strong = tier === 3 || /\s/.test(p.trim()); }
  }
  return { score: best, strong };
}

export interface Ambiguity { type: EntityType; phrase: string; candidates: EntityRef[] }

/**
 * Rank hits per type and detect ties. Pure (unit-tested). When strong matches exist anywhere, weak single-token
 * matches are dropped (they are how a tag or "SF" pulled in an unrelated company). When ≥2 records of a type tie on
 * the best strong score, none of them is resolved: the caller must ask which one.
 */
export function rankHits<H extends { ref: EntityRef; score: number; strong: boolean; phrase?: string }>(hits: H[], cap = CAP_PER_TYPE): { hits: H[]; ambiguous: Ambiguity[] } {
  const anyStrong = hits.some((h) => h.strong);
  const pool = (anyStrong ? hits.filter((h) => h.strong) : hits).slice().sort((a, b) => b.score - a.score || a.ref.label.localeCompare(b.ref.label));
  const ambiguous: Ambiguity[] = [];
  const out: H[] = [];
  const types = [...new Set(pool.map((h) => h.ref.type))];
  for (const t of types) {
    const of = pool.filter((h) => h.ref.type === t);
    const top = of[0];
    const tied = of.filter((h) => h.score === top.score);
    // assets are often compared in sets ("Property A, B and C") — ties only matter for single-record types
    if (top.strong && tied.length > 1 && t !== "asset" && t !== "meeting") {
      ambiguous.push({ type: t, phrase: top.phrase ?? "", candidates: tied.slice(0, 6).map((h) => h.ref) });
      continue;
    }
    out.push(...of.slice(0, cap));
  }
  return { hits: out.sort((a, b) => b.score - a.score), ambiguous };
}

const esc = (s: string) => s.replace(/[%_\\,()]/g, " ").replace(/\s+/g, " ").trim();

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

/** Name search over the main entity tables (ilike, capped), ranked exact > prefix > contains. */
export async function searchEntities(ctx: AppContext, text: string, types: EntityType[] = ENTITY_SOURCES.map((s) => s.type)): Promise<{ ref: EntityRef; row: Record<string, unknown>; score: number }[]> {
  return (await searchEntitiesRanked(ctx, text, types)).hits;
}

export async function searchEntitiesRanked(ctx: AppContext, text: string, types: EntityType[] = ENTITY_SOURCES.map((s) => s.type)) {
  const phrases = candidatePhrases(text).map(esc).filter((p) => p.length >= 2);
  type Hit = { ref: EntityRef; row: Record<string, unknown>; score: number; strong: boolean; phrase: string };
  if (!phrases.length) return { hits: [] as Hit[], ambiguous: [] as Ambiguity[] };
  const hits = new Map<string, Hit>();
  await Promise.all(types.map(async (t) => {
    const src = SOURCE_BY_TYPE.get(t)!;
    const rows: Record<string, unknown>[] = [];
    for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
      if (p.length < 3 && !/\s/.test(p)) continue;
      // exact first (so a name that is a prefix of many others is still found), then contains
      const exact = await ctx.db.from(src.table).select(src.cols).eq("workspace_id", ctx.workspaceId).is("archived_at", null).ilike(src.label, escapeLike(p)).limit(CAP_PER_TYPE * 2);
      rows.push(...((exact.data ?? []) as unknown as Record<string, unknown>[]));
      const { data } = await ctx.db.from(src.table).select(src.cols).eq("workspace_id", ctx.workspaceId).is("archived_at", null).ilike(src.label, containsLike(p)).limit(CAP_PER_TYPE * 2);
      rows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
      // partial multi-word name ("Northwind GCC" → "Northwind Halberd GCC India"): all words, in order
      if (/\s/.test(p)) {
        const pat = `%${p.split(/\s+/).map((w) => w.replace(/[%_\\]/g, "")).join("%")}%`;
        const part = await ctx.db.from(src.table).select(src.cols).eq("workspace_id", ctx.workspaceId).is("archived_at", null).ilike(src.label, pat).limit(CAP_PER_TYPE * 2);
        rows.push(...((part.data ?? []) as unknown as Record<string, unknown>[]));
      }
    }
    for (const r of rows) {
      const label = String(r[src.label] ?? "");
      const { score, strong } = scoreLabel(label, phrases);
      if (!score) continue;
      const phrase = phrases.find((p) => matchTier(label, p) * 1000 + p.length === score) ?? "";
      hits.set(`${t}:${r.id}`, { ref: { type: t, id: String(r.id), label, href: src.href(String(r.id)) }, row: r, score, strong, phrase });
    }
  }));
  return rankHits([...hits.values()]);
}

/** Pronoun / deictic references → types to pull from focus/conversation. */
const DEICTIC: [RegExp, EntityType[], number][] = [
  [/\b(these|those|the|same) (two|three|four|five|\d) (properties|buildings|options)\b/i, ["asset"], 0],
  [/\b(this|that|the|same|the same) (property|building|option|previous option)\b|\bprevious option\b/i, ["asset"], 1],
  [/\b(this|that|the|same|the same) (client|company|account|tenant)\b/i, ["company"], 1],
  [/\b(this|that|the|same|the same) (deal|opportunity|mandate)\b/i, ["opportunity"], 1],
  [/\b(this|that|the|same|the same) requirement\b/i, ["requirement"], 1],
  [/\b(this|that|the|same|the same) meeting\b/i, ["meeting"], 1],
  [/\b(this|that|the|same|the same) (proposal|draft|email|message|offer)\b/i, ["outreach"], 1],
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
}): Promise<ContextPackage & { focusDenied: boolean; ambiguous: Ambiguity[] }> {
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

  const ranked = await searchEntitiesRanked(ctx, request);
  const hits = ranked.hits;
  // A tie the page/conversation already settles is not ambiguous; otherwise ask instead of picking the first.
  const ambiguous = ranked.ambiguous.filter((a) => !resolved.some((r) => r.type === a.type));
  for (const a of ambiguous) {
    missing.push(`Several ${TYPE_PLURAL[a.type] ?? a.type} match "${a.phrase}" — which one? ${a.candidates.map((c) => `"${c.label}"`).join(", ")}.`);
  }
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
    ambiguous,
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
