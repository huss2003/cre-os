import { z } from "zod";
import type { EntityRef, ToolContext, ToolDef } from "../types";
import { defineTool, logDenied, NOT_FOUND } from "./shared";
import * as M from "../memory/service";

/** Memory tools (spec §4). Only explicitly stated info is saved as stated; inferences must say stated=false. */
const entityType = z.enum(["person", "company", "requirement"]);
const cat = z.enum(["person", "company", "requirement", "relationship"]);
const sourceOf = (t: ToolContext) => (t.conversationId ? `conversation:${t.conversationId}` : `run:${t.runId}`);
const today = () => new Date().toISOString().slice(0, 10);

async function visible(t: ToolContext, type: string, id: string): Promise<boolean> {
  const table = type === "company" || type === "organisation" ? "organisation" : type;
  const { data } = await t.ctx.db.from(table).select("id").eq("workspace_id", t.ctx.workspaceId).eq("id", id).maybeSingle();
  return !!data;
}
async function memOr404(t: ToolContext, toolId: string, id: string) {
  const m = await M.getMemory(t.ctx, id);
  if (!m) await logDenied(t, toolId, { memory_id: id });
  return m;
}
const err = (e: unknown) => ({ ok: false, summary: e instanceof Error ? e.message : "failed", error: e instanceof Error ? e.message : "failed" });

