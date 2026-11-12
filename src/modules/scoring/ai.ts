/**
 * Score explanation. Default (AI policy off): codeExplanation() from factors/weights. With AI on: a model The AI reads the already-calculated factors and evidence
 * labels and writes a plain summary, risks and questions to ask. It never produces or changes a number (rule S5),
 * and its output is stored with the model name next to the score — the score itself is untouched.
 */
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";

const Out = z.object({ summary: z.string(), risks: z.array(z.string()), questions: z.array(z.string()) });
type Row = Record<string, any>;

export type Explanation = z.infer<typeof Out>;

/**
 * Deterministic explanation from the stored factors and weights (AI policy "off" path). Ranks factors by points
 * contributed vs lost, names the strongest drivers and the biggest drags, turns unknown inputs into risks and
 * questions. Only copies numbers already on the score row (S5).
 */
export function codeExplanation(r: Row): Explanation {
  const factors = ((r.factors ?? []) as Row[]).map((f) => ({ label: String(f.label ?? f.key ?? "factor"), known: !!f.known, points: Number(f.points ?? 0), max: Number(f.max ?? 0), explanation: String(f.explanation ?? "") }));
  const known = factors.filter((f) => f.known && f.max > 0);
  const strong = [...known].filter((f) => f.points / f.max >= 0.6).sort((a, b) => b.points - a.points).slice(0, 2);
  const weak = [...known].filter((f) => f.points / f.max < 0.4).sort((a, b) => (b.max - b.points) - (a.max - a.points)).slice(0, 2);
  const unknown = factors.filter((f) => !f.known);
  const missing = [...new Set([...(r.missing ?? []) as string[], ...unknown.map((f) => f.label)])];
  const band = String(r.band ?? "unbanded").replace(/_/g, " ");
  const parts = [`Scores ${r.score}/100 (${band}) with ${r.confidence ?? "unknown"} evidence confidence; ${r.completeness ?? 0}% of inputs are known.`];
  if (strong.length) parts.push(`Strongest drivers: ${strong.map((f) => `${f.label} (${f.points}/${f.max})`).join(" and ")}.`);
  if (weak.length) parts.push(`Held back by ${weak.map((f) => `${f.label} (${f.points}/${f.max})`).join(" and ")}.`);
  if (!strong.length && !weak.length && !known.length) parts.push("No factor has known data yet, so treat this score as provisional.");
  if (r.recommended_action) parts.push(`Recommended next step: ${String(r.recommended_action).replace(/_/g, " ")}.`);
  const risks: string[] = [];
  for (const f of weak) risks.push(`${f.label} scores low (${f.points}/${f.max})${f.explanation ? ` — ${f.explanation}` : ""}`.slice(0, 240));
  for (const m of missing) risks.push(`${m} is unknown, so the score may move once confirmed`);
  if (Number(r.completeness ?? 0) < 50) risks.push(`Less than half the inputs are known (${r.completeness ?? 0}%)`);
  const questions = missing.map((m) => `Can you confirm the ${m.toLowerCase()}?`);
  for (const f of weak) if (questions.length < 4) questions.push(`What would change on ${f.label.toLowerCase()} in the next quarter?`);
  return { summary: parts.slice(0, 4).join(" "), risks: [...new Set(risks)].slice(0, 4), questions: [...new Set(questions)].slice(0, 4) };
}

export async function explainScore(db: Db, ws: string, resultId: string, opts: { mode?: AiMode } = {}) {
  const { data: r } = await db.from("score_result").select("id, model_key, score, band, confidence, completeness, factors, missing, extra, recommended_action").eq("workspace_id", ws).eq("id", resultId).single();
  if (!r) throw new Error("Score not found");
  const facts = (r.factors as Row[]).map((f) => `- ${f.label}: ${f.known ? `${f.points}/${f.max}` : "unknown"} — ${f.explanation}`).join("\n");
  const mode = opts.mode ?? await getAiMode(db, ws, "scoring.explain");
  let meta = { model: "rules", mocked: false };
  const out = await runWithPolicy<Explanation>({
    mode, code: () => codeExplanation(r),
    ai: async () => {
      const res = await callStructured({
        workspaceId: ws, workflow: "scoring.explain", tier: "luna", classification: "corporate_confidential", schema: Out, schemaName: "score_explanation", maxOutputTokens: 500,
        system: "You explain a commercial real-estate prospect score to a broker in plain English. Use only the facts given. Do not invent numbers, dates, budgets or areas, and do not change or re-score anything. Keep it short.",
        input: `Score type: ${r.model_key}. Score ${r.score}/100 (${r.band}), evidence confidence ${r.confidence}, ${r.completeness}% of inputs known.\nFactors:\n${facts}\nMissing: ${(r.missing ?? []).join(", ") || "none"}\nRecommended: ${r.recommended_action ?? "none"}\nWrite: summary (2-3 sentences), up to 4 risks, up to 4 questions the broker should ask the client to fill the gaps.`,
        mock: () => codeExplanation(r),
      });
      meta = { model: res.model, mocked: res.mocked };
      return res.data;
    },
  });
  const v = out.value ?? codeExplanation(r);
  const source = out.source === "ai" ? "ai" : "code";
  if (source === "code") meta = { model: "rules", mocked: false };
  const ai = { ...v, risks: v.risks.slice(0, 4), questions: v.questions.slice(0, 4), model: meta.model, source, at: new Date().toISOString(), mocked: meta.mocked };
  await db.from("score_result").update({ extra: { ...(r.extra as Row), ai } }).eq("workspace_id", ws).eq("id", resultId);
  return ai;
}
