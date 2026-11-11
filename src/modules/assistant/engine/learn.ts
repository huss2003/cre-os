import "server-only";
import { z } from "zod";
import type { AppContext } from "@/lib/auth/context";
import { callStructured } from "@/lib/ai/gateway";
import { saveMemory, MemoryError, type MemCtx, type MemoryRow } from "../memory/service";
import type { EntityRef } from "../types";

/**
 * Learning from corrections (round 2). Two inputs become candidate preference memories via saveMemory:
 *  - thumbs-down with a comment on an assistant answer  → stated=true (the user wrote it);
 *  - user edits of a model-generated draft              → stated=false, low confidence (inferred from the diff).
 * Memory categories are fixed: style preferences are stored as `relationship` memories against the person
 * (or `company` memories against the organisation when no person is known). Nothing is ever sent anywhere.
 */

type Target = { entityType: "person" | "organisation"; entityId: string };
export type LearnOutcome = { saved: MemoryRow | null; reason?: string };

const categoryFor = (t: Target) => (t.entityType === "person" ? "relationship" : "company") as "relationship" | "company";
const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

/** Person first, then company, from the message's run/conversation focus and entity refs. */
async function targetForMessage(ctx: MemCtx, messageId: string): Promise<Target | null> {
  const { data: msg } = await ctx.db.from("assistant_message").select("conversation_id").eq("workspace_id", ctx.workspaceId).eq("id", messageId).maybeSingle();
  if (!msg) return null;
  const { data: c } = await ctx.db.from("assistant_conversation").select("context_entity_type, context_entity_id, entity_refs")
    .eq("workspace_id", ctx.workspaceId).eq("id", msg.conversation_id).maybeSingle();
  if (!c) return null;
  const refs: EntityRef[] = [
    ...(c.context_entity_type && c.context_entity_id ? [{ type: c.context_entity_type, id: c.context_entity_id, label: "" } as EntityRef] : []),
    ...(((c.entity_refs as EntityRef[]) ?? []).slice().reverse()),
  ];
  const p = refs.find((r) => r.type === "person" && isUuid(r.id));
  if (p) return { entityType: "person", entityId: p.id };
  const o = refs.find((r) => (r.type === "company" || (r.type as string) === "organisation") && isUuid(r.id));
  return o ? { entityType: "organisation", entityId: o.id } : null;
}

