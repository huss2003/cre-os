import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Provider-independent chat interface for the assistant tool loop. One Anthropic implementation today;
 * another vendor only needs to implement `ModelProvider`. Cost of every call goes into mudar.model_usage
 * (same columns as the AI gateway's logUsage; no prompt bodies are logged).
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface ChatMessage { role: "user" | "assistant"; content: string | ContentBlock[] }
export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown> }

export interface ChatRequest {
  model: string;
  /** Static instructions — cached together with the tool list. */
  system: string;
  /** Per-request context (records, memories, date) — sent after the cache breakpoint. */
  systemContext?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  webSearch?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
}
export interface ChatResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage: { input: number; output: number; searches: number; usd: number; cacheWrite?: number; cacheRead?: number };
  model: string;
}

export interface ModelProvider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Same result as chat(), but calls onText with each text delta as it arrives. */
  chatStream?(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse>;
}

export class ProviderError extends Error {
  constructor(public status: number, message: string) { super(message); }
  get retryable() { return this.status === 429 || this.status === 529 || this.status >= 500 || this.status === 0; }
}

export const MODEL_FAST = () => process.env.ASSISTANT_MODEL_FAST || "claude-haiku-5-5";
export const MODEL_DEEP = () => process.env.ASSISTANT_MODEL_DEEP || "claude-sonnet-5-5";

/** USD per million tokens (estimates; update with pricing). */
const PRICES: { match: RegExp; inputPerM: number; outputPerM: number }[] = [
  { match: /haiku/, inputPerM: 1, outputPerM: 5 },
  { match: /sonnet/, inputPerM: 3, outputPerM: 15 },
  { match: /opus/, inputPerM: 5, outputPerM: 25 },
];
const PER_SEARCH = 0.01;
/** Cache writes bill at 1.25x input, cache reads at 0.1x input (Anthropic prompt caching, 5-minute TTL). */
export function estimateUsd(model: string, inTok: number, outTok: number, searches = 0, cacheWrite = 0, cacheRead = 0) {
  const p = PRICES.find((x) => x.match.test(model)) ?? PRICES[1];
  return ((inTok + cacheWrite * 1.25 + cacheRead * 0.1) / 1e6) * p.inputPerM + (outTok / 1e6) * p.outputPerM + searches * PER_SEARCH;
}

/** Equivalent of the gateway's (non-exported) logUsage. Never throws. */
export async function logModelUsage(u: {
  workspaceId: string | null; workflow: string; model: string; inTok?: number; outTok?: number; searchCalls?: number;
  usd?: number; ok: boolean; error?: string; requestId?: string;
}) {
  try {
    await createAdminClient().from("model_usage").insert({
      workspace_id: u.workspaceId, workflow: u.workflow, model: u.model, input_tokens: u.inTok ?? 0, output_tokens: u.outTok ?? 0,
      audio_seconds: 0, search_calls: u.searchCalls ?? 0, estimated_usd: u.usd ?? 0,
      pricing_version: "assistant-2026-11", request_id: u.requestId ?? null, ok: u.ok, error: u.error ?? null, mode: "responses",
    });
  } catch { /* never break the run */ }
}

const TIMEOUT_MS = 45_000;

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Builds the Anthropic Messages body with prompt caching (token saver #1). Up to 3 cache breakpoints:
 *  1. end of the static system prompt → caches tool list + instructions (same for every request with the same tool set);
 *  2. last block of the conversation → each tool-loop step re-reads everything before it from cache.
 * The per-request context sits between them, so it never invalidates the big static prefix.
 */
export function buildRequestBody(req: ChatRequest) {
  const tools: Record<string, unknown>[] = (req.tools ?? []).map((t) => ({ ...t }));
  if (req.webSearch) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 4, user_location: { type: "approximate", country: "IN" } });
  const system: Record<string, unknown>[] = [{ type: "text", text: req.system, cache_control: EPHEMERAL }];
  if (req.systemContext) system.push({ type: "text", text: req.systemContext });
  const messages = req.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map((c) => ({ ...c })) }));
  const last = messages[messages.length - 1];
  const tail = last?.content[last.content.length - 1] as Record<string, unknown> | undefined;
  if (tail && tail.type !== "thinking") tail.cache_control = EPHEMERAL;
  return { model: req.model, max_tokens: req.maxTokens ?? 2000, system, messages, ...(tools.length ? { tools } : {}) };
}

