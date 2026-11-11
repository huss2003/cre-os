// Round 2 engine: live streaming (provider SSE accumulator + mock chunked stream event order), answer cache, learning from corrections.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, USERS, tag } from "../../../../tests/helpers";
import type { AppContext } from "@/lib/auth/context";
import type { Block, StreamEvent } from "../types";
import { runAssistant } from "./run";
import { StreamAccumulator, chatWithFallback, ProviderError, type ModelProvider } from "./provider";
import { cacheKey, tablesFor, normaliseRequest } from "./cache";
import { learnFromFeedback, learnFromDraftEdit, heuristicPreference } from "./learn";
import { createDraft } from "@/lib/services/drafts";

type Row = Record<string, any>;
const T = tag("r2");
let ctx: AppContext;
let db: any;
delete process.env.ANTHROPIC_API_KEY;
process.env.ASSISTANT_RUNS_PER_MIN = "500";

async function ask(request: string, extra: Partial<Parameters<typeof runAssistant>[0]> = {}) {
  const events: StreamEvent[] = [];
  const r = await runAssistant({ ctx, request, onEvent: (e) => events.push(e), ...extra });
  const { data: msg } = await db.from("assistant_message").select("*").eq("id", r.messageId).single();
  return { ...r, events, msg: msg as Row, blocks: (msg?.blocks ?? []) as Block[] };
}
const ins = async (table: string, row: Row) => {
  const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, ...row }).select("*").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as Row;
};
let org: Row, person: Row;

beforeAll(async () => {
  db = await userClient("owner");
  ctx = { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner",
    allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] };
  org = await ins("organisation", { display_name: `Zeta${T}`, sector: "IT services" });
  person = await ins("person", { full_name: `Meera${T} Shah` });
});

describe("streaming", () => {
  it("StreamAccumulator folds Anthropic SSE (text + tool_use json + cache usage) into a ChatResponse", () => {
    const deltas: string[] = [];
    const a = new StreamAccumulator("claude-haiku-5-5", (d) => deltas.push(d));
    const sse = (o: unknown) => `event: x\ndata: ${JSON.stringify(o)}`;
    for (const ev of [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "search_companies", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"acme\"}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ]) a.feedSse(sse(ev));
    const r = a.result();
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.content).toEqual([{ type: "text", text: "Hello" }, { type: "tool_use", id: "tu1", name: "search_companies", input: { query: "acme" } }]);
    expect(r.stop_reason).toBe("tool_use");
    expect(r.usage).toMatchObject({ input: 115, output: 42, cacheRead: 100, cacheWrite: 5 });
  });

  it("no fast-model fallback once text has streamed; fallback before first text", async () => {
    let calls = 0;
    const failing: ModelProvider = { name: "t", chat: async () => { throw new Error("x"); },
      chatStream: async (_r, on) => { calls++; if (calls === 1) { on("partial"); } throw new ProviderError(500, "boom"); } };
    await expect(chatWithFallback(failing, { model: "claude-sonnet-5-5", system: "", messages: [] }, { workspaceId: WS1, workflow: "t" }, () => undefined)).rejects.toThrow();
    expect(calls).toBe(1);
    let n = 0;
    const flaky: ModelProvider = { name: "t", chat: async () => { throw new Error("x"); },
      chatStream: async (r, on) => { n++; if (n === 1) throw new ProviderError(500, "boom"); on("ok"); return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input: 0, output: 0, searches: 0, usd: 0 }, model: r.model }; } };
    const r = await chatWithFallback(flaky, { model: "claude-sonnet-5-5", system: "", messages: [] }, { workspaceId: WS1, workflow: "t" }, () => undefined);
    expect(r.model).toMatch(/haiku/);
  });

  it("mock run streams text in several deltas, after steps and before blocks/done; deltas join to the stored text", async () => {
    const r = await ask(`Give me everything important about Zeta${T}.`, { fresh: true });
    const types = r.events.map((e) => e.type);
    const texts = r.events.filter((e) => e.type === "text") as { delta: string }[];
    expect(texts.length).toBeGreaterThan(1);
    expect(types[0]).toBe("run");
    const firstText = types.indexOf("text"), lastStep = types.lastIndexOf("step"), blocks = types.indexOf("blocks");
    expect(lastStep).toBeLessThan(firstText);
    expect(types.lastIndexOf("text")).toBeLessThan(blocks);
    expect(types.at(-1)).toBe("done");
    expect(texts.map((t) => t.delta).join("").trim()).toBe(r.msg.content);
  });
});