/** Thumbs-down + comment → stated preference memory scoped to the conversation's person/company. */
export async function learnFromFeedback(ctx: MemCtx, p: { messageId: string; rating: number; comment?: string | null; feedbackId?: string }): Promise<LearnOutcome> {
  const comment = (p.comment ?? "").replace(/\s+/g, " ").trim();
  if (p.rating !== -1 || comment.length < 4) return { saved: null, reason: "only thumbs-down with a comment is learned from" };
  const target = await targetForMessage(ctx, p.messageId);
  if (!target) return { saved: null, reason: "no person or company in this conversation to attach the preference to" };
  try {
    const saved = await saveMemory(ctx, {
      category: categoryFor(target), entityType: target.entityType, entityId: target.entityId,
      content: `Preference (from user correction of an assistant answer): ${comment.slice(0, 500)}`,
      source: "assistant_feedback", sourceRef: { message_id: p.messageId, feedback_id: p.feedbackId ?? null, kind: "style_preference" },
      providedBy: ctx.userId, stated: true, confidence: 0.8,
    });
    return { saved };
  } catch (e) {
    if (e instanceof MemoryError) return { saved: null, reason: e.message };
    throw e;
  }
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const firstLine = (s: string) => s.trim().split(/\n/)[0]?.trim() ?? "";

/** Deterministic preference extraction from an edit (mock + guard). Word counts are code, not model output. */
export function heuristicPreference(before: string, after: string): string | null {
  const b = before.trim(), a = after.trim();
  if (!a || a === b) return null;
  const wb = words(b), wa = words(a);
  const notes: string[] = [];
  if (wb >= 20 && wa <= wb * 0.75) notes.push(`prefers shorter messages (edited from ${wb} to ${wa} words)`);
  else if (wa >= wb * 1.33 && wa - wb >= 15) notes.push(`prefers more detailed messages (edited from ${wb} to ${wa} words)`);
  const gb = firstLine(b), ga = firstLine(a);
  if (gb !== ga && ga.length <= 60 && /^(hi|hello|dear|hey|namaste|good (morning|afternoon|evening))\b/i.test(ga)) notes.push(`opens with "${ga}"`);
  if ((b.match(/!/g)?.length ?? 0) > 0 && (a.match(/!/g)?.length ?? 0) === 0) notes.push("avoids exclamation marks");
  const signB = b.split(/\n/).slice(-2).join(" ").trim(), signA = a.split(/\n/).slice(-2).join(" ").trim();
  if (signA !== signB && signA.length <= 80 && /(regards|thanks|best|cheers|sincerely)/i.test(signA)) notes.push(`signs off with "${signA}"`);
  return notes.length ? `Writing style: ${notes.join("; ")}.` : null;
}

const Extract = z.object({ preference: z.string().max(400).nullable() });

/**
 * Hook for draft saves. Call after a user edit of a draft is stored. Only model/job-generated drafts are learned from.
 * Never throws for business reasons; returns { saved: null, reason } when nothing is learned.
 */
export async function learnFromDraftEdit(ctx: MemCtx, p: { draftId: string; before: { subject?: string | null; body: string }; after: { subject?: string | null; body: string } }): Promise<LearnOutcome> {
  const { data: d } = await ctx.db.from("draft").select("id, created_by_kind, recipient_person_id, org_id").eq("workspace_id", ctx.workspaceId).eq("id", p.draftId).maybeSingle();
  if (!d) return { saved: null, reason: "draft not found" };
  if (d.created_by_kind === "user") return { saved: null, reason: "draft was written by the user, not generated" };
  if (p.before.body.trim() === p.after.body.trim() && (p.before.subject ?? "") === (p.after.subject ?? "")) return { saved: null, reason: "no change" };
  const target: Target | null = isUuid(d.recipient_person_id) ? { entityType: "person", entityId: d.recipient_person_id } : isUuid(d.org_id) ? { entityType: "organisation", entityId: d.org_id } : null;
  if (!target) return { saved: null, reason: "draft has no recipient person or company" };

  const mock = heuristicPreference(p.before.body, p.after.body);
  const res = await callStructured({
    workspaceId: ctx.workspaceId, workflow: "assistant.learn_draft_edit", tier: "luna", schema: Extract, schemaName: "draft_edit_preference",
    system: "Compare a generated outreach draft (GENERATED) with the user's edited version (EDITED). If the edit reveals a durable, reusable writing preference for this recipient (tone, length, greeting, sign-off, formality, things to avoid), state it in one short sentence starting 'Writing style:'. If the edit only fixes facts or is one-off, return null. Never include personal data beyond style.",
    input: "Extract the writing preference, if any.",
    evidence: `GENERATED subject: ${p.before.subject ?? ""}\nGENERATED body:\n${p.before.body.slice(0, 4000)}\n\nEDITED subject: ${p.after.subject ?? ""}\nEDITED body:\n${p.after.body.slice(0, 4000)}`,
    maxOutputTokens: 200,
    mock: () => ({ preference: mock }),
  }).catch(() => ({ data: { preference: mock } }));
  const pref = res.data.preference?.trim();
  if (!pref) return { saved: null, reason: "no durable preference in this edit" };
  try {
    const saved = await saveMemory(ctx, {
      category: categoryFor(target), entityType: target.entityType, entityId: target.entityId, content: pref.slice(0, 400),
      source: "draft_edit", sourceRef: { draft_id: p.draftId, kind: "style_preference" }, providedBy: ctx.userId, stated: false, confidence: 0.5,
    });
    return { saved };
  } catch (e) {
    if (e instanceof MemoryError) return { saved: null, reason: e.message };
    throw e;
  }
}

export type LearnCtx = Pick<AppContext, "db" | "workspaceId" | "userId">;