export class AnthropicProvider implements ModelProvider {
  name = "anthropic";
  constructor(private apiKey = process.env.ANTHROPIC_API_KEY ?? "") {}

  private async once(req: ChatRequest): Promise<ChatResponse> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(buildRequestBody(req)),
        signal,
      });
    } catch (e) {
      throw new ProviderError(0, `network/timeout: ${String(e).slice(0, 200)}`);
    }
    const body = (await res.json().catch(() => ({}))) as {
      content?: ContentBlock[]; stop_reason?: string; error?: { type?: string; message?: string };
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };
    };
    if (!res.ok) throw new ProviderError(body.error?.type === "overloaded_error" ? 529 : res.status, `${res.status} ${body.error?.message ?? ""}`);
    const input = body.usage?.input_tokens ?? 0, output = body.usage?.output_tokens ?? 0, searches = body.usage?.server_tool_use?.web_search_requests ?? 0;
    const cacheWrite = body.usage?.cache_creation_input_tokens ?? 0, cacheRead = body.usage?.cache_read_input_tokens ?? 0;
    // `input` reported = all prompt tokens (uncached + cache write + cache read) so token logs stay comparable.
    return { content: body.content ?? [], stop_reason: body.stop_reason ?? "end_turn", usage: { input: input + cacheWrite + cacheRead, output, searches, cacheWrite, cacheRead, usd: estimateUsd(req.model, input, output, searches, cacheWrite, cacheRead) }, model: req.model };
  }

  private async streamOnce(req: ChatRequest, onText: (d: string) => void, state: { started: boolean }): Promise<ChatResponse> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS * 2);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ ...buildRequestBody(req), stream: true }),
        signal,
      });
    } catch (e) {
      throw new ProviderError(0, `network/timeout: ${String(e).slice(0, 200)}`);
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
      throw new ProviderError(body.error?.type === "overloaded_error" ? 529 : res.status || 0, `${res.status} ${body.error?.message ?? ""}`);
    }
    const acc = new StreamAccumulator(req.model, (d) => { state.started = true; onText(d); });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        state.started = true;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          acc.feedSse(chunk);
        }
      }
      if (buf.trim()) acc.feedSse(buf);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(0, `stream interrupted: ${String(e).slice(0, 200)}`);
    }
    return acc.result();
  }

  /** Streaming variant. Retries once on 429/5xx/overloaded, but only if no byte of the response had arrived yet. */
  async chatStream(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResponse> {
    const state = { started: false };
    try {
      return await this.streamOnce(req, onText, state);
    } catch (e) {
      if (e instanceof ProviderError && e.retryable && !state.started && !req.signal?.aborted) {
        await new Promise((r) => setTimeout(r, e.status === 429 ? 2000 : 800));
        return this.streamOnce(req, onText, state);
      }
      throw e;
    }
  }

  /** timeout + one retry on 429/5xx/overloaded. */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      return await this.once(req);
    } catch (e) {
      if (e instanceof ProviderError && e.retryable && !req.signal?.aborted) {
        await new Promise((r) => setTimeout(r, e.status === 429 ? 2000 : 800));
        return this.once(req);
      }
      throw e;
    }
  }
}

/**
 * Folds Anthropic SSE events (message_start, content_block_start/delta/stop, message_delta, message_stop, error)
 * into a ChatResponse identical to the non-streaming one. Exported for tests.
 */
