import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";
import { closeException } from "@/modules/imports/service";

const Body = z.object({ status: z.enum(["resolved", "dismissed"]), note: z.string().max(2000).nullish() });

/** POST /api/v1/imports/exceptions/[id] — resolve or dismiss an exception-queue item (note kept for audit). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  return closeException(ctx, uuid.parse(params.id), b.status, b.note ?? null);
}, { requireIdempotency: true });
