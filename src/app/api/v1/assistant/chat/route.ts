import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { runAssistant } from "@/modules/assistant/engine/run";
import type { StreamEvent } from "@/modules/assistant/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1).max(8000),
  focus: z.object({ type: z.string(), id: z.string(), label: z.string().max(200).default(""), href: z.string().optional() }).nullish(),
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
  commandId: z.string().uuid().optional(),
  /** bypass the answer cache ("Refresh") */
  fresh: z.boolean().optional(),
});

/** POST /api/v1/assistant/chat — text/event-stream of StreamEvent JSON. Runs past ~50s continue as an `assistant.run` job. */
export const POST = route(async (req, { idempotencyKey }) => {
  const ctx = await requireContext();
  const body = await parseJson(req, Body);
  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => { if (!open) return; try { controller.enqueue(enc.encode(s)); } catch { open = false; } };
      // One enqueue per event: each SSE frame is flushed immediately (no batching of text deltas).
      const send = (e: StreamEvent) => write(`data: ${JSON.stringify(e)}\n\n`);
      const ping = setInterval(() => write(": keep-alive\n\n"), 15_000);
      req.signal.addEventListener("abort", () => { open = false; });
      write(": open\n\n");
      // The run keeps going if the client disconnects, so its result is still stored in the conversation.
      runAssistant({
        ctx, conversationId: body.conversationId ?? null, request: body.message, focus: (body.focus as never) ?? null,
        attachmentIds: body.attachmentIds, commandId: body.commandId, fresh: body.fresh, idempotencyKey: idempotencyKey ?? undefined,
        onEvent: send, deadlineAt: Date.now() + 48_000,
      }).catch((e) => send({ type: "error", message: e instanceof Error && "status" in e ? e.message : "The assistant run failed." }))
        .finally(() => { clearInterval(ping); if (open) { open = false; try { controller.close(); } catch { /* closed */ } } });
    },
    cancel() { open = false; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "Content-Encoding": "identity" } });
}, { requireIdempotency: true });
