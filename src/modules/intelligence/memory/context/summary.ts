import "server-only";
/** AI summary of an assembled context (spec §15: AI for summarisation only). Records go in `evidence` (S7); output is labelled AI. */
import { z } from "zod";
import { callStructured } from "@/lib/ai/gateway";
import type { AiCall } from "../../common";
import type { MemCtx } from "../types";

const Schema = z.object({ summary: z.string(), unknowns: z.array(z.string()) });
export interface ContextSummary { text: string; unknowns: string[]; aiGenerated: true; model: string; mock: boolean; error: string | null }

/** Deterministic fallback/mock: plain facts lines, no invention. */
export function mockSummary(facts: string[], unknowns: string[]): { summary: string; unknowns: string[] } {
  return { summary: facts.length ? facts.slice(0, 6).join(" ") : "Nothing is recorded yet.", unknowns };
}

export async function summariseContext(ctx: MemCtx, kind: "company" | "person" | "property" | "requirement" | "meeting", facts: string[], unknowns: string[], ai: AiCall = callStructured): Promise<ContextSummary> {
  try {
    const r = await ai({
      workspaceId: ctx.workspaceId, workflow: `intelligence.memory.summary.${kind}`, tier: "luna", schema: Schema, schemaName: "context_summary",
      system: "You summarise CRM records for a commercial real-estate adviser. Use ONLY the facts in the evidence. Never invent conversations, preferences, commitments or numbers. Keep 'reported'/'inferred' labels. List anything unknown under unknowns. Max 80 words, plain words.",
      input: `Summarise this ${kind} context in 2-4 sentences. Known unknowns: ${unknowns.join("; ") || "none"}.`,
      evidence: facts.join("\n"), maxOutputTokens: 400,
      mock: () => mockSummary(facts, unknowns),
    });
    return { text: r.data.summary, unknowns: r.data.unknowns, aiGenerated: true, model: r.model, mock: r.mocked, error: null };
  } catch (e) {
    const m = mockSummary(facts, unknowns);
    return { text: m.summary, unknowns, aiGenerated: true, model: "none", mock: true, error: e instanceof Error ? e.message : String(e) };
  }
}
