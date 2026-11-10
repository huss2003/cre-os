import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { runCommand } from "@/modules/assistant/commands/service";
import { domain } from "@/modules/assistant/memory/http";

/** POST {inputs?, conversationId?} — run now (non-streaming). For streaming use the chat UI: /assistant?command=<id>. */
export const POST = route<{ id: string }>(async (req, { params, idempotencyKey }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, z.object({ inputs: z.record(z.string(), z.string()).default({}), conversationId: uuid.nullish() }));
  return domain(() => runCommand(ctx, uuid.parse(params.id), b.inputs, { idempotencyKey: idempotencyKey ?? undefined, conversationId: b.conversationId ?? null }));
}, { requireIdempotency: true });
