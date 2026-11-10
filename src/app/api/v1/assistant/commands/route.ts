import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson } from "@/lib/util/http";
import { listCommands, createCommand, addTemplate, commandFields, TEMPLATES } from "@/modules/assistant/commands/service";
import { domain } from "@/modules/assistant/memory/http";

/** GET /api/v1/assistant/commands → {items, templates} */
export const GET = route(async () => {
  const ctx = await requireContext();
  return { items: await listCommands(ctx), templates: TEMPLATES };
});

/** POST /api/v1/assistant/commands {template} | {name, prompt, ...} */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, z.union([z.object({ template: z.string() }), commandFields]));
  return { command: await domain(() => ("template" in b ? addTemplate(ctx, b.template) : createCommand(ctx, b))) };
}, { requireIdempotency: true });
