import "server-only";
/** Summary of an assembled context: templated by default (AI policy off); AI only when turned on — then labelled AI. Records go in `evidence` (S7). */
import { z } from "zod";
import { callStructured } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";
import type { AiCall } from "../../common";
import type { MemCtx } from "../types";

const Schema = z.object({ summary: z.string(), unknowns: z.array(z.string()) });
export interface ContextSummary { text: string; unknowns: string[]; /** true only when a model wrote the text */ aiGenerated: boolean; source: "code" | "ai"; model: string; mock: boolean; error: string | null }

const KIND_LEAD: Record<string, string> = { company: "Company record", person: "Contact record", property: "Property record", requirement: "Requirement", meeting: "Meeting record" };
const sentence = (f: string) => { const t = f.trim().replace(/\s+/g, " "); return t ? (/[.!?)]$/.test(t) ? t : `${t}.`) : ""; };

/**
 * Templated summary (AI policy "off" path): up to five fact lines verbatim (labels like "reported" kept), the count of
 * further facts, and what is unknown. Never paraphrases numbers or invents (S5/S6).
 */
export function mockSummary(facts: string[], unknowns: string[], kind = "record"): { summary: string; unknowns: string[] } {
  const clean = [...new Set(facts.map(sentence).filter(Boolean))];
  if (!clean.length) return { summary: `Nothing is recorded yet for this ${kind}.${unknowns.length ? ` Unknown: ${unknowns.slice(0, 5).join(", ")}.` : ""}`, unknowns };
  const shown = clean.slice(0, 5);
  const more = clean.length - shown.length;
  const parts = [`${KIND_LEAD[kind] ?? "Record"} — ${clean.length} recorded fact${clean.length === 1 ? "" : "s"}.`, ...shown];
  if (more > 0) parts.push(`${more} more in the records below.`);
  if (unknowns.length) parts.push(`Still unknown: ${unknowns.slice(0, 5).join(", ")}.`);
  return { summary: parts.join(" "), unknowns };
}

export async function summariseContext(ctx: MemCtx, kind: "company" | "person" | "property" | "requirement" | "meeting", facts: string[], unknowns: string[], ai: AiCall = callStructured, mode?: AiMode): Promise<ContextSummary> {
  const code = () => mockSummary(facts, unknowns, kind);
  let meta = { model: "rules", mock: false };
  const m = mode ?? await getAiMode(ctx.db, ctx.workspaceId, "intelligence.memory");
  const pol = await runWithPolicy({ mode: m, code, ai: async () => {
    const r = await ai({
      workspaceId: ctx.workspaceId, workflow: `intelligence.memory.summary.${kind}`, tier: "luna", schema: Schema, schemaName: "context_summary",
      system: "You summarise CRM records for a commercial real-estate adviser. Use ONLY the facts in the evidence. Never invent conversations, preferences, commitments or numbers. Keep 'reported'/'inferred' labels. List anything unknown under unknowns. Max 80 words, plain words.",
      input: `Summarise this ${kind} context in 2-4 sentences. Known unknowns: ${unknowns.join("; ") || "none"}.`,
      evidence: facts.join("\n"), maxOutputTokens: 400,
      mock: code,
    });
    meta = { model: r.model, mock: r.mocked };
    return r.data as { summary: string; unknowns: string[] };
  } });
  const v = pol.value ?? code();
  if (pol.source === "ai") return { text: v.summary, unknowns: v.unknowns, aiGenerated: true, source: "ai", model: meta.model, mock: meta.mock, error: null };
  return { text: v.summary, unknowns, aiGenerated: false, source: "code", model: "rules", mock: false, error: m !== "off" && pol.aiError ? (pol.aiError instanceof Error ? pol.aiError.message : String(pol.aiError)) : null };
}
