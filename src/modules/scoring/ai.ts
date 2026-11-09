/**
 * AI explanation of a score (Claude Haiku, no web search). The AI reads the already-calculated factors and evidence
 * labels and writes a plain summary, risks and questions to ask. It never produces or changes a number (rule S5),
 * and its output is stored with the model name next to the score — the score itself is untouched.
 */
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";

const Out = z.object({ summary: z.string(), risks: z.array(z.string()), questions: z.array(z.string()) });
type Row = Record<string, any>;

export async function explainScore(db: Db, ws: string, resultId: string) {
  const { data: r } = await db.from("score_result").select("id, model_key, score, band, confidence, completeness, factors, missing, extra, recommended_action").eq("workspace_id", ws).eq("id", resultId).single();
  if (!r) throw new Error("Score not found");
  const facts = (r.factors as Row[]).map((f) => `- ${f.label}: ${f.known ? `${f.points}/${f.max}` : "unknown"} — ${f.explanation}`).join("\n");
  const res = await callStructured({
    workspaceId: ws, workflow: "scoring.explain", tier: "luna", classification: "corporate_confidential", schema: Out, schemaName: "score_explanation", maxOutputTokens: 500,
    system: "You explain a commercial real-estate prospect score to a broker in plain English. Use only the facts given. Do not invent numbers, dates, budgets or areas, and do not change or re-score anything. Keep it short.",
    input: `Score type: ${r.model_key}. Score ${r.score}/100 (${r.band}), evidence confidence ${r.confidence}, ${r.completeness}% of inputs known.\nFactors:\n${facts}\nMissing: ${(r.missing ?? []).join(", ") || "none"}\nRecommended: ${r.recommended_action ?? "none"}\nWrite: summary (2-3 sentences), up to 4 risks, up to 4 questions the broker should ask the client to fill the gaps.`,
    mock: () => ({
      summary: `${r.band} (${r.score}/100) with ${r.confidence} confidence; ${r.completeness}% of inputs are known.`,
      risks: (r.missing ?? []).slice(0, 4).map((m: string) => `${m} is unknown`),
      questions: (r.missing ?? []).slice(0, 4).map((m: string) => `Can you confirm the ${m.toLowerCase()}?`),
    }),
  });
  const ai = { ...res.data, risks: res.data.risks.slice(0, 4), questions: res.data.questions.slice(0, 4), model: res.model, at: new Date().toISOString(), mocked: res.mocked };
  await db.from("score_result").update({ extra: { ...(r.extra as Row), ai } }).eq("workspace_id", ws).eq("id", resultId);
  return ai;
}