export class StreamAccumulator {
  private blocks: (ContentBlock & { _json?: string })[] = [];
  private stop = "end_turn";
  private u = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 };
  constructor(private model: string, private onText: (d: string) => void) {}

  feedSse(chunk: string) {
    const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) return;
    let ev: Record<string, any>;
    try { ev = JSON.parse(data); } catch { return; }
    this.feed(ev);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feed(ev: Record<string, any>) {
    switch (ev.type) {
      case "message_start": this.usage(ev.message?.usage); break;
      case "content_block_start": {
        const b = { ...(ev.content_block ?? {}) } as ContentBlock & { _json?: string };
        if (b.type === "tool_use" || b.type === "server_tool_use") b._json = "";
        this.blocks[ev.index] = b;
        if (b.type === "text" && (b as { text?: string }).text) this.onText((b as { text: string }).text);
        break;
      }
      case "content_block_delta": {
        const b = this.blocks[ev.index]; const d = ev.delta ?? {};
        if (!b) break;
        if (d.type === "text_delta") { (b as { text: string }).text = ((b as { text?: string }).text ?? "") + d.text; this.onText(d.text); }
        else if (d.type === "input_json_delta") b._json = (b._json ?? "") + (d.partial_json ?? "");
        break;
      }
      case "content_block_stop": {
        const b = this.blocks[ev.index];
        if (b && b._json !== undefined) {
          try { (b as { input: unknown }).input = b._json ? JSON.parse(b._json) : {}; } catch { (b as { input: unknown }).input = {}; }
          delete b._json;
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) this.stop = ev.delta.stop_reason;
        this.usage(ev.usage);
        break;
      case "error":
        throw new ProviderError(ev.error?.type === "overloaded_error" ? 529 : 500, `stream error: ${ev.error?.message ?? ""}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private usage(x: any) {
    if (!x) return;
    // message_delta usage is cumulative; take the max so either ordering is safe.
    this.u.input = Math.max(this.u.input, x.input_tokens ?? 0);
    this.u.output = Math.max(this.u.output, x.output_tokens ?? 0);
    this.u.cacheWrite = Math.max(this.u.cacheWrite, x.cache_creation_input_tokens ?? 0);
    this.u.cacheRead = Math.max(this.u.cacheRead, x.cache_read_input_tokens ?? 0);
    this.u.searches = Math.max(this.u.searches, x.server_tool_use?.web_search_requests ?? 0);
  }

  result(): ChatResponse {
    const content = this.blocks.filter(Boolean).map((b) => { const { _json, ...rest } = b; void _json; return rest as ContentBlock; });
    const { input, output, cacheWrite, cacheRead, searches } = this.u;
    return { content, stop_reason: this.stop, model: this.model,
      usage: { input: input + cacheWrite + cacheRead, output, searches, cacheWrite, cacheRead, usd: estimateUsd(this.model, input, output, searches, cacheWrite, cacheRead) } };
  }
}

/**
 * Call with logging, and fall back deep → fast model when the deep model fails. With `onText` and a streaming provider,
 * text deltas are forwarded live; the fast-model fallback only happens if no text has been forwarded yet.
 */
export async function chatWithFallback(provider: ModelProvider, req: ChatRequest, log: { workspaceId: string; workflow: string; requestId?: string }, onText?: (delta: string) => void): Promise<ChatResponse> {
  let emitted = false;
  const fwd = (d: string) => { if (d) { emitted = true; onText?.(d); } };
  const attempt = async (model: string) => {
    try {
      const r = onText && provider.chatStream ? await provider.chatStream({ ...req, model }, fwd) : await provider.chat({ ...req, model });
      await logModelUsage({ ...log, model: r.model, inTok: r.usage.input, outTok: r.usage.output, searchCalls: r.usage.searches, usd: r.usage.usd, ok: true });
      return r;
    } catch (e) {
      await logModelUsage({ ...log, model, ok: false, error: String(e).slice(0, 500) });
      throw e;
    }
  };
  try {
    return await attempt(req.model);
  } catch (e) {
    if (req.model !== MODEL_FAST() && !req.signal?.aborted && !emitted) return attempt(MODEL_FAST());
    throw e;
  }
}

export const RATE_LIMIT_PER_MIN = () => Number(process.env.ASSISTANT_RUNS_PER_MIN ?? 20);
