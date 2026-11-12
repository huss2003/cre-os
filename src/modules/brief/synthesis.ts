/**
 * Optional AI synthesis on top of the deterministic brief (spec Part III: "If model fails, deliver tasks/meetings/deadlines
 * as plain text with an explicit missing synthesis notice"). The model never computes numbers or dates (S5): it only gets
 * the already-computed sections and writes a short headline. Reply subjects/summaries are untrusted => `evidence` (S7).
 * Any failure (no key without mock, kill switch, budget cap, provider error) => synthesis_status "fallback_no_ai".
 */
import { z } from "zod";
import type { BriefContent } from "./builder";
import { runWithPolicy, type AiMode } from "@/lib/ai/policy";

export const SynthesisSchema = z.object({
  headline: z.string().max(300),
  focus: z.array(z.string().max(200)).max(3),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

export interface SynthesisOutcome {
  status: "ok" | "fallback_no_ai";
  /** "code" = sentence templates over the computed sections (default, AI policy off); "ai" = model wrote it. */
  source?: "code" | "ai";
  synthesis: Synthesis | null;
  notice: string | null;
  model: string | null;
  mocked: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Deterministic synthesis: sentence templates over counts and top items (AI policy "off" path; also the mock).
 * Only copies numbers/dates already computed by the builder (S5).
 */
export function codeSynthesis(c: BriefContent): Synthesis {
  const meetings = c.meetings.clusters.reduce((n, cl) => n + cl.meetings.length, 0);
  const firstMeeting = c.meetings.clusters.flatMap((cl) => cl.meetings)[0];
  const nextDeadline = c.deadlines.items[0];
  const clauses: string[] = [];
  if (c.actions[0]) clauses.push(`start with ${c.actions[0].title}`);
  if (meetings) clauses.push(`${plural(meetings, "meeting")}${c.meetings.clusters.length > 1 ? ` across ${c.meetings.clusters.length} areas` : ""}`);
  if (c.overdue.items.length) clauses.push(`${plural(c.overdue.items.length, "overdue task")} to clear`);
  if (nextDeadline) clauses.push(`${plural(c.deadlines.items.length, "lease event")} in the next 90 days (nearest: ${nextDeadline.tenant ?? "a tenant"}, ${nextDeadline.kind.replace(/_/g, " ")} in ${nextDeadline.days} days)`);
  let headline: string;
  if (!clauses.length) headline = c.mode === "light" ? "Light review day — nothing urgent." : "No urgent items — work the target list.";
  else {
    const [first, ...rest] = clauses;
    const lead = first.charAt(0).toUpperCase() + first.slice(1);
    headline = rest.length ? `${lead}; ${rest.length > 1 ? rest.slice(0, -1).join(", ") + " and " + rest[rest.length - 1] : rest[0]}.` : `${lead}.`;
  }
  if (c.staleSections.length) headline += ` Check stale sources: ${c.staleSections.join(", ")}.`;
  headline = headline.slice(0, 300);
  const focus: string[] = c.actions.slice(0, 3).map((a) => (a.why ? `${a.title} — ${a.why}` : a.title).slice(0, 200));
  if (focus.length < 3 && firstMeeting?.title) focus.push(`Prepare for ${firstMeeting.title}`.slice(0, 200));
  const pending = c.approvals.changes + c.approvals.drafts;
  if (focus.length < 3 && pending > 0 && !c.actions.some((a) => a.kind === "approvals")) focus.push(`Review ${plural(pending, "pending approval")}`);
  return { headline, focus: focus.slice(0, 3) };
}

/** Back-compat alias (tests and the gateway mock use it). */
export const mockSynthesis = codeSynthesis;

export type StructuredCaller = (call: {
  workspaceId: string; workflow: string; system: string; input: string; evidence?: string;
  schema: typeof SynthesisSchema; schemaName: string; maxOutputTokens: number; mock: () => Synthesis;
}) => Promise<{ data: Synthesis; mocked: boolean; model: string }>;

export function synthesisPrompt(c: BriefContent): { input: string; evidence: string } {
  const facts = {
    date: c.date, mode: c.mode, stale_sections: c.staleSections,
    actions: c.actions.map((a) => ({ title: a.title, why: a.why })),
    approaches: c.approaches,
    overdue: c.overdue.items.slice(0, 5).map((t) => t.title),
    meetings: c.meetings.clusters.map((cl) => ({ area: cl.label, count: cl.meetings.length })),
    deadlines: c.deadlines.items.slice(0, 5).map((d) => ({ kind: d.kind, date: d.date, days: d.days, tenant: d.tenant, basis: d.basisLabel })),
    approvals: c.approvals,
    pipeline: { open: c.pipeline.open, closing_this_quarter: c.pipeline.closingThisQuarter },
  };
  const evidence = c.replies.items.slice(0, 5).map((r) => `- ${r.orgName ?? "unknown"}: ${r.subject ?? ""} ${r.summary ?? ""}`.slice(0, 400)).join("\n");
  return {
    input: "Write a one-sentence headline and up to three focus lines for this CRE adviser's morning. Use ONLY the facts below; copy numbers/dates exactly, never compute new ones. Facts JSON:\n" + JSON.stringify(facts),
    evidence,
  };
}

export async function synthesise(c: BriefContent, workspaceId: string, call: StructuredCaller, mode: AiMode = "off"): Promise<SynthesisOutcome> {
  const p = synthesisPrompt(c);
  let model: string | null = null;
  let mocked = false;
  const out = await runWithPolicy<Synthesis>({
    mode,
    code: () => codeSynthesis(c),
    ai: async () => {
      const res = await call({
        workspaceId, workflow: "brief.synthesis", system: "You summarise a deterministic daily brief. You never add facts.",
        input: p.input, evidence: p.evidence || undefined, schema: SynthesisSchema, schemaName: "brief_synthesis", maxOutputTokens: 400,
        mock: () => codeSynthesis(c),
      });
      model = res.model; mocked = res.mocked;
      return res.data;
    },
  });
  if (out.source === "ai") return { status: "ok", source: "ai", synthesis: out.value, notice: null, model, mocked };
  if (mode === "off" || !out.aiError) return { status: "ok", source: "code", synthesis: out.value, notice: null, model: null, mocked: false };
  // AI was asked for (on/backup) and failed: keep the explicit notice, plus the code summary.
  const reason = (out.aiError as { reason?: string }).reason ?? "provider_error";
  const why: Record<string, string> = {
    no_api_key: "AI not configured", paused: "AI paused by the workspace kill switch", budget_exceeded: "monthly AI budget reached", provider_error: "AI provider error",
    watchdog: "generated by the health watchdog without waiting for AI", ai_disabled: "AI turned off for this feature",
  };
  return { status: "fallback_no_ai", source: "code", synthesis: out.value, notice: `AI synthesis missing (${why[reason] ?? reason}) — deterministic brief shown in full.`, model: null, mocked: false };
}
