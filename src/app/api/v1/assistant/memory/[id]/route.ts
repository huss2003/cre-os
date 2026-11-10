import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { getMemory, correctMemory, verifyMemory, restrictMemory, forgetMemory } from "@/modules/assistant/memory/service";
import { domain } from "@/modules/assistant/memory/http";

/** GET /api/v1/assistant/memory/:id */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const m = await getMemory(ctx, uuid.parse(params.id));
  if (!m) throw new HttpError(404, "memory not found");
  return { memory: m };
});

const patch = z.discriminatedUnion("action", [
  z.object({ action: z.literal("correct"), content: z.string().min(3).max(1000), stated: z.boolean().default(true), provided_by: z.string().max(120).optional() }),
  z.object({ action: z.literal("verify") }),
  z.object({ action: z.literal("restrict") }),
]);
/** PATCH /api/v1/assistant/memory/:id {action: correct|verify|restrict} — correction keeps the old version as history. */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const b = await parseJson(req, patch);
  return domain(async () => {
    if (b.action === "correct") return correctMemory(ctx, id, b.content, { source: "user", sourceRef: { via: "api" }, providedBy: b.provided_by ?? "user", stated: b.stated });
    if (b.action === "verify") return { memory: await verifyMemory(ctx, id) };
    return { memory: await restrictMemory(ctx, id) };
  });
}, { requireIdempotency: true });

/** DELETE /api/v1/assistant/memory/:id — forget (content erased, row kept as a tombstone). */
export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext("editor");
  return { memory: await domain(() => forgetMemory(ctx, uuid.parse(params.id))) };
}, { requireIdempotency: true });