describe("answer cache", () => {
  it("key normalises the request and depends on focus/groups/user; side-effect tools are uncacheable", () => {
    expect(normaliseRequest("  Hello,  WORLD? ")).toBe("hello world");
    const k = (o: Partial<Parameters<typeof cacheKey>[0]>) => cacheKey({ request: "x", groups: ["core"], userId: "u", ...o });
    expect(k({ request: "X?" })).toBe(k({}));
    expect(k({ focusId: "f" })).not.toBe(k({}));
    expect(k({ userId: "v" })).not.toBe(k({}));
    expect(tablesFor(["get_company_profile"])).toContain("organisation");
    expect(tablesFor(["get_company_profile", "generate_outreach_draft"])).toBeNull();
    expect(tablesFor(["web_research"])).toBeNull();
  });

  it("miss → hit (reused label, no tools) → invalidated by a data change → fresh bypass", async () => {
    const q = `Give me everything important about Zeta${T} please`;
    const first = await ask(q);
    expect(first.status).toBe("completed");
    expect(first.events.some((e) => e.type === "step")).toBe(true);

    const second = await ask(q.toUpperCase() + "!");
    expect(second.events.some((e) => e.type === "step")).toBe(false);
    expect(second.msg.content).toBe(first.msg.content);
    const st = second.blocks.find((b) => b.kind === "status") as Extract<Block, { kind: "status" }>;
    expect(st.done[0]).toMatch(/^Reused answer from .* — data unchanged$/);
    expect(second.msg.model).toBe("cache");

    await db.from("organisation").update({ sector: "Banking" }).eq("id", org.id);
    const third = await ask(q);
    expect(third.events.some((e) => e.type === "step")).toBe(true);

    const fourth = await ask(q, { fresh: true });
    expect(fourth.events.some((e) => e.type === "step")).toBe(true);
    const fifth = await ask(q);
    expect(fifth.msg.model).toBe("cache");
  });
});

describe("learning from corrections", () => {
  it("thumbs-down with comment → stated relationship memory on the conversation's person", async () => {
    const r = await ask(`Who is Meera${T} Shah?`, { focus: { type: "person", id: person.id, label: "Meera" } });
    const out = await learnFromFeedback(ctx, { messageId: r.messageId, rating: -1, comment: "Keep answers about her to three bullet points" });
    expect(out.saved).toMatchObject({ category: "relationship", entity_type: "person", entity_id: person.id, stated: true });
    expect(out.saved!.content).toContain("three bullet points");
    expect((await learnFromFeedback(ctx, { messageId: r.messageId, rating: 1, comment: "great" })).saved).toBeNull();
    expect((await learnFromFeedback(ctx, { messageId: r.messageId, rating: -1 })).saved).toBeNull();
  });

  it("heuristic preference is deterministic", () => {
    const long = "Hello Meera!\n" + "word ".repeat(60) + "\nBest";
    expect(heuristicPreference(long, "Hi Meera,\n" + "word ".repeat(20) + "\nWarm regards, Ravi")).toMatch(/shorter[^]*80 to 25|opens with "Hi Meera,"/);
    expect(heuristicPreference("same", "same")).toBeNull();
  });

  it("user edit of a generated draft → inferred memory; user-written drafts are ignored", async () => {
    const body = "Hello Meera!\n" + "We have some exciting options for you. ".repeat(6) + "\nBest";
    const { data: d } = await createDraft(db, WS1, { channel: "email", recipientPersonId: person.id, recipientDisplay: "Meera", subject: `Options ${T}`, body, createdByKind: "model", ownerUserId: USERS.owner.id }) as unknown as { data: Row };
    const draftId = (d?.id ?? (await db.from("draft").select("id").eq("subject", `Options ${T}`).single()).data.id) as string;
    const out = await learnFromDraftEdit(ctx, { draftId, before: { subject: `Options ${T}`, body }, after: { subject: `Options ${T}`, body: "Hi Meera,\nTwo options fit your brief. Free for a call Thursday?\nRegards, Ravi" } });
    expect(out.saved).toMatchObject({ category: "relationship", entity_id: person.id, stated: false });
    expect(out.saved!.content).toMatch(/^Writing style:/);

    const own = await createDraft(db, WS1, { channel: "email", recipientPersonId: person.id, subject: `Own ${T}`, body: "hi", createdByKind: "user", ownerUserId: USERS.owner.id }) as unknown as Row;
    const ownId = (own?.data?.id ?? own?.id ?? (await db.from("draft").select("id").eq("subject", `Own ${T}`).single()).data.id) as string;
    expect((await learnFromDraftEdit(ctx, { draftId: ownId, before: { body: "hi" }, after: { body: "hello there" } })).saved).toBeNull();
  });
});
