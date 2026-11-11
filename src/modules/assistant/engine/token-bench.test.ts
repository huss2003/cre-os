// Token/cost benchmark for the assistant loop. Records the exact request bodies the engine would send to
// Anthropic (via the mock planner, so no API key is needed), estimates tokens (chars / 4) and simulates
// Anthropic prompt caching (5-minute cache; write = 1.25x input price, read = 0.1x; min cacheable prefix).
// Run: BENCH_LABEL=before npx vitest run src/modules/assistant/engine/token-bench.test.ts
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { userClient, WS1, USERS } from "../../../../tests/helpers";
import type { AppContext } from "@/lib/auth/context";
import { runAssistant } from "./run";
import { MockProvider } from "./mock";
import * as provider from "./provider";

delete process.env.ANTHROPIC_API_KEY;
process.env.ASSISTANT_RUNS_PER_MIN = "500";

const QUESTIONS = [
  "Which five accounts should I focus on this week?",
  "Prepare me for my next meeting",
  "Find all companies whose lease expires in the next 12 months",
  "What did I promise clients last week?",
  "Compare renewal against moving to two other buildings for my client",
  "Find office buildings that may benefit from the upcoming metro station",
  "Show me everything about the latest deal",
  "Draft a follow-up email to the decision maker",
];

const PRICE: Record<string, { in: number; out: number; min: number }> = {
  haiku: { in: 1, out: 5, min: 2048 },
  sonnet: { in: 3, out: 15, min: 1024 },
};
const tok = (s: string) => Math.ceil(s.length / 4);

type Body = { model: string; system: unknown; tools?: unknown[]; messages: unknown[] };
// Serialise the way the real provider does. After the change the provider exports buildRequestBody().
const toBody = (req: provider.ChatRequest): Body => {
  const b = (provider as unknown as { buildRequestBody?: (r: provider.ChatRequest) => Body }).buildRequestBody;
  return b ? b(req) : { model: req.model, system: req.system, messages: req.messages, tools: req.tools };
};

/** Split body into ordered segments with cache breakpoints (Anthropic order: tools → system → messages). */
function segments(b: Body): { text: string; breakpoint: boolean }[] {
  const out: { text: string; breakpoint: boolean }[] = [];
  const has = (x: unknown) => JSON.stringify(x ?? null).includes('"cache_control"');
  for (const t of b.tools ?? []) out.push({ text: JSON.stringify(t), breakpoint: has(t) });
  const sys = Array.isArray(b.system) ? b.system : [{ type: "text", text: String(b.system) }];
  for (const s of sys) out.push({ text: JSON.stringify(s), breakpoint: has(s) });
  for (const m of b.messages as { role: string; content: unknown }[]) {
    const parts = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
    for (const p of parts) out.push({ text: JSON.stringify(p), breakpoint: has(p) });
  }
  return out;
}

it("token benchmark", async () => {
  const label = process.env.BENCH_LABEL ?? "run";
  const db = await userClient("owner");
  const ctx: AppContext = { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner",
    allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] } as AppContext;

  const cache = new Set<string>(); // simulated 5-min cache (whole bench runs within 5 minutes)
  const rows: Record<string, unknown>[] = [];
  const orig = MockProvider.prototype.chat;
  let calls: { model: string; total: number; toolsTok: number; toolCount: number; resultTok: number; cost: number; noCacheCost: number; readTok: number; writeTok: number }[] = [];
  MockProvider.prototype.chat = async function (req: provider.ChatRequest) {
    const body = toBody(req);
    const segs = segments(body);
    const total = segs.reduce((n, s) => n + tok(s.text), 0);
    const toolsTok = (body.tools ?? []).reduce((n: number, t) => n + tok(JSON.stringify(t)), 0);
    const resultTok = (body.messages as { content: unknown }[]).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p: { type?: string }) => p.type === "tool_result").reduce((n: number, p) => n + tok(JSON.stringify(p)), 0);
    const p = /sonnet/.test(req.model) ? PRICE.sonnet : PRICE.haiku;
    // Find the longest cached breakpoint prefix; then the last breakpoint (written for next time).
    let acc = "", accTok = 0, readTok = 0, lastBpTok = 0;
    const bps: { key: string; t: number }[] = [];
    for (const s of segs) { acc += s.text; accTok += tok(s.text); if (s.breakpoint) bps.push({ key: req.model + "|" + acc, t: accTok }); }
    for (const bp of bps) if (bp.t >= p.min && cache.has(bp.key)) readTok = bp.t;
    let writeTok = 0;
    for (const bp of bps) if (bp.t >= p.min && !cache.has(bp.key)) { cache.add(bp.key); lastBpTok = bp.t; }
    if (lastBpTok > readTok) writeTok = lastBpTok - readTok;
    const plain = total - readTok - writeTok;
    const cost = (plain * p.in + writeTok * p.in * 1.25 + readTok * p.in * 0.1) / 1e6;
    calls.push({ model: req.model, total, toolsTok, toolCount: (body.tools ?? []).length, resultTok, cost, noCacheCost: (total * p.in) / 1e6, readTok, writeTok });
    return orig.call(this, req);
  };
  try {
    for (const q of QUESTIONS) {
      calls = [];
      await runAssistant({ ctx, request: q });
      const sum = (k: keyof (typeof calls)[number]) => calls.reduce((n, c) => n + (c[k] as number), 0);
      rows.push({ q, model: calls[0]?.model, calls: calls.length, tools: calls[0]?.toolCount, inputTok: sum("total"), toolDefTok: sum("toolsTok"), toolResultTok: sum("resultTok"),
        cachedReadTok: sum("readTok"), cacheWriteTok: sum("writeTok"), usd: +sum("cost").toFixed(5), usdNoCache: +sum("noCacheCost").toFixed(5) });
    }
  } finally { MockProvider.prototype.chat = orig; }
  console.table(rows);
  const tot = (k: string) => rows.reduce((n, r) => n + (r[k] as number), 0);
  const summary = { label, questions: rows.length, inputTok: tot("inputTok"), toolDefTok: tot("toolDefTok"), toolResultTok: tot("toolResultTok"), cachedReadTok: tot("cachedReadTok"), usd: +tot("usd").toFixed(4) };
  console.log(JSON.stringify(summary));
  writeFileSync(`/tmp/bench-${label}.json`, JSON.stringify({ summary, rows }, null, 2));
}, 180_000);