export const memoryTools: ToolDef[] = [
  defineTool({
    id: "recall_memories", module: "assistant", category: "A",
    description: "Recall saved memories (preferences, commitments, constraints, history) about people, companies or requirements. Inferred memories are prefixed '(inferred)' and must be presented as inferences, never as confirmed facts. Stale memories should be re-checked before important recommendations.",
    input: z.object({ entities: z.array(z.object({ type: entityType, id: z.string().uuid() })).max(10).default([]), query: z.string().max(200).optional(), include_restricted: z.boolean().default(false).describe("Only when the user explicitly asks to include their restricted memories") }),
    run: async (i, t) => {
      const refs: EntityRef[] = i.entities.map((e) => ({ type: e.type, id: e.id, label: "" }));
      const mems = await M.recallMemories(t.ctx, refs.length ? refs : t.focus ? [t.focus] : [], { q: i.query, includeRestricted: i.include_restricted });
      return {
        ok: true, summary: mems.length ? `${mems.length} memories (${mems.filter((m) => !m.stated).length} inferred, ${mems.filter((m) => m.stale).length} due for review)` : "No saved memories for this.",
        data: mems.map((m) => ({ id: m.id, about: m.label, category: m.category, content: m.content, stated: m.stated, confidence: m.confidence, captured: m.capturedAt.slice(0, 10), stale: m.stale })),
        sources: mems.map((m) => ({ label: `Memory: ${m.label}`, href: `/assistant/memory?entity=${m.entityId}`, observedAt: m.capturedAt, status: m.stated ? "reported" as const : "inferred" as const })),
        missing: mems.length ? [] : ["No memories recorded for these records"],
      };
    },
  }),
  defineTool({
    id: "save_memory", module: "assistant", category: "B",
    description: "Save a memory the user has explicitly stated (stated=true) about a person, company or requirement — e.g. 'John prefers short emails'. Use stated=false ONLY for your own inference, with lower confidence. Set company_specific=true for preferences tied to the person's current employer. Never save health, religion, caste, politics or other sensitive personal data.",
    input: z.object({ category: cat, entity_type: entityType, entity_id: z.string().uuid(), content: z.string().min(3).max(1000), stated: z.boolean().default(true), confidence: z.number().min(0).max(1).optional(), company_specific: z.boolean().default(false), provided_by: z.string().max(120).optional() }),
    run: async (i, t) => {
      if (!(await visible(t, i.entity_type, i.entity_id))) { await logDenied(t, "save_memory", { entity_type: i.entity_type, entity_id: i.entity_id }); return { ok: false, summary: "Record not found.", error: NOT_FOUND }; }
      try {
        const m = await M.saveMemory(t.ctx, { category: i.category, entityType: i.entity_type, entityId: i.entity_id, content: i.content, stated: i.stated, confidence: i.confidence, scope: i.company_specific ? "employer" : undefined, source: sourceOf(t), sourceRef: { run_id: t.runId, conversation_id: t.conversationId }, providedBy: i.provided_by ?? "user" });
        return { ok: true, summary: `Saved ${m.stated ? "stated" : "inferred"} memory (${today()}).`, data: { id: m.id, stated: m.stated, review_at: m.review_at } };
      } catch (e) { return err(e); }
    },
  }),
  defineTool({
    id: "correct_memory", module: "assistant", category: "B",
    description: "Correct an outdated memory, e.g. 'That preference is outdated. He now prefers larger floor plates.' Give memory_id if known, otherwise the entity and a hint (words from the old memory). The old memory is kept as history (outdated) and the new one is saved as stated with this conversation as source and today's date.",
    input: z.object({ memory_id: z.string().uuid().optional(), entity_type: entityType.optional(), entity_id: z.string().uuid().optional(), hint: z.string().max(300).optional(), new_content: z.string().min(3).max(1000) }),
    run: async (i, t) => {
      let id = i.memory_id;
      if (!id) {
        const et = i.entity_type ?? (t.focus?.type as "person" | undefined); const eid = i.entity_id ?? t.focus?.id;
        if (!et || !eid) return { ok: false, summary: "Which person or company is this about?", error: "entity_required", missing: ["entity"] };
        const found = await M.findMemoryToCorrect(t.ctx, et, eid, i.hint ?? i.new_content);
        if (!found) return { ok: false, summary: "No matching memory to correct — save it as a new memory instead.", error: "no_matching_memory" };
        id = found.id;
      } else if (!(await memOr404(t, "correct_memory", id))) return { ok: false, summary: "Memory not found.", error: NOT_FOUND };
      try {
        const r = await M.correctMemory(t.ctx, id, i.new_content, { source: sourceOf(t), sourceRef: { run_id: t.runId, conversation_id: t.conversationId }, providedBy: "user" });
        return { ok: true, summary: `Updated: "${r.old.content}" → "${r.current.content}" (old kept as history, ${today()}).`, data: { old_id: r.old.id, new_id: r.current.id, captured: r.current.captured_at } };
      } catch (e) { return err(e); }
    },
  }),
  defineTool({
    id: "forget_memory", module: "assistant", category: "C",
    description: "Permanently forget a memory (content erased). Needs the user's approval.",
    input: z.object({ memory_id: z.string().uuid() }),
    plan: async (i, t) => {
      const m = await M.getMemory(t.ctx, i.memory_id);
      if (!m) throw new Error(NOT_FOUND);
      const label = (await M.entityLabels(t.ctx, [{ type: m.entity_type, id: m.entity_id }])).get(m.entity_id) ?? "record";
      return { title: "Forget a memory", explanation: `The assistant will permanently erase this ${m.category} memory about ${label}. It can't be recalled afterwards.`, affected: [{ type: m.entity_type === "organisation" ? "company" : (m.entity_type as "person"), id: m.entity_id, label, href: M.hrefFor(m.entity_type, m.entity_id) }], diff: [{ field: "memory", before: m.content, after: "(forgotten)" }] };
    },
    run: async (i, t) => {
      if (!(await memOr404(t, "forget_memory", i.memory_id))) return { ok: false, summary: "Memory not found.", error: NOT_FOUND };
      try { await M.forgetMemory(t.ctx, i.memory_id); return { ok: true, summary: "Memory forgotten." }; } catch (e) { return err(e); }
    },
  }),
  defineTool({
    id: "restrict_memory", module: "assistant", category: "B",
    description: "Restrict a memory so it is no longer used in assistant answers (kept for the owner only).",
    input: z.object({ memory_id: z.string().uuid() }),
    run: async (i, t) => {
      if (!(await memOr404(t, "restrict_memory", i.memory_id))) return { ok: false, summary: "Memory not found.", error: NOT_FOUND };
      try { await M.restrictMemory(t.ctx, i.memory_id); return { ok: true, summary: "Memory restricted — it won't be used in answers." }; } catch (e) { return err(e); }
    },
  }),
];
