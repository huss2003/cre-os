import "server-only";
import { createHash } from "node:crypto";
import type { AppContext } from "@/lib/auth/context";
import type { Block } from "../types";

/**
 * Answer cache for repeated questions (round 2). A finished, side-effect-free answer is reused when the same user asks the
 * same (normalised) question with the same focus and tool groups within 24h AND the tables its tools read are unchanged
 * (fingerprint = row count + max(updated_at) per table, read through RLS).
 */

export const CACHE_TTL_MS = 24 * 3_600_000;

/** Tables each tool reads. `null` = tool has side effects / external data → the run is never cached. */
const CORE = ["organisation", "person", "employment"];
const PROPS = ["asset", "space", "availability", "geography"];
export const TOOL_TABLES: Record<string, string[] | null> = {
  search_companies: [...CORE, "requirement", "opportunity"],
  get_company_profile: [...CORE, "requirement", "opportunity", "interaction", "lease", "stakeholder", "task", "score_result", "contact_method"],
  search_contacts: [...CORE, "contact_method", "contact_role_assessment"],
  get_contact_profile: [...CORE, "contact_method", "contact_role_assessment", "interaction", "stakeholder"],
  search_properties: [...PROPS, "lease"],
  get_property_details: [...PROPS, "lease", "lease_event", "quote"],
  search_requirements: ["requirement", "organisation"],
  get_requirement_details: ["requirement", "requirement_version", "shortlist_option", "asset", "organisation", "meeting_property_feedback"],
  search_opportunities: ["opportunity", "organisation"],
  get_opportunity_details: ["opportunity", "organisation", "requirement", "quote", "deal_analysis", "task", "stakeholder"],
  find_leases_expiring: ["lease", "lease_event", "organisation", "asset"],
  calculate_distance: ["asset", "infrastructure"],
  get_upcoming_meetings: ["meeting_visit", "meeting_prep", "organisation"],
  get_meeting_history: ["meeting_visit", "meeting_note", "meeting_prep", "interaction"],
  get_commitments: ["task", "meeting_note", "interaction"],
  get_outreach_history: ["outreach_item", "draft"],
  get_research_signals: ["signal", "research_dossier"],
  get_scores: ["score_result", "score_override"],
  rank_priority_accounts: ["score_result", "score_override", "organisation"],
  find_decision_makers: [...CORE, "contact_role_assessment", "stakeholder"],
  explain_deal_stuck: ["opportunity", "task", "interaction", "meeting_visit"],
  search_documents: ["legal_document", "clause_extract", "meeting_note", "interaction"],
  retrieve_document_content: ["legal_document", "clause_extract", "meeting_note"],
  recall_memories: ["assistant_memory"],
  list_saved_commands: ["assistant_command"],
  // pure calculators (category B, no writes)
  compare_properties: [...PROPS, "quote"],
  calculate_lease_economics: [], calculate_occupancy_cost: [], compare_renewal_vs_relocation: [], compare_quotes: ["quote"], analyse_fitout: [],
  // side effects / external → never cached
  web_research: null, generate_meeting_brief: null, generate_outreach_draft: null, create_internal_task: null, generate_deal_review: null,
  save_command: null, save_memory: null, correct_memory: null, forget_memory: null, restrict_memory: null,
};
/** Always part of the fingerprint: the context package recalls memories. */
export const BASE_TABLES = ["assistant_memory"];

export const normaliseRequest = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export function cacheKey(p: { request: string; focusId?: string | null; groups: readonly string[]; userId: string }) {
  return createHash("sha256").update(JSON.stringify([normaliseRequest(p.request), p.focusId ?? null, [...p.groups].sort(), p.userId])).digest("hex");
}

/** Follow-ups that refer back into the conversation ("these three", "that one") depend on history → not cacheable. */
export const refersToConversation = (request: string) => /\b(these|those|this|that|them|it|above|previous|earlier|same)\b/i.test(request);

/** Tables touched by the tools of a run, or null when any tool makes the run uncacheable. */
export function tablesFor(toolIds: string[], focusType?: string | null): string[] | null {
  const out = new Set(BASE_TABLES);
  for (const id of toolIds) {
    const t = TOOL_TABLES[id];
    if (t === null || t === undefined) return null;
    t.forEach((x) => out.add(x));
  }
  const f = focusType === "company" ? "organisation" : focusType;
  if (f && /^[a-z_]+$/.test(f)) out.add(f);
  return [...out].sort();
}

/** count + max(updated_at) per table, through the caller's RLS client. Missing tables fingerprint as "x". */
export async function dataFingerprint(ctx: AppContext, tables: string[]): Promise<string> {
  const parts = await Promise.all(tables.map(async (t) => {
    try {
      const { data, count, error } = await ctx.db.from(t).select("updated_at", { count: "exact" }).eq("workspace_id", ctx.workspaceId).order("updated_at", { ascending: false }).limit(1);
      if (error) return `${t}:x`;
      return `${t}:${count ?? 0}:${(data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? "-"}`;
    } catch { return `${t}:x`; }
  }));
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

export interface CachedAnswer { id: string; text: string; blocks: Block[]; createdAt: string; sourceRunId: string | null }

export async function lookupAnswer(ctx: AppContext, key: string, now = Date.now()): Promise<CachedAnswer | null> {
  const { data } = await ctx.db.from("assistant_answer_cache").select("id, answer_text, blocks, tables, fingerprint, created_at, updated_at, expires_at, source_run_id, hits")
    .eq("workspace_id", ctx.workspaceId).eq("owner_user_id", ctx.userId).eq("cache_key", key).is("archived_at", null).maybeSingle();
  if (!data || new Date(data.expires_at as string).getTime() < now) return null;
  const fp = await dataFingerprint(ctx, (data.tables as string[]) ?? BASE_TABLES);
  if (fp !== data.fingerprint) return null;
  await ctx.db.from("assistant_answer_cache").update({ hits: ((data.hits as number) ?? 0) + 1 }).eq("workspace_id", ctx.workspaceId).eq("id", data.id);
  // created_at is when the answer was computed (re-stores refresh it via upsert below)
  return { id: data.id as string, text: data.answer_text as string, blocks: (data.blocks as Block[]) ?? [], createdAt: (data.updated_at as string) ?? (data.created_at as string), sourceRunId: (data.source_run_id as string) ?? null };
}

export async function storeAnswer(ctx: AppContext, p: { key: string; request: string; text: string; blocks: Block[]; tables: string[]; runId: string }) {
  const fingerprint = await dataFingerprint(ctx, p.tables);
  const row = {
    answer_text: p.text, blocks: p.blocks as object, tables: p.tables, fingerprint, source_run_id: p.runId, request: p.request.slice(0, 2000),
    expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(), hits: 0,
  };
  const { data: prior } = await ctx.db.from("assistant_answer_cache").select("id").eq("workspace_id", ctx.workspaceId).eq("owner_user_id", ctx.userId).eq("cache_key", p.key).maybeSingle();
  if (prior) await ctx.db.from("assistant_answer_cache").update({ ...row, archived_at: null }).eq("workspace_id", ctx.workspaceId).eq("id", prior.id);
  else await ctx.db.from("assistant_answer_cache").insert({ workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, cache_key: p.key, ...row });
}

export const REUSED_PREFIX = "Reused answer from";
export function reusedLabel(iso: string, tz = "Asia/Kolkata") {
  const t = new Intl.DateTimeFormat("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return `${REUSED_PREFIX} ${t} — data unchanged`;
}
