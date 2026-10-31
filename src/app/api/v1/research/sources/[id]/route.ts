import { z } from "zod";
import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { saveSource, setSourceAllowed } from "@/modules/intelligence/research/registry";
import { SourceInput } from "@/modules/intelligence/research/sources";

type P = { id: string };
const Body = z.union([
  z.object({ allowed: z.boolean() }).strict(),
  SourceInput.extend({ expectedVersion: z.number().int().optional().nullable() }),
]);

/** Update a source (full body + expectedVersion) or just enable/disable it ({allowed}). Admin only. */
export const POST = route<P>(async (req, { params }) => {
  const ctx = await requireContext("admin");
  const id = uuid.parse(params.id);
  const b = await parseJson(req, Body);
  if ("name" in b) {
    const { expectedVersion, ...rest } = b;
    return guard(saveSource(ctx.db, ctx.workspaceId, rest, { id, expectedVersion: expectedVersion ?? null, userId: ctx.userId }));
  }
  return guard(setSourceAllowed(ctx.db, ctx.workspaceId, id, b.allowed, ctx.userId));
}, { requireIdempotency: true });
